package com.gourdai.ai.talents.registry;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * TalentRegistry 启禁用过滤测试 — 禁用技能对模型不可见、对管理视图可见。
 *
 * <p>契约：getSkills() 排除 {@code enabled: false}；getSkillsAll() 全量返回；
 * 切换 SKILL.md 的 enabled 后 refresh() 立即生效。</p>
 *
 * @author oisin
 */
public class TalentRegistryEnabledFilterTest {

    @TempDir
    Path tempDir;

    private TalentRegistry registryWith(Path globalBase, Path workspace) {
        return new TalentRegistry(workspace.toString(), globalBase.toString(), ".gwork/");
    }

    private Path writeSkill(Path skillsRoot, String name, String frontmatterExtra) throws Exception {
        Path dir = skillsRoot.resolve(name);
        Files.createDirectories(dir);
        String md = "---\nname: " + name + "\ndescription: " + name + " 描述\n"
                + (frontmatterExtra == null ? "" : frontmatterExtra)
                + "---\n\n# " + name + "\n";
        Files.write(dir.resolve("SKILL.md"), md.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    @Test
    @DisplayName("禁用技能不出现在 getSkills()，但出现在 getSkillsAll()")
    void disabledHiddenFromModel() throws Exception {
        Path globalBase = Files.createTempDirectory(tempDir, "global-");
        Path workspace = Files.createTempDirectory(tempDir, "ws-");
        Path skillsRoot = globalBase.resolve(".gwork").resolve("skills");
        Files.createDirectories(skillsRoot);

        writeSkill(skillsRoot, "ok-skill", null);
        writeSkill(skillsRoot, "off-skill", "enabled: false\n");

        TalentRegistry registry = registryWith(globalBase, workspace);

        assertEquals(2, registry.getSkillsAll().size(), "管理视图应看到全部");
        assertEquals(1, registry.getSkills().size(), "模型可见面应排除禁用技能");
        assertTrue(registry.getSkills().stream().anyMatch(s -> "ok-skill".equals(s.getName())));
        assertFalse(registry.getSkills().stream().anyMatch(s -> "off-skill".equals(s.getName())));

        SkillDir off = registry.getSkill("off-skill");
        assertNotNull(off);
        assertFalse(off.isEnabled());
    }

    @Test
    @DisplayName("setEnabled 后 refresh()：禁用/启用立即在两个视图生效")
    void toggleThenRefresh() throws Exception {
        Path globalBase = Files.createTempDirectory(tempDir, "global2-");
        Path workspace = Files.createTempDirectory(tempDir, "ws2-");
        Path skillsRoot = globalBase.resolve(".gwork").resolve("skills");
        Files.createDirectories(skillsRoot);

        Path okDir = writeSkill(skillsRoot, "toggle-skill", null);

        TalentRegistry registry = registryWith(globalBase, workspace);
        assertEquals(1, registry.getSkills().size());

        assertTrue(SkillMdFrontmatter.setEnabled(okDir, false));
        registry.refresh();
        assertEquals(0, registry.getSkills().size(), "禁用后模型可见面应为空");
        assertEquals(1, registry.getSkillsAll().size());

        assertTrue(SkillMdFrontmatter.setEnabled(okDir, true));
        registry.refresh();
        assertEquals(1, registry.getSkills().size(), "重新启用后应恢复可见");
    }

    @Test
    @DisplayName("getSkillsByScope 仍按作用域返回（含禁用），卸载/反查不受过滤影响")
    void byScopeIncludesDisabled() throws Exception {
        Path globalBase = Files.createTempDirectory(tempDir, "global3-");
        Path workspace = Files.createTempDirectory(tempDir, "ws3-");
        Path skillsRoot = globalBase.resolve(".gwork").resolve("skills");
        Files.createDirectories(skillsRoot);

        writeSkill(skillsRoot, "off-skill", "enabled: false\n");

        TalentRegistry registry = registryWith(globalBase, workspace);

        assertEquals(1, registry.getSkillsByScope(TalentScope.GLOBAL).size(),
                "卸载/反查走 getSkillsByScope，必须能看到禁用技能");
    }
}
