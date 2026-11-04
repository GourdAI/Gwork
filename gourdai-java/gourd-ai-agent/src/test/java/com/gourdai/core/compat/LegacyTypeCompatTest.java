package com.gourdai.core.compat;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;
import com.gourdai.agent.session.FileAgentSession;
import com.gourdai.ai.chat.message.ChatMessage;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 旧包名反序列化兼容层测试。
 *
 * <p>覆盖：热路径（ChatMessage）与冷路径（快照）读旧数据、新数据不受影响、
 * 正文里的类名字符串不被误伤、映射后类不存在时不改写、快照自愈回写与幂等、
 * 回写失败不影响会话加载。</p>
 *
 * @author oisin
 */
public class LegacyTypeCompatTest {

    private static final String OLD_PREFIX = "org.noear.solon.ai.";
    private static final String NEW_PREFIX = "com.gourdai.ai.";

    /** 旧包名的用户消息（blocks 里写的是迁移前的 TextBlock）。 */
    private static final String OLD_USER_JSON =
            "{\"role\":\"USER\",\"blocks\":[{\"@type\":\"org.noear.solon.ai.chat.content.TextBlock\","
                    + "\"text\":\"你好\"}],\"content\":\"你好\",\"createdAt\":1789401771978}";

    // ---------------- 热路径 ----------------

    /** 旧包名消息应能正常反序列化（迁移前的历史 ndjson）。 */
    @Test
    public void testHotPathReadsLegacyMessage() {
        ChatMessage msg = ChatMessage.fromJson(OLD_USER_JSON);
        Assertions.assertNotNull(msg);
        Assertions.assertEquals("你好", msg.getContent());
        Assertions.assertEquals("com.gourdai.ai.chat.message.UserMessage", msg.getClass().getName());
    }

    /** 新包名消息（当前写出的格式）仍然正常。 */
    @Test
    public void testHotPathReadsCurrentMessage() {
        String json = ChatMessage.toJson(ChatMessage.ofUser("hello"));
        Assertions.assertTrue(json.contains(NEW_PREFIX), "当前写出的消息应为新包名");
        Assertions.assertFalse(json.contains(OLD_PREFIX), "当前写出的消息不应含旧包名");

        ChatMessage msg = ChatMessage.fromJson(json);
        Assertions.assertEquals("hello", msg.getContent());
    }

    /** 关键负样本：正文里出现的类名字符串不得被改写。 */
    @Test
    public void testRewriteDoesNotTouchTextContent() {
        String text = "报错信息：Unsupported type, class: org.noear.solon.ai.chat.message.UserMessage";
        String json = ChatMessage.toJson(ChatMessage.ofUser(text));

        String fixed = LegacyTypeCompat.rewrite(json);
        Assertions.assertTrue(fixed.contains(OLD_PREFIX + "chat.message.UserMessage"),
                "正文中的旧类名字符串必须原样保留");

        ChatMessage msg = ChatMessage.fromJson(json);
        Assertions.assertEquals(text, msg.getContent(), "正文内容不得被兼容层篡改");
    }

    /** 只改写 @type 位置：同一份 JSON 里，@type 改写而普通字段不动。 */
    @Test
    public void testRewriteOnlyTargetsTypeKey() {
        String json = "{\"note\":\"org.noear.solon.ai.chat.content.TextBlock\","
                + "\"@type\":\"org.noear.solon.ai.chat.content.TextBlock\",\"text\":\"x\"}";
        String fixed = LegacyTypeCompat.rewrite(json);

        Assertions.assertTrue(fixed.contains("\"note\":\"org.noear.solon.ai.chat.content.TextBlock\""),
                "普通字段值不得被改写");
        Assertions.assertTrue(fixed.contains("\"@type\":\"com.gourdai.ai.chat.content.TextBlock\""),
                "@type 应被改写为新包名");
    }

