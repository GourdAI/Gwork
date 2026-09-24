/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react;

import com.gourdai.agent.util.AskUserTool;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.chat.tool.FunctionToolDesc;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.Collections;
import java.util.List;

/**
 * ask_user 主动提问硬规则的注入契约。
 *
 * <p>背景（2026-09-17 实证）：ask_user 的挂起-恢复链路、question 帧下发与前端渲染都是健康的，
 * 但模型侧几乎从不发起该工具调用——系统提示词里零处提到 ask_user，模型唯一能看到的引导是
 * 工具 description，且其中只有「别问」的抑制条款而没有「必须问」的判据。
 * 结果就是模型把 A/B/C 方案写进正文后以「请选择/你拍板」收尾，用户只能手打答案。</p>
 *
 * <p>本测试锁定修复形态：
 * 1) 工具描述含强触发措辞、不得回退到抑制措辞；
 * 2) 硬规则仅在 ask_user 真正位于当前工具集时注入（子代理无该工具，注入会诱导幻觉调用）；
 * 3) 中英双语提示词、NATIVE_TOOL 与 STRUCTURED_TEXT 两种风格都接上了条件注入。</p>
 */
class AskUserPromptRuleTest {

    // ==================== 基础设施 ====================

    /** 仅覆写工具集的选项桩：避免为构造 ChatModel 拉起整条模型链路。 */
    private static class StubOptions extends ReActOptions {
        private final Collection<FunctionTool> tools;

        StubOptions(Collection<FunctionTool> tools) {
            super(null);
            this.tools = tools;
        }

        @Override
        public Collection<FunctionTool> getTools() {
            return tools;
        }
    }

    /** 仅覆写选项的 trace 桩（getNaturalInstruction 只依赖 options 与 instructionProvider）。 */
    private static class StubTrace extends ReActTrace {
        private final ReActOptions options;

        StubTrace(Collection<FunctionTool> tools) {
            this.options = new StubOptions(tools);
        }

        @Override
        public ReActOptions getOptions() {
            return options;
        }
    }

    private static FunctionTool otherTool() {
        return new FunctionToolDesc("read")
                .description("读取文件内容")
                .doHandle((args) -> "ok");
    }

