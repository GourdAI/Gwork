/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.entity.ModelDo;
import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * 用量归档账本 —— 把散落在各会话 {@code *.stream.ndjson} 里的 token 消耗，
 * <b>增量</b>聚合进全局区的月度账本，使历史用量不随项目删除/移走而丢失。
 *
 * <h3>为什么要归档</h3>
 * <p>统计原本靠实时扫描会话流文件，存在两个问题：① 项目目录被删除、移走或取消登记后，
 * 那部分历史消耗就永久查不到了；② 会话越积越多时每次打开统计页都要全量扫描，越来越慢。
     * 账本把「按天 × 按模型」的聚合结果固化到全局基准目录，源文件消失后历史依旧可查。</p>
 *
 * <h3>存储形态</h3>
     * <p>按月分片：{@code <globalBase>/.gwork/usage/usage-YYYY-MM.json}，<b>只存聚合、不存原文</b>，
 * 单月体积通常仅几十 KB。结构：</p>
 * <pre>{@code
 * {
 *   "month": "2026-08",
 *   "days": {
 *     "2026-08-25": {
 *       "messages": 12,
 *       "sessions": ["work-a", "work-b"],
 *       "models": {
 *         "GLM-5.3": {"tokens":123,"input":100,"output":23,"cacheRead":80,"cacheCreation":5,"rounds":3}
 *       }
 *     }
 *   },
 *   "watermarks": { "work-a": {"ts": 1756100000000, "size": 20480} }
 * }
 * }</pre>
 *
 * <h3>增量水位</h3>
 * <p>每个会话记录已归档到的最大 {@code createdAt}（{@code ts}）与当时的文件字节数（{@code size}）：
 * 重扫时只累加 {@code createdAt > ts} 的事件，杜绝重复计数；{@code size} 用于快速跳过<b>完全未增长</b>
 * 的会话文件，避免无谓 IO。水位按会话记在<b>当月</b>账本里；月份翻页后当月账本查不到旧会话水位时，
 * 会从<b>历史分片</b>继承（取时间戳最大的一条）并登记到当月，因此跨月/长期休眠都不会退化成全量重扫。</p>
 *
 * <h3>历史保留语义</h3>
 * <p>项目取消登记或目录被删除后，扫描阶段自然扫不到它的会话，账本中既有的历史天<b>原样保留</b>，
 * 只是不再增量更新——这正是归档要达到的效果。</p>
 *
 * @author oisin
 * @see UsageStatsService
 * @see SessionStreamStore
 */
public class UsageArchiveService {
    private static final Logger LOG = LoggerFactory.getLogger(UsageArchiveService.class);

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter MONTH_FMT = DateTimeFormatter.ofPattern("yyyy-MM");

    /** 账本目录名（位于全局基准目录 {@code .gwork/} 下） */
    private static final String USAGE_DIR = "usage";

    /** 月度分片文件名前缀（{@code usage-YYYY-MM.json}）；列举分片与拼路径共用此常量。 */
    private static final String LEDGER_PREFIX = "usage-";
    /** 月度分片文件名后缀。落盘中途的 {@code .json.tmp} 因不匹配此后缀而天然被排除。 */
    private static final String LEDGER_SUFFIX = ".json";
    /** 月份标识长度（{@code yyyy-MM}）。 */
    private static final int MONTH_KEY_LEN = 7;

    private final SessionLocator sessionLocator;
    /** 全局基准目录（通常为 AgentFlags.getHarnessBase()），不随项目工作区变化。 */
    private final String globalBase;

    /**
     * 归档串行化（进程级共享）：避免「打开统计页」「启动静默归档」「存量回填」并发写同一账本。
     *
     * <p><b>必须 static（勿改回实例级）</b>：启动线程（Configurator warmup）与 Web 统计页
     * 各自 new 了本类实例，实例级锁互相看不见——回填与并发归档交错时会互相覆盖
     * （回填结果被旧快照覆盖后标记已写、永不重跑；并发读改写还会竞争同一 .json.tmp 临时文件）。</p>
     */
    private static final Object ARCHIVE_LOCK = new Object();

    /**
     * @param sessionLocator 会话目录定位器
     * @param globalBase     全局区基准目录；用量账本固定写入此目录，不使用项目工作区或 cwd
     */
    public UsageArchiveService(SessionLocator sessionLocator, String globalBase) {
        this.sessionLocator = sessionLocator;
        this.globalBase = globalBase;
    }

