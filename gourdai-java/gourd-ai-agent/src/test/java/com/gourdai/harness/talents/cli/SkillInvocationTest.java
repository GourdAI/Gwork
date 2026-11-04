package com.gourdai.harness.talents.cli;

import com.gourdai.ai.talents.registry.TalentRegistry;
import com.gourdai.harness.talents.cli.impl.RegistrySkillProvider;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 斜杠技能调用（{@code /技能名 说明}）的解析契约。
 *
 * <p>背景：技能原先只能由前端插入 {@code $} 前缀，后端零解析——符号连同名字原样
 * 发给模型，能不能用上全看模型是否愿意主动调 {@code skillread}（实测经常不生效）。
 * 现在统一收敛到 {@code /}：命中技能即刻注入 SKILL.md 规约。本测试守住四条：</p>
 * <ol>
 *   <li>{@code /技能名} 与 {@code /技能名 说明} 都能命中；</li>
 *   <li>非技能输入（普通文本、未知名字、{@code $技能名} 旧写法）一律不命中，
 *       交由调用方维持原语义——本类绝不能吞掉别的东西；</li>
 *   <li>两级技能名（{@code 分类/技能名}）不被 "/" 截断；</li>
 *   <li>注入的 Prompt 同时包含技能规约与用户请求，缺一不可；</li>
 *   <li>「勿重复读取」声明成对存在：注入头与系统提示词豁免子句缺一不可，
 *       否则保守模型会把同一份 SKILL.md 读两遍、上下文翻倍。</li>
 * </ol>
 *
 * @author oisin
 */
public class SkillInvocationTest {

    @TempDir
    Path tempDir;

    // ========== 脚手架 ==========

    private Path globalSkillsRoot() throws Exception {
        Path globalBase = Files.createTempDirectory(tempDir, "global-");
        Path skillsRoot = globalBase.resolve(".gwork").resolve("skills");
        Files.createDirectories(skillsRoot);
        return skillsRoot;
    }

    private void writeSkill(Path skillsRoot, String name, String description) throws Exception {
        Path dir = skillsRoot.resolve(name);
        Files.createDirectories(dir);
        String md = "---\nname: " + name + "\ndescription: " + description + "\n---\n\n"
                + "# " + name + "\n\n执行规约正文-" + name + "。\n";
        Files.write(dir.resolve("SKILL.md"), md.getBytes(StandardCharsets.UTF_8));
    }

    /** 用真实注册表构造 provider，确保「解析」与「真扫描结果」口径一致。 */
    private SkillInvocation parse(Path globalSkillsRoot, String input) throws Exception {
        Path globalBase = globalSkillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws-");
        TalentRegistry registry = new TalentRegistry(workspace.toString(), globalBase.toString(), ".gwork/");
        SkillProvider provider = new RegistrySkillProvider(registry);
        return SkillInvocation.parse(registry.getSkills(), provider, input);
    }

    /** 同一技能根下的 SkillTalent，用于校验系统提示词侧的豁免子句。 */
    private SkillTalent talentFor(Path globalSkillsRoot) throws Exception {
        Path globalBase = globalSkillsRoot.getParent().getParent();
        Path workspace = Files.createTempDirectory(tempDir, "ws-talent-");
        TalentRegistry registry = new TalentRegistry(workspace.toString(), globalBase.toString(), ".gwork/");
        return new SkillTalent(new RegistrySkillProvider(registry));
    }

    // ========== 契约 1：命中 ==========

