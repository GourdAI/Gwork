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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.agent.util.AskUserTool;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 结构化问答拦截器 (ask_user)
 *
 * <p>该拦截器通过 ReAct 协议的生命周期钩子实现「挂起-恢复」机制：</p>
 * <ul>
 * <li><b>onAction 阶段</b>：仅处理 {@code ask_user} 工具。无答案则记录挂起任务并暂停执行；
 * 已有答案则把格式化后的答案文本回填为工具结果（不执行真实工具）。</li>
 * <li><b>onObservation 阶段</b>：现场清理挂起任务与答案键，确保 Session 状态幂等。</li>
 * </ul>
 *
 * <p>与 HITL（人工审批）骨架完全同构，区别在于「决策」换成了「答案 JSON」，
 * 且恢复时不做参数修正/拒绝路由，只是把答案作为 Observation 交还给模型继续推理。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class AskUserInterceptor extends AbsReActInterceptor {

    @Override
    public void onAction(ReActTrace trace, ToolExchanger toolExchanger) {
        // 只处理结构化问答工具，其余工具一律放行
        if (!AskUserTool.TOOL_NAME.equals(toolExchanger.getToolName())) {
            return;
        }

        // 获取会话上下文中的用户答案
        String answer = AskUser.getAnswer(trace.getSession(), toolExchanger.getToolName());

        // 1. 阶段：暂无答案 —— 挂起任务
        if (Assert.isEmpty(answer)) {
            // 带上 actionId：标识本轮提问，供前端对重复 question 帧做幂等（不丢已作答进度）
            trace.getContext().put(AskUser.TASK_KEY, new AskUserTask(toolExchanger.getToolName(),
                    extractQuestions(toolExchanger.getArgs()), toolExchanger.getActionId()));

            trace.getSession().pending(true, AskUser.PENDING_REASON);
            trace.setFinalAnswer(AskUser.PENDING_REASON);

            return;
        }

        // 2. 阶段：已有答案 —— 回填答案文本作为工具结果（不执行真实工具）

        // 既然已经到了这一步，说明用户已经回答了，立即清理“挂起”标识，防止下一轮推理误判
        List<Map<String, Object>> questions = null;
        AskUserTask task = trace.getContext().getAs(AskUser.TASK_KEY);
        if (task != null) {
            questions = task.getQuestions();
        }
        if (Assert.isEmpty(questions)) {
            // 旧快照/异常场景：挂起任务缺失时回退到本次工具调用参数中的 questions
            questions = extractQuestions(toolExchanger.getArgs());
        }

        trace.getContext().remove(AskUser.TASK_KEY);
        // 答案键留到 onObservation 统一清理，与 HITL 的决策清理时机保持一致
        toolExchanger.setResult(AskUser.formatAnswerText(questions, answer));
    }

    @Override
    public void onObservation(ReActTrace trace, ToolExchanger toolExchanger,
                              @Nullable ChatMessage observation,
                              @Nullable Throwable error, long durationMs) {
        // 只清理本工具的现场：TASK_KEY 是全局单键，若对任意工具都清，
        // 一旦将来 ask_user 与其它工具同轮并行执行，邻居工具的观察回调会把
        // 刚写入的挂起任务抹掉（挂起还在、任务实体没了 → 前端收不到 question 帧）。
        if (!AskUserTool.TOOL_NAME.equals(toolExchanger.getToolName())) {
            return;
        }

        // 100% 闭环：现场清理（幂等），避免残留答案让下一轮同类调用误判为“已恢复”
        trace.getContext().remove(AskUser.TASK_KEY);
        trace.getContext().remove(AskUser.ANSWER_PREFIX + toolExchanger.getToolName());
    }

    /**
     * 从工具调用参数中提取 questions 数组（防御性归一）
     *
     * <p>模型产出的参数经 JSON 反序列化后元素类型不保证为 Map，逐项做类型过滤，
     * 非列表/非对象条目直接丢弃，避免污染挂起任务与恢复渲染。</p>
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> extractQuestions(Map<String, Object> args) {
        if (args == null) {
            return null;
        }

        Object value = args.get("questions");
        if (!(value instanceof List)) {
            return null;
        }

        List<Map<String, Object>> questions = new ArrayList<>();
        for (Object item : (List<Object>) value) {
            if (item instanceof Map) {
                questions.add((Map<String, Object>) item);
            }
        }

        return questions;
    }
}