    // ────────────────────────────── 账本数据结构 ──────────────────────────────

    /** 单模型聚合量（账本中的最小存储单元）。 */
    public static final class ModelStat {
        public long tokens;
        public long input;
        public long output;
        public long cacheRead;
        public long cacheCreation;
        public int rounds;
        /** 模型稳定 uid（{@code ModelDo#uidOf} 派生）；旧数据/无 trace uid 时为 null。统计页按它归组。 */
        public String uid;

        void add(ModelStat o) {
            tokens += o.tokens;
            input += o.input;
            output += o.output;
            cacheRead += o.cacheRead;
            cacheCreation += o.cacheCreation;
            rounds += o.rounds;
        }
    }

    /** 单日聚合（按模型明细 + 消息数 + 活跃会话集合）。 */
    public static final class DayStat {
        public int messages;
        public final Set<String> sessions = new LinkedHashSet<>();
        public final Map<String, ModelStat> models = new LinkedHashMap<>();

        ModelStat model(String name) {
            return models.computeIfAbsent(name, k -> new ModelStat());
        }

        /** 当日总 token（跨模型求和）。 */
        public long tokens() {
            long sum = 0L;
            for (ModelStat m : models.values()) {
                sum += m.tokens;
            }
            return sum;
        }

        /** 当日总轮次（跨模型求和）。 */
        public int rounds() {
            int sum = 0;
            for (ModelStat m : models.values()) {
                sum += m.rounds;
            }
            return sum;
        }
    }

    /** 单个会话的归档水位。 */
    private static final class Watermark {
        long ts;
        long size;
    }

    /** 一个月度账本分片。 */
    private static final class MonthLedger {
        final String month;
        final Map<String, DayStat> days = new TreeMap<>();
        final Map<String, Watermark> watermarks = new HashMap<>();
        boolean dirty;

        MonthLedger(String month) {
            this.month = month;
        }
    }

    // ────────────────────────────── 对外能力 ──────────────────────────────

    /**
     * 执行一次增量归档：扫描全局区与所有已登记项目根下的会话流文件，
     * 把新增事件合并进对应月度账本并落盘。
     *
     * <p>幂等：重复调用只会处理水位之后的新事件。异常不外抛（统计页/启动流程不受影响）。</p>
     */
    public void archiveIncremental() {
        synchronized (ARCHIVE_LOCK) {
            try {
                doArchive();
            } catch (Throwable e) {
                LOG.warn("[UsageArchive] incremental archive failed: {}", e.getMessage());
            }
        }
    }

    /**
     * 读取指定日期区间（含端点）的归档数据。
     *
     * @param from 起始日期（含）
     * @param to   截止日期（含）
     * @return 日期 → 当日聚合；仅包含账本中真实存在的天（调用方自行补零）
     */
    public TreeMap<LocalDate, DayStat> load(LocalDate from, LocalDate to) {
        TreeMap<LocalDate, DayStat> result = new TreeMap<>();
        if (from == null || to == null || from.isAfter(to)) {
            return result;
        }
        synchronized (ARCHIVE_LOCK) {
            // 逐月遍历区间涉及的分片
            LocalDate cursor = from.withDayOfMonth(1);
            LocalDate last = to.withDayOfMonth(1);
            while (!cursor.isAfter(last)) {
                MonthLedger ledger = readLedger(cursor.format(MONTH_FMT));
                for (Map.Entry<String, DayStat> e : ledger.days.entrySet()) {
                    LocalDate d;
                    try {
                        d = LocalDate.parse(e.getKey(), DATE_FMT);
                    } catch (Throwable ignore) {
                        continue;
                    }
                    if (d.isBefore(from) || d.isAfter(to)) {
                        continue;
                    }
                    result.put(d, e.getValue());
                }
                cursor = cursor.plusMonths(1);
            }
        }
        return result;
    }

