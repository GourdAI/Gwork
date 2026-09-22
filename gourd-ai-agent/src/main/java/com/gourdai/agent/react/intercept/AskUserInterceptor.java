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
import com.gourdai.ai.chat.message.ChatMessage;
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

    /**
     * 参数非法时回交模型的错误结果（{@code __ERROR__} 前缀与 {@code ActionTask#executeTool} 的
     * Schema 自愈口径一致，模型已被训练成据此重试）。
     *
     * <p><b>为什么非法参数绝不能挂起</b>：题面为空时前端会隐藏问答卡，用户根本看不到、也点不到回答入口；
     * 而挂起是「等外部事件唤醒」的单向状态，此时挂起就等于「后台无限死等 + 无人可答」——会话永久卡死，
     * 只能重启会话解开。故改为把错误当作一次普通观测交还模型，由它自行重试或改走正文提问。</p>
     *
     * <p>措辞给出了正确调用形态与「无需作答就别调」的退路，避免模型拿到错误后原样重放同一份坏参数。</p>
     */
    static final String INVALID_QUESTIONS_RESULT = "__ERROR__ Invalid arguments for [" + AskUserTool.TOOL_NAME
            + "]: `questions` 为空，或所有条目的 `header` 均为空白，问答卡无法渲染，任务未挂起。"
            + " 请重新调用并至少传入一个 header 非空的问题，格式："
            + "{\"questions\":[{\"header\":\"问题文本\",\"options\":[{\"label\":\"候选项\"}]}]}；"
            + "若本就无需用户作答，请直接在正文中说明或继续执行，不要再调用本工具。";

    @Override
    public void onAction(ReActTrace trace, ToolExchanger toolExchanger) {
        // 只处理结构化问答工具，其余工具一律放行
        if (!AskUserTool.TOOL_NAME.equals(toolExchanger.getToolName())) {
            return;
        }

        // 获取会话上下文中的用户答案
        String answer = AskUser.getAnswer(trace.getSession(), toolExchanger.getToolName());

        /* 归属校验：答案键是会话级全局单键，而它未必能在产生它的那次提问里被消费掉
           （如用户作答后会话已不可恢复，恢复轮空转，本拦截器根本没被执行）。残留的答案会变成
           「幽灵答案」：下一次模型真的提问时被当作本次回答直接回填，用户连卡片都看不到
           就被替作了答。不归属则丢弃，按「无答案」正常挂起提问。 */
        if (Assert.isNotEmpty(answer)
                && !AskUser.ownsAnswer(trace.getSession(), toolExchanger.getToolName(), toolExchanger.getActionId())) {
            AskUser.clear(trace.getSession(), toolExchanger.getToolName());
            answer = null;
        }

        // 1. 阶段：暂无答案 —— 先校验参数，再决定是否挂起
        if (Assert.isEmpty(answer)) {
            List<Map<String, Object>> questions = extractQuestions(toolExchanger.getArgs());

            // 参数非法直接短路（见 INVALID_QUESTIONS_RESULT）：判定必须发生在 pending 之前——
            // 一旦挂起，本轮执行流立即中断，后面不再有任何可以补救的落点。
            if (!hasRenderableQuestion(questions)) {
                toolExchanger.setResult(INVALID_QUESTIONS_RESULT);
                return;
            }

            // 带上 actionId：标识本轮提问，供前端对重复 question 帧做幂等（不丢已作答进度）
            trace.getContext().put(AskUser.TASK_KEY, new AskUserTask(toolExchanger.getToolName(),
                    questions, toolExchanger.getActionId()));

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
        // （含答案归属标识：它与答案同生同灭，漏清会让下一份答案背上旧归属而被误判丢弃）
        trace.getContext().remove(AskUser.TASK_KEY);
        AskUser.clear(trace.getSession(), toolExchanger.getToolName());
    }

    /**
     * 是否存在「可渲染」的问题：至少一条含非空白 {@code header}。
     *
     * <p>与前端的空卡隐藏规则同口径——前端渲染不出来的题面，后端就不该为它挂起会话。
     * 只要有一条题面可渲染即放行：用户仍有回答入口，剩余空条目由渲染层自行忽略，
     * 不值得为此否掉整次提问（宁可少拦，也不能把合法提问误判成非法）。</p>
     */
    private static boolean hasRenderableQuestion(List<Map<String, Object>> questions) {
        if (Assert.isEmpty(questions)) {
            return false;
        }

        for (Map<String, Object> question : questions) {
            if (question == null) {
                continue;
            }

            Object header = question.get("header");
            if (header != null && !String.valueOf(header).trim().isEmpty()) {
                return true;
            }
        }

        return false;
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
