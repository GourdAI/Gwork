package com.gourdai.core.portal.web;

import com.gourdai.ai.talents.registry.TalentScope;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.Result;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 任务监控「技能调用」区的展示名契约 — 面板上显示的名字必须与技能页一致。
 *
 * <p><b>用户报障（2026-10）</b>：技能页的展示名修好之后，任务监控里同一个技能仍显示
 * 安装目录名 {@code _owner_slug}。根因是展示名口径散落各处：技能页改了一处，
 * 监控这边 {@code renderSkills} 仍直接渲染 {@code name}（= {@code skillread} 的
 * 参数值 = 安装目录名）。本测试锁住「口径已收敛到 {@link SkillDisplayNames}」这件事。</p>
 *
 * <p><b>真实数据取证（不是推理）</b>：本机 8 个会话的用量账本里，
 * {@code "skill":"_user_3b5e1511_lawyer-letter5399"} 与 {@code "skill":"agent-browser"}
 * 共存——前者就是 namespace 限定 slug 的安装目录名，正是用户看不懂的那个名字。
 * 账本字段本身<b>不能改</b>（它是 skillread 的定位键、也是历史数据），
 * 必须在读取侧补展示名。</p>
 *
 * <p><b>夹具用合成名，不抄真实上游值</b>：展示名的具体字串只用于验证「透传」这一步，
 * 与上游真实叫什么无关。把上游具体值写进夹具，一旦记错就成了下一个人误判的源头
 * （本项目已因此踩过一次：两个同裸 slug 不同作者的技能被搞混）。</p>
 */
class SessionToolUsageSkillDisplayNameTest {

    private static final String SESSION_ID = "work-monitor-display";

    @TempDir
    Path sessionDir;

    @TempDir
    Path workspace;

    @TempDir
    Path globalBase;

    // ==================== 1. 服务层：展示名注入 ====================

    @Test
    @DisplayName("技能行：displayName 透出，name 恒为账本里的原始标识")
    void skillRowCarriesDisplayNameWithoutTouchingName() throws Exception {
        writeLedger(
                ledger("skillread", "_user_3b5e1511_lawyer-letter5399"),
                ledger("skillread", "_user_3b5e1511_lawyer-letter5399"),
                ledger("skillread", "agent-browser"));

        Map<String, String> displayNames = new LinkedHashMap<>();
        displayNames.put("_user_3b5e1511_lawyer-letter5399", "示例展示名.Skill");

        Map<String, Object> usage = SessionToolUsageService.usage(
                List.of(sessionDir.toFile()), SESSION_ID, displayNames);

        Map<String, Object> row = skillRow(usage, "_user_3b5e1511_lawyer-letter5399");
        Assertions.assertEquals("示例展示名.Skill", row.get("displayName"),
                "监控必须显示技能页同款展示名（否则同一个技能两处叫两个名字）");
        Assertions.assertEquals("_user_3b5e1511_lawyer-letter5399", row.get("name"),
                "name 必须仍是账本里的原始标识——它是 skillread 的定位键，被展示名污染就再也读不到技能");
        Assertions.assertEquals(2, number(row.get("count")));

        // 未在映射里的技能（如已卸载）不得凭空造展示名
        Assertions.assertNull(skillRow(usage, "agent-browser").get("displayName"),
                "映射里没有的技能不得产生 displayName 字段（前端据此回退 name）");
    }

    @Test
    @DisplayName("传 null 映射：技能行结构与旧版完全一致（向后兼容）")
    void nullMappingKeepsLegacyShape() throws Exception {
        writeLedger(ledger("skillread", "agent-browser"));

        // 旧调用方（不关心展示名 / 单目录重载）走的正是这条路径
        Map<String, Object> usage = SessionToolUsageService.usage(sessionDir.toFile(), SESSION_ID);

        Map<String, Object> row = skillRow(usage, "agent-browser");
        Assertions.assertFalse(row.containsKey("displayName"),
                "无展示名映射时不得新增字段——字段骨架必须与旧版逐字兼容");
        Assertions.assertEquals("skillread", row.get("toolName"));
        Assertions.assertEquals(1, number(row.get("count")));
    }

    @Test
    @DisplayName("空态与正常态字段骨架一致：空态也不得缺 skills 键")
    void emptyStateShapeUnchanged() {
        Map<String, Object> usage = SessionToolUsageService.usage(
                List.of(sessionDir.toFile()), SESSION_ID, Map.of("x", "y"));

        Assertions.assertEquals(Boolean.FALSE, usage.get("exists"));
        Assertions.assertTrue(usage.containsKey("skills"), "空态也必须字段齐备（前端不做 undefined 判定）");
        Assertions.assertEquals(0, ((List<?>) usage.get("skills")).size());
    }

    // ==================== 2. 展示名解析口径（SkillDisplayNames） ====================

