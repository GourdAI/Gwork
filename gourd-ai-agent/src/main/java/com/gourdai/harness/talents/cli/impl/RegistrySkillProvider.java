/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.talents.cli.impl;

import com.gourdai.ai.talents.registry.SkillDir;
import com.gourdai.ai.talents.registry.TalentRegistry;
import com.gourdai.harness.talents.cli.SkillProvider;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 基于 {@link TalentRegistry} 的技能提供者。
 *
 * <p>取代已移除的 {@code MountSkillProvider}。对模型可见的输出有一处实质变化：
 * 技能辅助文件原来以 {@code @global-skills/xxx/scripts/y.py} 这样的挂载逻辑路径公示，
 * 现在直接给真实路径。原因见 {@link TalentRegistry#getTrustedReadRoots()}：
 * 挂载别名连同其路径翻译一起被移除了，而全局技能目录已被纳入终端工具的受信只读白名单，
 * 模型拿到真实路径即可直接 {@code read} / 在 {@code bash} 中执行。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
public class RegistrySkillProvider implements SkillProvider {
    private final TalentRegistry registry;

    public RegistrySkillProvider(TalentRegistry registry) {
        this.registry = registry;
    }

    @Override
    public void refresh() {
        registry.refresh();
    }

    @Override
    public int getSkillCount() {
        return registry.getSkillCount();
    }

    @Override
    public Collection<SkillDir> getSkillAll() {
        return registry.getSkills();
    }

    @Override
    public Collection<SkillDir> searchSkill(String query) {
        Collection<SkillDir> skillList = registry.getSkills();
        String[] keys = query.toLowerCase().split("\\s+");

        return skillList.stream()
                .filter(s -> Arrays.stream(keys).anyMatch(k ->
                        s.getName().toLowerCase().contains(k) ||
                                s.getDescription().toLowerCase().contains(k)))
                .limit(15)
                .collect(Collectors.toList());
    }

    @Override
    public String readSkill(String name) {
        SkillDir cachedSkill = registry.getSkill(name);
        if (cachedSkill != null) {
            return renderSkillXml(cachedSkill, true);
        }

        return null;
    }

    // --- 核心渲染与辅助逻辑 ---

    private String renderSkillXml(SkillDir skill, boolean includeFiles) {
        Path md = skill.getRealPath().resolve("SKILL.md");
        if (!Files.exists(md)) {
            md = skill.getRealPath().resolve("skill.md");
        }

        try {
            String content = Files.exists(md) ? new String(Files.readAllBytes(md), StandardCharsets.UTF_8) : "";

            StringBuilder sb = new StringBuilder("\n<skill_content name=\"" + skill.getName() + "\">\n");
            sb.append("[SYSTEM NOTE: Access granted. The <path> entries below are real filesystem paths;")
                    .append(" use them directly with the 'read' tool or inside 'bash' commands.]\n");
            sb.append("[If this task takes many steps, remember to re-read this skill if you feel uncertain about details.]\n");

            sb.append(content.trim()).append("\n\n");

            if (includeFiles) {
                sb.append("<skill_files root=\"").append(escapeXml(skill.getRealPath().toString())).append("\">\n")
                        .append(sampleFiles(skill))
                        .append("</skill_files>\n");
            }
            sb.append("</skill_content>\n");
            return sb.toString();
        } catch (IOException e) {
            return "Load skill " + skill.getName() + " failed.";
        }
    }

    private String sampleFiles(SkillDir skill) throws IOException {
        Path dir = skill.getRealPath();

        // 定义忽略列表，过滤掉干扰项
        Set<String> ignorePatterns = new HashSet<>(Arrays.asList(
                ".DS_Store", "__pycache__", ".git", ".idea", ".vscode", "node_modules", "venv"
        ));

        try (Stream<Path> stream = Files.walk(dir, 3)) { // 深度增至 3，以便看到 scripts/ 下的内容
            return stream.filter(Files::isRegularFile)
                    .filter(p -> {
                        String name = p.getFileName().toString();
                        // 过滤 SKILL.md 本身和隐藏文件/杂质
                        return !name.equalsIgnoreCase("SKILL.md") &&
                                !ignorePatterns.contains(name) &&
                                !name.startsWith(".");
                    })
                    .map(p -> {
                        String relative = dir.relativize(p).toString().replace("\\", "/");

                        // 返回结构化标签：相对路径便于阅读，绝对路径供直接执行
                        return String.format(
                                "  <file>\n" +
                                        "    <rel>%s</rel>\n" +
                                        "    <path>%s</path>\n" +
                                        "  </file>",
                                escapeXml(relative), escapeXml(p.toAbsolutePath().normalize().toString())
                        );
                    })
                    .collect(Collectors.joining("\n"));
        }
    }

    /**
     * 路径进入 XML 属性/文本前的最小转义。
     *
     * <p>Windows 路径本身不含 {@code &<>}，但技能名与描述可能含（它们是用户数据），
     * 不转义会产出畸形 XML，模型据此拼出的路径就是错的。</p>
     */
    private static String escapeXml(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
