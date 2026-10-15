package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * {@link SessionToolUsageService} 的聚焦测试。
 *
 * <p><b>WHY 手写 ndjson 而不构造真消息对象</b>：统计的输入契约是「落盘后的 JSON 行」，
 * 而 {@code ChatMessage.toJson} 会随消息模型演进（protocolStates、thoughtSignature 裁剪等）。
 * 直接按落盘形态写行，测试锁定的是解析契约本身，不会因消息模型内部调整而误报。
 * 行结构对齐 {@code ToolCall} 的真实字段（name / arguments / argumentsStr）。</p>
 *
 * <p>全部用例 hermetic：只写临时目录，不启动容器、不联网、不依赖真会话。</p>
 */
class SessionToolUsageTest {

    private static final String SESSION_ID = "work-tool-usage";

    @TempDir
    Path sessionDir;

    /** 写一份 {@code <sid>.messages.ndjson}；返回会话目录。 */
    private Path writeMessages(String... lines) throws Exception {
        Path file = sessionDir.resolve(SESSION_ID + ".messages.ndjson");
        Files.createDirectories(file.getParent());
        Files.write(file, String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
        return sessionDir;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> memory(Map<String, Object> usage) {
        return (Map<String, Object>) usage.get("memory");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> skills(Map<String, Object> usage) {
        return (List<Map<String, Object>>) usage.get("skills");
    }

    private static Map<String, Object> skillRow(Map<String, Object> usage, String name) {
        for (Map<String, Object> row : skills(usage)) {
            if (name.equals(row.get("name"))) return row;
        }
        return Assertions.fail("skill row not found: " + name);
    }

    private static int number(Object value) {
        return ((Number) value).intValue();
    }

    /** assistant 行：带若干工具调用（name + argumentsStr）。 */
    private static String assistant(String content, String... toolCalls) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"role\":\"ASSISTANT\",\"content\":\"").append(content)
                .append("\",\"createdAt\":1760000000000,\"toolCalls\":[");
        for (int i = 0; i < toolCalls.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(toolCalls[i]);
        }
        sb.append("]}");
        return sb.toString();
    }

    /** 工具调用片段：只带 argumentsStr（多数国内模型通道的落盘形态）。 */
    private static String call(String name, String argumentsJson) {
        return "{\"uuid\":\"u-" + name + "\",\"name\":\"" + name + "\",\"argumentsStr\":"
                + quote(argumentsJson) + ",\"arguments\":{}}";
    }

    /** 工具调用片段：只带 arguments 字典（另一类通道的落盘形态）。 */
    private static String callWithMap(String name, String argumentsJson) {
        return "{\"uuid\":\"u-" + name + "\",\"name\":\"" + name + "\",\"arguments\":" + argumentsJson + "}";
    }

    /** JSON 字符串字面量转义（把 {"name":"x"} 变成 "{\"name\":\"x\"}"）。 */
    private static String quote(String raw) {
        return "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    // ==================== 1. 记忆统计 ====================

    @Test
    void countsMemoryToolsAndOnlyExtractMarksUpdated() throws Exception {
        Path dir = writeMessages(
                assistant("hi", call("memory_search", "{\"query\":\"deploy\"}")),
                assistant("ok", call("memory_extract", "{\"key\":\"K1\"}")),
                assistant("done", call("memory_recall", "{\"key\":\"K1\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
        Map<String, Object> mem = memory(usage);
        Assertions.assertEquals(Boolean.TRUE, mem.get("updated"), "调用过 memory_extract 即视为已更新");
        Assertions.assertEquals(1, number(mem.get("extractCount")));
        Assertions.assertEquals(3, number(mem.get("totalCount")), "memory_* 全集都计入 totalCount");
        Assertions.assertEquals(List.of("memory_search", "memory_extract", "memory_recall"), mem.get("names"));
    }

    @Test
    void readOnlyMemoryCallsDoNotMarkUpdated() throws Exception {
        // memory_search / memory_recall 只读不写：算成「已更新」会让面板谎报「AI 沉淀了新认知」
        Path dir = writeMessages(
                assistant("hi", call("memory_search", "{\"query\":\"x\"}"), call("memory_recall", "{\"key\":\"K\"}")));

        Map<String, Object> mem = memory(SessionToolUsageService.usage(dir.toFile(), SESSION_ID));

        Assertions.assertEquals(Boolean.FALSE, mem.get("updated"));
        Assertions.assertEquals(0, number(mem.get("extractCount")));
        Assertions.assertEquals(2, number(mem.get("totalCount")));
    }

    @Test
    void repeatedExtractAccumulates() throws Exception {
        Path dir = writeMessages(
                assistant("a", call("memory_extract", "{\"key\":\"K1\"}")),
                assistant("b", call("memory_extract", "{\"key\":\"K1\"}"), call("memory_extract", "{\"key\":\"K2\"}")));

        Map<String, Object> mem = memory(SessionToolUsageService.usage(dir.toFile(), SESSION_ID));

        Assertions.assertEquals(3, number(mem.get("extractCount")), "同一条消息里的多次调用都要计数");
        // names 去重：同一工具名只出现一次
        Assertions.assertEquals(List.of("memory_extract"), mem.get("names"));
    }

    // ==================== 2. 技能统计 ====================

    @Test
    void skillNameComesFromSkillreadArguments() throws Exception {
        Path dir = writeMessages(
                assistant("read", call("skillread", "{\"name\":\"deep-research\"}")),
                assistant("read again", call("skillread", "{\"name\":\"deep-research\"}")),
                assistant("other", call("skillread", "{\"name\":\"ppt-craft-master\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(3, number(usage.get("skillCount")));
        Map<String, Object> deep = skillRow(usage, "deep-research");
        Assertions.assertEquals("skillread", deep.get("toolName"));
        Assertions.assertEquals(2, number(deep.get("count")));
        Assertions.assertEquals(1, number(skillRow(usage, "ppt-craft-master").get("count")));
        // 按次数降序：调用最多的技能排在前
        Assertions.assertEquals("deep-research", skills(usage).get(0).get("name"));
    }

    @Test
    void skillNameIsReadFromArgumentsMapWhenArgumentsStrAbsent() throws Exception {
        // 另一类通道只写 arguments 字典，不写 argumentsStr：两种形态都要认
        Path dir = writeMessages(
                assistant("read", callWithMap("skillread", "{\"name\":\"design-lanhu-skill\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(1, number(usage.get("skillCount")));
        Assertions.assertEquals("design-lanhu-skill", skillRow(usage, "design-lanhu-skill").get("name"));
    }

    @Test
    void skillsearchFallsBackToQueryField() throws Exception {
        Path dir = writeMessages(assistant("search", call("skillsearch", "{\"query\":\"ppt\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(1, number(skillRow(usage, "ppt").get("count")),
                "skillsearch 没有 name 参数，应退回 query 作为技能标识");
    }

    @Test
    void argumentlessSkillToolsAreAggregatedByToolName() throws Exception {
        // skilllist / skillrefresh 无参：用工具名聚合，仍要如实计数
        Path dir = writeMessages(
                assistant("list", call("skilllist", "{}")),
                assistant("refresh", call("skillrefresh", "{}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(2, number(usage.get("skillCount")));
        Assertions.assertEquals("skilllist", skillRow(usage, "skilllist").get("toolName"));
        Assertions.assertEquals("skillrefresh", skillRow(usage, "skillrefresh").get("toolName"));
    }

    @Test
    void skillreadWithoutUsableArgumentsFallsBackToPlaceholder() throws Exception {
        // 参数被截断/不是合法 JSON：不能丢掉「调用过技能」这一事实
        Path dir = writeMessages(
                assistant("bad", "{\"name\":\"skillread\",\"argumentsStr\":\"{\\\"name\\\":\",\"arguments\":{}}"),
                assistant("empty", call("skillread", "{}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(2, number(usage.get("skillCount")));
        Assertions.assertEquals(2, number(skillRow(usage, "(unknown)").get("count")));
    }

    @Test
    void nonSkillNonMemoryToolsAreCountedButNotGrouped() throws Exception {
        Path dir = writeMessages(
                assistant("work", call("read", "{\"file_path\":\"a.txt\"}"), call("bash", "{\"command\":\"ls\"}"),
                        call("skillread", "{\"name\":\"s1\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(3, number(usage.get("toolCallCount")), "普通工具也计入总调用数");
        Assertions.assertEquals(1, number(usage.get("skillCount")), "但只有技能进 skills 分组");
        Assertions.assertEquals(1, skills(usage).size());
    }

    // ==================== 3. 降级与空态 ====================

    @Test
    void malformedLinesAreCountedAsDegradedAndSkipped() throws Exception {
        Path dir = writeMessages(
                assistant("good", call("memory_extract", "{\"key\":\"K\"}")),
                "not json at all",
                "[1,2,3]",
                "123",
                "{\"content\":\"object without role\"}",
                "",
                "   ",
                assistant("also good", call("skillread", "{\"name\":\"s2\"}")));

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        // 4 行不是消息：非 JSON / 数组 / 标量 / 缺 role 的对象，均计入 degradedLines；
        // 空行与空白行按既有读取口径直接跳过，不算 degraded
        Assertions.assertEquals(4, number(usage.get("degradedLines")));
        Assertions.assertEquals(2, number(usage.get("toolCallCount")), "畸形行不得影响正常行的统计");
        Assertions.assertEquals(1, number(memory(usage).get("extractCount")));
        Assertions.assertEquals(1, number(usage.get("skillCount")));
    }

    /**
     * 锁定 snack4 的实际宽容语义：正在被追写的<b>截断行</b>会被解析成含 role 的对象，
     * 因此归为「本行无工具调用」而不是 degraded。
     *
     * <p>WHY 值得单独锁住：若把它当畸形，面板在会话运行期间（ndjson 末尾永远是半行）
     * 会恒定显示「数据不完整」，而下一轮读取它就完整了——那是假告警。</p>
     */
    @Test
    void truncatedTrailingLineIsNotReportedAsDegraded() throws Exception {
        Path dir = writeMessages(
                assistant("good", call("memory_extract", "{\"key\":\"K\"}")),
                "{\"role\":\"ASSISTANT\",");

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(0, number(usage.get("degradedLines")), "截断行不算不可统计");
        Assertions.assertEquals(1, number(usage.get("toolCallCount")));
        Assertions.assertEquals(1, number(memory(usage).get("extractCount")));
    }

    @Test
    void missingFileReturnsStructuredEmptyState() throws Exception {
        // 文件不存在：空态（exists=false）而非抛错——新会话还没落盘消息是常态
        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(SESSION_ID, usage.get("sessionId"));
        Assertions.assertEquals(Boolean.FALSE, usage.get("exists"));
        Assertions.assertEquals(Boolean.FALSE, memory(usage).get("updated"));
        Assertions.assertEquals(0, number(memory(usage).get("extractCount")));
        Assertions.assertEquals(0, number(memory(usage).get("totalCount")));
        Assertions.assertTrue(((List<?>) memory(usage).get("names")).isEmpty());
        Assertions.assertTrue(skills(usage).isEmpty());
        Assertions.assertEquals(0, number(usage.get("skillCount")));
        Assertions.assertEquals(0, number(usage.get("toolCallCount")));
        Assertions.assertEquals(0, number(usage.get("degradedLines")));
    }

    @Test
    void messagesWithoutToolCallsYieldZeroCounts() throws Exception {
        // 纯文本对话（USER / 无 toolCalls 的 ASSISTANT）：不是畸形，不计 degraded
        Path dir = writeMessages(
                "{\"role\":\"USER\",\"content\":\"hello\",\"createdAt\":1760000000000}",
                "{\"role\":\"ASSISTANT\",\"content\":\"hi there\",\"createdAt\":1760000000001}");

        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
        Assertions.assertEquals(0, number(usage.get("toolCallCount")));
        Assertions.assertEquals(0, number(usage.get("degradedLines")));
        Assertions.assertEquals(0, number(usage.get("skillCount")));
    }

    @Test
    void nullArgumentsAreTolerated() throws Exception {
        // sessionDir / sessionId 为空：回空态，绝不抛 NPE
        Map<String, Object> noDir = SessionToolUsageService.usage(null, SESSION_ID);
        Assertions.assertEquals(Boolean.FALSE, noDir.get("exists"));

        Path dir = writeMessages(assistant("x", call("skillread", "{\"name\":\"s3\"}")));
        Map<String, Object> noId = SessionToolUsageService.usage(dir.toFile(), null);
        Assertions.assertEquals(Boolean.FALSE, noId.get("exists"));
        Assertions.assertEquals(0, number(noId.get("toolCallCount")));
    }

    @Test
    void toolCallsWithoutNameAreSkipped() throws Exception {
        // 流式追加中途的半截 toolCall（还没写出 name）：跳过且不计入 toolCallCount
        Path dir = writeMessages(
                "{\"role\":\"ASSISTANT\",\"content\":\"x\",\"toolCalls\":[{\"uuid\":\"u1\"},{\"name\":\"\"},"
                        + "{\"name\":\"skillread\",\"argumentsStr\":\"{\\\"name\\\":\\\"s4\\\"}\"}]}");
        Map<String, Object> usage = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);

        Assertions.assertEquals(1, number(usage.get("toolCallCount")));
        Assertions.assertEquals(1, number(skillRow(usage, "s4").get("count")));
        Assertions.assertEquals(0, number(usage.get("degradedLines")));
    }

    @Test
    void responseKeysAreStable() throws Exception {
        // 面板按固定字段渲染：键集合必须恒定，空态与有数据时一致
        Path dir = writeMessages(assistant("x", call("memory_extract", "{\"key\":\"K\"}")));
        Map<String, Object> withData = SessionToolUsageService.usage(dir.toFile(), SESSION_ID);
        Map<String, Object> empty = SessionToolUsageService.usage(sessionDir.resolve("nope").toFile(), SESSION_ID);

        Assertions.assertEquals(empty.keySet(), withData.keySet());
        Assertions.assertEquals(List.of("sessionId", "exists", "memory", "skills",
                "skillCount", "toolCallCount", "degradedLines"), List.copyOf(withData.keySet()));
        Assertions.assertEquals(List.of("updated", "extractCount", "totalCount", "names"),
                List.copyOf(memory(withData).keySet()));
    }
}
