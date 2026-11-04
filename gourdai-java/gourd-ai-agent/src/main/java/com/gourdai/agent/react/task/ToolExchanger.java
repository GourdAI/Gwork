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
package com.gourdai.agent.react.task;

import java.util.Map;

/**
 * Action 工具执行交换器
 *
 * @author oisin
 * @since 3.11.0
 */
public class ToolExchanger {
    private final String toolName;
    private final Map<String, Object> args;
    /**
     * 本次工具调用的唯一标识，同源于 {@code ActionTask} 生成的 actionId
     * （原生调用取 {@code ToolCall.getId()}，文本模式为 {@code toolName#递增序号}）。
     *
     * <p>存在的意义：拦截器（如 HITL）在 onAction 阶段挂起任务时，必须把「究竟是哪一次调用被挂起」
     * 透传给 UI 层。否则前端只能按工具名匹配卡片，并发调用同名工具（如同时两个 bash、其中一个
     * 触发审批）时会接管错对象。</p>
     */
    private final String actionId;
    private String result;

    public ToolExchanger(String toolName, Map<String, Object> args) {
        this(toolName, args, null);
    }

    public ToolExchanger(String toolName, Map<String, Object> args, String actionId) {
        this.toolName = toolName;
        this.args = args;
        this.actionId = actionId;
    }

    public String getToolName() {
        return toolName;
    }

    /**
     * 获取本次调用标识；未提供时为 {@code null}，调用方须容忍并自行降级
     */
    public String getActionId() {
        return actionId;
    }

    public Map<String, Object> getArgs() {
        return args;
    }

    public String getResult() {
        return result;
    }

    public void setResult(String result) {
        this.result = result;
    }
}