    /**
     * 读取账本中的<b>全部历史</b>（所有月度分片），供「累计至今」视图使用。
     *
     * <p>与 {@link #load(LocalDate, LocalDate)} 的关键区别：调用方<b>不知道</b>区间起点，
     * 若仍按月份逐月推进去找「最早一天」，就得从公元 0 年一路空扫到现代，代价不可接受。
     * 因此这里直接<b>列举目录下真实存在的分片文件</b>，读几个算几个，与历史长度成正比。</p>
     *
     * @return 日期 → 当日聚合（升序）；账本目录缺失或为空时返回空表
     */
    public TreeMap<LocalDate, DayStat> loadAll() {
        TreeMap<LocalDate, DayStat> result = new TreeMap<>();
        synchronized (ARCHIVE_LOCK) {
            for (String month : listMonths()) {
                MonthLedger ledger = readLedger(month);
                for (Map.Entry<String, DayStat> e : ledger.days.entrySet()) {
                    LocalDate d;
                    try {
                        d = LocalDate.parse(e.getKey(), DATE_FMT);
                    } catch (Throwable ignore) {
                        continue;
                    }
                    result.put(d, e.getValue());
                }
            }
        }
        return result;
    }

    /**
     * 一次性存量回填：给历史账本条目补「模型稳定 uid」，并统一名称。
     *
     * <p><b>为什么需要</b>：uid 机制上线前的账本条目只有「服务商名-模型ID」名称 key；
     * 服务商改名后新旧条目在统计页分裂。本方法把「可解析到当前配置」的条目补上 uid
     * （服务商改名/名称大小写差异产生的旧条目就此归并到同一 uid 组），无法解析的
     * （渠道已删除等）保持原样、退化为按名称展示。</p>
     *
     * <p><b>解析优先级</b>：① 别名文件 {@code usage/merge-aliases.json}（{@code 旧key → 当前规范名}，
     * 用于跨名改名如「黑驴AI→黑驴」，显式指定优先于一切推断）；② 当前配置精确同名；
     * ③ 大小写不敏感唯一匹配（如「Mad-*」→「MAD-*」，存在多个候选时跳过以防误并）。</p>
     *
     * <p><b>性能约束（勿破坏）</b>：本方法在启动 warmup 线程执行一次，成功后写标记文件
     * {@code usage/.uid-backfilled}，之后每次启动直接跳过（O(1) 文件存在性检查），
     * 不给热路径（trace 写入 / 统计聚合）增加任何成本。账本无变化时不写盘。</p>
     *
     * @param models 当前配置的全部模型（{@code settings.getModels()}）；null 或空表时
     *               本轮不扫描不写标记（配置不可用，避免永久错过回填）
     * @return 是否有账本被改写
     */
    public boolean backfillModelUids(Map<String, ModelDo> models) {
        synchronized (ARCHIVE_LOCK) {
            try {
                return doBackfillModelUids(models);
            } catch (Throwable e) {
                LOG.warn("[UsageArchive] uid backfill failed: {}", e.getMessage());
                return false;
            }
        }
    }

    private boolean doBackfillModelUids(Map<String, ModelDo> models) {
        File dir = usageDir();
        File marker = new File(dir, ".uid-backfilled");
        if (marker.isFile()) {
            return false;
        }
        // 模型表不可用（配置加载失败兜底空表等）：不扫描、不写标记，等下次启动配置可用时重试。
        // 若此刻写标记，配置恢复后将永久失去回填机会（旧账本条目持续按名称分裂）。
        if (models == null || models.isEmpty()) {
            return false;
        }
        // 无账本的全新环境（或目录尚不存在）：需要先建目录，标记文件才能落盘
        if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
            return false;
        }

        // 当前配置索引：精确名 → uid；小写名 → 规范名（仅大小写不同的多个模型出现时置 null 防误并）
        Map<String, String> exactUid = new HashMap<>();
        Map<String, String> lowerName = new HashMap<>();
        if (models != null) {
            for (Map.Entry<String, ModelDo> me : models.entrySet()) {
                String name = me.getKey();
                ModelDo m = me.getValue();
                if (name == null || name.isEmpty() || m == null) {
                    continue;
                }
                exactUid.put(name, m.stableUid());
                String low = name.toLowerCase(Locale.ROOT);
                if (lowerName.containsKey(low)) {
                    lowerName.put(low, null);
                } else {
                    lowerName.put(low, name);
                }
            }
        }
        // 别名文件（可选）：旧key → 目标规范名；目标必须仍在当前配置中才生效
        Map<String, String> aliases = readMergeAliases(dir);