    /** 映射后类不存在时不得改写（避免把错误换成更难排查的另一个错误）。 */
    @Test
    public void testRewriteSkipsWhenTargetClassMissing() {
        String json = "{\"@type\":\"org.noear.solon.ai.chat.content.NoSuchBlockXyz\"}";
        String fixed = LegacyTypeCompat.rewrite(json);
        Assertions.assertSame(json, fixed, "目标类不存在时应原样返回同一引用");
    }

    /** 不含旧前缀时应短路返回同一引用（零拷贝）。 */
    @Test
    public void testRewriteShortCircuitsWhenNoLegacyPrefix() {
        String json = "{\"@type\":\"com.gourdai.ai.chat.content.TextBlock\",\"text\":\"x\"}";
        Assertions.assertSame(json, LegacyTypeCompat.rewrite(json), "已迁移数据应原样返回同一引用");
        Assertions.assertSame(null, LegacyTypeCompat.rewrite(null));
    }

    /** 共享 Options 必须是单例（热路径不得每条消息新建）。 */
    @Test
    public void testReadOptionsIsSingleton() {
        Assertions.assertSame(LegacyTypeCompat.readOptions(), LegacyTypeCompat.readOptions());
    }

    // ---------------- 冷路径（快照） ----------------

    /** 旧包名快照：改写后可被 FlowContext 正常反序列化。 */
    @Test
    public void testColdPathRewriteMakesSnapshotLoadable() {
        String snapshot = legacySnapshotJson();

        Assertions.assertThrows(Throwable.class, () -> FlowContext.fromJson(snapshot),
                "未改写的旧快照应当解析失败（这正是故障现象）");

        String fixed = LegacyTypeCompat.rewrite(snapshot);
        Assertions.assertNotSame(snapshot, fixed);
        Assertions.assertNotNull(FlowContext.fromJson(fixed), "改写后应能正常解析");
    }

