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
import com.gourdai.agent.util.CompleteTaskTool;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;

import java.util.List;

/**
 * 显式收尾拦截器（complete_task，契约 §4.2）
 *
 * <p>与 {@link AskUserInterceptor} 骨架同构：onAction 阶段短路真实工具执行，
 * 把 summary 原样回填为工具结果（execute 语义 = ok(summary)）。真正的
 * 「finalAnswer + 直通 END」由 ActionTask 在检测到成功结果后完成。</p>
 *
 * <p><b>同批互斥</b>：同批工具调用中含 ask_user 时，complete_task 返回错误
 * 「本批含待用户回答的提问，不能同时提交完成」并不结束——提问挂起与提交完成
 * 语义互斥，先等用户回答再由模型决定是否收尾。判定基于本轮推理消息的完整
 * tool_calls（含已执行/未执行），与调用次序无关。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class CompleteTaskInterceptor extends AbsReActInterceptor {

    /**
     * 同批含 ask_user（或 HITL 待审批操作）时的互斥错误文案（契约 §4.2，双内核逐字一致）。
     * 自审对齐：旧版 Java 只有中段、Rust 带前缀后缀，且 HITL 场景提 ask_user 语义错位，统一为现版。
     */
    static final String CONFLICT_RESULT = "complete_task 未结束任务：本批含待用户回应的挂起操作（提问或审批），不能同时提交完成。请先等待用户回应，再决定是否收尾。";

    @Override
    public void onAction(ReActTrace trace, ToolExchanger toolExchanger) {
        // 只处理显式收尾工具，其余工具一律放行
        if (!CompleteTaskTool.TOOL_NAME.equals(toolExchanger.getToolName())) {
            return;
        }

        // 同批含 ask_user：互斥拒绝（结构化失败，模型据此改走「先等回答」路径），不结束任务
        if (batchContainsAskUser(trace)) {
            toolExchanger.setResult(CONFLICT_RESULT);
            toolExchanger.setFailed(true);
            return;
        }

        // summary 缺失/空白：不结束，返回可自愈的参数错误（与 AskUser 的非法参数口径一致）
        String summary = summaryOf(toolExchanger);
        if (Assert.isEmpty(summary) || summary.trim().isEmpty()) {
            toolExchanger.setResult("Invalid arguments for [" + CompleteTaskTool.TOOL_NAME
                    + "]: `summary` 为空，未提交完成。请传入面向用户的最终回答全文后重新调用；"
                    + "若工作尚未完成，请继续执行而不是调用本工具。");
            toolExchanger.setFailed(true);
            return;
        }

        // execute 语义：ok(summary)。ActionTask 检测成功结果后 setFinalAnswer + 直通 END
        toolExchanger.setResult(summary);
    }

    /**
     * 本轮推理消息的 tool_calls 中是否含 ask_user（含任意次序）。
     *
     * <p>批内成员判定必须看完整调用清单而非「当前已执行的部分」：complete_task
     * 已被 ActionTask 排到批尾，执行到它时 ask_user 可能已挂起（pending 路径由
     * doAction 前置退出）也可能参数非法未挂起——后者仍属「本批含提问」，必须拒绝。</p>
     */
    static boolean batchContainsAskUser(ReActTrace trace) {
        AssistantMessage lastReason = trace.getLastReasonMessage();
        if (lastReason == null) {
            return false;
        }
        List<ToolCall> calls = lastReason.getToolCalls();
        if (calls == null || calls.isEmpty()) {
            return false;
        }
        for (ToolCall call : calls) {
            if (call != null && AskUserTool.TOOL_NAME.equals(call.getName())) {
                return true;
            }
        }
        return false;
    }

    /**
     * 提取 summary 入参（防御性字符串化；缺失返回 null）。
     */
    static String summaryOf(ToolExchanger toolExchanger) {
        if (toolExchanger.getArgs() == null) {
            return null;
        }
        Object value = toolExchanger.getArgs().get("summary");
        return value == null ? null : String.valueOf(value);
    }
}