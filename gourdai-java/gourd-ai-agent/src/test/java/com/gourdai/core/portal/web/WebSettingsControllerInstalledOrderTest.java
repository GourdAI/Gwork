package com.gourdai.core.portal.web;

import com.gourdai.ai.talents.registry.TalentScope;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.portal.web.market.MarketManager;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 已安装列表顺序契约 — {@code /web/settings/skills/installed} 必须按名称稳定排序。
 *
 * <p>注册表底层是 ConcurrentHashMap，{@code values()} 顺序随哈希漂移；不排序会让
 * 已安装列表每次刷新都换位置（用户视角=列表在跳）。本测试写入 8 个技能并断言
 * 返回顺序为大小写不敏感的字典序——8 个键恰好按哈希序排成字典序的概率可忽略，
 * 断言因此能真实捕获「未排序」的回归。</p>
 */
class WebSettingsControllerInstalledOrderTest {

    @TempDir
    Path workspace;

    @TempDir
    Path globalBase;

    @Test
    @DisplayName("已安装列表按名称大小写不敏感字典序返回")
    @SuppressWarnings("unchecked")
    void installedListIsSortedByName() throws Exception {
        // 全局区必须隔离进 @TempDir（绝对 harnessHome）：相对 ".gwork" 会让
        // globalBase 落到 AgentFlags 解析的真实用户目录（~/.gwork/skills），
        // 测试探针会污染用户真实技能库（2026-10 已实际发生过一次）
        HarnessEngine engine = HarnessEngine.of(workspace.toString(),
                globalBase.resolve(".gwork").toString()).build();
        Path skillsRoot = engine.getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Files.createDirectories(skillsRoot);

        String[] names = {"zeta-skill", "Alpha-skill", "mike-skill", "bravo-skill",
                "xray-skill", "charlie-skill", "whiskey-skill", "delta-skill"};
        for (String name : names) {
            Path dir = skillsRoot.resolve(name);
            Files.createDirectories(dir);
            Files.write(dir.resolve("SKILL.md"),
                    ("---\nname: " + name + "\ndescription: " + name + " 描述\n---\nbody\n")
                            .getBytes(StandardCharsets.UTF_8));
        }
        engine.refreshTalents();

        WebSettingsController controller =
                new WebSettingsController(engine, new AgentSettings(), new MarketManager());
        Result result = controller.skillsInstalled(null);
        Assertions.assertEquals(200, result.getCode(), "已安装列表应成功返回: " + result);

        List<Map<String, Object>> skills = (List<Map<String, Object>>) result.getData();
        Assertions.assertEquals(names.length, skills.size(), "应返回全部技能");

        List<String> returned = new ArrayList<>();
        for (Map<String, Object> item : skills) {
            returned.add(String.valueOf(item.get("name")));
        }
        List<String> expected = new ArrayList<>(returned);
        expected.sort(String.CASE_INSENSITIVE_ORDER);
        Assertions.assertEquals(expected, returned, "已安装列表必须按名称稳定排序（不得随哈希漂移）");
    }
}
