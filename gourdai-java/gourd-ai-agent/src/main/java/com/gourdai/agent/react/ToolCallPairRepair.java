/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.react;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.intercept.AskUser;
import com.gourdai.agent.react.intercept.AskUserTask;
import com.gourdai.agent.util.AskUserTool;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.ToolMessage;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.tool.ToolCall;
import com.gourdai.ai.chat.tool.ToolResult;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 原生工具调用配对自愈器
 *
 * <p>工作记忆中的原生工具调用必须保持「Assistant(tool_calls) ↔ ToolMessage 结果」一一配对。
 * 异常场景（工具调用挂起/中断后的历史遗留、旧快照恢复、异常恢复路径）可能残留「已声明但无结果」
 * 的调用；OpenAI Responses / Chat 等供应商接口会直接拒绝这类请求
 * （如 {@code 400 No tool output found for tool call call_xxx}），且重试无法自愈。</p>
 *
 * <p>本修复器在发送前补齐合成结果：</p>
 * <ul>
 * <li><b>ask_user</b>：若挂起答案仍在会话上下文（用户已作答、但恢复回放未执行到该调用），
 * 且该调用就是「产生这份答案的那一次提问」（按 actionId 精确匹配），则按正常恢复语义回填答案文本，
 * 并清理挂起任务与答案键（与拦截器 onObservation 同构）。</li>
 * <li><b>其它工具</b>：写入明确的中断标记文本，避免模型把空结果误当作真实观测。</li>
 * </ul>
 *
 * <p><b>答案归属严格按 actionId 判定</b>：历史遗留的孤儿 ask_user 调用（旧快照、上轮被中断的提问）
 * 可能排在「真正被回答的那次调用」之前；若按「遇到的第一个孤儿 ask_user 就填」，答案会被前面的旧调用
 * 截胡并随即清除，真正提问的那次只能拿到「中断无输出」——用户白答一次，且模型拿到的是错位的语义。
 * 故只有 {@code call.getId()} 与挂起任务记录的 {@code actionId} 相等时才回填；匹配不上的孤儿一律给中断标记。</p>
 *
 * <p>合成结果插入到该推理消息的已有结果段之后，保持配对连续；健康流程恒为空操作（幂等）。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class ToolCallPairRepair {
    private static final Logger LOG = LoggerFactory.getLogger(ToolCallPairRepair.class);

    /**
     * 工具调用因挂起/中断未执行完成时的合成结果文案。
     *
     * <p><b>措辞为何用中性陈述</b>：写「如需请重新调用」会主动诱导模型重跑工具，而重跑又会产生
     * 新的大结果、再次推高上下文，形成「补位→重调→再压缩」的放大循环（与
     * {@code ContextCompressionInterceptor#clearedPlaceholder} 同一教训，措辞口径保持一致）。
     * 此处只陈述事实，把「要不要重调」的判断权交给模型。</p>
     */
    static final String INTERRUPTED_MARKER = "[该工具调用因任务挂起/中断未执行完成 · 无输出]";

    /**
     * 扫描并修复工作记忆中「已声明但无结果」的原生工具调用。
     *
     * @param trace 推理轨迹（工作记忆来源）
     * @return 本次补齐的结果条数；健康流程返回 0
     */
    public static int repair(ReActTrace trace) {
        if (trace == null) {
            return 0;
        }

        Prompt workingMemory = trace.getWorkingMemory();
        List<ChatMessage> messages = workingMemory.getMessages();
        if (messages == null || messages.isEmpty()) {
            return 0;
        }

        // 已有结果的调用 id（任意位置）——结果只可能由同批回灌产生，id 全局唯一
        Set<String> resolvedIds = new HashSet<>();
        for (ChatMessage message : messages) {
            if (message instanceof ToolMessage) {
                String toolCallId = ((ToolMessage) message).getToolCallId();
                if (Assert.isNotEmpty(toolCallId)) {
                    resolvedIds.add(toolCallId);
                }
            }
        }

        // 逐个推理消息找缺失结果；插入点 = 该消息及其连续结果段之后
        Map<Integer, List<ChatMessage>> insertions = new LinkedHashMap<>();
        int repaired = 0;
        for (int i = 0; i < messages.size(); i++) {
            if (!(messages.get(i) instanceof AssistantMessage)) {
                continue;
            }

            List<ToolCall> calls = ((AssistantMessage) messages.get(i)).getToolCalls();
            if (calls == null || calls.isEmpty()) {
                continue;
            }

            List<ChatMessage> synthesized = new ArrayList<>();
            for (ToolCall call : calls) {
                if (call == null || Assert.isEmpty(call.getId()) || resolvedIds.contains(call.getId())) {
                    continue;
                }

                synthesized.add(buildSyntheticResult(trace, call));
                resolvedIds.add(call.getId()); //防御同批重复 id
            }

            if (synthesized.isEmpty()) {
                continue;
            }

            int insertAt = i;
            while (insertAt + 1 < messages.size() && messages.get(insertAt + 1) instanceof ToolMessage) {
                insertAt++;
            }
            insertions.put(insertAt, synthesized);
            repaired += synthesized.size();
        }

        if (repaired == 0) {
            return 0;
        }

        List<ChatMessage> rebuilt = new ArrayList<>(messages.size() + repaired);
        for (int i = 0; i < messages.size(); i++) {
            rebuilt.add(messages.get(i));
            List<ChatMessage> add = insertions.get(i);
            if (add != null) {
                rebuilt.addAll(add);
            }
        }
        workingMemory.replaceMessages(rebuilt);

        LOG.warn("ToolCallPairRepair: 补齐 {} 个缺失结果的原生工具调用，避免供应商因配对不完整拒绝请求", repaired);
        return repaired;
    }

    /**
     * 构造缺失调用的合成结果；ask_user 且「答案确实属于本次调用」时按正常恢复语义回填真实答案。
     */
    private static ChatMessage buildSyntheticResult(ReActTrace trace, ToolCall call) {
        String toolName = call.getName();

        if (AskUserTool.TOOL_NAME.equals(toolName)) {
            AgentSession session = trace.getSession();
            if (session != null) {
                String answer = AskUser.getAnswer(session, toolName);
                if (Assert.isNotEmpty(answer)) {
                    AskUserTask task = AskUser.getPendingTask(session);

                    // 归属校验：答案只能给「产生它的那一次提问」（见类注释）。
                    // 不匹配时不得挪用，也不得清理现场——答案要留给后面真正属于它的调用。
                    if (ownsAnswer(task, call)) {
                        List<Map<String, Object>> questions = (task == null) ? null : task.getQuestions();

                        // 与正常恢复路径同源：清理挂起任务与答案现场（幂等），防止后续同类调用误判为“已恢复”。
                        // 必须走 AskUser.clear 而非手写 remove：答案归属键与答案同生同灭，
                        // 漏清会留下孤儿归属，让下一份答案背上旧归属而被 ownsAnswer 误判丢弃。
                        session.getContext().remove(AskUser.TASK_KEY);
                        AskUser.clear(session, toolName);

                        return ChatMessage.ofTool(ToolResult.success(AskUser.formatAnswerText(questions, answer)),
                                toolName, call.getId(), false);
                    }

                    if (LOG.isWarnEnabled()) {
                        LOG.warn("ToolCallPairRepair: ask_user 调用 {} 与待回填答案的提问 {} 不匹配，按中断标记处理（不挪用他人答案）",
                                call.getId(), (task == null) ? null : task.getActionId());
                    }
                }
            }
        }

        return ChatMessage.ofTool(ToolResult.success(INTERRUPTED_MARKER), toolName, call.getId(), false);
    }

    /**
     * 判定待回填的答案是否归属于本次调用。
     *
     * <p>归属以挂起任务的 {@code actionId} 为凭：它就是发起提问那一次调用的 {@code ToolCall.id}
     * （{@code ActionTask#doAction} 中 actionId 同源于 {@code ToolCall.getId()}，question 帧也带它下发）。</p>
     *
     * <p><b>两个向后兼容的放行口</b>（宁可保守，也不要让用户白答一次）：</p>
     * <ul>
     * <li>{@code task == null}：挂起任务已丢（旧快照/异常路径），无从判归属。此时全局只有一份答案键，
     * 交给首个孤儿 ask_user 是唯一可行选择（行为与修复前一致，不引入新的丢答案风险）。</li>
     * <li>{@code task.getActionId() == null}：actionId 字段新增前落盘的旧快照取不到值
     * （见 {@link AskUserTask#getActionId()} 的「可能为 null」声明），同样降级放行。</li>
     * </ul>
     */
    private static boolean ownsAnswer(AskUserTask task, ToolCall call) {
        if (task == null || Assert.isEmpty(task.getActionId())) {
            return true; //无归属信息可用：降级为旧行为
        }

        return task.getActionId().equals(call.getId());
    }
}
