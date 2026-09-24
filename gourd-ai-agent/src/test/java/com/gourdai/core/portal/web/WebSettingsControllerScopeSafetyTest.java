package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.portal.web.market.MarketManager;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Path;

/**
 * 技能安装/卸载端点的 scope 守卫测试。
 *
 * <p>背景：{@code TalentScope.of(scope)} 对无法识别的输入返回 {@code null}，而
 * {@code TalentRegistry.getSkillsDir(null)} 会走 else 分支返回<b>全局</b>技能目录——
 * 若不 fail-fast，前端传脏 scope 时技能会被静默装进跨项目共享的全局区，
 * 违反本 Controller 自己声明的 fail-fast 契约。本测试锁定两处端点：
 * 非法 scope 必须 400，而不是落盘后再靠目录校验兜底。</p>
 */
class WebSettingsControllerScopeSafetyTest {
    @TempDir
    Path workspace;

    @Test
    void installRejectsUnknownScopeInsteadOfFallingBackToGlobal() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller =
                new WebSettingsController(engine, new AgentSettings(), new MarketManager());

        // ctx 在 skillsInstall 方法体内未使用，可传 null
        Result result = controller.skillsInstall(null, "probe-skill", "", "abc");

        Assertions.assertEquals(400, result.getCode(),
                "非法 scope 必须 400 fail-fast，而不是静默走全局目录: " + result);
    }

    @Test
    void uninstallRejectsUnknownScopeBeforeTouchingRegistry() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller =
                new WebSettingsController(engine, new AgentSettings(), new MarketManager());

        Result result = controller.skillsUninstall("abc", "probe-skill");

        Assertions.assertEquals(400, result.getCode(),
                "非法 scope 必须 400，而不是按全局区反查/删除: " + result);
    }

    @Test
    void uninstallRejectsPathTraversalSkillName() {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller =
                new WebSettingsController(engine, new AgentSettings(), new MarketManager());

        // 技能名含 ../ 必须被拒绝：即使注册表扫描结果被污染，也不得拼出越界目录
        Result result = controller.skillsUninstall("global", "../evil");

        Assertions.assertNotEquals(200, result.getCode());
        Assertions.assertTrue(String.valueOf(result).contains("非法技能名"),
                "路径穿越形态的技能名应走非法技能名分支: " + result);
    }
}