    @Test
    @DisplayName("展示名三层口径：meta 优先 / 旧记录退裸尾名 / 无 meta 返回 null")
    void displayNameLayersFromMarketMeta() throws Exception {
        Path skillsRoot = globalSkillsDir();

        // ① 新装技能：meta 带 displayName
        Path fresh = writeSkill(skillsRoot, "_owner_fresh-skill",
                "{\"market\":\"m\",\"slug\":\"@owner/fresh-skill\",\"displayName\":\"示例展示名.Skill\"}");
        Assertions.assertEquals("示例展示名.Skill", SkillDisplayNames.of(fresh),
                "meta 有 displayName 必须原样透出");

        // ② 旧装技能：meta 无 displayName，slug 为 namespace 限定形态 → 裸尾名
        Path legacy = writeSkill(skillsRoot, "_owner_legacy-skill",
                "{\"market\":\"m\",\"slug\":\"@owner/legacy-skill\"}");
        Assertions.assertEquals("legacy-skill", SkillDisplayNames.of(legacy),
                "旧安装记录必须退化为裸尾名（比 _owner_slug 目录名可读）");

        // ③ 本地手放技能：无 meta → null（调用方回退技能名）
        Path local = writeSkill(skillsRoot, "my-local-skill", null);
        Assertions.assertNull(SkillDisplayNames.of(local),
                "无市场元数据的本地技能不得凭空造展示名");
    }

    @Test
    @DisplayName("裸尾 slug 边界：@/slug 与裸 slug 必须与前端同口径（indexOf('/') > 1）")
    void bareSlugBoundaryMatchesFrontend() {
        Assertions.assertEquals("slug", SkillDisplayNames.marketBareSlug("@owner/slug"));
        Assertions.assertEquals("@/slug", SkillDisplayNames.marketBareSlug("@/slug"),
                "@/slug 的分隔符在 index 1，不满足 > 1 → 原样返回（与前端 app-skills.js 一致）");
        Assertions.assertEquals("plain", SkillDisplayNames.marketBareSlug("plain"));
        Assertions.assertNull(SkillDisplayNames.marketBareSlug(null));
    }

    @Test
    @DisplayName("ofAll：键是技能名（= skillread 参数值 = 账本落盘值），禁用技能也要收录")
    void ofAllKeysBySkillNameIncludingDisabled() throws Exception {
        Path skillsRoot = globalSkillsDir();
        writeSkill(skillsRoot, "_owner_enabled-one",
                "{\"market\":\"m\",\"slug\":\"@owner/enabled-one\"}");
        // 禁用技能：仍可能留在历史账本里，名字照样要能读出来
        writeSkill(skillsRoot, "_owner_disabled-one",
                "{\"market\":\"m\",\"slug\":\"@owner/disabled-one\",\"enabled\":false}");
        writeSkill(skillsRoot, "no-meta-skill", null);

        HarnessEngine engine = newEngine();
        Map<String, String> map = SkillDisplayNames.ofAll(engine.getSkillsAll());

        Assertions.assertEquals("enabled-one", map.get("_owner_enabled-one"));
        Assertions.assertEquals("disabled-one", map.get("_owner_disabled-one"),
                "禁用技能必须收录：历史账本里还有它的调用记录");
        Assertions.assertFalse(map.containsKey("no-meta-skill"),
                "无 meta 的技能不进映射（前端回退 name）");
    }

    // ==================== 3. 接线：真实端点确实带上了展示名 ====================

    @Test
    @DisplayName("接线：/web/chat/session/tool-usage 真实回包带 displayName")
    @SuppressWarnings("unchecked")
    void endpointWiresDisplayNamesIntoUsageRows() throws Exception {
        // 真实目录结构：会话落在 <workspace>/.gwork/sessions/<sid>/
        HarnessEngine engine = newEngine();
        Path skillsRoot = engine.getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Files.createDirectories(skillsRoot);
        writeSkill(skillsRoot, "_owner_wired-skill",
                "{\"market\":\"m\",\"slug\":\"@owner/wired-skill\",\"displayName\":\"接线展示名.Skill\"}");
        engine.refreshTalents();

        Path sessionsRoot = Path.of(workspace.toString(), ".gwork", "sessions", SESSION_ID);
        Files.createDirectories(sessionsRoot);
        Files.write(sessionsRoot.resolve(SESSION_ID + ".usage.ndjson"),
                (ledger("skillread", "_owner_wired-skill") + "\n").getBytes(StandardCharsets.UTF_8));

        SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(),
                ".gwork/sessions/");
        // 真实链路：Web 层在处理聊天输入前先把 sessionId → 工作空间根登记到定位器
        // （不登记则 resolveDir 回退到 globalBase，会把项目会话认成全局会话）
        locator.bindSessionRoot(SESSION_ID, workspace.toString());
        WebController controller = new WebController(engine, null, null, locator,
                new com.gourdai.core.config.AgentSettings());
        Result<?> result = controller.sessionToolUsage(null, SESSION_ID, null);

