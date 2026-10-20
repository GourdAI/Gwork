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
 * 用量账本（{@code <sid>.usage.ndjson}）与 stream 回退源的统计契约测试。
 *
 * <p><b>背景（2026-10 修复）</b>：任务监控「技能调用/记忆更新」曾恒为空——统计只读
 * messages.ndjson，而带 toolCalls 的中间 assistant 消息从不落盘。修复后数据源优先级为
 * 账本 &gt; stream action_start 帧 &gt; messages toolCalls，本类锁定前两级与优先级语义。</p>
 *
 * <p>账本行结构对齐 {@code SessionStreamStore.recordToolUsage} 的真实写盘形态
 * （tool/ok/at 必备，actionId/agent/skill 可选）。</p>
 */
class SessionToolUsageLedgerTest {

    private static final String SESSION_ID = "work-ledger-test";

    @TempDir
    Path sessionDir;

    @TempDir
    Path legacyDir;

    private Path writeLedger(String... lines) throws Exception {
        Path file = sessionDir.resolve(SESSION_ID + ".usage.ndjson");
        Files.write(file, String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private Path writeStream(String... lines) throws Exception {
        Path file = sessionDir.resolve(SESSION_ID + ".stream.ndjson");
        Files.write(file, String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private Path writeMessages(String... lines) throws Exception {
        Path file = sessionDir.resolve(SESSION_ID + ".messages.ndjson");
        Files.write(file, String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
        return file;
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

    /** 账本行：tool 必备，ok/at 齐全，skill 可选。 */
    private static String ledger(String tool, boolean ok, String skill) {
        return "{\"tool\":\"" + tool + "\",\"ok\":" + ok + ",\"at\":1760000000000"
                + (skill == null ? "" : ",\"skill\":\"" + skill + "\"") + "}";
    }

    /** stream 的 action_start 帧（回退源形态：toolName + args）。 */
    private static String actionStart(String toolName, String argsJson) {
        return "{\"sessionId\":\"" + SESSION_ID + "\",\"type\":\"action_start\",\"toolName\":\"" + toolName
                + "\",\"args\":" + argsJson + ",\"createdAt\":1760000000000}";
    }

    // ==================== 1. 账本为权威源 ====================

    @Test
    void ledgerCountsSkillsAndMemory() throws Exception {
        writeLedger(
                ledger("skillread", true, "remotion-best-practices-zh"),
                ledger("skillread", true, "remotion-best-practices-zh"),
                ledger("memory_extract", true, null),
                ledger("memory_search", true, null),
                ledger("bash", true, null),
                ledger("grep", false, null));

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
        Assertions.assertEquals(6, number(usage.get("toolCallCount")), "失败调用也如实计数");
        Assertions.assertEquals(2, number(usage.get("skillCount")));
        Assertions.assertEquals("remotion-best-practices-zh", skillRow(usage, "remotion-best-practices-zh").get("name"));
        Assertions.assertEquals(2, number(skillRow(usage, "remotion-best-practices-zh").get("count")));
        Assertions.assertEquals(Boolean.TRUE, memory(usage).get("updated"));
        Assertions.assertEquals(1, number(memory(usage).get("extractCount")));
        Assertions.assertEquals(2, number(memory(usage).get("totalCount")));
        Assertions.assertEquals(0, number(usage.get("degradedLines")));
    }

    @Test
    void ledgerWithoutExtractDoesNotMarkUpdated() throws Exception {
        writeLedger(ledger("memory_search", true, null), ledger("memory_recall", true, null));

        Map<String, Object> mem = memory(SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID));

        Assertions.assertEquals(Boolean.FALSE, mem.get("updated"), "只读记忆工具不得谎报已更新");
        Assertions.assertEquals(2, number(mem.get("totalCount")));
    }

    @Test
    void ledgerBeatsMessagesWhenBothExist() throws Exception {
        // 优先级锁定：账本与 messages 数据不一致时以账本为准（绝不混读重复计数）
        writeLedger(ledger("skillread", true, "from-ledger"));
        writeMessages("{\"role\":\"ASSISTANT\",\"content\":\"x\",\"toolCalls\":["
                + "{\"name\":\"skillread\",\"argumentsStr\":\"{\\\"name\\\":\\\"from-messages\\\"}\"}]}");

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(1, number(usage.get("toolCallCount")), "只读账本，不叠加 messages");
        Assertions.assertEquals(1, number(skillRow(usage, "from-ledger").get("count")));
        Assertions.assertTrue(skills(usage).stream().noneMatch(r -> "from-messages".equals(r.get("name"))));
    }

    @Test
    void malformedLedgerLinesAreDegradedWithoutBreakingGoodOnes() throws Exception {
        writeLedger(
                "not json",
                "[1,2]",
                "{\"ok\":true}",
                ledger("skillread", true, "good-skill"));

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(3, number(usage.get("degradedLines")), "非 JSON/数组/缺 tool 各计一次");
        Assertions.assertEquals(1, number(usage.get("toolCallCount")));
        Assertions.assertEquals(1, number(skillRow(usage, "good-skill").get("count")));
    }

    // ==================== 2. stream 回退源（老会话） ====================

    @Test
    void streamFallbackCountsSkillsFromActionStartFrames() throws Exception {
        writeStream(
                "{\"type\":\"user\",\"text\":\"hi\"}",
                actionStart("skillread", "{\"name\":\"ppt-craft-master\"}"),
                actionStart("grep", "{\"pattern\":\"x\"}"),
                "{\"type\":\"action_end\",\"toolName\":\"skillread\",\"text\":\"...\"}",
                actionStart("skillsearch", "{\"query\":\"ppt\"}"));

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
        Assertions.assertEquals(3, number(usage.get("toolCallCount")), "只认 action_start，end 帧不重复计数");
        Assertions.assertEquals(2, number(usage.get("skillCount")));
        Assertions.assertEquals(1, number(skillRow(usage, "ppt-craft-master").get("count")));
        Assertions.assertEquals(1, number(skillRow(usage, "ppt").get("count")), "skillsearch 退回 query");
        Assertions.assertEquals(0, number(usage.get("degradedLines")), "异构 stream 行静默跳过不报 degraded");
    }

    @Test
    void streamFallbackCannotSeeMemoryToolsAndStaysHonest() throws Exception {
        // 记忆工具被可见性策略过滤、从不进 stream：老会话的「记忆已更新」如实为空，不伪造
        writeStream(actionStart("skillread", "{\"name\":\"s\"}"));

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.FALSE, memory(usage).get("updated"));
        Assertions.assertEquals(0, number(memory(usage).get("totalCount")));
        Assertions.assertEquals(1, number(usage.get("skillCount")));
    }

    @Test
    void streamFallbackWithoutSkillArgsFallsBackToPlaceholder() throws Exception {
        writeStream(actionStart("skillread", "{}"));

        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(1, number(skillRow(usage, "(unknown)").get("count")));
    }

    // ==================== 3. 候选目录与空态 ====================

    @Test
    void ledgerIsFoundInLegacyDirWhenPrimaryHasNone() throws Exception {
        // 历史落点回探：账本只在 legacy 目录时也必须统计到（老会话数据不「消失」）
        Path legacyLedger = legacyDir.resolve(SESSION_ID + ".usage.ndjson");
        Files.write(legacyLedger, List.of(ledger("skillread", true, "legacy-skill")), StandardCharsets.UTF_8);

        Map<String, Object> usage = SessionToolUsageService.usage(
                List.of(sessionDir.toFile(), legacyDir.toFile()), SESSION_ID);

        Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
        Assertions.assertEquals(1, number(skillRow(usage, "legacy-skill").get("count")));
    }

    @Test
    void ledgerInPrimaryBeatsLegacyDirAndStreamFallback() throws Exception {
        // 优先级与目录序双锁：三类源/两个目录同时有数据时，只读「标准目录的账本」，
        // 不得回退 stream、不得误取 legacy（否则重复计数或读错副本）
        writeLedger(ledger("skillread", true, "primary-skill"));
        writeStream(actionStart("skillread", "{\"name\":\"stream-skill\"}"));
        Files.write(legacyDir.resolve(SESSION_ID + ".usage.ndjson"),
                List.of(ledger("skillread", true, "legacy-skill")), StandardCharsets.UTF_8);

        Map<String, Object> usage = SessionToolUsageService.usage(
                List.of(sessionDir.toFile(), legacyDir.toFile()), SESSION_ID);

        Assertions.assertEquals(1, number(usage.get("toolCallCount")), "只读一个源，不叠加");
        Assertions.assertEquals(1, number(skillRow(usage, "primary-skill").get("count")));
        Assertions.assertTrue(skills(usage).stream().noneMatch(r -> "stream-skill".equals(r.get("name"))),
                "有账本时不得回退 stream");
        Assertions.assertTrue(skills(usage).stream().noneMatch(r -> "legacy-skill".equals(r.get("name"))),
                "标准目录有账本时不得读 legacy");
    }

    @Test
    void noDataSourceAtAllYieldsStructuredEmptyState() throws Exception {
        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Assertions.assertEquals(Boolean.FALSE, usage.get("exists"));
        Assertions.assertEquals(0, number(usage.get("toolCallCount")));
        Assertions.assertEquals(0, number(usage.get("skillCount")));
        Assertions.assertEquals(Boolean.FALSE, memory(usage).get("updated"));
    }

    // ==================== 4. 写侧技能标识口径 ====================

    @Test
    void skillNameOrNullOnlyFiresForSkillTools() {
        Assertions.assertEquals("deep-research",
                SessionToolUsageService.skillNameOrNull(Map.of("name", "deep-research"), "skillread"));
        Assertions.assertEquals("ppt",
                SessionToolUsageService.skillNameOrNull(Map.of("query", "ppt"), "skillsearch"));
        Assertions.assertEquals("(unknown)",
                SessionToolUsageService.skillNameOrNull(Map.of(), "skillread"), "取不到参数仍保住「调用过」事实");
        Assertions.assertEquals("skilllist",
                SessionToolUsageService.skillNameOrNull(null, "skilllist"), "无参技能工具用工具名聚合");
        Assertions.assertNull(SessionToolUsageService.skillNameOrNull(Map.of("name", "x"), "bash"),
                "非技能工具不写 skill 字段");
        Assertions.assertNull(SessionToolUsageService.skillNameOrNull(Map.of("name", "x"), null));
    }
}
