package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 批次 A 的落盘架构改造回归：写侧 delta 合并（A2）、loadAfter 合并（A3）、
 * 响应体字节预算（A4）、懒压缩（A5）与旧格式兼容。
 *
 * <p>核心断言口径是「内容等价」而非「行数相等」：改造后磁盘行数必然变少，
 * 但把各事件的 text 按顺序拼起来必须与逐条写入完全一致——这是本批次不可退让的底线。</p>
 */
class SessionStreamStoreBatchTest {

    /** A2：写侧合并后读回的文本与逐条写入完全等价，且磁盘行数显著减少。 */
    @Test
    void mergedWritesAreContentEquivalentToPerFrameWrites() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-merge");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-merge";

            StringBuilder expected = new StringBuilder();
            store.recordUser(sid, null, "go", 1L);
            for (int i = 0; i < 500; i++) {
                String piece = "t" + i;
                expected.append(piece);
                WebChunk chunk = WebChunk.ofText(piece);
                chunk.setRunId("run-1");
                store.record(sid, null, chunk);
            }
            store.flush(sid, null);

            Path streamFile = locator.resolveDir(sid, null).toPath().resolve(sid + SessionStreamStore.STREAM_SUFFIX);
            long lines = Files.readAllLines(streamFile).stream().filter(l -> !l.trim().isEmpty()).count();
            Assertions.assertTrue(lines < 500, "写侧合并后行数应远小于帧数，实际 " + lines);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 2000);
            Assertions.assertEquals(expected.toString(), concatText(loaded.events, "text"),
                    "合并落盘后读回的正文必须与逐条写入完全等价");
        } finally {
            delete(workspace);
        }
    }

    /** A2：类型/归属切换必须强制断开攒批，事件时序绝不能错乱。 */
    @Test
    void ownerSwitchBreaksBatchAndKeepsOrder() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-order");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-order";

            store.record(sid, null, text("run-1", "A1"));
            store.record(sid, null, reason("run-1", "R1"));
            store.record(sid, null, text("run-1", "A2"));
            WebChunk action = WebChunk.ofActionStart("read", "read", Map.of("file_path", "a.txt"));
            action.setRunId("run-1");
            store.record(sid, null, action);
            store.record(sid, null, text("run-1", "A3"));
            store.record(sid, null, text("run-2", "B1"));
            store.flush(sid, null);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 2000);
            List<String> types = new ArrayList<>();
            for (Map e : loaded.events) types.add(String.valueOf(e.get("type")));
            Assertions.assertEquals(List.of("text", "reason", "text", "action_start", "text", "text"), types,
                    "类型切换必须断开合并，时序不得串位");
            Assertions.assertEquals("A1", loaded.events.get(0).get("text"));
            Assertions.assertEquals("R1", loaded.events.get(1).get("text"));
            Assertions.assertEquals("A2", loaded.events.get(2).get("text"));
            Assertions.assertEquals("A3", loaded.events.get(4).get("text"));
            Assertions.assertEquals("B1", loaded.events.get(5).get("text"));
        } finally {
            delete(workspace);
        }
    }

    /** A2：flush 后立刻读取，必须能看到攒批中尚未达阈值的数据。 */
    @Test
    void flushMakesPendingBatchVisibleImmediately() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-flush");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-flush";

            store.record(sid, null, text("run-1", "hello"));
            store.flush(sid, null);

            Path streamFile = locator.resolveDir(sid, null).toPath().resolve(sid + SessionStreamStore.STREAM_SUFFIX);
            Assertions.assertTrue(Files.exists(streamFile), "flush 后文件必须已存在");
            Assertions.assertTrue(Files.readString(streamFile).contains("hello"), "flush 后磁盘必须能看到攒批数据");

            // 未显式 flush 时，load* 入口也必须自行冲刷（这是回放正确性的硬保证）
            store.record(sid, null, text("run-1", "-world"));
            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 100);
            Assertions.assertEquals("hello-world", concatText(loaded.events, "text"),
                    "读取入口必须先冲刷攒批缓冲");
        } finally {
            delete(workspace);
        }
    }

    /** A2/A3：断线点落在合并组中间时，绝不能重复回放已渲染过的文本。 */
    @Test
    void loadAfterSkipsBoundaryGroupInsteadOfDuplicatingText() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-boundary");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-boundary";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            // 手工构造一条 [2,5] 的合并行，模拟前端已收到 seq=3 后断线
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    "{\"type\":\"user\",\"text\":\"q\",\"eventSeq\":1}\n"
                            + "{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"abcd\",\"eventSeq\":5,\"seqFrom\":2}\n"
                            + "{\"type\":\"done\",\"eventSeq\":6}\n");

            SessionStreamStore.LoadResult mid = store.loadAfter(sid, null, 3L, 100);
            for (Map e : mid.events) {
                Assertions.assertNotEquals("text", String.valueOf(e.get("type")),
                        "跨游标的边界组必须整组跳过，不得重复渲染已显示文本");
            }
            Assertions.assertEquals(6L, mid.latestSeq, "跳过边界组不得丢失 latestSeq 游标");

            // 游标在组左端之前：整组是新内容，必须完整返回
            SessionStreamStore.LoadResult full = store.loadAfter(sid, null, 1L, 100);
            Assertions.assertEquals("abcd", concatText(full.events, "text"));
        } finally {
            delete(workspace);
        }
    }

    /** A4：响应体字节预算生效，且至少返回一条（超大单条不得导致永远返回空）。 */
    @Test
    void responseBudgetTruncatesButAlwaysReturnsAtLeastOne() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-budget");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-budget";

            // 20 条各 16K 字符的工具结果（不参与合并），远超 96KB 预算
            String blob = "x".repeat(16 * 1024);
            for (int i = 0; i < 20; i++) {
                WebChunk end = WebChunk.ofActionEnd(blob);
                end.setRunId("run-" + i);
                store.record(sid, null, end);
            }
            store.flush(sid, null);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 2000);
            Assertions.assertFalse(loaded.events.isEmpty(), "必须至少返回一条事件");
            Assertions.assertTrue(loaded.events.size() < 20, "超预算时必须截断，实际 " + loaded.events.size());
            Assertions.assertTrue(loaded.hasMore, "截断后必须置 hasMore 保持分页可继续");

            int bytes = 0;
            for (Map e : loaded.events) {
                Object t = e.get("text");
                bytes += t instanceof String ? ((String) t).getBytes("UTF-8").length : 0;
            }
            Assertions.assertTrue(bytes < 130 * 1024,
                    "响应体必须远低于 smart-socket 的 ~130KB 栈溢出阈值，实际 " + bytes);
        } finally {
            delete(workspace);
        }
    }

    /** A4 自审修复：loadWithMeta 的预算截断必须保留<b>尾部</b>（最新事件）。
     *  该入口语义是「会话快照 = 最近 tail 条」：前端初始加载/断线重连都从响应尾部
     *  续接实时流。若保头丢尾，用户打开会话只看到最旧一页、最新回复整段消失，
     *  且该入口没有向前补页的游标，丢失不可恢复。 */
    @Test
    void loadWithMetaBudgetTruncationKeepsNewestEvents() throws Exception {
        Path workspace = Files.createTempDirectory("stream-budget-tail");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-budget-tail";

            String pad = "x".repeat(16 * 1024);
            for (int i = 0; i < 20; i++) {
                WebChunk end = WebChunk.ofActionEnd(pad + "#m" + i);
                end.setRunId("run-" + i);
                store.record(sid, null, end);
            }
            store.flush(sid, null);

            SessionStreamStore.LoadResult loaded = store.loadWithMeta(sid, null, null);
            Assertions.assertFalse(loaded.events.isEmpty(), "必须至少返回一条事件");
            Assertions.assertTrue(loaded.events.size() < 20, "超预算时必须截断，实际 " + loaded.events.size());
            Assertions.assertTrue(loaded.hasMore, "截断后必须置 hasMore");
            String lastText = tail4(loaded.events.get(loaded.events.size() - 1));
            Assertions.assertTrue(lastText.endsWith("#m19"),
                    "必须保留最新事件（尾部），实际尾=" + lastText);
            String firstText = tail4(loaded.events.get(0));
            Assertions.assertFalse(firstText.endsWith("#m0"),
                    "最旧事件应是被截断丢弃的一侧，实际首=" + firstText);

            // tail 分支同口径：tail=5 再按预算截断，尾部仍必须是最新事件
            SessionStreamStore.LoadResult tailed = store.loadWithMeta(sid, null, 5);
            Assertions.assertTrue(tail4(tailed.events.get(tailed.events.size() - 1)).endsWith("#m19"),
                    "tail 分支的尾部同样必须是最新事件");
        } finally {
            delete(workspace);
        }
    }

    private static String tail4(Map event) {
        String t = String.valueOf(event.get("text"));
        return t.substring(Math.max(0, t.length() - 4));
    }

    /** A4：单条超大事件也必须返回（且已被预览截断到安全体积）。 */
    @Test
    void singleHugeEventIsStillReturned() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-huge");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-huge";

            WebChunk end = WebChunk.ofActionEnd("y".repeat(600 * 1024));
            end.setRunId("run-1");
            store.record(sid, null, end);
            store.flush(sid, null);

            SessionStreamStore.LoadResult loaded = store.loadAfter(sid, null, 0L, 2000);
            Assertions.assertEquals(1, loaded.events.size(), "单条超大事件必须被返回，否则前端无限重试");
            Map only = loaded.events.get(0);
            Assertions.assertEquals(Boolean.TRUE, only.get("truncated"));
            int bytes = ((String) only.get("text")).getBytes("UTF-8").length;
            Assertions.assertTrue(bytes < 130 * 1024, "截断后仍须低于栈溢出阈值，实际 " + bytes);
        } finally {
            delete(workspace);
        }
    }

    /** A5：懒压缩信息无损、幂等，且压缩前后 loadRounds 结果等价。 */
    @Test
    void compactionIsLosslessIdempotentAndPreservesRounds() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-compact");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-compact";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            Path streamFile = sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX);

            // 造一个旧格式（逐条落盘、无 seqFrom）历史文件：3 轮，每轮 300 条增量 + 1 张工具卡
            List<String> raw = new ArrayList<>();
            long seq = 0;
            StringBuilder expected = new StringBuilder();
            for (int round = 1; round <= 3; round++) {
                raw.add("{\"type\":\"user\",\"text\":\"u" + round + "\",\"eventSeq\":" + (++seq) + "}");
                for (int i = 0; i < 300; i++) {
                    String piece = "r" + round + "-" + i;
                    expected.append(piece);
                    raw.add("{\"type\":\"text\",\"runId\":\"run" + round + "\",\"text\":\"" + piece
                            + "\",\"eventSeq\":" + (++seq) + "}");
                }
                raw.add("{\"type\":\"action_end\",\"runId\":\"run" + round + "\",\"text\":\"ok"
                        + round + "\",\"eventSeq\":" + (++seq) + "}");
            }
            Files.write(streamFile, raw);
            int rawLines = raw.size();

            SessionStreamStore.LoadResult before = store.loadRounds(sid, null, null, 10);
            waitForCompaction(streamFile, rawLines);
            SessionStreamStore.LoadResult after = store.loadRounds(sid, null, null, 10);

            Assertions.assertTrue(Files.readAllLines(streamFile).size() < rawLines,
                    "懒压缩应显著减少物理行数");
            Assertions.assertEquals(concatText(before.events, "text"), concatText(after.events, "text"),
                    "压缩前后 loadRounds 的文本内容必须完全一致");
            Assertions.assertEquals(before.events.size(), after.events.size(),
                    "压缩前后 loadRounds 的事件条数必须一致（读侧合并口径相同）");
            Assertions.assertEquals(3, after.totalRounds, "user 轮边界必须完整保留");
            Assertions.assertEquals(expected.toString(), concatText(after.events, "text"));

            // 幂等：再次读取不应再次重写文件
            long sizeAfter = Files.size(streamFile);
            store.loadRounds(sid, null, null, 10);
            Thread.sleep(300);
            Assertions.assertEquals(sizeAfter, Files.size(streamFile), "已压缩文件不得反复重写");

            // 压缩后继续写入，seq 不得回退或重复
            store.record(sid, null, text("run4", "tail"));
            store.flush(sid, null);
            SessionStreamStore.LoadResult tail = store.loadAfter(sid, null, 0L, 5000);
            long maxSeq = 0;
            for (Map e : tail.events) {
                long s = ((Number) e.get("eventSeq")).longValue();
                Assertions.assertTrue(s > maxSeq, "eventSeq 必须严格递增，出现回退/重复：" + s);
                maxSeq = s;
            }
        } finally {
            delete(workspace);
        }
    }

    /** 向后兼容：旧格式文件（无 seqFrom）必须能正常读、正常补流。 */
    @Test
    void legacyFileWithoutSeqFromLoadsNormally() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-legacy");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-legacy";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    "{\"type\":\"user\",\"text\":\"q\",\"eventSeq\":1}\n"
                            + "{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"a\",\"eventSeq\":2}\n"
                            + "{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"b\",\"eventSeq\":3}\n"
                            + "{\"type\":\"done\",\"eventSeq\":4}\n");

            SessionStreamStore.LoadResult all = store.loadAfter(sid, null, 0L, 100);
            Assertions.assertEquals("ab", concatText(all.events, "text"));
            Assertions.assertEquals(4L, all.latestSeq);
            Assertions.assertEquals("user", all.events.get(0).get("type"), "旧格式 user 行必须原样读出");

            // 旧格式单帧行视为 [seq, seq]，afterSeq=2 时第 3 条必须正常补上（不得被边界规则误杀）
            SessionStreamStore.LoadResult after = store.loadAfter(sid, null, 2L, 100);
            Assertions.assertEquals("b", concatText(after.events, "text"));
        } finally {
            delete(workspace);
        }
    }

    /** A1：长驻 Writer 不得阻塞 Windows 上的删除与回退（文件占用回归）。 */
    @Test
    void longLivedWriterDoesNotBlockDeleteOrRewind() throws Exception {
        Path workspace = Files.createTempDirectory("stream-batch-handle");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-handle";
            Path streamFile = locator.resolveDir(sid, null).toPath().resolve(sid + SessionStreamStore.STREAM_SUFFIX);

            store.recordUser(sid, null, "u1", 1L);
            store.record(sid, null, text("run-1", "a1"));
            store.recordUser(sid, null, "u2", 2L);
            store.record(sid, null, text("run-1", "a2"));

            store.rewindTurns(sid, null, 1);
            SessionStreamStore.LoadResult afterRewind = store.loadAfter(sid, null, 0L, 100);
            Assertions.assertEquals(2, afterRewind.events.size(), "回退必须真正生效（句柄未关会静默失败）");

            store.record(sid, null, text("run-2", "a3"));
            store.delete(sid, null);
            Assertions.assertFalse(Files.exists(streamFile), "删除必须真正生效（Windows 文件占用回归）");
        } finally {
            delete(workspace);
        }
    }

    private static WebChunk text(String runId, String content) {
        WebChunk chunk = WebChunk.ofText(content);
        chunk.setRunId(runId);
        return chunk;
    }

    private static WebChunk reason(String runId, String content) {
        WebChunk chunk = WebChunk.ofReason(content);
        chunk.setRunId(runId);
        return chunk;
    }

    private static String concatText(List<Map> events, String type) {
        StringBuilder sb = new StringBuilder();
        for (Map e : events) {
            if (!type.equals(String.valueOf(e.get("type")))) continue;
            Object t = e.get("text");
            if (t instanceof String) sb.append((String) t);
        }
        return sb.toString();
    }

    /** 等待后台懒压缩完成（daemon 单线程执行器，最多等 10s）。 */
    private static void waitForCompaction(Path file, int originalLines) throws Exception {
        for (int i = 0; i < 100; i++) {
            if (Files.readAllLines(file).size() < originalLines) return;
            Thread.sleep(100);
        }
        Assertions.fail("懒压缩未在 10s 内完成");
    }

    private static void delete(Path path) throws Exception {
        if (Files.exists(path)) {
            Files.walk(path).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
