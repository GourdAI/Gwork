/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.harness.agent;

import com.gourdai.agent.event.AgentEvent;
import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import org.noear.solon.ai.chat.ChatRequest;
import org.noear.solon.ai.chat.event.ChatEvent;
import org.noear.solon.ai.chat.ChatSession;
import org.noear.solon.ai.chat.interceptor.StreamChain;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 模型重试提示拦截器。
 *
 * <p><b>背景：</b>底层框架（solon-ai 的 {@code ReasonTask.callWithRetry}）在模型调用失败时会自动重试，
 * 但重试过程只写日志、不通知前端；重试全部失败后才会把最终错误作为答复推给用户。
 * 本拦截器负责把「正在重试第 N 次」的中间状态也推送给前端，让用户可感知。</p>
 *
 * <p><b>原理：</b>同一次 Reason 回合内，框架会对同一个模型请求反复调用 {@code req.stream()}，
 * 每调用一次即代表一次尝试，因此每次进入 {@link #interceptStream} 就是一次新尝试。
 * 首次尝试不提示；从第 2 次尝试起（即发生了重试）推送 {@link RetryEvent}。</p>
 *
 * <p><b>无状态约束：</b>拦截器按 class 注册为全局单例，故所有会话相关状态都必须按
 * sessionId 隔离存放在 {@link #stateMap} 中，不能使用普通实例字段，否则并发会话会互相污染。</p>
 *
 * @author oisin
 */
public class RetryNotifyInterceptor extends AbsReActInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(RetryNotifyInterceptor.class);

    /** 每个会话一份的重试状态（按 sessionId 隔离） */
    private final Map<String, RetryState> stateMap = new ConcurrentHashMap<>();

    /**
     * stateMap 条目数上限。正常情况下条目在 onAgentEnd 即被清理，稳态规模≈并发活跃会话数，
     * 远小于此值。仅当 onAgentEnd 因未捕获异常被绕过、留下"崩了不再回来"的残留条目时才会逼近上限；
     * 一旦超限即整体清空，作为兜底防止长生命周期单例拦截器无限泄漏 trace（trace 可能很大）。
     */
    private static final int MAX_STATE_ENTRIES = 256;

    private static final class RetryState {
        final ReActTrace trace;
        // 当前 Reason 回合内的尝试计数（1 = 首次，>1 = 重试）
        final AtomicInteger attempt = new AtomicInteger(0);

        RetryState(ReActTrace trace) {
            this.trace = trace;
        }
    }

    /**
     * Reason 回合开始（每回合调用一次，在重试循环之前）：
     * 绑定当前 trace 并把尝试计数归零，使计数按「每回合」而非「整个会话」统计。
     */
    @Override
    public void onReasonStart(ReActTrace trace, StringBuilder systemPromptBuf) {
        String sessionId = trace.getSession().getSessionId();
        if (sessionId != null) {
            // 兜底：条目异常堆积（onAgentEnd 被绕过的残留）时整体清空，防止 trace 泄漏
            if (stateMap.size() >= MAX_STATE_ENTRIES && !stateMap.containsKey(sessionId)) {
                stateMap.clear();
            }
            stateMap.put(sessionId, new RetryState(trace));
        }
    }

    /**
     * 每次模型流式请求（含重试）都会经过这里：进入即代表一次新尝试。
     * 从第 2 次尝试起推送重试提示；请求本身照常放行。
     */
    @Override
    public Flux<ChatEvent> interceptStream(ChatRequest req, StreamChain chain) {
        Object sessionId = req.getOptions().toolContext().get(ChatSession.ATTR_SESSIONID);
        if (sessionId != null) {
            RetryState state = stateMap.get(sessionId.toString());
            if (state != null) {
                int attempt = state.attempt.incrementAndGet();
                if (attempt > 1) {
                    // 发生了重试：attempt 即当前是第几次尝试
                    pushRetryEvent(state.trace, attempt);
                }
            }
        }

        return chain.doIntercept(req);
    }

    /**
     * Agent 执行结束：清理本会话的重试状态，避免 map 累积。
     */
    @Override
    public void onAgentEnd(ReActTrace trace) {
        String sessionId = trace.getSession().getSessionId();
        if (sessionId != null) {
            stateMap.remove(sessionId);
        }
    }

    private void pushRetryEvent(ReActTrace trace, int attempt) {
        try {
            FluxSink<AgentEvent> sink = trace.getOptions().getStreamSink();
            if (sink != null && !sink.isCancelled()) {
                int maxRetries = trace.getOptions().getMaxRetries();
                sink.next(new RetryEvent(trace, attempt, maxRetries));
            }
        } catch (Exception e) {
            if (LOG.isDebugEnabled()) {
                LOG.debug("Failed to push RetryEvent: {}", e.getMessage());
            }
        }
    }
}
