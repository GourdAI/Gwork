package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * 「消息加载不出来 / 正文被误标截断」两个缺陷的回归锚点。
 *
 * <p>这两条都是自审期间由临时探针实锤、而既有用例一个都抓不住的盲区：
 * {@code SessionStreamStoreRoundPagingTest} 的样本只有 6 行，环形缓冲压根不会绕回；
 * {@code SessionStreamStoreBatchTest} 只断言了「单条巨型事件应当被截断」的合法场景，
 * 从未验证「正常流式正文不该被截断」的反面。把修复回退掉那些用例照样全绿，
 * 等于没有防线。</p>
 */
class SessionStreamStoreLoadRegressionTest {

    /**
     * 缺陷#3：响应预算计量器按「最坏 3 字节/字符」估算，使纯 ASCII 内容（代码、路径、
     * JSON、英文叙述——占会话绝大多数）只能用掉 1/3 预算。
     *
     * <p>后果不是「更安全」而是用户每页只拿到三分之一的内容：真实 125MB 会话（懒压缩后
     * 2191 行，整个文件都装得进 4000 行扫描窗口）实测要翻 <b>176 页</b>，
     * 单页真实序列化只有 32~38KB 就被判定占满 96KB。这就是用户报的「每次只加载一点点，
     * 我要一直拉一直拉」。</p>
     */
    @Test
    void asciiPayloadMustNotBeOverchargedByBudgetEstimator() throws Exception {
        Path workspace = Files.createTempDirectory("stream-budget-ascii");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-ascii";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);

            // 20 条 × 4000 字符纯 ASCII 正文 = 真实 80,000 字节；加固定开销 20×512=10,240
            // → 新口径估算 ≈ 90KB < 96KB 预算，全部装得下。
            // 旧口径：80,000×3 + 10,240 = 250KB → 被切成 3 页以上。
            // （故意用长正文而非多条短事件：让 512 字节/条的固定开销占比可忽略，
            //   本用例才是在测「正文计长口径」而非「开销常量」。）
            StringBuilder sb = new StringBuilder();
            sb.append("{\"type\":\"user\",\"text\":\"u1\",\"eventSeq\":1}\n");
            for (int s = 2; s <= 21; s++) {
                sb.append("{\"type\":\"action_end\",\"runId\":\"r").append(s)
                        .append("\",\"text\":\"").append("a".repeat(4000))
                        .append("\",\"eventSeq\":").append(s).append("}\n");
            }
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX), sb.toString());

            SessionStreamStore.LoadResult p1 = store.loadRounds(sid, null, null, 5);
            // 新口径下总量 ~90KB < 96KB：必须一页返回全部 21 条。
            // 旧口径下正文被估成 3 倍，这里只会返回 7 条左右并报 hasMore=true。
            Assertions.assertEquals(21, p1.events.size(),
                    "纯 ASCII 正文的真实体积远低于预算，不得被 3 倍估算提前截断，实际只返回 "
                            + p1.events.size() + " 条");
            Assertions.assertFalse(p1.hasMore, "全部内容已在本页，hasMore 必须为假");
        } finally {
            delete(workspace);
        }
    }

    /** 须 &gt; MAX_PAGE_LINES(4000)+1，否则环形缓冲不绕回、缺陷不显形。取 12000 与事故现场同量级。 */
    private static final int TOTAL_LINES = 12000;

    /** 与主源码 PREVIEW_CHARS / DELTA_FLUSH_CHARS 对齐（二者刻意相等）。 */
    private static final int PREVIEW_CHARS = 32 * 1024;

    /**
     * 缺陷#1：{@code scanForPage} 的环形槽位在游标命中后仍继续写入，窗口起点
     * {@code ws = endLine - MAX_PAGE_LINES} 的偏移会被第 {@code ws + cap} 行覆盖成一个
     * 远在游标<b>之后</b>的位置 —— 第二遍 seek 于是跳到游标后方，向上翻页反而取回更新的
     * 内容，firstSeq 不降反升，前端永远翻不完。
     *
     * <p>触发条件是「文件行数超过环容量(4001)」且「游标不在末行」，与轮数无关。</p>
     */
    @Test
    void upwardPagingNeverCrossesCursorOnLargeFile() throws Exception {
        Path workspace = Files.createTempDirectory("stream-scan-ring");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-long-run";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);

            // 单轮长任务：仅首行是 user 边界，窗口内无边界可吸附 —— 与事故现场同形。
            // 多轮样本（每页按轮吸附）绕不到出问题的槽位，抓不住本缺陷。
            StringBuilder sb = new StringBuilder();
            sb.append("{\"type\":\"user\",\"text\":\"u1\",\"eventSeq\":1}\n");
            for (int s = 2; s <= TOTAL_LINES; s++) {
                sb.append("{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"e").append(s)
                        .append("\",\"eventSeq\":").append(s).append("}\n");
            }
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX), sb.toString());

            SessionStreamStore.LoadResult p1 = store.loadRounds(sid, null, null, 5);
            Assertions.assertTrue(p1.hasMore, "12000 行远超单页容量，前面必定还有内容");

            SessionStreamStore.LoadResult p2 = store.loadRounds(sid, null, p1.firstSeq, 5);
            SessionStreamStore.LoadResult p3 = store.loadRounds(sid, null, p2.firstSeq, 5);

            // 核心不变量：向上翻页拿回的内容必须严格早于游标。
            // 缺陷版本这里会取回游标之后的更新内容。
            Assertions.assertTrue(p2.lastSeq < p1.firstSeq,
                    "第二页内容必须严格早于游标 " + p1.firstSeq + "，实际 lastSeq=" + p2.lastSeq);
            Assertions.assertTrue(p3.lastSeq < p2.firstSeq,
                    "第三页内容必须严格早于游标 " + p2.firstSeq + "，实际 lastSeq=" + p3.lastSeq);

            // 游标单调收敛（缺陷版本 firstSeq 不降反升：11816 → 11817 → 11818）
            Assertions.assertTrue(p1.firstSeq > p2.firstSeq && p2.firstSeq > p3.firstSeq,
                    "游标必须单调收敛，实际 " + p1.firstSeq + " → " + p2.firstSeq + " → " + p3.firstSeq);
            // 第二页须真正推进整页而非个位数条目（第三页已收敛到文件头，不适用此断言）
            Assertions.assertTrue(p1.firstSeq - p2.firstSeq > 100,
                    "第二页应推进整页，实际推进 " + (p1.firstSeq - p2.firstSeq));
        } finally {
            delete(workspace);
        }
    }

    /**
     * 缺陷#2：{@code offerDelta} 曾「先追加再判 buf &gt;= 阈值」，落盘行长度必定落在
     * {@code [DELTA_FLUSH_CHARS, DELTA_FLUSH_CHARS + 末帧长度)}，而
     * {@code DELTA_FLUSH_CHARS == PREVIEW_CHARS} —— 每个攒满的桶都恰好越过预览阈值一点点，
     * 回放时被当成「超长工具结果」截掉并标 truncated，长回答显示不全。
     *
     * <p>断言落在<b>磁盘行</b>上：offerDelta 是写侧逻辑，落盘文本长度才是它的直接产物。
     * 读侧另有 96KB 响应字节预算会合法分页（满桶按最坏 3 字节/字符估算恰好吃满预算），
     * 那是另一回事，不可与截断语义混为一谈。</p>
     */
    @Test
    void longStreamedBodyIsNeverMarkedTruncated() throws Exception {
        Path workspace = Files.createTempDirectory("stream-delta-truncate");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-long-answer";

            String piece = "x".repeat(100);
            store.recordUser(sid, null, "go", 1L);
            for (int i = 0; i < 400; i++) {
                WebChunk chunk = WebChunk.ofText(piece);
                chunk.setRunId("run-1");
                store.record(sid, null, chunk);
            }
            store.flush(sid, null);

            Path file = locator.resolveDir(sid, null).toPath().resolve(sid + SessionStreamStore.STREAM_SUFFIX);
            List<String> lines = Files.readAllLines(file);

            // 写侧不变量：任何一条落盘行的正文都不得越过预览阈值，否则回放必被误标截断
            int diskTotal = 0;
            for (int i = 0; i < lines.size(); i++) {
                Map bean = ONode.ofJson(lines.get(i).trim()).toBean(Map.class);
                if (!"text".equals(String.valueOf(bean.get("type")))) continue;
                int len = String.valueOf(bean.get("text")).length();
                diskTotal += len;
                Assertions.assertTrue(len <= PREVIEW_CHARS,
                        "落盘行 " + i + " 正文 " + len + " 字符已越过预览阈值 " + PREVIEW_CHARS
                                + "，回放时会被误标截断");
            }
            Assertions.assertEquals(40000, diskTotal, "攒批落盘不得丢字");

            // 读侧：正常流式正文不得带截断标记（对照 BatchTest 中单条巨型事件必须 truncated=true）
            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 2000);
            for (Map e : loaded.events) {
                Assertions.assertNull(e.get("truncated"),
                        "正常流式正文不得被标记截断，越界事件 type=" + e.get("type")
                                + " len=" + String.valueOf(e.get("text")).length());
            }
        } finally {
            delete(workspace);
        }
    }

    private static void delete(Path path) throws Exception {
        if (Files.exists(path)) {
            Files.walk(path).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
