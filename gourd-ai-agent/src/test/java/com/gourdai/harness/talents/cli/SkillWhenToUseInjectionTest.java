package com.gourdai.harness.talents.cli;

import com.gourdai.ai.talents.registry.SkillDir;
import com.gourdai.ai.talents.registry.TalentRegistry;
import com.gourdai.harness.talents.cli.impl.RegistrySkillProvider;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.gourdai.ai.chat.tool.FunctionTool;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 「何时使用」提示（frontmatter 的 {@code when_to_use} / {@code trigger}）的注入与检索契约。
 *
 * <p>背景：技能作者写在 SKILL.md 里的触发条件原本是<b>死字段</b> —— {@code Markdown}
 * 没有 getter、全代码库无消费方，模型只能靠 description 反推该不该用这个技能。
 * 本测试守住修复后的三条契约：</p>
 * <ol>
 *   <li>两个字段名都认，{@code when_to_use} 优先于 {@code trigger}；</li>
 *   <li>三个档位（SUMMARY / LIST / SEARCH）与两个工具（skilllist / skillsearch）
 *       的渲染口径一致，未声明时不产出空标签；</li>
 *   <li>检索能按触发词命中 —— 否则字段进了提示词却搜不到，等于白存。</li>
 * </ol>
 *
 * @author oisin
 */
public class SkillWhenToUseInjectionTest {

    @TempDir
    Path tempDir;

    // ========== 脚手架 ==========

    private TalentRegistry registryWith(Path globalBase, Path workspace) {
        return new TalentRegistry(workspace.toString(), globalBase.toString(), ".gwork/");
    }

    private Path globalSkillsRoot() throws Exception {
        Path globalBase = Files.createTempDirectory(tempDir, "global-");
        Path skillsRoot = globalBase.resolve(".gwork").resolve("skills");
        Files.createDirectories(skillsRoot);
        return skillsRoot;
    }

    /** 写一个技能目录；frontmatterExtra 直接拼进 frontmatter 块内。 */
    private Path writeSkill(Path skillsRoot, String name, String description, String frontmatterExtra) throws Exception {
        Path dir = skillsRoot.resolve(name);
        Files.createDirectories(dir);
        String md = "---\nname: " + name + "\ndescription: " + description + "\n"
                + (frontmatterExtra == null ? "" : frontmatterExtra)
                + "---\n\n# " + name + "\n\n正文规约。\n";
        Files.write(dir.resolve("SKILL.md"), md.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    private SkillTalent talentOver(Path globalBase, Path workspace) {
        return new SkillTalent(new RegistrySkillProvider(registryWith(globalBase, workspace)));
    }

    // ========== 契约 1：字段识别与优先级 ==========

    @Test
    @DisplayName("trigger 字段被读取（此前是死字段，模型永远看不到）")
    void triggerFieldIsParsed() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws-");

        writeSkill(skillsRoot, "lanhu-skill", "蓝湖设计稿还原",
                "trigger: 用户提供蓝湖设计稿 URL，或要求还原蓝湖设计图\n");

        SkillDir skill = registryWith(globalBase, workspace).getSkill("lanhu-skill");

        assertNotNull(skill);
        assertTrue(skill.hasWhenToUse(), "trigger 必须被识别为「何时使用」");
        assertEquals("用户提供蓝湖设计稿 URL，或要求还原蓝湖设计图", skill.getWhenToUse());
    }

    @Test
    @DisplayName("when_to_use 字段被读取（Claude Code 标准扩展字段）")
    void whenToUseFieldIsParsed() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws2-");

        writeSkill(skillsRoot, "pdf-skill", "处理 PDF 文件",
                "when_to_use: 用户提到 PDF、表单填写或文档抽取时\n");

        SkillDir skill = registryWith(globalBase, workspace).getSkill("pdf-skill");

        assertNotNull(skill);
        assertEquals("用户提到 PDF、表单填写或文档抽取时", skill.getWhenToUse());
    }

    @Test
    @DisplayName("两者同时声明时 when_to_use 优先（标准字段压过自定义写法）")
    void whenToUseWinsOverTrigger() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws3-");

        writeSkill(skillsRoot, "dual-skill", "双声明技能",
                "trigger: 旧的触发描述\nwhen_to_use: 标准字段优先\n");

        SkillDir skill = registryWith(globalBase, workspace).getSkill("dual-skill");

