package com.gourdai.harness.talents.memory.md;

import com.gourdai.harness.talents.memory.MemorySearchResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 真实语料 smoke：在**复制出来的**真实记忆库上验证检索命中，而不是自建 fixture。
 *
 * <p>单元测试里的条目都是按预期行为捏出来的，只能证明「实现符合我的假设」，
 * 不能证明「命中不准」这个真实抱怨被解决了。这个类是唯一能回答后者的验证。
 *
 * <h2>为什么必须用副本</h2>
 * {@code MemoryMdData} 的构造函数会 {@code loadFromDisk}，其中对过期条目执行
 * {@code Files.deleteIfExists} —— 直接指向真实库会**静默删除**用户数据。
 * 因此本类只接受环境变量给出的目录，且约定它必须是副本。
 *
 * <h2>如何运行</h2>
 * <pre>
 *   Copy-Item "D:\work\gourd\gourdai\.gwork\memory\*.md" $env:TEMP\gwork-smoke-real
 *   $env:GWORK_SMOKE_DIR="$env:TEMP\gwork-smoke-real"
 *   mvn -o -pl gourd-ai-agent test -Dtest=MemoryRealCorpusSmokeTest
 * </pre>
 * 未设置 {@code GWORK_SMOKE_DIR} 时整个类跳过，常规构建不受影响。
 *
 * <h2>本类两轮返工换来的两条设计约束</h2>
 * 首轮用「自以为无关」的 query 和「按字符位置硬切」的标题 probe，失败了 2 条，
 * 取证后确认都是测试自身的问题，且反证实现是对的：
 * <ol>
 *   <li><b>反例 query 的每个 token 必须先验证在语料中零命中。</b>
 *       {@code kubernetes ingress controller} 里的 {@code controller} 真实存在于
 *       30 个文件；{@code zzzqqqxxx_not_a_real_token} 被 {@code _} 切成
 *       {@code not}(29)/{@code real}(2)/{@code token}(29)。多词 query 部分命中即返回
 *       结果，这正是 P0-2 要的行为，不是精确率崩塌。</li>
 *   <li><b>probe 必须是完整词，不能跨词边界切片。</b>
 *       从 {@code gourd-work} 切出的 {@code d-wo} 分词后只剩 {@code wo}，而
 *       {@code wo} 出现在 154/190 个文件里，是零区分度的噪声 token；它在
 *       limit=190 下确实能召回自己，只是排序靠后。</li>
 * </ol>
 */
@EnabledIfEnvironmentVariable(named = "GWORK_SMOKE_DIR", matches = ".+")
class MemoryRealCorpusSmokeTest {

    private static final String USER = "shared";

    /**
     * 跨内核判定交接文件名，须与 Rust 侧
     * {@code memory::real_corpus_tests::VERDICTS_FILE} 保持一致。
     */
    private static final String VERDICTS_FILE = "kernel-verdicts.txt";

    /** 首轮失败条目的 key，作为「完整词 vs 碎片」对照的固定样本。 */
    private static final String FRAGMENT_VICTIM =
            "gourdwork_rust_five_usability_defects_maxturns_steer_stop_subagent_compression";

    private Path corpus() {
        Path dir = Path.of(System.getenv("GWORK_SMOKE_DIR"));
        assertTrue(Files.isDirectory(dir), "GWORK_SMOKE_DIR must be a directory: " + dir);
        return dir;
    }

    private MemoryMdData open() {
        return new MemoryMdData(corpus());
    }

    private long mdCount() throws Exception {
        try (Stream<Path> s = Files.list(corpus())) {
            return s.filter(p -> p.getFileName().toString().endsWith(".md")).count();
        }
    }

    private List<MemorySearchResult> all(MemoryMdData data) {
        return data.listAll(USER, Integer.MAX_VALUE);
    }

    private boolean recalls(MemoryMdData data, String key, String query, int limit) {
        return data.search(USER, query, limit).stream().anyMatch(r -> r.getKey().equals(key));
    }

