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

    /**
     * 工具描述（契约 §1.1 精简版，双内核逐字一致）。
     *
     * <p>第 4 条「呈现纪律」来自真实会话取证（146 个会话 / 414 个选项）：选项 label 中位 41 字、
     * 最长 321 字，90% 把「标题：解释」整段塞进 label，另有 80 个 label 自带「推荐」字样。
     * 问答卡把选项渲染为「粗体短标题 + 推荐胶囊 + 一行灰色说明」，解释必须落到 description 才能扫读。</p>
     *
     * <p>与 {@link #PROMPT_RULE_CN} 去重：呈现纪律细节保留，「必须使用的场景」的重复展开
     * 收敛为一句（硬规则由系统提示词条件注入承担）。字数约束全部是引导（「建议」措辞），
     * 严禁实现成硬校验失败（Qwen PR#7063 教训：header 超长硬拒 → 弹层整个不出现）。</p>
     */
    public static final String TOOL_DESCRIPTION = "向用户发起结构化提问并等待回答。用户可点击选项、自由输入或跳过；任务挂起直到回答后自动恢复。\n"
            + "【必须使用】准备在正文列出多个方案让用户挑选，或以「请选择/请确认/你拍板」等措辞收尾等待时，一律改为调用本工具，把每个方案作为一个 option 传入；需要用户无法自行查询/推断的关键信息（凭据、业务口径、目标取舍）时同样必须调用。\n"
            + "纪律：1) 多个问题一次调用成组提出（1-4 个）；2) 最佳实践项标 recommended=true，不要把「推荐」写进 label；3) 能自行查询/推断的信息不要问；4) 呈现简洁：header 一句话（建议≤30字），label 短标题（建议≤12字），取舍写进 description（建议≤40字），长篇背景写正文；5) 选项互斥单选；仅当选项可同时成立时传 multiSelect=true；6) 不要自造「其他/自定义」选项，界面自动提供自由输入；7) 选项不要包含时间估计。";

    /**
     * 系统提示词硬规则（中文）：由 ReAct 提示词在工具可用时条件注入。
     *
     * <p>不含编号前缀，由调用方按其规则列表的顺序拼接编号。</p>
     */
    public static final String PROMPT_RULE_CN = "**主动提问**：需要用户在方案间选择、拍板确认，"
            + "或提供你无法自行查询/推断的关键信息时，【必须】调用 `ask_user` 发起结构化提问"
            + "（每个方案一个 option：label 短标题、解释进 description、最佳实践标 recommended=true）；"
            + "严禁仅在正文列出 A/B/C 方案后以「请选择/请确认/你拍板」收尾让用户打字作答。";

    /**
     * 系统提示词硬规则（英文）：由 ReAct 提示词在工具可用时条件注入，与 CN 语义等价。
     */
    public static final String PROMPT_RULE_EN = "**Ask The User**: When the user must choose between options, "
            + "sign off on a decision, or supply key information you cannot look up or infer, "
            + "you MUST call `ask_user` to raise a structured question "
            + "(one option per candidate: short label, explanation in description, best practice marked recommended=true). "
            + "NEVER list options A/B/C in your reply and stop with \"please choose / please confirm / your call\" "
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
     * 嵌套 JSON Schema（手写以保证 detail/options/description/recommended/multiSelect 的“可选”语义精确可表达）。
     *
     * <p>option.description 为可选：旧模型不传时前端按 label 兜底拆分展示，协议向后兼容。
     * multiSelect 为可选布尔（契约 §5.1）：默认 false 单选，向后兼容旧模型/旧前端。
     * 各字段字数约束一律「建议」措辞，不做硬校验。</p>
     */
    public static final String INPUT_SCHEMA =
            "{\"type\":\"object\",\"properties\":{"
                    + "\"questions\":{\"type\":\"array\",\"description\":\"问题列表（必填）：每项含问题文本 header（必填）、补充说明 detail（可选）、候选项 options（可选）与多选开关 multiSelect（可选）；多个问题一次调用成组提出（建议 1-4 个）\","
                    + "\"items\":{\"type\":\"object\",\"properties\":{"
                    + "\"header\":{\"type\":\"string\",\"description\":\"问题文本（必填）：一句话说清要用户决定什么，建议不超过 30 字\"},"
                    + "\"detail\":{\"type\":\"string\",\"description\":\"补充说明（可选）：建议不超过 2 句的决策要点；长篇背景与分析请写在回复正文里\"},"
                    + "\"multiSelect\":{\"type\":\"boolean\",\"description\":\"选项可同时成立时置 true 允许多选；互斥选项保持默认单选\"},"
                    + "\"options\":{\"type\":\"array\",\"description\":\"候选项列表（可选，建议 2-4 个）；不要自造「其他/自定义」选项，界面自动提供自由输入；选项不要包含时间估计\","
                    + "\"items\":{\"type\":\"object\",\"properties\":{"
                    + "\"label\":{\"type\":\"string\",\"description\":\"选项短标题（必填）：建议不超过 12 字；不要写解释，不要写「推荐」字样\"},"
                    + "\"description\":{\"type\":\"string\",\"description\":\"选项一句话说明（可选）：建议不超过 40 字的取舍或影响，界面以灰色小字显示在标题后\"},"
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