        assertNotNull(skill);
        assertEquals("标准字段优先", skill.getWhenToUse(), "when_to_use 应压过 trigger");
    }

    @Test
    @DisplayName("两者都未声明时 getWhenToUse 返回空串而非 null（调用方可直接拼接）")
    void absentYieldsEmptyNotNull() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws4-");

        writeSkill(skillsRoot, "plain-skill", "没有触发声明", null);

        SkillDir skill = registryWith(globalBase, workspace).getSkill("plain-skill");

        assertNotNull(skill);
        assertFalse(skill.hasWhenToUse());
        assertEquals("", skill.getWhenToUse(), "必须返回空串，返回 null 会让拼接方 NPE");
    }

    @Test
    @DisplayName("空白值视同未声明（避免注入「[何时使用: ]」这种空标签）")
    void blankValueTreatedAsAbsent() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws5-");

        writeSkill(skillsRoot, "blank-skill", "空白触发", "trigger:    \n");

        SkillDir skill = registryWith(globalBase, workspace).getSkill("blank-skill");

        assertNotNull(skill);
        assertFalse(skill.hasWhenToUse(), "纯空白不应算已声明");
    }

    // ========== 契约 2：提示词与工具渲染 ==========

    @Test
    @DisplayName("SUMMARY 档（≤30）：清单内联「何时使用」片段")
    void summaryModeInjectsWhenToUse() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws6-");

        writeSkill(skillsRoot, "lanhu-skill", "蓝湖设计稿还原",
                "trigger: 用户提供蓝湖设计稿 URL\n");
        writeSkill(skillsRoot, "plain-skill", "无触发声明", null);

        String instruction = talentOver(globalBase, workspace).getInstruction(null);

        assertNotNull(instruction);
        assertTrue(instruction.contains("### 运行模式: 摘要发现"), "2 个技能应走 SUMMARY 档");
        assertTrue(instruction.contains("[何时使用: 用户提供蓝湖设计稿 URL]"),
                "已声明的技能应带触发提示，实际:\n" + instruction);
        assertFalse(instruction.contains("<skill name=\"plain-skill\">无触发声明 [何时使用:"),
                "未声明的技能不得产出空的「何时使用」片段");
    }

    @Test
    @DisplayName("LIST 档（31~100）：description 被丢弃但「何时使用」保留 —— 它是唯一路由线索")
    void listModeKeepsWhenToUseEvenWithoutDescription() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws7-");

        // 造 31 个技能把档位顶到 LIST
        for (int i = 0; i < 31; i++) {
            String name = "skill-" + i;
            String extra = (i == 0) ? "trigger: 第零号技能的独特触发词\n" : null;
            writeSkill(skillsRoot, name, "描述-" + i, extra);
        }

        String instruction = talentOver(globalBase, workspace).getInstruction(null);

        assertNotNull(instruction);
        assertTrue(instruction.contains("### 运行模式: 路径导航"), "31 个技能应走 LIST 档");
        assertTrue(instruction.contains("when_to_use=\"第零号技能的独特触发词\""),
                "LIST 档丢了 description，必须留住触发提示，实际:\n" + instruction);
    }

    @Test
    @DisplayName("skillsearch 结果也带「何时使用」（工具口径与提示词一致）")
    void searchToolRendersWhenToUse() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws8-");

        writeSkill(skillsRoot, "lanhu-skill", "蓝湖设计稿还原",
                "trigger: 用户提供蓝湖设计稿 URL\n");

        // 31 个技能才会开放 skillsearch 工具，但工具方法本身可直接调用验证渲染
        String out = talentOver(globalBase, workspace).skillsearch("蓝湖");

        assertTrue(out.contains("[何时使用: 用户提供蓝湖设计稿 URL]"),
                "搜索结果应带触发提示，实际:\n" + out);
    }

    @Test
    @DisplayName("skilllist 结果也带「何时使用」")
    void listToolRendersWhenToUse() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws9-");

        writeSkill(skillsRoot, "lanhu-skill", "蓝湖设计稿还原",
                "when_to_use: 用户提到蓝湖设计稿\n");

        String out = talentOver(globalBase, workspace).skilllist();

        assertTrue(out.contains("[何时使用: 用户提到蓝湖设计稿]"),
                "列表工具应带触发提示，实际:\n" + out);
    }

    @Test
    @DisplayName("「何时使用」里的 XML 特殊字符被转义（用户数据不得产出畸形标签）")
    void whenToUseIsXmlEscaped() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws10-");

        writeSkill(skillsRoot, "esc-skill", "转义测试",
                "trigger: 含 <尖括号> 与 \"引号\" 及 & 符号\n");

        String instruction = talentOver(globalBase, workspace).getInstruction(null);

        assertNotNull(instruction);
        assertTrue(instruction.contains("&lt;尖括号&gt;"), "尖括号必须转义");
        assertTrue(instruction.contains("&quot;引号&quot;"), "引号必须转义");
        assertTrue(instruction.contains("&amp;"), "& 必须转义");
        assertFalse(instruction.contains("<尖括号>"), "不得残留裸尖括号，否则技能清单 XML 结构被破坏");
    }

    @Test
    @DisplayName("超长「何时使用」被截到上限（提示词体积不得由外部文件无限制撑大）")
    void overlongWhenToUseIsClipped() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws11-");

        String huge = "触发条件".repeat(2000); // 8000 字符，远超上限
        writeSkill(skillsRoot, "huge-skill", "超长触发", "trigger: " + huge + "\n");

        SkillTalent talent = talentOver(globalBase, workspace);
        String instruction = talent.getInstruction(null);

        assertNotNull(instruction);
        assertFalse(instruction.contains(huge), "超长文本必须被截断");
        assertTrue(instruction.contains("…"), "截断处应留省略号作为可见信号");
        // 上限 + 片段包裹的余量，宽松断言避免锁死格式
        assertTrue(instruction.length() < SkillTalent.WHEN_TO_USE_MAX_CHARS * 3,
                "清单体积应受控，实际长度: " + instruction.length());
    }

    @Test
    @DisplayName("连续空白在渲染时压成单空格，但 SkillDir 保留原值（数据层忠实、展示层规整）")
    void multilineWhenToUseIsFlattenedAtRenderTime() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws12-");

        // YAML 平直标量：解析后是单行，但内部可能带多空格与制表符
        writeSkill(skillsRoot, "fold-skill", "折叠测试",
                "trigger: 第一段   第二段\t第三段\n");

        TalentRegistry registry = registryWith(globalBase, workspace);
        SkillDir skill = registry.getSkill("fold-skill");

        assertNotNull(skill);
        // 数据层不改写作者原文（只 trim），避免丢失信息
        assertEquals("第一段   第二段\t第三段", skill.getWhenToUse(),
                "SkillDir 应保留原始空白，规整只属于渲染职责");

        // 展示层压平：清单里一个技能占一行，不得被内部空白撑成多行
        String instruction = talentOver(globalBase, workspace).getInstruction(null);
        assertNotNull(instruction);
        assertTrue(instruction.contains("[何时使用: 第一段 第二段 第三段]"),
                "渲染时应压成单空格，实际:\n" + instruction);
    }

    // ========== 契约 3：检索 ==========

    @Test
    @DisplayName("skillsearch 能按触发词命中（description 里没有该词也能搜到）")
    void searchHitsByTriggerWords() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws13-");

        // description 刻意不含"设计稿"三字，只有 trigger 里有
        writeSkill(skillsRoot, "lanhu-skill", "蓝湖代码生成",
                "trigger: 用户提供设计稿 URL 时使用\n");

        RegistrySkillProvider provider = new RegistrySkillProvider(registryWith(globalBase, workspace));
        Collection<SkillDir> hits = provider.searchSkill("设计稿");

        assertEquals(1, hits.size(), "触发词应参与检索，否则字段进了提示词却搜不到");
        assertEquals("lanhu-skill", hits.iterator().next().getName());
    }

    @Test
    @DisplayName("检索仍按 name 与 description 命中（未回归原有能力）")
    void searchStillHitsNameAndDescription() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws14-");

        writeSkill(skillsRoot, "ppt-skill", "演示文稿生成助手", null);

        RegistrySkillProvider provider = new RegistrySkillProvider(registryWith(globalBase, workspace));

        assertEquals(1, provider.searchSkill("ppt-skill").size(), "按名字命中");
        assertEquals(1, provider.searchSkill("演示文稿").size(), "按描述命中");
        assertEquals(0, provider.searchSkill("不存在的词").size(), "无关词应零命中");
    }

    // ========== 契约 5：提示词推荐与工具面一致（防死路） ==========

    /**
     * 从提示词里抽出所有被推荐的 skill* 工具名。
     *
     * <p><b>不能只认反引号包裹的名字</b> —— 曾有一版前言把 skillsearch 写成裸文本
     * （「可通过 skillsearch 搜索」），只看反引号的护栏直接漏报，变异测试跑下来
     * SURVIVED。因此这里改为匹配四个确切工具名的词边界。</p>
     *
     * <p>用确切词表而非 {@code skill[a-z]+} 是为了避开清单里的
     * {@code <skill_list>} / {@code <skill_files>} 这类 XML 标签名
     * （它们含下划线，不会与本词表碰撞）。</p>
     */
    private static Set<String> recommendedTools(String instruction) {
        Set<String> names = new LinkedHashSet<>();
        Matcher m = Pattern.compile("\\b(skillread|skilllist|skillsearch|skillrefresh)\\b")
                .matcher(instruction);
        while (m.find()) {
            names.add(m.group(1));
        }
        return names;
    }

    private static Set<String> availableTools(SkillTalent talent) {
        Set<String> names = new LinkedHashSet<>();
        Collection<FunctionTool> tools = talent.getTools(null);
        if (tools != null) {
            for (FunctionTool t : tools) {
                names.add(t.name());
            }
        }
        return names;
    }

    /** 造 n 个技能，把档位顶到指定区间。 */
    private SkillTalent talentWithSkillCount(Path skillsRoot, int count) throws Exception {
        for (int i = 0; i < count; i++) {
            writeSkill(skillsRoot, "skill-" + i, "描述-" + i, null);
        }
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws-tier-" + count + "-");
        return talentOver(globalBase, workspace);
    }

    @Test
    @DisplayName("SUMMARY 档：提示词推荐的工具必须全部真实开放（前言不得绑定 skillsearch）")
    void summaryTierRecommendationsAllExist() throws Exception {
        SkillTalent talent = talentWithSkillCount(globalSkillsRoot(), 2);

        String instruction = talent.getInstruction(null);
        assertNotNull(instruction);
        assertTrue(instruction.contains("### 运行模式: 摘要发现"));

        Set<String> recommended = recommendedTools(instruction);
        Set<String> available = availableTools(talent);

        assertFalse(recommended.isEmpty(), "应至少推荐 skillread");
        assertTrue(available.containsAll(recommended),
                "SUMMARY 档推荐了不存在的工具，模型照着调必然失败。推荐=" + recommended
                        + " 实际开放=" + available);
    }

    @Test
    @DisplayName("LIST 档：提示词推荐的工具必须全部真实开放（曾推荐被过滤掉的 skillsearch）")
    void listTierRecommendationsAllExist() throws Exception {
        SkillTalent talent = talentWithSkillCount(globalSkillsRoot(), 31);

        String instruction = talent.getInstruction(null);
        assertNotNull(instruction);
        assertTrue(instruction.contains("### 运行模式: 路径导航"), "31 个技能应走 LIST 档");

        Set<String> recommended = recommendedTools(instruction);
        Set<String> available = availableTools(talent);

        assertTrue(available.containsAll(recommended),
                "LIST 档推荐了不存在的工具。推荐=" + recommended + " 实际开放=" + available);
        assertTrue(recommended.contains("skilllist"),
                "本档丢了描述，必须把 skilllist（能一次拿回全量描述）告知模型，推荐=" + recommended);
    }

    @Test
    @DisplayName("SEARCH 档：提示词推荐的工具必须全部真实开放")
    void searchTierRecommendationsAllExist() throws Exception {
        SkillTalent talent = talentWithSkillCount(globalSkillsRoot(), 101);

        String instruction = talent.getInstruction(null);
        assertNotNull(instruction);
        assertTrue(instruction.contains("### 运行模式: 动态发现"), "101 个技能应走 SEARCH 档");

        Set<String> recommended = recommendedTools(instruction);
        Set<String> available = availableTools(talent);

        assertTrue(recommended.contains("skillsearch"), "本档必须推荐 skillsearch");
        assertTrue(available.containsAll(recommended),
                "SEARCH 档推荐了不存在的工具。推荐=" + recommended + " 实际开放=" + available);
    }

    // ========== 契约 4：skillread 正文不受影响 ==========

    @Test
    @DisplayName("skillread 仍返回 SKILL.md 原文（frontmatter 原样保留，不改写技能内容）")
    void skillreadReturnsRawMarkdown() throws Exception {
        Path skillsRoot = globalSkillsRoot();
        Path globalBase = skillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws15-");

        writeSkill(skillsRoot, "lanhu-skill", "蓝湖设计稿还原",
                "trigger: 用户提供蓝湖设计稿 URL\n");

        String content = talentOver(globalBase, workspace).skillread("lanhu-skill", null);

        assertNotNull(content);
        assertTrue(content.contains("trigger: 用户提供蓝湖设计稿 URL"),
                "skillread 返回的是原文，frontmatter 不应被吞掉");
        assertTrue(content.contains("正文规约。"), "正文必须完整返回");
    }
}
