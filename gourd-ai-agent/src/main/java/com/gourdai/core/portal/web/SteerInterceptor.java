package com.gourdai.core.portal.web;

import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.message.ToolMessage;
import org.noear.solon.ai.chat.tool.ToolCall;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 在 ReAct Reason 安全边界注入当前 run 的即时插话。
 *
 * <p>run 生命周期、邮箱容量、幂等与 accept/apply/drop/cancel 原子状态由 {@link WebGate}
 * 统一管理；本拦截器只负责首轮/ToolCall 守卫和 WorkingMemory 注入。</p>
 */
@Preview("3.8.1")
public final class SteerInterceptor extends AbsReActInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(SteerInterceptor.class);

    public static final String ATTR_RUN_STATE = "_steer_run_state";
    public static final String ATTR_ACTIVE_RUN_ID = "_steer_active_run_id";
    public static final int MAX_BOX_SIZE = 5;
    public static final int MAX_TEXT_LENGTH = 4096;
    private static final String STEER_PREFIX = "[用户实时补充] ";

    private final WebGate webGate;

    public SteerInterceptor(WebGate webGate) {
        this.webGate = webGate;
    }

    @Override
    public void onAgentStart(ReActTrace trace) {
        String runId = trace.getRunId();
        webGate.registerSteerRun(trace.getSession(), runId);
        LOG.debug("[Steer] run started: session={}, runId={}", trace.getSession().getSessionId(), runId);
    }

    @Override
    public void onReasonStart(ReActTrace trace, StringBuilder systemPromptBuf) {
        if (trace.getTurnCount() <= 1 || hasOpenToolCall(trace)) {
            return;
        }

        // WebGate 在 session inputLock 内完成 RUNNING 校验、摘取、注入和 applied 事件发布。
        // Stop/结束与该操作共享同一锁，因此不会出现 Stop 后仍 applied。
        webGate.applySteers(trace.getSession(), trace.getRunId(), items -> {
            for (SteerEnvelope item : items) {
                trace.getWorkingMemory().addMessage(ChatMessage.ofUser(STEER_PREFIX + item.getText()));
                LOG.info("[Steer] applied: session={}, runId={}, steerId={}",
                        trace.getSession().getSessionId(), trace.getRunId(), item.getSteerId());
            }
        });
    }

    @Override
    public void onAgentEnd(ReActTrace trace) {
        webGate.finishSteerRun(trace.getSession(), trace.getRunId());
    }

    /**
     * 精确检查最近一组原生 ToolCall 是否全部有对应 ToolMessage。
     * 无 ID、部分闭合或夹入非 ToolMessage 时均保守阻塞插话。
     */
    private boolean hasOpenToolCall(ReActTrace trace) {
        List<ChatMessage> memory = trace.getWorkingMemory().getMessages();
        if (memory == null || memory.isEmpty()) return false;

        for (int i = memory.size() - 1; i >= 0; i--) {
            ChatMessage msg = memory.get(i);
            if (!(msg instanceof AssistantMessage)) continue;

            AssistantMessage assistant = (AssistantMessage) msg;
            List<ToolCall> calls = assistant.getToolCalls();
            if (calls == null || calls.isEmpty()) return false;

            Set<String> openIds = new HashSet<>();
            for (ToolCall call : calls) {
                if (call.getId() == null || call.getId().isEmpty()) return true;
                openIds.add(call.getId());
            }
            for (int j = i + 1; j < memory.size(); j++) {
                ChatMessage after = memory.get(j);
                if (!(after instanceof ToolMessage)) return true;
                String id = ((ToolMessage) after).getToolCallId();
                if (id != null) openIds.remove(id);
            }
            return !openIds.isEmpty();
        }
        return false;
    }
}