    private static String readSource(String relativePath) throws IOException {
        Path path = Paths.get(relativePath);
        Assertions.assertTrue(Files.exists(path), "源码文件不存在：" + path.toAbsolutePath());
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    // ==================== 1. 工具描述措辞 ====================

    @Test
    void toolDescriptionCarriesMandatoryTrigger() {
        String desc = AskUserTool.TOOL_DESCRIPTION;

        // 强触发：必须点明「正文列方案让用户挑」这一具体反面场景
        Assertions.assertTrue(desc.contains("必须使用的场景"), "描述必须给出「必须调用」的判据");
        Assertions.assertTrue(desc.contains("A/B/C"), "描述必须点名正文列选项这一反面场景");
        Assertions.assertTrue(desc.contains("recommended=true"), "描述必须保留推荐项纪律");

        // 防回退：旧描述里的抑制条款让模型偏向「写正文而不调用」，不得再出现
        Assertions.assertFalse(desc.contains("仅在确实需要用户输入才能继续时使用"),
                "抑制性措辞已被判定为不调用的根因之一，不得回退");

        Assertions.assertEquals(desc, AskUserTool.getTool().description(),
                "工具实例描述必须与常量同源");
    }

    @Test
    void toolDescriptionCarriesPresentationDiscipline() {
        // 真实会话取证：414 个选项里 90% 把「标题：解释」整段塞进 label（中位 41 字、最长 321 字），
        // 另有 80 个 label 自带「推荐」字样——问答卡因此难以扫读。描述与硬规则必须讲清分工。
        String desc = AskUserTool.TOOL_DESCRIPTION;
        Assertions.assertTrue(desc.contains("短标题"), "描述必须要求 label 只写短标题");
        Assertions.assertTrue(desc.contains("写进 description"), "描述必须指明解释写进 description");
        Assertions.assertTrue(desc.contains("不要写进 label"), "描述必须禁止把「推荐」字样写进 label");
        Assertions.assertTrue(desc.contains("不要塞进 detail"), "描述必须约束 detail 不放长篇分析");

        Assertions.assertTrue(AskUserTool.PROMPT_RULE_CN.contains("description"), "中文硬规则同样要点明 description 分工");
        Assertions.assertTrue(AskUserTool.PROMPT_RULE_EN.contains("description"), "英文硬规则同样要点明 description 分工");
    }

    // ==================== 2. 工具可用性判定 ====================

    @Test
    void availabilityDetectionHandlesEdgeCases() {
        Assertions.assertFalse(AskUserTool.isAvailable(null), "null 工具集不得视为可用");
        Assertions.assertFalse(AskUserTool.isAvailable(Collections.emptyList()), "空工具集不得视为可用");
        Assertions.assertFalse(AskUserTool.isAvailable(List.of(otherTool())), "无 ask_user 时不得视为可用");
        Assertions.assertTrue(AskUserTool.isAvailable(List.of(otherTool(), AskUserTool.getTool())),
                "工具集含 ask_user 时必须识别");
    }

    // ==================== 3. 条件注入（NATIVE_TOOL 真实行为） ====================

    @Test
    void ruleInjectedOnlyWhenToolAvailableCn() {
        ReActSystemPromptCn prompt = (ReActSystemPromptCn) ReActSystemPromptCn.getDefault();

        String withTool = prompt.getNaturalInstruction(
                new StubTrace(List.of(otherTool(), AskUserTool.getTool())));
        Assertions.assertTrue(withTool.contains("`ask_user`"), "工具可用时必须注入硬规则");
        Assertions.assertTrue(withTool.contains("主动提问"), "硬规则标题缺失");
        Assertions.assertTrue(withTool.contains("5. "), "硬规则必须作为核心规则第 5 条编号注入");
        Assertions.assertTrue(withTool.contains(AskUserTool.PROMPT_RULE_CN), "注入内容必须与常量同源");

        String withoutTool = prompt.getNaturalInstruction(new StubTrace(List.of(otherTool())));
        Assertions.assertFalse(withoutTool.contains("ask_user"),
                "工具不可用（如子代理）时不得注入，否则诱导幻觉调用");
        Assertions.assertTrue(withoutTool.contains("4. **自然回复**"), "原有规则不得被破坏");
    }

    @Test
    void ruleInjectedOnlyWhenToolAvailableEn() {
        ReActSystemPromptEn prompt = (ReActSystemPromptEn) ReActSystemPromptEn.getDefault();

        String withTool = prompt.getNaturalInstruction(
                new StubTrace(List.of(otherTool(), AskUserTool.getTool())));
        Assertions.assertTrue(withTool.contains("`ask_user`"), "工具可用时必须注入硬规则（英文）");
        Assertions.assertTrue(withTool.contains(AskUserTool.PROMPT_RULE_EN), "注入内容必须与常量同源（英文）");
        Assertions.assertTrue(withTool.contains("MUST call"), "英文规则必须使用 MUST 级措辞");

        String withoutTool = prompt.getNaturalInstruction(new StubTrace(List.of(otherTool())));
        Assertions.assertFalse(withoutTool.contains("ask_user"),
                "工具不可用时不得注入（英文）");
        Assertions.assertTrue(withoutTool.contains("4. **Natural Response**"), "原有规则不得被破坏（英文）");
    }

    // ==================== 4. 经典文本模式接线（源码护栏） ====================

    @Test
    void structuredTextStyleAlsoWiredUp() throws IOException {
        String cn = readSource("src/main/java/com/gourdai/agent/react/ReActSystemPromptCn.java");
        String en = readSource("src/main/java/com/gourdai/agent/react/ReActSystemPromptEn.java");

        String guard = "AskUserTool.isAvailable(trace.getOptions().getTools())";

        // NATIVE_TOOL 与 STRUCTURED_TEXT 两条指令路径各一处，缺一处即有一种风格拿不到硬规则
        Assertions.assertEquals(2, countOccurrences(cn, guard),
                "中文提示词的两种风格都必须接上条件注入");
        Assertions.assertEquals(2, countOccurrences(en, guard),
                "英文提示词的两种风格都必须接上条件注入");

        Assertions.assertTrue(cn.contains("AskUserTool.PROMPT_RULE_CN"), "中文必须复用 PROMPT_RULE_CN 常量");
        Assertions.assertTrue(en.contains("AskUserTool.PROMPT_RULE_EN"), "英文必须复用 PROMPT_RULE_EN 常量");

        // 负样本对照：护栏字符串必须真的能区分（避免断言恒真）
        Assertions.assertEquals(0, countOccurrences(cn, "AskUserTool.PROMPT_RULE_EN"),
                "中文提示词不应引用英文规则常量");
    }

    private static int countOccurrences(String text, String token) {
        int count = 0;
        int from = 0;
        while (true) {
            int idx = text.indexOf(token, from);
            if (idx < 0) {
                break;
            }
            count++;
            from = idx + token.length();
        }
        return count;
    }
}
