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
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 已安装技能的「展示名」契约 — {@code /web/settings/skills/installed} 必须回传 displayName。
 *
 * <p><b>用户报障</b>：技能在<b>市场里</b>与<b>安装后</b>显示的名字不一样。根因是本地技能名取自
 * <b>安装目录名</b>（namespace 限定 slug 会落成 {@code _owner_slug}），而
 * {@code .skill-market.json} 当时只存 market/slug/iconUrl，没有存展示名，
 * 前端只能拿目录名当标题。</p>
 *
 * <p><b>夹具用合成名字，不拄真实上游值</b>：displayName 的值只用于验证「透传」这一步，
 * 与上游具体叫什么都无关。初版夹具把 {@code @user_814dbe54/dev-expert} 写成「编程专家.Skill」
 * 是<b>错的</b>：上游实测该 namespace 的 name 就是 {@code dev-expert}，
 * 「编程专家.Skill」属于另一位作者 {@code @indiv-ebandao}。
 * 把错误事实写进测试，会成为下一个人误判真相的源头。</p>
 *
 * <p>本测试锁三层口径：</p>
 * <ol>
 *   <li>meta 里有 displayName → 原样透出（新装技能）；</li>
 *   <li>meta 缺失 displayName 但有限定 slug → 退化为裸尾名（旧装技能，比目录名可读）；</li>
 *   <li>无 meta（手放技能的本地技能）→ 不产生 displayName 字段，前端回退目录名。</li>
 * </ol>
 *
 * <p>同时断言 {@code name} 恒为真实目录名——它是卸载/启禁用的定位键，
 * 一旦被展示名污染，操作就会打到错误的技能上。</p>
 */
class WebSettingsControllerInstalledDisplayNameTest {

    @TempDir
    Path workspace;

    @TempDir
    Path globalBase;

    @Test
    @DisplayName("展示名：meta 优先，旧记录退裸尾名，无 meta 不出字段，name 恒为目录名")
    @SuppressWarnings("unchecked")
    void installedListExposesDisplayName() throws Exception {
        HarnessEngine engine = HarnessEngine.of(workspace.toString(),
                globalBase.resolve(".gwork").toString()).build();
        Path skillsRoot = engine.getTalentRegistry().getSkillsDir(TalentScope.GLOBAL);
        Files.createDirectories(skillsRoot);

        // ① 新装技能：meta 带 displayName（writeMarketMeta 的产物形态）；
        //    展示名与目录名刻意毫无关系，才能证明「显示的是展示名、操作的是目录名」
        writeSkill(skillsRoot, "_user_814dbe54_dev-expert", "dev-expert", """
                {"market":"skillhub.cn","slug":"@user_814dbe54/dev-expert","displayName":"示例展示名.Skill"}
                """);

        // ② 旧装技能：meta 无 displayName，slug 为 namespace 限定形态 → 退裸尾名
        writeSkill(skillsRoot, "agent-browser", "agent-browser", """
                {"market":"skillhub.cn","slug":"@someone/agent-browser"}
                """);

        // ③ 本地技能：无 meta → 无 displayName 字段
        writeSkill(skillsRoot, "my-local-skill", "my-local-skill", null);

        engine.refreshTalents();

        WebSettingsController controller =
                new WebSettingsController(engine, new AgentSettings(), new MarketManager());
        Result result = controller.skillsInstalled(null);
        Assertions.assertEquals(200, result.getCode(), "已安装列表应成功返回: " + result);

        List<Map<String, Object>> skills = (List<Map<String, Object>>) result.getData();
        Map<String, Map<String, Object>> byName = skills.stream()
                .collect(Collectors.toMap(m -> String.valueOf(m.get("name")), Function.identity()));

        Assertions.assertTrue(byName.containsKey("_user_814dbe54_dev-expert"),
                "技能名必须是真实目录名（卸载/启禁用靠它定位），实际: " + byName.keySet());

        // ① 市场展示名原样透出
        Assertions.assertEquals("示例展示名.Skill", byName.get("_user_814dbe54_dev-expert").get("displayName"),
                "meta 有 displayName 时必须原样透出（否则安装后只能看到目录名，与市场卡片对不上）");

        // ② 旧记录：无 displayName → 裸尾名（@someone/agent-browser → agent-browser）
        Assertions.assertEquals("agent-browser", byName.get("agent-browser").get("displayName"),
                "旧安装记录必须退化为市场 slug 的裸尾名（而不是 _owner_slug 目录名）");

        // ③ 本地技能：不得凭空造 displayName（前端据此回退目录名）
        Assertions.assertNull(byName.get("my-local-skill").get("displayName"),
                "无市场元数据的本地技能不得产生 displayName 字段");
    }

    private static void writeSkill(Path root, String dirName, String frontmatterName, String metaJson)
            throws Exception {
        Path dir = root.resolve(dirName);
        Files.createDirectories(dir);
        Files.write(dir.resolve("SKILL.md"),
                ("---\nname: " + frontmatterName + "\ndescription: " + frontmatterName + " 描述\n---\nbody\n")
                        .getBytes(StandardCharsets.UTF_8));
        if (metaJson != null) {
            Files.write(dir.resolve(".skill-market.json"), metaJson.getBytes(StandardCharsets.UTF_8));
        }
    }
}