        Assertions.assertEquals(200, result.getCode(), "端点必须成功: " + result);
        Map<String, Object> data = (Map<String, Object>) result.getData();
        List<Map<String, Object>> rows = (List<Map<String, Object>>) data.get("skills");
        Assertions.assertEquals(1, rows.size(), "应统计到 1 条技能行: " + rows);

        Map<String, Object> row = rows.get(0);
        Assertions.assertEquals("_owner_wired-skill", row.get("name"), "name 保持账本原始值");
        Assertions.assertEquals("接线展示名.Skill", row.get("displayName"),
                "端点必须把展示名接进技能行——技能页与监控显示同一个名字");
    }

    @Test
    @DisplayName("接线：技能已卸载（映射里没有）时回包不带 displayName，前端回退 name")
    @SuppressWarnings("unchecked")
    void endpointOmitsDisplayNameForUninstalledSkill() throws Exception {
        HarnessEngine engine = newEngine();   // 技能目录刻意留空 = 技能已卸载
        Path sessionsRoot = Path.of(workspace.toString(), ".gwork", "sessions", SESSION_ID);
        Files.createDirectories(sessionsRoot);
        Files.write(sessionsRoot.resolve(SESSION_ID + ".usage.ndjson"),
                (ledger("skillread", "_owner_gone-skill") + "\n").getBytes(StandardCharsets.UTF_8));

        SessionLocator locator = new SessionLocator(workspace.toString(), globalBase.toString(),
                ".gwork/sessions/");
        locator.bindSessionRoot(SESSION_ID, workspace.toString());
        WebController controller = new WebController(engine, null, null, locator,
                new com.gourdai.core.config.AgentSettings());
        Result<?> result = controller.sessionToolUsage(null, SESSION_ID, null);

        Map<String, Object> data = (Map<String, Object>) result.getData();
        List<Map<String, Object>> rows = (List<Map<String, Object>>) data.get("skills");
        Assertions.assertEquals(1, rows.size(), "应统计到 1 条技能行: " + rows);
        Assertions.assertFalse(rows.get(0).containsKey("displayName"),
                "已卸载技能算不出展示名，不得留空字符串字段（前端按「字段存在」判定是否覆盖 name）");
        Assertions.assertEquals("_owner_gone-skill", rows.get(0).get("name"));
    }

    // ==================== 夹具 ====================

    private HarnessEngine newEngine() {
        return HarnessEngine.of(workspace.toString(), globalBase.resolve(".gwork").toString()).build();
    }

    private Path globalSkillsDir() throws Exception {
        Path dir = newEngine().getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Files.createDirectories(dir);
        return dir;
    }

    /**
     * 写一个技能目录：SKILL.md + 可选 {@code .skill-market.json}。
     * 目录名与 frontmatter 名一致（真实安装产物就是如此）。
     */
    private static Path writeSkill(Path root, String dirName, String metaJson) throws Exception {
        Path dir = root.resolve(dirName);
        Files.createDirectories(dir);
        Files.write(dir.resolve("SKILL.md"),
                ("---\nname: " + dirName + "\ndescription: " + dirName + " 描述\n---\nbody\n")
                        .getBytes(StandardCharsets.UTF_8));
        if (metaJson != null) {
            Files.write(dir.resolve(".skill-market.json"), metaJson.getBytes(StandardCharsets.UTF_8));
        }
        return dir;
    }

    private void writeLedger(String... lines) throws Exception {
        Files.createDirectories(sessionDir);
        Files.write(sessionDir.resolve(SESSION_ID + ".usage.ndjson"),
                String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
    }

    /** 账本行：与 {@code SessionStreamStore.recordToolUsage} 的真实落盘形态一致。 */
    private static String ledger(String tool, String skill) {
        return "{\"tool\":\"" + tool + "\",\"ok\":true,\"at\":1760000000000,\"actionId\":\"call_1\""
                + (skill == null ? "" : ",\"skill\":\"" + skill + "\"") + "}";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> skillRow(Map<String, Object> usage, String name) {
        for (Map<String, Object> row : (List<Map<String, Object>>) usage.get("skills")) {
            if (name.equals(row.get("name"))) return row;
        }
        return Assertions.fail("skill row not found: " + name + " in " + usage.get("skills"));
    }

    private static int number(Object value) {
        return ((Number) value).intValue();
    }

    /** 保留以证明夹具用的是合法 JSON（解析失败时给出可读失败而非 NPE）。 */
    @SuppressWarnings("unused")
    private static ONode parse(String json) {
        return ONode.ofJson(json);
    }
}