    /**
     * 前置校验：语料真的有内容，且索引条目数等于磁盘文件数。
     * 否则后面所有「命中」断言都是在空库上假绿。
     *
     * <h3>顺序要紧：先 open() 再数文件</h3>
     * 构造函数里的 {@code loadFromDisk} 会对过期条目执行 {@code deleteIfExists}。
     * 若先数文件再 open()，就与时钟赛跑：Rust 侧的同名测试已真实失败过一次 ——
     * 一条 TTL=30 天的条目在「数文件」与「load」之间到期被删，断言拿 191 比 190，
     * 而实现完全正确。先 open() 把过期删除结清，再数文件，比较就不会漂。
     */
    @Test
    void corpusIsFullyIndexed() throws Exception {
        // 先构造，结清过期删除；再取磁盘文件数做比较。
        MemoryMdData data = open();
        long n = mdCount();
        assertTrue(n > 50, "expected a real corpus (>50 entries), got " + n);
        assertEquals(n, data.count(USER),
                "索引条目数必须等于磁盘文件数，否则有文件被静默跳过");
    }

    /**
     * 截图失败②的原型：多词中英混合 query 必须命中，而不是被当作一整个子串。
     *
     * <p>旧实现把整句当一个子串匹配，数学上不可能命中任何条目，模型据此认为
     * 「没存过」并写入重复条目。这里同时断言 top1 与 query 相关 —— 否则
     * 「返回了非空结果」也可能只是把噪声塞了进来。
     */
    @Test
    void multiWordMixedScriptQueryFindsRelevantEntries() {
        MemoryMdData data = open();
        String query = "codereview 变异测试 护栏 P0 修复";
        List<MemorySearchResult> hits = data.search(USER, query, 10);
        assertFalse(hits.isEmpty(), "多词混合 query 在真实库上不应为空: " + query);

        MemorySearchResult top = hits.get(0);
        String hay = (top.getKey() + " " + top.getTitle() + " " + top.getContent()).toLowerCase();
        assertTrue(hay.contains("codereview") || hay.contains("变异") || hay.contains("护栏"),
                "top1 必须与 query 相关，实际: " + top.getKey() + " / " + top.getTitle());
    }

    /**
     * 核心判据：标题里的**连续中文词**必须能召回自己。
     *
     * <p>这是「存过却搜不到」这个原始抱怨最核心的场景 —— 旧索引只收 content 的
     * 分词，标题词从未进入索引。取每条标题的完整 CJK 片段（不跨词边界切片）
     * 逐一验证。
     */
    @Test
    void completeChinesePhrasesFromTitleRecallTheirOwnEntry() {
        MemoryMdData data = open();
        int checked = 0;
        for (MemorySearchResult e : all(data)) {
            String probe = firstCjkPhrase(e.getTitle(), 3);
            if (probe == null) continue;
            assertTrue(recalls(data, e.getKey(), probe, 20),
                    "标题中的连续中文词「" + probe + "」必须能召回自己: " + e.getKey()
                            + " / " + e.getTitle());
            if (++checked >= 30) break;
        }
        assertTrue(checked > 0, "至少应校验若干条标题中文词召回");
    }

    /**
     * 核心判据：key 的**完整长片段**必须能召回自己。
     *
     * <p>记忆 key 是最强的识别信号，旧索引完全不含 key。只取长度 ≥8 的完整
     * 片段，避免高频短词把榜单占满导致区分度为零。
     */
    @Test
    void completeKeyFragmentsRecallTheirOwnEntry() {
        MemoryMdData data = open();
        int checked = 0;
        for (MemorySearchResult e : all(data)) {
            String probe = firstLongKeySegment(e.getKey(), 8);
            if (probe == null) continue;
            assertTrue(recalls(data, e.getKey(), probe, 20),
                    "key 完整片段「" + probe + "」必须能召回自己: " + e.getKey());
            if (++checked >= 30) break;
        }
        assertTrue(checked > 0, "至少应校验若干条 key 片段召回");
    }

