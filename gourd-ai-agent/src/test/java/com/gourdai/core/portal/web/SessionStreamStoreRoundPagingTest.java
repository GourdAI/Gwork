package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * 「按对话轮分页」回归：loadRounds 的页首必须恒为整轮起点（轮边界吸附），
 * 游标 firstSeq 必须单调收敛（不得死循环翻页），remainingRounds 与截断后真实页首同口径。
 *
 * <p>事故背景：字节预算的头部截断曾把页首切在 assistant run 中段，firstSeq 又把下一页
 * 游标钉在该非边界点上——用户每上拉一次，同一条回答就被多切一刀，前端渲染成
 * 「上方碎片 + 下方残段」的错乱版式。</p>
 */
class SessionStreamStoreRoundPagingTest {

    /** 单轮正文即超字节预算（32700 字符 ≈ 98.6KB > 96KB 预算，且 < PREVIEW_CHARS 不被预览截断）。 */
    private static final String BIG = "x".repeat(32700);

    @Test
    void pageHeadAlwaysAlignsToRoundBoundaryAndCursorConverges() throws Exception {
        Path workspace = Files.createTempDirectory("stream-round-paging");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-rounds";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            // 三轮：第 2 轮正文单条即超预算（极端长回答），用于触发头部截断与吸附判定
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    "{\"type\":\"user\",\"text\":\"u1\",\"eventSeq\":1}\n"
                            + "{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"a\",\"eventSeq\":2}\n"
                            + "{\"type\":\"user\",\"text\":\"u2\",\"eventSeq\":3}\n"
                            + "{\"type\":\"text\",\"runId\":\"r2\",\"text\":\"" + BIG + "\",\"eventSeq\":4}\n"
                            + "{\"type\":\"user\",\"text\":\"u3\",\"eventSeq\":5}\n"
                            + "{\"type\":\"text\",\"runId\":\"r3\",\"text\":\"" + "c".repeat(100) + "\",\"eventSeq\":6}\n");

            // 尾页：第 3 轮整轮，页首必须是 user 边界
            SessionStreamStore.LoadResult p1 = store.loadRounds(sid, null, null, 5);
            Assertions.assertEquals("user", String.valueOf(p1.events.get(0).get("type")),
                    "尾页页首必须是轮边界（user 事件）");
            Assertions.assertEquals(5L, p1.firstSeq, "尾页游标应指向本轮 user 事件");
            Assertions.assertTrue(p1.hasMore, "前面还有两轮，hasMore 必须为真");
            Assertions.assertEquals(2, p1.remainingRounds, "尾页之前应有 2 轮未加载");

            // 第二页：第 2 轮单条超预算，反向截断只能保住正文组、丢掉本轮 user 行。
            // 吸附失败（保留段内无边界）是允许的极端情形，但游标必须仍收敛、计数不得多算。
            SessionStreamStore.LoadResult p2 = store.loadRounds(sid, null, p1.firstSeq, 5);
            Assertions.assertEquals(1, p2.events.size(), "超预算轮一页只应返回该轮的正文组");
            Assertions.assertTrue(((String) p2.events.get(0).get("text")).startsWith("xxxx"),
                    "返回的应是第 2 轮的长正文");
            Assertions.assertEquals(4L, p2.firstSeq, "游标应推进到被保留组的 seqFrom");
            Assertions.assertTrue(p2.hasMore, "第 1 轮仍未加载");
            Assertions.assertEquals(1, p2.remainingRounds,
                    "本页所属轮的 user 行虽被丢弃但内容已部分呈现，剩余只应计第 1 轮");

            // 第三页：第 1 轮整轮；到此必须收敛（hasMore=false），否则前端死循环翻页
            SessionStreamStore.LoadResult p3 = store.loadRounds(sid, null, p2.firstSeq, 5);
            Assertions.assertEquals("user", String.valueOf(p3.events.get(0).get("type")),
                    "普通轮的页首必须是轮边界");
            Assertions.assertEquals("u1", p3.events.get(0).get("text"));
            Assertions.assertFalse(p3.hasMore, "翻到头后 hasMore 必须为假，禁止死循环翻页");
            Assertions.assertEquals(0, p3.remainingRounds);

            // 游标严格单调递减（向上翻页语义）
            Assertions.assertTrue(p1.firstSeq > p2.firstSeq && p2.firstSeq > p3.firstSeq,
                    "游标必须单调收敛");
        } finally {
            delete(workspace);
        }
    }

    @Test
    void legacyFileWithoutEventSeqStopsPagingInsteadOfLooping() throws Exception {
        Path workspace = Files.createTempDirectory("stream-round-legacy");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-round-legacy";
            Path sessionDir = locator.resolveDir(sid, null).toPath();
            Files.createDirectories(sessionDir);
            // 旧数据：无 eventSeq。beforeSeq 无法在旧行上定位 endIdx，继续翻页会把同一页
            // 反复 prepend，碎片成倍堆叠——宁可收起加载入口。
            Files.writeString(sessionDir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    "{\"type\":\"user\",\"text\":\"q1\"}\n"
                            + "{\"type\":\"text\",\"runId\":\"r1\",\"text\":\"a\"}\n"
                            + "{\"type\":\"user\",\"text\":\"q2\"}\n"
                            + "{\"type\":\"text\",\"runId\":\"r2\",\"text\":\"b\"}\n");

            SessionStreamStore.LoadResult lr = store.loadRounds(sid, null, null, 5);
            Assertions.assertFalse(lr.events.isEmpty(), "旧数据仍应能渲染");
            Assertions.assertEquals(0L, lr.firstSeq, "旧数据给不出可用游标");
            Assertions.assertFalse(lr.hasMore, "无游标时必须收起翻页入口，禁止同页反复 prepend");
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