    @Test
    @DisplayName("/技能名 命中并注入 SKILL.md 正文")
    void bareSkillNameHits() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "wechat-ai-publisher", "微信公众号发布");

        SkillInvocation inv = parse(root, "/wechat-ai-publisher");

        assertNotNull(inv, "裸技能名必须命中");
        assertEquals("wechat-ai-publisher", inv.getName());
        assertEquals("", inv.getArgs(), "无补充说明时 args 必须为空串，不能是 null");
        assertTrue(inv.getPrompt().contains("执行规约正文-wechat-ai-publisher"),
                "必须注入 SKILL.md 正文，否则模型仍拿不到规约");
        assertTrue(inv.getPrompt().contains(SkillInvocation.DEFAULT_REQUEST),
                "无补充说明时必须补一句默认指令，避免 Prompt 以规约裸尾结束");
    }

    @Test
    @DisplayName("/技能名 补充说明：说明进 Prompt，且与规约同时在")
    void argsAreCarriedIntoPrompt() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "remotion-best-practices-zh", "Remotion 最佳实践");

        SkillInvocation inv = parse(root, "/remotion-best-practices-zh 做一个 10 秒片头");

        assertNotNull(inv);
        assertEquals("做一个 10 秒片头", inv.getArgs());
        assertTrue(inv.getPrompt().contains("执行规约正文-remotion-best-practices-zh"));
        assertTrue(inv.getPrompt().contains("做一个 10 秒片头"), "用户的补充说明不能被规约吞掉");
    }

    // ========== 契约 2：不命中 ==========

    @Test
    @DisplayName("普通文本 / 未知技能名 / 旧 $ 写法一律不命中（不吞别人的输入）")
    void nonSkillInputsAreRejected() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "video-cinematography", "镜头运动");

        assertNull(parse(root, "帮我看下这个技能"), "普通文本不得命中");
        assertNull(parse(root, "/no-such-skill 做点什么"), "未知名字不得命中");
        assertNull(parse(root, "$video-cinematography"), "旧 $ 写法已移除，不得命中");
        assertNull(parse(root, "/"), "只有触发符时不得命中");
        assertNull(parse(root, "/ video-cinematography"), "触发符与名字之间有空格时不得命中");
        assertNull(parse(root, ""), "空输入不得命中");
        assertNull(parse(root, null), "null 不得命中");
    }

    @Test
    @DisplayName("禁用技能不命中（与 skillread / 提示词清单同口径）")
    void disabledSkillIsRejected() throws Exception {
        Path root = globalSkillsRoot();
        Path dir = root.resolve("muted-skill");
        Files.createDirectories(dir);
        String md = "---\nname: muted-skill\ndescription: 已停用\nenabled: false\n---\n\n# muted\n";
        Files.write(dir.resolve("SKILL.md"), md.getBytes(StandardCharsets.UTF_8));

        assertNull(parse(root, "/muted-skill"),
                "禁用技能不得经斜杠调用复活，否则管理视图的开关就是假的");
    }

    // ========== 契约 3：两级技能名 ==========

    @Test
    @DisplayName("两级技能名（分类/技能名）不被 / 截断")
    void nestedSkillNameIsNotTruncated() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "design/lanhu", "蓝湖设计稿还原");

        SkillInvocation inv = parse(root, "/design/lanhu 还原这个设计稿");

        assertNotNull(inv, "技能名本身含 /，不能按 / 切分名字");
        assertEquals("design/lanhu", inv.getName());
        assertEquals("还原这个设计稿", inv.getArgs());
    }

    // ========== 契约 4：大小写 ==========

    @Test
    @DisplayName("大小写不敏感，但回填的是注册表里的真名")
    void nameMatchIsCaseInsensitive() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "Agent-Browser", "浏览器自动化");

        SkillInvocation inv = parse(root, "/agent-browser 打开首页");

        assertNotNull(inv);
        assertEquals("Agent-Browser", inv.getName(), "Prompt 里的名字应是注册表真名，不是用户输入的大小写");
    }

    // ========== 契约 5：防重复读取的成对声明 ==========

    @Test
    @DisplayName("注入头与系统提示词必须成对声明「勿重复读取」（防同一 SKILL.md 进上下文两遍）")
    void noReloadDeclarationsExistInPair() throws Exception {
        Path root = globalSkillsRoot();
        writeSkill(root, "agent-browser", "浏览器自动化");

        SkillInvocation inv = parse(root, "/agent-browser 打开首页");
        assertNotNull(inv);
        assertTrue(inv.getPrompt().contains("无需再调用 `skillread`"),
                "注入头必须声明规约已全文在列、勿再读取；否则保守模型会再读一遍，上下文出现两份全文");

        String instruction = talentFor(root).getInstruction(null);
        assertNotNull(instruction);
        assertTrue(instruction.contains("若本轮用户消息已随附该技能的完整规约"),
                "系统提示词的「务必 skillread」必须带豁免子句，否则与注入头方向冲突、诱导重复读取");
    }
}