    /** 会话打开时：旧快照被加载，且自愈回写为新包名；再次打开不再走兼容。 */
    @Test
    public void testSnapshotSelfHealingWriteBack() throws Exception {
        Path base = Files.createTempDirectory("legacy-compat-heal");
        try {
            Path dir = base.resolve("dir");
            Files.createDirectories(dir);
            Path snapshotFile = dir.resolve("work-c1.snapshot.json");
            Files.write(snapshotFile, legacySnapshotJson().getBytes(StandardCharsets.UTF_8));

            FileAgentSession session = new FileAgentSession("work-c1", dir.toString());
            Assertions.assertNotNull(session.getContext(), "旧快照应能加载");
            Assertions.assertEquals("work-mu1fm0lj", session.getContext().get("instanceId"),
                    "快照内容应被正确恢复");

            String onDisk = new String(Files.readAllBytes(snapshotFile), StandardCharsets.UTF_8);
            Assertions.assertFalse(onDisk.contains("\"@type\":\"" + OLD_PREFIX),
                    "回写后磁盘上不应再有旧包名的 @type");
            Assertions.assertTrue(onDisk.contains(NEW_PREFIX), "回写后磁盘应为新包名");

            // 再次打开：已自愈，rewrite 短路，内容不再变化
            long before = Files.size(snapshotFile);
            FileAgentSession again = new FileAgentSession("work-c1", dir.toString());
            Assertions.assertNotNull(again.getContext());
            Assertions.assertEquals(before, Files.size(snapshotFile), "已自愈的快照不应被重复回写");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 新包名快照不触发回写（幂等/零副作用）。 */
    @Test
    public void testCurrentSnapshotNotRewritten() throws Exception {
        Path base = Files.createTempDirectory("legacy-compat-current");
        try {
            Path dir = base.resolve("dir");
            Files.createDirectories(dir);
            Path snapshotFile = dir.resolve("work-c2.snapshot.json");

            String fixed = LegacyTypeCompat.rewrite(legacySnapshotJson());
            Files.write(snapshotFile, fixed.getBytes(StandardCharsets.UTF_8));
            byte[] before = Files.readAllBytes(snapshotFile);

            FileAgentSession session = new FileAgentSession("work-c2", dir.toString());
            Assertions.assertNotNull(session.getContext());
            Assertions.assertArrayEquals(before, Files.readAllBytes(snapshotFile),
                    "新包名快照不应被改动");
        } finally {
            deleteRecursively(base);
        }
    }

    /** 回写失败（快照文件只读）不得影响会话加载。 */
    @Test
    public void testWriteBackFailureDoesNotBreakLoading() throws Exception {
        Path base = Files.createTempDirectory("legacy-compat-rofail");
        try {
            Path dir = base.resolve("dir");
            Files.createDirectories(dir);
            Path snapshotFile = dir.resolve("work-c3.snapshot.json");
            Files.write(snapshotFile, legacySnapshotJson().getBytes(StandardCharsets.UTF_8));

            // 快照文件置为只读：可读但覆盖写会失败，用于模拟自愈回写失败
            boolean readOnly = snapshotFile.toFile().setReadOnly();
            Assumptions.assumeTrue(readOnly, "当前文件系统不支持只读标记，跳过");

            FileAgentSession session = new FileAgentSession("work-c3", dir.toString());
            Assertions.assertNotNull(session.getContext(), "回写失败时会话仍须正常加载");
            Assertions.assertEquals("work-mu1fm0lj", session.getContext().get("instanceId"),
                    "回写失败不影响快照内容恢复");

            String onDisk = new String(Files.readAllBytes(snapshotFile), StandardCharsets.UTF_8);
            Assertions.assertTrue(onDisk.contains("\"@type\":\"" + OLD_PREFIX),
                    "回写确实失败了（磁盘仍为旧包名），但会话照常加载");

            // 目录下不得残留兼容层的临时文件
            try (Stream<Path> children = Files.list(dir)) {
                Assertions.assertTrue(children.noneMatch(p -> p.getFileName().toString().endsWith(".compat.tmp")),
                        "回写失败后不得残留临时文件");
            }

            snapshotFile.toFile().setWritable(true);
        } finally {
            deleteRecursively(base);
        }
    }

    /** 历史消息文件（ndjson）里的旧包名消息可被会话正常加载。 */
    @Test
    public void testSessionLoadsLegacyNdjsonMessages() throws Exception {
        Path base = Files.createTempDirectory("legacy-compat-ndjson");
        try {
            Path dir = base.resolve("dir");
            Files.createDirectories(dir);
            Files.write(dir.resolve("work-c4.messages.ndjson"),
                    (OLD_USER_JSON + "\n").getBytes(StandardCharsets.UTF_8));

            FileAgentSession session = new FileAgentSession("work-c4", dir.toString());
            List<ChatMessage> messages = session.getMessages();
            Assertions.assertEquals(1, messages.size(), "旧包名历史消息应能加载");
            Assertions.assertEquals("你好", messages.get(0).getContent());
        } finally {
            deleteRecursively(base);
        }
    }

    /**
     * 构造一份含旧包名的快照 JSON（取自真实历史快照的结构，已精简）。
     */
    private static String legacySnapshotJson() {
        return "{\"stopped\":false,\"data\":{\"instanceId\":\"work-mu1fm0lj\","
                + "\"__main\":{\"@type\":\"com.gourdai.agent.react.ReActTrace\",\"agentName\":\"main\","
                + "\"originalPrompt\":{\"@type\":\"org.noear.solon.ai.chat.prompt.PromptImpl\","
                + "\"messages\":[{\"@type\":\"org.noear.solon.ai.chat.message.UserMessage\","
                + "\"role\":\"USER\",\"blocks\":[{\"@type\":\"org.noear.solon.ai.chat.content.TextBlock\","
                + "\"text\":\"你好\"}],\"content\":\"你好\",\"createdAt\":1789401771978}]}}}}";
    }

    private static void deleteRecursively(Path path) {
        if (path == null || !Files.exists(path)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(path)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    p.toFile().setWritable(true);
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }
}
