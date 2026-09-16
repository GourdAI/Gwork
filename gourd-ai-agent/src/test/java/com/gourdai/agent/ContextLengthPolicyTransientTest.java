/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent;

import com.gourdai.agent.session.InMemoryAgentSession;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ContextLengthPolicy 的「本轮」transient 覆盖通道测试。
 *
 * <p>语义：transient 优先于持久选择、非法值不生效、clear 后回落持久值、
 * resolve() 永远不受 transient 影响（供 /web/chat/models 等持久值展示端使用）。</p>
 */
class ContextLengthPolicyTransientTest {
    @Test
    void transientShouldTakePrecedenceOverPersistent() {
        AgentSession session = InMemoryAgentSession.of("ctx-policy-1");
        ContextLengthPolicy.set(session, 128_000L);

        ContextLengthPolicy.setTransient(session, 512_000L);

        assertEquals(512_000L, ContextLengthPolicy.resolveRuntime(session));
    }

    @Test
    void resolveShouldIgnoreTransient() {
        AgentSession session = InMemoryAgentSession.of("ctx-policy-2");
        ContextLengthPolicy.set(session, 128_000L);
        ContextLengthPolicy.setTransient(session, 1_000_000L);

        // 持久值展示端（如模型选择器初始化）不受本轮覆盖影响
        assertEquals(128_000L, ContextLengthPolicy.resolve(session));
    }

    @Test
    void clearTransientShouldFallBackToPersistent() {
        AgentSession session = InMemoryAgentSession.of("ctx-policy-3");
        ContextLengthPolicy.set(session, 512_000L);
        ContextLengthPolicy.setTransient(session, 1_000_000L);
        assertEquals(1_000_000L, ContextLengthPolicy.resolveRuntime(session));

        ContextLengthPolicy.clearTransient(session);

        assertEquals(512_000L, ContextLengthPolicy.resolveRuntime(session));
    }

    @Test
    void invalidTransientShouldNotTakeEffect() {
        AgentSession session = InMemoryAgentSession.of("ctx-policy-4");
        ContextLengthPolicy.set(session, 128_000L);

        // 绕过 setTransient 直接写入（模拟损坏/遗留脏值）：读取侧应视为未设置
        session.getContext().put(ContextLengthPolicy.TRANSIENT_CONTEXT_LENGTH_KEY, 999L);
        assertEquals(128_000L, ContextLengthPolicy.resolveRuntime(session));

        session.getContext().put(ContextLengthPolicy.TRANSIENT_CONTEXT_LENGTH_KEY, "abc");
        assertEquals(128_000L, ContextLengthPolicy.resolveRuntime(session));
    }

    @Test
    void setTransientShouldRejectUnsupportedValue() {
        AgentSession session = InMemoryAgentSession.of("ctx-policy-5");

        assertThrows(IllegalArgumentException.class, () -> ContextLengthPolicy.setTransient(session, 300_000L));
        // 拒绝后不落值：仍回落持久选择（未设置 -> 默认）
        assertEquals(ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH, ContextLengthPolicy.resolveRuntime(session));
    }

    @Test
    void clearTransientShouldBeIdempotentAndNullSafe() {
        ContextLengthPolicy.clearTransient(null);

        AgentSession session = InMemoryAgentSession.of("ctx-policy-6");
        ContextLengthPolicy.clearTransient(session); // 未设置时为空操作
        ContextLengthPolicy.clearTransient(session);

        assertEquals(ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH, ContextLengthPolicy.resolveRuntime(session));
    }

    @Test
    void copyShouldTakeRuntimeValueForChildSession() {
        AgentSession parent = InMemoryAgentSession.of("ctx-policy-parent");
        ContextLengthPolicy.set(parent, 128_000L);
        ContextLengthPolicy.setTransient(parent, 1_000_000L);

        AgentSession child = InMemoryAgentSession.of("ctx-policy-child");
        long copied = ContextLengthPolicy.copy(parent, child);

        // 子代理在某一轮之内创建：应继承该轮实际生效的预算
        assertEquals(1_000_000L, copied);
        assertEquals(1_000_000L, ContextLengthPolicy.resolve(child));
    }
}
