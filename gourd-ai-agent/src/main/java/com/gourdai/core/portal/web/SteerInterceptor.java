package com.gourdai.core.portal.web;

import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.ai.chat.content.ContentBlock;
import com.gourdai.ai.chat.content.ImageBlock;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.message.ToolMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
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
            // 会话目录只在确有附件时解析一次：纯文本插话是高频路径，不该为它做文件系统探测。
            File sessionDir = null;
            for (SteerEnvelope item : items) {
                if (item.hasAttachments()) {
                    sessionDir = webGate.resolveSessionDir(trace.getSession().getSessionId(), null);
                    break;
                }
            }
            for (SteerEnvelope item : items) {
                ChatMessage message = buildSteerMessage(sessionDir, item);
                if (message == null) {
                    // 无文本且附件全部读失败：注入一条空消息只会污染工作记忆，跳过。
                    // applied 事件照常发布，否则前端会一直等这条插话的结果。
                    LOG.warn("[Steer] skipped empty injection: session={}, steerId={}",
                            trace.getSession().getSessionId(), item.getSteerId());
                    continue;
                }
                trace.getWorkingMemory().addMessage(message);
                LOG.info("[Steer] applied: session={}, runId={}, steerId={}, images={}, files={}",
                        trace.getSession().getSessionId(), trace.getRunId(), item.getSteerId(),
                        item.getImagePaths().size(), item.getFilePaths().size());
            }
        });
    }

    /**
     * 把一条插话信封组装成待注入的用户消息（可含图片块）。
     *
     * <p>组装口径与发送主链路一致：文件附件以 {@code [附件: 路径]} 前缀呈现，图片走多模态块；
     * 文本为空时沿用主链路的图片兜底文案，避免出现一条只有前缀没有内容的插话。</p>
     *
     * @return 可注入的消息；文本为空且附件全部不可读时返回 null
     */
    private ChatMessage buildSteerMessage(File sessionDir, SteerEnvelope item) {
        List<ImageBlock> images = new ArrayList<>();
        List<String> fileRefs = new ArrayList<>();
        if (sessionDir != null && item.hasAttachments()) {
            WebGate.resolveAttachmentRefs(sessionDir, item.getImagePaths(),
                    Collections.nCopies(item.getImagePaths().size(), "image"), images, fileRefs);
            WebGate.resolveAttachmentRefs(sessionDir, item.getFilePaths(),
                    Collections.nCopies(item.getFilePaths().size(), "file"), images, fileRefs);
        }

        StringBuilder buf = new StringBuilder();
        for (String ref : fileRefs) {
            buf.append("[附件: ").append(ref).append("]\n");
        }
        String text = item.getText();
        if (text != null) {
            buf.append(text.trim());
        }

        String content = buf.toString().trim();
        if (content.isEmpty()) {
            if (images.isEmpty()) return null;
            content = images.size() > 1 ? "请描述这些图片" : "请描述这张图片";
        }
        if (images.isEmpty()) {
            return ChatMessage.ofUser(STEER_PREFIX + content);
        }
        List<ContentBlock> blocks = new ArrayList<>(images);
        return ChatMessage.ofUser(STEER_PREFIX + content, blocks);
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
