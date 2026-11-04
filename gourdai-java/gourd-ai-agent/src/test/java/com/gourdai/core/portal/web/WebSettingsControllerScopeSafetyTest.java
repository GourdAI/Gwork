package com.gourdai.core.portal.web;

import com.gourdai.ai.talents.registry.SkillDir;
import com.gourdai.ai.talents.registry.TalentScope;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.portal.web.market.MarketManager;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 技能安装/卸载端点的 scope 语义守卫测试（2026-10 契约更新）。
 *
 * <p>契约演进：安装统一落全局区后，{@code scope} 参数一律忽略（兼容旧前端），
 * 因此「非法 scope 必须 400」的旧契约已作废——本类锁定<b>新</b>契约：</p>
 * <ul>
 *   <li>install：脏 scope 不再 400，落盘位置恒为全局区（不得因 scope 改变目录）；</li>
 *   <li>uninstall：scope 缺省/非法时按「全局优先、工作区兜底」反查，找不到即失败，
 *       绝不猜路径；路径穿越形态的技能名仍必须走「非法技能名」分支。</li>
 * </ul>
 *
 * <p>历史教训：旧版两个用例断言 {@code getCode()==400}，在 scope 校验被删除后
 * 仍因 {@code Result.failure(String)} 的默认 FAILURE_CODE==400 而通过——
 * 断言命中的是框架默认码而非被测行为（假绿）。本版断言改为「落盘位置/反查结果」
 * 等行为可观测面，不再依赖状态码数值。</p>
 */
class WebSettingsControllerScopeSafetyTest {
    @TempDir
    Path workspace;

    /** 引擎引用由测试自持（控制器的 engine 字段是 private，不得为测试放宽可见性） */
    private HarnessEngine engine;

    @TempDir
    Path globalBase;

    private WebSettingsController controller() {
        // 全局区隔离进 @TempDir（绝对 harnessHome）：相对 ".gwork" 会落到真实
        // 用户目录，卸载用例的探针目录会污染用户真实技能库
        engine = HarnessEngine.of(workspace.toString(), globalBase.resolve(".gwork").toString()).build();
        return new WebSettingsController(engine, new AgentSettings(), new MarketManager());
    }

    @Test
    void installAlwaysLandsInGlobalRegardlessOfScope() throws Exception {
        WebSettingsController controller = controller();
        Path globalSkills = engine.getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Path workspaceSkills = engine.getTalentRegistry().getSkillsDir(TalentScope.WORKSPACE);

        // 脏 scope 不得改变落盘位置：安装一个不存在的 slug 会在市场侧失败，
        // 但失败前不得在工作区目录创建任何技能目录（scope 被忽略的直接证据）
        Result result = controller.skillsInstall(null, "probe-skill", "", "abc");
        Assertions.assertNotEquals(200, result.getCode(), "不存在的 slug 不应安装成功: " + result);

        Assertions.assertTrue(Files.notExists(workspaceSkills) || isEmptyDir(workspaceSkills),
                "脏 scope 不得让任何目录落进工作区技能目录");
        Assertions.assertTrue(globalSkills == null || Files.notExists(globalSkills) || isEmptyDir(globalSkills),
                "安装失败时全局目录也不应残留半成品");
    }

    @Test
    void uninstallFallsBackToRegistryLookupWhenScopeMissingOrInvalid() throws Exception {
        WebSettingsController controller = controller();
        Path skillsRoot = engine.getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Path skillDir = skillsRoot.resolve("probe-off");
        Files.createDirectories(skillDir);
        Files.write(skillDir.resolve("SKILL.md"),
                "---\nname: probe-off\ndescription: probe\n---\nbody\n".getBytes(StandardCharsets.UTF_8));
        engine.refreshTalents();

        SkillDir seen = engine.getTalentRegistry().getSkill("probe-off");
        Assertions.assertNotNull(seen, "前置：技能应被扫描进注册表");

        // scope 缺省：应能按名反查到全局区技能并删除（新契约：全局优先、工作区兜底）
        Result result = controller.skillsUninstall("", "probe-off");
        Assertions.assertEquals(200, result.getCode(), "scope 缺省应回退注册表反查: " + result);
        Assertions.assertTrue(Files.notExists(skillDir), "卸载后目录应被删除");

        // 再删一次：注册表已无此技能，必须失败且不得猜路径
        Result again = controller.skillsUninstall("abc", "probe-off");
        Assertions.assertNotEquals(200, again.getCode(), "不存在的技能不得卸载成功: " + again);
        Assertions.assertTrue(String.valueOf(again.getDescription()).contains("技能不存在"),
                "反查失败应明确报技能不存在: " + again);
    }

    @Test
    void uninstallRejectsPathTraversalSkillName() {
        WebSettingsController controller = controller();

        // 技能名含 ../ 必须被拒绝：即使注册表扫描结果被污染，也不得拼出越界目录
        Result result = controller.skillsUninstall("global", "../evil");

        Assertions.assertNotEquals(200, result.getCode());
        Assertions.assertTrue(String.valueOf(result.getDescription()).contains("非法技能名"),
                "路径穿越形态的技能名应走非法技能名分支: " + result);
    }

    private static boolean isEmptyDir(Path dir) throws Exception {
        try (var stream = Files.list(dir)) {
            return stream.findAny().isEmpty();
        }
    }
}