    /**
     * 碎片 probe 的对照实验：跨词边界切片得到的高频噪声 token 不是漏检，
     * 只是排序靠后。放大 limit 必须能召回 —— 证明条目一直在候选集里。
     *
     * <p>没有这条，上面两条「完整词能召回」的通过就可能被误读为
     * 「只有完整词能召回，碎片一律丢失」。
     */
    @Test
    void noisyFragmentProbeIsARankingIssueNotAMiss() {
        MemoryMdData data = open();
        // "d-wo" 来自 "gourd-work"，分词后只剩 "wo"（单字符 run 与连字符都不进索引）。
        assertFalse(recalls(data, FRAGMENT_VICTIM, "d-wo", 20),
                "首轮现象应可复现：零区分度碎片在 limit=20 内召不回");
        assertTrue(recalls(data, FRAGMENT_VICTIM, "d-wo", 190),
                "放大 limit 必须召回 —— 证明是排序靠后，不是漏检");

        // 同一条目，换成完整词就不需要放大 limit。
        assertTrue(recalls(data, FRAGMENT_VICTIM, "gourd-work", 20), "完整英文词必须能召回");
        for (String probe : List.of("maxturns", "subagent")) {
            assertTrue(recalls(data, FRAGMENT_VICTIM, probe, 20),
                    "key 完整片段「" + probe + "」必须能召回");
        }
    }

    /**
     * 精确率护栏：**每个 token 都零命中**的 query 必须返回空。
     *
     * <p>三域扩召回最容易踩的坑是把检索变成「什么都命中」。召回率提升不能以
     * 精确率崩塌为代价 —— 否则注入给模型的记忆全是噪声，反而更费上下文。
     *
     * <h3>为什么反例词必须在运行时派生，不能硬编码</h3>
     * 本测试原先写死 {@code zzzqqqxxx} 作为「语料中不存在的词」，并因此失败过一次：
     * 那个词是我在写这批测试时随手造的哨兵，随后又被 {@code memory_extract} 当作
     * 经验记录**写进了同一个记忆库**，于是它从「零命中」变成了「1 个文件命中」。
     * 只要反例词是常量，它就迟早会被库内容追上 —— 记忆库是活的数据，不是 fixture。
     *
     * <p>所以这里改为运行时在语料上实测：随机加长度的候选串逐个验证「全库零命中」，
     * 只有实测为零命中的才允许当反例。判据因此对库内容免疫，不会再被自己污染。
     */
    @Test
    void queriesWhoseTokensAreAllAbsentReturnNothing() throws Exception {
        MemoryMdData data = open();

        // 运行时派生：找一个在当前语料中确实零命中的词，而不是假设某个词不存在。
        String absent = findTermAbsentFromCorpus();
        assertNotNull(absent, "应能在语料中派生出一个零命中的反例词");

        assertTrue(data.search(USER, absent, 20).isEmpty(),
                "实测零命中的词不应被检索命中: " + absent);
        // 多词：全部 token 均由实测零命中的词构成。
        assertTrue(data.search(USER, absent + " " + findSecondTermAbsentFromCorpus(absent), 20).isEmpty(),
                "全部 token 均零命中的多词 query 必须返回空");

        // 反向断言：语料中真实存在的词必须命中，否则上面的「返回空」可能只是
        // 检索整体坏掉（什么都搜不到）造成的假绿。
        String present = findTermPresentInCorpus();
        assertFalse(data.search(USER, present, 20).isEmpty(),
                "语料中真实存在的词必须命中: " + present);
    }

    /** 在语料中真实存在的英文词（用于反向断言，防止「检索整体失效」被误判为精确率达标）。 */
    private String findTermPresentInCorpus() throws Exception {
        Map<String, Integer> freq = new LinkedHashMap<>();
        for (Path p : mdFiles()) {
            for (String w : words(Files.readString(p, StandardCharsets.UTF_8))) {
                freq.merge(w, 1, Integer::sum);
            }
        }
        // 取中频词：太高频（如 "the"）区分度为零，太低频可能是噪声。
        return freq.entrySet().stream()
                .filter(e -> e.getValue() >= 10 && e.getValue() <= 200)
                .map(Map.Entry::getKey)
                .findFirst()
                .orElseThrow(() -> new AssertionError("语料中找不到中频英文词，无法做反向断言"));
    }

    private static final Pattern WORD = Pattern.compile("[a-z]{6,12}");

    private List<String> words(String text) {
        List<String> out = new ArrayList<>();
        var m = WORD.matcher(text.toLowerCase());
        while (m.find()) out.add(m.group());
        return out;
    }