        boolean anyChanged = false;
        boolean writeFailed = false;
        for (String month : listMonths()) {
            MonthLedger ledger = readLedger(month);
            boolean monthChanged = false;
            for (DayStat day : ledger.days.values()) {
                Map<String, ModelStat> rebuilt = new LinkedHashMap<>();
                for (Map.Entry<String, ModelStat> e : day.models.entrySet()) {
                    String key = e.getKey();
                    ModelStat ms = e.getValue();
                    String finalKey = key;
                    if (ms.uid == null) {
                        String target = resolveBackfillTarget(key, aliases, exactUid, lowerName);
                        if (target != null) {
                            ms.uid = exactUid.get(target);
                            finalKey = target;
                            monthChanged = true;
                        }
                    }
                    ModelStat exist = rebuilt.get(finalKey);
                    if (exist == null) {
                        rebuilt.put(finalKey, ms);
                    } else {
                        exist.add(ms);
                        monthChanged = true;
                    }
                }
                if (monthChanged) {
                    day.models.clear();
                    day.models.putAll(rebuilt);
                }
            }
            if (monthChanged) {
                anyChanged = true;
                if (!writeLedger(ledger)) {
                    writeFailed = true;
                }
            }
        }

        // 写标记：无论是否有改写都记录「已扫描」，避免每次启动重复全量扫描；
        // 但任一月份落盘失败时不写标记——失败月份会失去回填机会，留待下次启动重试（回填幂等）。
        if (!writeFailed) {
            try {
                Files.write(marker.toPath(), ("uid-backfill done " + Instant.now()).getBytes(StandardCharsets.UTF_8));
            } catch (Throwable e) {
                LOG.warn("[UsageArchive] cannot write backfill marker: {}", e.getMessage());
            }
        } else {
            LOG.warn("[UsageArchive] uid backfill: some month ledgers failed to persist; marker withheld for retry");
        }
        if (anyChanged) {
            LOG.info("[UsageArchive] uid backfill applied: legacy model entries merged by stable uid");
        }
        return anyChanged;
    }

    /** 解析历史条目应归属的当前规范名；解析不到返回 null（保持原样）。 */
    private static String resolveBackfillTarget(String key, Map<String, String> aliases,
                                                Map<String, String> exactUid, Map<String, String> lowerName) {
        if (key == null || key.isEmpty()) {
            return null;
        }
        String aliased = aliases.get(key);
        if (aliased != null && exactUid.containsKey(aliased)) {
            return aliased;
        }
        if (exactUid.containsKey(key)) {
            return key;
        }
        String canon = lowerName.get(key.toLowerCase(Locale.ROOT));
        if (canon != null && exactUid.containsKey(canon)) {
            return canon;
        }
        return null;
    }

    /** 读取别名文件（{@code usage/merge-aliases.json}，可选）：旧key → 目标规范名。缺失/损坏返回空。 */
    private Map<String, String> readMergeAliases(File dir) {
        Map<String, String> aliases = new HashMap<>();
        File f = new File(dir, "merge-aliases.json");
        if (!f.isFile()) {
            return aliases;
        }
        try {
            String json = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(json);
            if (root != null && root.isObject()) {
                root.getObjectUnsafe().forEach((k, v) -> {
                    if (!(v instanceof ONode)) {
                        return;
                    }
                    String s = ((ONode) v).getString();
                    if (k != null && !k.isEmpty() && s != null && !s.isEmpty()) {
                        aliases.put(k, s);
                    }
                });
            }
        } catch (Throwable e) {
            LOG.warn("[UsageArchive] merge-aliases.json ignored: {}", e.getMessage());
        }
        return aliases;
    }

    /**
     * 列举账本目录下全部分片的月份标识（升序，形如 {@code 2026-08}）。
     *
     * <p>只认 {@code usage-YYYY-MM.json} 这一种命名：写盘过程中的临时文件
     * （{@code usage-2026-08.json.tmp}）后缀不匹配，天然不会被当成有效分片读进来。</p>
     */
    private List<String> listMonths() {
        List<String> months = new ArrayList<>();
        File[] files = usageDir().listFiles(f -> f.isFile()
                && f.getName().startsWith(LEDGER_PREFIX)
                && f.getName().endsWith(LEDGER_SUFFIX));
        if (files == null) {
            return months;
        }
        for (File f : files) {
            String name = f.getName();
            String month = name.substring(LEDGER_PREFIX.length(), name.length() - LEDGER_SUFFIX.length());
            if (month.length() == MONTH_KEY_LEN) {
                months.add(month);
            }
        }
        Collections.sort(months);
        return months;
    }

    // ────────────────────────────── 归档实现 ──────────────────────────────

    private void doArchive() {
        ZoneId zone = ZoneId.systemDefault();

        // 收集待扫描的会话流文件（全局区 + 所有已登记项目根），按 sid 去重
        List<SessionFile> targets = collectSessionFiles();
        if (targets.isEmpty()) {
            return;
        }

        // 已加载的月度分片（按需加载，最后统一落盘）
        Map<String, MonthLedger> ledgers = new LinkedHashMap<>();
        // 账本目录下已存在的分片月份：本轮只列一次目录，供水位跨月继承复用
        List<String> historyMonths = listMonths();

        for (SessionFile sf : targets) {
            try {
                archiveOne(sf, zone, ledgers, historyMonths);
            } catch (Throwable e) {
                LOG.warn("[UsageArchive] archive failed for {}: {}", sf.sid, e.getMessage());
            }
        }

        for (MonthLedger ledger : ledgers.values()) {
            if (ledger.dirty) {
                writeLedger(ledger);
            }
        }
    }

    /** 待归档的会话文件（sid + 流文件）。 */
    private static final class SessionFile {
        final String sid;
        final File stream;

        SessionFile(String sid, File stream) {
            this.sid = sid;
            this.stream = stream;
        }
    }

    /**
     * 收集全局区 + 所有已登记项目根下的会话流文件。
     *
     * <p><b>去重口径（勿改回按目录去重）</b>：同一 sid 可能在多个根下同时存在目录——
     * 新会话在绑定所属根之前，{@code AgentSessionProvider} 已用无根提示的
     * {@link SessionLocator#resolveDir(String)} 在<b>全局区建好了空目录</b>，
     * 随后 {@code bindSessionRoot} 才把真身写到 {@code <项目根>/.gwork/sessions/}。
     * 于是全局区留下大量<b>没有流文件的空壳目录</b>。若按「目录名」占坑去重，
     * 先扫到的全局空壳会把项目根下的真身整个吞掉，导致项目会话的用量永久不入账。
     * 因此这里<b>只让真实存在且非空的流文件占坑</b>，同 sid 多处命中时取<b>字节数更大</b>者。</p>
     */
    private List<SessionFile> collectSessionFiles() {
        // sid → 已选中的流文件（保持根的扫描顺序，便于排查）
        Map<String, SessionFile> picked = new LinkedHashMap<>();

        List<File> roots = new ArrayList<>();
        File globalRoot = sessionLocator.globalSessionsRoot();
        if (globalRoot != null) {
            roots.add(globalRoot);
        }
        for (String projectRoot : sessionLocator.registeredRoots()) {
            try {
                File dir = sessionLocator.sessionsRoot(projectRoot);
                if (dir != null) {
                    roots.add(dir);
                }
            } catch (Throwable ignore) {
                // 项目根已失效（目录被删/盘符丢失）：跳过，账本中的历史仍保留
            }
        }

        for (File root : roots) {
            if (root == null || !root.isDirectory()) {
                continue;
            }
            File[] dirs = root.listFiles(f ->
                    f.isDirectory() && f.getName().startsWith(SessionLocator.PREFIX_WORK));
            if (dirs == null) {
                continue;
            }
            for (File dir : dirs) {
                String sid = dir.getName();
                File stream = new File(dir, sid + SessionStreamStore.STREAM_SUFFIX);
                // 空壳目录（无流文件 / 零字节）不占坑，否则会吞掉别的根下的同 sid 真身
                if (!stream.isFile() || stream.length() <= 0L) {
                    continue;
                }
                SessionFile prev = picked.get(sid);
                if (prev == null || stream.length() > prev.stream.length()) {
                    picked.put(sid, new SessionFile(sid, stream));
                }
            }
        }
        return new ArrayList<>(picked.values());
    }

    /** 归档单个会话：只处理水位之后的新事件。 */
    private void archiveOne(SessionFile sf, ZoneId zone, Map<String, MonthLedger> ledgers,
                            List<String> historyMonths) {
        long fileSize = sf.stream.length();
        if (fileSize <= 0) {
            return;
        }

        // 以「当前月」账本承载该会话的水位。
        //
        // 【跨月继承·勿删】水位只登记在写入当时的「当前月」账本里，因此每逢月份翻页，
        // 新月账本里必然查不到旧会话的水位。若就此按 wm == null 处理，sinceTs 会退化为
        // Long.MIN_VALUE，整个流文件被从头重扫，而事件按各自日期落回<b>历史月账本</b>，
        // 叠在回读出来的旧值上再加一遍（下方是 ms.tokens += / day.messages += 的累加语义，
        // 落盘又是整分片覆盖写）—— 存活会话的历史就此翻倍，跨 N 次断链被叠加 N 遍。
        // 已由 UsageArchiveRolloverTest 实测复现（1000→2000）。
        //
        // 故当月查不到时必须继承历史水位：比对的是<b>绝对时间戳</b>，与分片月份无关，可直接沿用。
        //
        // 【只回落一个月不够·勿改回去】旧实现只回落上一个月，仍有两条真实翻倍路径：
        //   ① 会话休眠（字节数不变）时命中下方 fileSize == wm.size 的提前 return，继承到的水位
        //      没被登记进当月账本；再翻一页连「上月」也查不到 → 断链 → 全量重扫 → 翻倍；
        //   ② 连续两个自然月没跑过归档（关机 / 没打开统计页），上月分片根本不存在 → 同样断链。
        // 因此继承范围扩到<b>全部历史分片</b>（仅在当月+上月都未命中时才多读几个几十 KB 小文件，
        // 且分片经 ledger(..) 缓存），并在提前 return 前把水位写回当月账本，让断链自愈。
        String currentMonth = LocalDate.now(zone).format(MONTH_FMT);
        MonthLedger current = ledger(ledgers, currentMonth);
        Watermark wm = current.watermarks.get(sf.sid);
        boolean inherited = false;
        if (wm == null) {
            wm = inheritWatermark(ledgers, historyMonths, currentMonth,
                    LocalDate.now(zone).minusMonths(1).format(MONTH_FMT), sf.sid);
            inherited = (wm != null);
        }
        long sinceTs = wm == null ? Long.MIN_VALUE : wm.ts;

        // 文件未增长且已归档过：直接跳过（省掉整轮 IO）
        if (wm != null && fileSize == wm.size) {
            if (inherited) {
                // 继承来的水位必须落到当月账本，否则下个月又查不到（上述路径①的根因）
                Watermark cw = new Watermark();
                cw.ts = wm.ts;
                cw.size = wm.size;
                current.watermarks.put(sf.sid, cw);
                current.dirty = true;
            }
            return;
        }

        long maxTs = sinceTs;
        boolean changed = false;

        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(sf.stream), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                boolean isTrace = line.indexOf("\"type\":\"trace\"") >= 0;
                boolean isUser = line.indexOf("\"type\":\"user\"") >= 0
                        || line.indexOf("\"type\":\"user_input\"") >= 0;
                if (!isTrace && !isUser) {
                    // 海量 text/reason 增量块，跳过不解析
                    continue;
                }
                ONode node;
                try {
                    node = ONode.ofJson(line.trim());
                } catch (Throwable ignore) {
                    continue;
                }
                Long createdAt = node.hasKey("createdAt") ? node.get("createdAt").getLong() : null;
                if (createdAt == null || createdAt <= 0) {
                    continue;
                }
                // 增量水位：只吃新事件，杜绝重复累加
                if (createdAt <= sinceTs) {
                    continue;
                }
                if (createdAt > maxTs) {
                    maxTs = createdAt;
                }

                LocalDate date = Instant.ofEpochMilli(createdAt).atZone(zone).toLocalDate();
                MonthLedger target = ledger(ledgers, date.format(MONTH_FMT));
                DayStat day = target.days.computeIfAbsent(date.format(DATE_FMT), k -> new DayStat());

                String type = node.get("type").getString();
                if ("trace".equals(type)) {
                    String model = node.get("model").getString();
                    if (model == null || model.isEmpty()) {
                        model = "unknown";
                    }
                    long input = longOf(node, "inputTokens");
                    long output = longOf(node, "outputTokens");
                    long total = longOf(node, "totalTokens");
                    if (total <= 0) {
                        total = input + output;
                    }
                    ModelStat ms = day.model(model);
                    String traceUid = node.hasKey("modelId") ? node.get("modelId").getString() : null;
                    if (traceUid != null && traceUid.isEmpty()) { traceUid = null; }
                    if (traceUid != null) { ms.uid = traceUid; }
                    ms.tokens += total;
                    ms.input += input;
                    ms.output += output;
                    ms.cacheRead += longOf(node, "cacheReadTokens");
                    ms.cacheCreation += longOf(node, "cacheCreationTokens");
                    ms.rounds += 1;
                } else {
                    day.messages += 1;
                }
                day.sessions.add(sf.sid);

                target.dirty = true;
                changed = true;
            }
        } catch (Throwable e) {
            LOG.warn("[UsageArchive] read failed for {}: {}", sf.stream.getName(), e.getMessage());
            return;
        }

        // 更新水位（即便本轮无新事件，也刷新 size 以便下次快速跳过）
        Watermark nw = new Watermark();
        nw.ts = (maxTs == Long.MIN_VALUE) ? 0L : maxTs;
        nw.size = fileSize;
        current.watermarks.put(sf.sid, nw);
        if (changed || wm == null || wm.size != fileSize) {
            current.dirty = true;
        }
    }

    /**
     * 当月账本查不到水位时，从历史分片继承该会话「已归档到哪」。
     *
     * <p>先查上一个月（月份翻页的常见情形，命中率最高），未命中再扫其余历史分片并取
     * {@code ts} <b>最大</b>的一条（防御分片间时间戳非单调的极端情况）。</p>
     *
     * <p><b>性能</b>：只有「当月 + 上月都没有水位」的会话才会触发其余分片的读取，且分片由
     * {@link #ledger(Map, String)} 缓存，单轮归档内每个分片最多读一次；水位就在当月的
     * 正常增量路径完全不受影响。</p>
     *
     * @return 继承到的水位；整个账本都没有（真正的新会话）时返回 null
     */
    private Watermark inheritWatermark(Map<String, MonthLedger> ledgers, List<String> historyMonths,
                                       String currentMonth, String prevMonth, String sid) {
        Watermark prev = ledger(ledgers, prevMonth).watermarks.get(sid);
        if (prev != null) {
            return prev;
        }
        Watermark best = null;
        for (int i = historyMonths.size() - 1; i >= 0; i--) {
            String month = historyMonths.get(i);
            if (month.equals(currentMonth) || month.equals(prevMonth)) {
                continue;
            }
            Watermark w = ledger(ledgers, month).watermarks.get(sid);
            if (w != null && (best == null || w.ts > best.ts)) {
                best = w;
            }
        }
        return best;
    }

    private static long longOf(ONode node, String key) {
        if (!node.hasKey(key)) {
            return 0L;
        }
        try {
            return Math.max(0L, node.get(key).getLong());
        } catch (Throwable ignore) {
            return 0L;
        }
    }

    private MonthLedger ledger(Map<String, MonthLedger> cache, String month) {
        return cache.computeIfAbsent(month, this::readLedger);
    }

    // ────────────────────────────── 落盘 / 回读 ──────────────────────────────

    /** 账本目录：{@code <globalBase>/.gwork/usage/}。 */
    private File usageDir() {
        return Paths.get(globalBase, AgentFlags.getHarnessHome(), USAGE_DIR)
                .toAbsolutePath().normalize().toFile();
    }

    private File ledgerFile(String month) {
        return new File(usageDir(), LEDGER_PREFIX + month + LEDGER_SUFFIX);
    }

    /** 回读月度账本（文件不存在或损坏时返回空账本，不阻断统计）。 */
    private MonthLedger readLedger(String month) {
        MonthLedger ledger = new MonthLedger(month);
        File f = ledgerFile(month);
        if (!f.isFile()) {
            return ledger;
        }
        try {
            String json = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(json);
            if (root == null || !root.isObject()) {
                return ledger;
            }

            ONode daysNode = root.get("days");
            if (daysNode != null && daysNode.isObject()) {
                daysNode.getObjectUnsafe().forEach((date, v) -> {
                    if (!(v instanceof ONode)) {
                        return;
                    }
                    ONode dn = (ONode) v;
                    DayStat day = new DayStat();
                    day.messages = (int) longOf(dn, "messages");
                    ONode sessionsNode = dn.get("sessions");
                    if (sessionsNode != null && sessionsNode.isArray()) {
                        for (ONode s : sessionsNode.getArray()) {
                            String sid = s.getString();
                            if (sid != null && !sid.isEmpty()) {
                                day.sessions.add(sid);
                            }
                        }
                    }
                    ONode modelsNode = dn.get("models");
                    if (modelsNode != null && modelsNode.isObject()) {
                        modelsNode.getObjectUnsafe().forEach((model, mv) -> {
                            if (!(mv instanceof ONode)) {
                                return;
                            }
                            ONode mn = (ONode) mv;
                            ModelStat ms = new ModelStat();
                            ms.tokens = longOf(mn, "tokens");
                            ms.input = longOf(mn, "input");
                            ms.output = longOf(mn, "output");
                            ms.cacheRead = longOf(mn, "cacheRead");
                            ms.cacheCreation = longOf(mn, "cacheCreation");
                            ms.rounds = (int) longOf(mn, "rounds");
                            String u = mn.hasKey("uid") ? mn.get("uid").getString() : null;
                            ms.uid = (u == null || u.isEmpty()) ? null : u;
                            day.models.put(model, ms);
                        });
                    }
                    ledger.days.put(date, day);
                });
            }

            ONode wmNode = root.get("watermarks");
            if (wmNode != null && wmNode.isObject()) {
                wmNode.getObjectUnsafe().forEach((sid, v) -> {
                    if (!(v instanceof ONode)) {
                        return;
                    }
                    ONode n = (ONode) v;
                    Watermark w = new Watermark();
                    w.ts = longOf(n, "ts");
                    w.size = longOf(n, "size");
                    ledger.watermarks.put(sid, w);
                });
            }
        } catch (Throwable e) {
            LOG.warn("[UsageArchive] ledger corrupted, ignored: {} ({})", f.getName(), e.getMessage());
            // 损坏账本按空处理：本轮会重新聚合（水位丢失可能少量重算，但不会崩）
            return new MonthLedger(month);
        }
        return ledger;
    }

    /** 落盘月度账本（先写临时文件再原子替换，避免写一半损坏）。
     *
     * @return 是否成功落盘（调用方据此决定是否需重试，如回填的标记文件 gating） */
    private boolean writeLedger(MonthLedger ledger) {
        try {
            File dir = usageDir();
            if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
                LOG.warn("[UsageArchive] cannot create usage dir: {}", dir);
                return false;
            }

            ONode root = new ONode().asObject();
            root.set("month", ledger.month);

            ONode daysNode = root.getOrNew("days").asObject();
            for (Map.Entry<String, DayStat> e : ledger.days.entrySet()) {
                DayStat day = e.getValue();
                ONode dn = daysNode.getOrNew(e.getKey()).asObject();
                dn.set("messages", day.messages);
                ONode sessionsNode = dn.getOrNew("sessions").asArray();
                for (String sid : day.sessions) {
                    sessionsNode.add(sid);
                }
                ONode modelsNode = dn.getOrNew("models").asObject();
                for (Map.Entry<String, ModelStat> me : day.models.entrySet()) {
                    ModelStat ms = me.getValue();
                    ONode mn = modelsNode.getOrNew(me.getKey()).asObject();
                    mn.set("tokens", ms.tokens);
                    mn.set("input", ms.input);
                    mn.set("output", ms.output);
                    mn.set("cacheRead", ms.cacheRead);
                    mn.set("cacheCreation", ms.cacheCreation);
                    mn.set("rounds", ms.rounds);
                    if (ms.uid != null && !ms.uid.isEmpty()) {
                        mn.set("uid", ms.uid);
                    }
                }
            }

            ONode wmNode = root.getOrNew("watermarks").asObject();
            for (Map.Entry<String, Watermark> e : ledger.watermarks.entrySet()) {
                ONode n = wmNode.getOrNew(e.getKey()).asObject();
                n.set("ts", e.getValue().ts);
                n.set("size", e.getValue().size);
            }

            Path target = ledgerFile(ledger.month).toPath();
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(tmp, root.toJson().getBytes(StandardCharsets.UTF_8));
            try {
                Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            } catch (Throwable atomicFail) {
                // 个别文件系统不支持原子移动，退回普通替换
                Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            ledger.dirty = false;
            return true;
        } catch (Throwable e) {
            LOG.warn("[UsageArchive] write ledger failed for {}: {}", ledger.month, e.getMessage());
            return false;
        }
    }

    /**
     * 合并两个按天聚合（用于把多来源数据叠加到同一天）。
     *
     * @param base   目标（原地累加）
     * @param extra  待并入
     */
    public static void mergeDay(DayStat base, DayStat extra) {
        if (base == null || extra == null) {
            return;
        }
        base.messages += extra.messages;
        base.sessions.addAll(extra.sessions);
        for (Map.Entry<String, ModelStat> e : extra.models.entrySet()) {
            base.model(e.getKey()).add(e.getValue());
        }
    }
}
