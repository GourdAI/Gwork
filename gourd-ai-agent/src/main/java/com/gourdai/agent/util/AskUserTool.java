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
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;

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

    public static final String TOOL_DESCRIPTION = "当任务需要用户提供关键信息、做出选择或确认时，向用户发起结构化提问并等待回答。支持提供候选项（可标记推荐）；用户可点击选项、自由输入或跳过。任务将挂起，直到用户回答后自动恢复。使用纪律：1) 仅在确实需要用户输入才能继续时使用（能自行查询/推断的信息不要问）；2) 多个问题必须在一次调用中成组提出；3) 若有明确最佳实践，请对相应选项标记 recommended=true。";

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
