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
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
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
 * 的会话文件，避免无谓 IO。水位按会话记在<b>当月</b>账本里；跨月的会话在新月账本中水位重新登记，
 * 但由于比对的是绝对时间戳，不会重复累加。</p>
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

    private final SessionLocator sessionLocator;
    /** 全局基准目录（通常为 AgentFlags.getHarnessBase()），不随项目工作区变化。 */
    private final String globalBase;

    /** 归档串行化：避免「打开统计页」与「启动静默归档」并发写同一账本 */
    private final Object archiveLock = new Object();

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
        synchronized (archiveLock) {
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
        synchronized (archiveLock) {
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

        for (SessionFile sf : targets) {
            try {
                archiveOne(sf, zone, ledgers);
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
    private void archiveOne(SessionFile sf, ZoneId zone, Map<String, MonthLedger> ledgers) {
        long fileSize = sf.stream.length();
        if (fileSize <= 0) {
            return;
        }

        // 以「当前月」账本承载该会话的水位（水位比对用绝对时间戳，跨月不会重复累加）
        String currentMonth = LocalDate.now(zone).format(MONTH_FMT);
        MonthLedger current = ledger(ledgers, currentMonth);
        Watermark wm = current.watermarks.get(sf.sid);
        long sinceTs = wm == null ? Long.MIN_VALUE : wm.ts;

        // 文件未增长且已归档过：直接跳过（省掉整轮 IO）
        if (wm != null && fileSize == wm.size) {
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
        return new File(usageDir(), "usage-" + month + ".json");
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

    /** 落盘月度账本（先写临时文件再原子替换，避免写一半损坏）。 */
    private void writeLedger(MonthLedger ledger) {
        try {
            File dir = usageDir();
            if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
                LOG.warn("[UsageArchive] cannot create usage dir: {}", dir);
                return;
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
        } catch (Throwable e) {
            LOG.warn("[UsageArchive] write ledger failed for {}: {}", ledger.month, e.getMessage());
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
