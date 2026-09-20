/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.util;

import org.noear.snack4.ONode;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.chat.tool.FunctionToolDesc;

import java.util.Collection;

/**
 * 结构化问答工具（ask_user）
 *
 * <p>工具函数体永远不会真正执行：{@link com.gourdai.agent.react.intercept.AskUserInterceptor}
 * 在 onAction 阶段短路（无答案挂起 / 有答案直接回填结果），此处仅按 FeedbackTool 的语义
 * 提供 {@code {"status":"suspended"}} 兜底返回值，防御任何未挂拦截器的异常调用路径。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class AskUserTool {
    public static final String TOOL_NAME = "ask_user";

    public static final String TOOL_DESCRIPTION = "向用户发起结构化提问并等待回答（支持候选项，可标记推荐；用户可点击选项、自由输入或跳过）。任务将挂起，直到用户回答后自动恢复。【必须使用的场景】凡是你准备在回复正文里列出多个方案（A/B/C、方案一/方案二）让用户挑选，或以「请选择 / 请确认 / 你拍板 / 你选哪个 / 等你确认」之类措辞收尾停下时，一律改为调用本工具，把每个方案作为一个 option 传入——不要让用户自己打字复述选项。需要用户提供你无法自行查询或推断的关键信息（凭据、业务口径、目标取舍）时同样必须调用本工具。使用纪律：1) 多个问题必须在一次调用中成组提出；2) 若有明确最佳实践，请对相应选项标记 recommended=true；3) 能自行查询/推断的信息不要问。";

    /**
     * 系统提示词硬规则（中文）：由 ReAct 提示词在工具可用时条件注入。
     *
     * <p>不含编号前缀，由调用方按其规则列表的顺序拼接编号。</p>
     */
    public static final String PROMPT_RULE_CN = "**主动提问**：当需要用户在多个方案之间做出选择、拍板确认，"
            + "或需要用户提供你无法自行查询/推断的关键信息时，【必须】调用 `ask_user` 工具发起结构化提问"
            + "（把每个候选方案作为一个 option 传入，最佳实践项标记 recommended=true）；"
            + "严禁仅在正文里列出 A/B/C 方案后以「请选择 / 请确认 / 你拍板」收尾、让用户自己打字作答。";

    /**
     * 系统提示词硬规则（英文）：由 ReAct 提示词在工具可用时条件注入。
     */
    public static final String PROMPT_RULE_EN = "**Ask The User**: When the user must choose between multiple options, "
            + "sign off on a decision, or supply key information you cannot look up or infer, "
            + "you MUST call the `ask_user` tool to raise a structured question "
            + "(pass every candidate as an option; mark the best practice with recommended=true). "
            + "NEVER list options A/B/C in your reply and stop with phrases like \"please choose\" or \"your call\" "
            + "that force the user to type the answer.";

    /**
     * 判断当前工具集是否包含 ask_user（用于系统提示词条件注入，避免向无此工具的子代理注入幻觉指令）。
     *
     * @param tools 当前可用工具集（允许为 null）
     */
    public static boolean isAvailable(Collection<FunctionTool> tools) {
        if (tools == null || tools.isEmpty()) {
            return false;
        }

        for (FunctionTool tool : tools) {
            if (tool != null && TOOL_NAME.equals(tool.name())) {
                return true;
            }
        }

        return false;
    }

    /**
     * 嵌套 JSON Schema（手写以保证 detail/options/recommended 的“可选”语义精确可表达）。
     */
    public static final String INPUT_SCHEMA =
            "{\"type\":\"object\",\"properties\":{"
                    + "\"questions\":{\"type\":\"array\",\"description\":\"问题列表（必填）：每项含问题文本 header（必填）、补充说明 detail（可选）与候选项 options（可选）\","
                    + "\"items\":{\"type\":\"object\",\"properties\":{"
                    + "\"header\":{\"type\":\"string\",\"description\":\"问题文本（必填）\"},"
                    + "\"detail\":{\"type\":\"string\",\"description\":\"补充说明（可选）\"},"
                    + "\"options\":{\"type\":\"array\",\"description\":\"候选项列表（可选）\","
                    + "\"items\":{\"type\":\"object\",\"properties\":{"
                    + "\"label\":{\"type\":\"string\",\"description\":\"选项文本（必填）\"},"
                    + "\"recommended\":{\"type\":\"boolean\",\"description\":\"是否为推荐项（可选）\"}"
                    + "},\"required\":[\"label\"]}}"
                    + "},\"required\":[\"header\"]}}"
                    + "},\"required\":[\"questions\"]}";

    public static FunctionTool getTool() {
        return new FunctionToolDesc(TOOL_NAME)
                .description(TOOL_DESCRIPTION)
                .inputSchema(INPUT_SCHEMA)
                .doHandle((args) -> {
                    return ONode.ofBean(args).set("status", "suspended").toJson();
                });
    }
}