    private List<Path> mdFiles() throws Exception {
        try (Stream<Path> s = Files.list(corpus())) {
            return s.filter(p -> p.getFileName().toString().endsWith(".md")).sorted().toList();
        }
    }

    /** 语料全文拼接一次，供零命中判定复用。 */
    private String corpusText() throws Exception {
        StringBuilder sb = new StringBuilder();
        for (Path p : mdFiles()) sb.append(Files.readString(p, StandardCharsets.UTF_8)).append('\n');
        return sb.toString().toLowerCase();
    }

    /**
     * 派生一个在当前语料中零命中的词。
     *
     * <p>用「语料里不存在的字母组合」而非随机串：随机串可能碰巧撞上库内容，
     * 那就又变成一次假反例。这里显式实测，命中即换下一个。
     */
    private String findTermAbsentFromCorpus() throws Exception {
        String hay = corpusText();
        for (String cand : List.of("kubernetes", "terraform", "ansible", "zzqwkxfj", "qmvzbrtl")) {
            if (!hay.contains(cand)) return cand;
        }
        return null;
    }

    /** 派生第二个零命中词，且必须与第一个不同，保证多词 query 真的是「两个都不存在」。 */
    private String findSecondTermAbsentFromCorpus(String first) throws Exception {
        String hay = corpusText();
        for (String cand : List.of("zzqwkxfj", "qmvzbrtl", "hxpwzndk", "vbqrjtsm")) {
            if (!cand.equals(first) && !hay.contains(cand)) return cand;
        }
        throw new AssertionError("无法派生第二个零命中词");
    }

    /**
     * 跨内核交接：把本内核在真实语料上的**实测**判定写给 Rust 侧比对。
     *
     * <p>Rust 的 {@code hit_miss_verdict_agrees_with_the_java_kernel} 原先把期望值
     * 硬编码成一张 {@code Vec<(&str, bool)>}，注释写着「取自 MemoryRealCorpusSmokeTest」，
     * 断言消息里还打印 {@code java={}} —— 但那个值来自常量，Java 内核**从未被调用**。
     * 它结构上不可能因内核分歧而失败，只是在拿 Rust 对照我对 Rust 的笔记，却让我
     * 得出了「双内核逐条一致」的结论。
     *
     * <p>现在判定由本测试实际跑出并落盘，Rust 读取后逐条比对；文件不存在时 Rust 侧
     * **显式跳过并打印**，而不是静默 return 冒充通过。
     *
     * <p>文件写在语料副本目录内（两侧已通过 {@code GWORK_SMOKE_DIR} 约定同一目录），
     * 不落在任何构建产物树里，避免第二套路径约定需要同步维护。
     */
    @Test
    void writesKernelVerdictsForTheRustCounterpart() throws Exception {
        MemoryMdData data = open();

        // 正反例都要覆盖：只有正例时，「检索整体坏掉」也会判为一致。
        List<String> queries = new ArrayList<>(List.of(
                "codereview 变异测试 护栏 P0 修复",
                "rust 内核 修复",
                "gourd-work",
                "maxturns",
                "subagent",
                "controller"));
        // 反例同样运行时派生，理由见 queriesWhoseTokensAreAllAbsentReturnNothing。
        String absent = findTermAbsentFromCorpus();
        assertNotNull(absent, "应能派生零命中反例词");
        queries.add(absent);
        queries.add(absent + " " + findSecondTermAbsentFromCorpus(absent));

        StringBuilder sb = new StringBuilder();
        sb.append("# kernel verdicts written by MemoryRealCorpusSmokeTest (Java)\n");
        sb.append("# format: <HIT|MISS>\\t<query>; limit=20\n");
        int hits = 0;
        for (String q : queries) {
            boolean hit = !data.search(USER, q, 20).isEmpty();
            if (hit) hits++;
            sb.append(hit ? "HIT" : "MISS").append('\t').append(q).append('\n');
        }

        Path out = corpus().resolve(VERDICTS_FILE);
        Files.writeString(out, sb.toString(), StandardCharsets.UTF_8);

        // 防退化：若全部 MISS 或全部 HIT，这份文件对 Rust 侧几乎没有判别力
        // （一侧全错也能对上大半），说明 query 选取失效而不是内核一致。
        assertTrue(hits > 0 && hits < queries.size(),
                "verdict 集必须同时含命中与落空，否则无判别力: hits=" + hits + "/" + queries.size());
        assertTrue(Files.size(out) > 0, "verdicts 文件不应为空");
    }

