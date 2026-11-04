package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.portal.web.market.MarketManager;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 技能卸载端点的「链接不递归」与「两级技能名」守卫测试。
 *
 * <p>P1-1：技能目录内含指向外部的 symlink/junction 时，卸载只删链接节点本身，
 * 绝不递归进链接目标删除内容（市场 zip 可携带链接条目，跟随链接等于越界删除）。</p>
 *
 * <p>P1-2：TalentRegistry 支持两级组织（分类/技能名），注册名含 "/" 是合法形态，
 * uninstall 不得因名字含 "/" 而拒绝卸载。</p>
 */
class WebSettingsControllerUninstallSafetyTest {
    @TempDir
    Path workspace;

    private WebSettingsController newController(HarnessEngine engine) {
        return new WebSettingsController(engine, new AgentSettings(), new MarketManager());
    }

    private HarnessEngine newEngine() {
        return HarnessEngine.of(workspace.toString(), ".gwork").build();
    }

    /**
     * 在工作区技能根下造一个技能（可选两级：分类/技能名），返回注册名。
     *
     * <p>注意：HarnessEngine.of(workspace, ".gwork") 的全局区 base 是
     * AgentFlags.getHarnessBase()（真实用户主目录），测试不得写真实全局区；
     * workspace scope 的技能根是 <workspace>/.gwork/skills，隔离在 @TempDir 内。</p>
     */
    private String createSkill(String category, String name) throws Exception {
        Path skillsRoot = workspace.resolve(".gwork").resolve("skills");
        Path dir = (category == null) ? skillsRoot.resolve(name) : skillsRoot.resolve(category).resolve(name);
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("SKILL.md"), "---\ndescription: test skill\n---\n# test\n");
        return (category == null) ? name : category + "/" + name;
    }

    /**
     * P1-2：二级技能名（分类/技能名）必须能通过 uninstall 端点卸载。
     * 修复前：skillName.contains("/") 一律判非法 → 装得上卸不掉。
     */
    @Test
    void uninstallAcceptsTwoLevelSkillName() throws Exception {
        HarnessEngine engine = newEngine();
        WebSettingsController controller = newController(engine);

        String skillName = createSkill("python", "data-tools");
        engine.refreshTalents();

        // 自证前提：注册表确实扫到了这个二级名
        Assertions.assertNotNull(engine.getTalentRegistry().getSkill(skillName),
                "前提：二级技能应被注册表扫描到: " + skillName);

        Result result = controller.skillsUninstall("workspace", skillName);

        Assertions.assertEquals(200, result.getCode(),
                "二级技能名（分类/技能名）必须可卸载，而不是被判非法: " + result);
        Assertions.assertNull(engine.getTalentRegistry().getSkill(skillName),
                "卸载后注册表不应再有该技能");
    }

    /**
     * P1-2 反向：路径穿越形态仍然拦截。含 ".." 的名字无论几级都必须拒绝——
     * 放行 "/" 后，".." 成为唯一的字面拦截线。
     */
    @Test
    void uninstallStillRejectsPathTraversal() {
        HarnessEngine engine = newEngine();
        WebSettingsController controller = newController(engine);

        Result upEscape = controller.skillsUninstall("workspace", "..");
        Result midEscape = controller.skillsUninstall("workspace", "a/../../evil");
        Result backslash = controller.skillsUninstall("workspace", "a\\b");

        Assertions.assertTrue(String.valueOf(upEscape).contains("非法技能名"),
                "纯 .. 必须拒绝: " + upEscape);
        Assertions.assertTrue(String.valueOf(midEscape).contains("非法技能名"),
                "中段 .. 必须拒绝: " + midEscape);
        Assertions.assertTrue(String.valueOf(backslash).contains("非法技能名"),
                "反斜杠必须拒绝: " + backslash);
    }

    /**
     * P1-1：技能目录内的 junction 不被跟随递归删除。
     *
     * <p>Windows 上 junction 无需管理员权限即可创建（本测试用 cmd /c mklink /J），
     * 且 {@code Files.isSymbolicLink()} 对 junction 返回 false、
     * {@code isDirectory(NOFOLLOW)} 返回 true——只有 NOFOLLOW 读 attributes 后
     * {@code isOther()} 才能兜住。修复前 deleteRecursively 跟随链接递归，
     * 会把外部目标的全部内容删光。</p>
     */
    @Test
    void uninstallDoesNotFollowJunctionInsideSkillDir() throws Exception {
        // 外部目标目录（技能根之外），卸载不得删它里面的任何文件
        Path outsideTarget = Files.createDirectories(workspace.resolve("outside").resolve("keep"));
        Files.writeString(outsideTarget.resolve("precious.txt"), "must survive uninstall");
        Path outsideMarker = workspace.resolve("outside").resolve("marker.txt");
        Files.writeString(outsideMarker, "outside root must survive too");

        HarnessEngine engine = newEngine();
        // 工作区技能根：<workspace>/.gwork/skills
        Path skillDir = workspace.resolve(".gwork").resolve("skills").resolve("linked-skill");
        Files.createDirectories(skillDir);
        Files.writeString(skillDir.resolve("SKILL.md"), "---\ndescription: j\n---\n# j\n");

        // 技能目录内的 junction 指向外部目录
        Path junction = skillDir.resolve("assets-link");
        Process p = new ProcessBuilder("cmd", "/c", "mklink", "/J",
                junction.toString(), outsideTarget.toString()).inheritIO().start();
        Assertions.assertEquals(0, p.waitFor(), "测试环境需能创建 junction");

        engine.refreshTalents();
        WebSettingsController controller = newController(engine);

        Result result = controller.skillsUninstall("workspace", "linked-skill");

        Assertions.assertEquals(200, result.getCode(), "卸载应成功: " + result);
        // 链接目标的内容必须原封不动
        Assertions.assertTrue(Files.exists(outsideTarget.resolve("precious.txt")),
                "junction 目标内的文件不得被删除（修复前会被递归删光）");
        Assertions.assertTrue(Files.exists(outsideMarker),
                "junction 目标同级的外部文件不得被删除");
        // 技能目录本身（含 junction 节点）已删
        Assertions.assertFalse(Files.exists(skillDir), "技能目录应被整体移除");
        Assertions.assertFalse(Files.exists(junction), "junction 节点应被删除（节点本身，非目标）");
    }

    /**
     * P1-3：绝对路径 harnessHome 构建的 engine，派生路径不得出现
     * 「workspace + 绝对路径」的双盘符非法路径。
     */
    @Test
    void absoluteHarnessHomeDerivesValidWorkspacePaths() {
        // 绝对 home（@TempDir 场景）
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), workspace.resolve("home").toString()).build();

        // getHarnessSessions() 返回相对名拼接产物；与 workspace 拼接必须是合法路径且不抛异常
        String sessions = engine.getHarnessSessions();
        Assertions.assertNotNull(sessions);
        Assertions.assertFalse(java.nio.file.Paths.get(sessions).isAbsolute(),
                "engine 派生路径必须是相对名（重写发生在字段赋值前）: " + sessions);

        java.nio.file.Path resolved = java.nio.file.Paths.get(engine.getWorkspace(), sessions);
        Assertions.assertTrue(resolved.startsWith(workspace),
                "workspace 侧派生路径必须落在 workspace 内: " + resolved);
        Assertions.assertTrue(resolved.toString().contains("home" + java.io.File.separator + "sessions"),
                "末段名 home 应保留在相对名里: " + resolved);
    }
}