    /**
     * 精确 key 直取：库里每个 key 都必须能被 {@code get} 取回。
     *
     * <p>这是截图失败①的对照组 —— 那条 key 在库里根本不存在，所以正确行为就是
     * 报错；但**存在的** key 绝不能报 not found。
     */
    @Test
    void everyStoredKeyIsRecallable() {
        MemoryMdData data = open();
        List<MemorySearchResult> entries = all(data);
        assertFalse(entries.isEmpty());
        for (MemorySearchResult e : entries) {
            assertNotNull(data.get(USER, e.getKey()),
                    "已存在的 key 必须可精确取回: " + e.getKey());
        }
    }

    /**
     * 检索排序必须跨调用稳定：真实库 190 条，同分碰撞概率高。
     * 若排序随 HashMap 遍历顺序漂移，模型会看到记忆自己在动。
     */
    @Test
    void rankingIsStableAcrossCalls() {
        MemoryMdData data = open();
        String query = "rust 内核 修复";
        List<String> first = keys(data.search(USER, query, 10));
        for (int i = 0; i < 5; i++) {
            assertEquals(first, keys(data.search(USER, query, 10)), "同 query 排序必须稳定");
        }
    }

    /**
     * 多词 query 中，命中词更多的条目应排在前面。
     *
     * <p>否则「搜到了」和「搜对了」无法区分 —— 这正是用户抱怨的「命中不准」。
     */
    @Test
    void entriesMatchingMoreQueryTermsRankFirst() {
        MemoryMdData data = open();
        List<MemorySearchResult> hits = data.search(USER, "rust 内核 子代理 模型继承", 10);
        assertFalse(hits.isEmpty());
        // top1 的标题+key+正文里，query 的 CJK 片段命中数不应少于榜单中任意条目。
        int topHits = countQueryTermHits(hits.get(0), List.of("rust", "内核", "子代理", "模型继承"));
        for (MemorySearchResult r : hits) {
            assertTrue(topHits >= countQueryTermHits(r, List.of("rust", "内核", "子代理", "模型继承")),
                    "top1 命中词数必须不少于其他条目: top=" + hits.get(0).getKey()
                            + " 其他=" + r.getKey());
        }
    }

    // ==================== 辅助方法 ====================

    private List<String> keys(List<MemorySearchResult> rs) {
        List<String> out = new ArrayList<>(rs.size());
        for (MemorySearchResult r : rs) out.add(r.getKey());
        return out;
    }

    private int countQueryTermHits(MemorySearchResult r, List<String> terms) {
        String hay = (r.getKey() + " " + r.getTitle() + " " + r.getContent()).toLowerCase();
        int n = 0;
        for (String t : terms) if (hay.contains(t.toLowerCase())) n++;
        return n;
    }

    /**
     * 取标题中第一段长度 ≥{@code minLen} 的**连续 CJK 片段**。
     *
     * <p>不按字符位置切片：跨词边界切出来的碎片（如 {@code gourd-work} → {@code d-wo}）
     * 分词后可能只剩一个零区分度的高频 token，测不出任何检索质量。
     */
    private String firstCjkPhrase(String title, int minLen) {
        if (title == null) return null;
        StringBuilder run = new StringBuilder();
        for (int i = 0; i < title.length(); i++) {
            char c = title.charAt(i);
            if (c >= '\u4e00' && c <= '\u9fff') {
                run.append(c);
            } else {
                if (run.length() >= minLen) return run.toString();
                run.setLength(0);
            }
        }
        return run.length() >= minLen ? run.toString() : null;
    }

    /** 取 key 中第一个长度 ≥{@code minLen} 的完整下划线片段。 */
    private String firstLongKeySegment(String key, int minLen) {
        if (key == null) return null;
        for (String part : key.split("_")) {
            if (part.length() >= minLen) return part;
        }
        return null;
    }
}
