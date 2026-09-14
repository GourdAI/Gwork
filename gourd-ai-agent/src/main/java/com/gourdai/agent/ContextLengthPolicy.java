/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.agent;

import org.noear.solon.flow.FlowContext;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 会话级上下文窗口策略。
 *
 * <p>上下文窗口是会话选择，而不是模型配置。所有运行时消费者都应从同一个
 * {@link AgentSession} / {@link FlowContext} 读取 {@link #CONTEXT_LENGTH_KEY}，
 * 缺失或非法值统一回落到 {@link #DEFAULT_CONTEXT_LENGTH}。</p>
 *
 * <p>这里不依赖 harness 或 portal，因而核心压缩、Web、桌面 WebSocket 及子代理
 * 可以共享完全相同的取值和校验口径。</p>
 */
public final class ContextLengthPolicy {
    /** 会话快照中的上下文窗口键。 */
    public static final String CONTEXT_LENGTH_KEY = "_context_length";
    /** 缺省上下文窗口，单位为十进制 token。 */
    public static final long DEFAULT_CONTEXT_LENGTH = 256_000L;

    /** 模型选择器允许的固定上下文窗口选项。 */
    public static final List<Long> CONTEXT_LENGTH_OPTIONS = Collections.unmodifiableList(
            Arrays.asList(128_000L, 256_000L, 512_000L, 1_000_000L));

    private ContextLengthPolicy() {
    }

    /** 从 AgentSession 读取有效上下文窗口。 */
    public static long resolve(AgentSession session) {
        return session == null ? DEFAULT_CONTEXT_LENGTH : resolve(session.getContext());
    }

    /** 从 FlowContext 读取有效上下文窗口。 */
    public static long resolve(FlowContext context) {
        return context == null ? DEFAULT_CONTEXT_LENGTH : normalize(context.get(CONTEXT_LENGTH_KEY));
    }

    /**
     * 将任意会话快照值解析为 Long；不接受的类型或格式返回 null。
     * 支持 Long、Integer 等 Number 以及十进制字符串，并兼容 256K/1M 表示。
     */
    public static Long parse(Object raw) {
        if (raw == null) {
            return null;
        }

        try {
            String text;
            if (raw instanceof Number) {
                text = raw.toString();
            } else if (raw instanceof CharSequence) {
                text = raw.toString().trim().replace(",", "").replace("_", "");
            } else {
                return null;
            }

            if (text.isEmpty()) {
                return null;
            }

            long multiplier = 1L;
            String numeric = text;
            char suffix = Character.toLowerCase(text.charAt(text.length() - 1));
            if (suffix == 'k' || suffix == 'm') {
                multiplier = suffix == 'k' ? 1_000L : 1_000_000L;
                numeric = text.substring(0, text.length() - 1).trim();
            }
            if (numeric.isEmpty()) {
                return null;
            }

            BigDecimal value = new BigDecimal(numeric).multiply(BigDecimal.valueOf(multiplier));
            return value.longValueExact();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 将任意值归一化；缺失、格式错误或非固定选项统一回落默认值。 */
    public static long normalize(Object raw) {
        Long parsed = parse(raw);
        // 显式取 longValue：避免与 isAllowed(Object) 重载共存时优先匹配到 Object 版本而重复解析一次
        return parsed != null && isAllowed(parsed.longValue()) ? parsed : DEFAULT_CONTEXT_LENGTH;
    }

    /** 严格判断数值是否为固定选项之一。 */
    public static boolean isAllowed(long value) {
        return CONTEXT_LENGTH_OPTIONS.contains(value);
    }

    /** 返回不可变的固定选项列表。 */
    public static List<Long> options() {
        return CONTEXT_LENGTH_OPTIONS;
    }

    /** 将合法的会话级上下文窗口写入 AgentSession。 */
    public static void set(AgentSession session, long contextLength) {
        if (session == null) {
            return;
        }
        set(session.getContext(), contextLength);
    }

    /** 将合法的会话级上下文窗口写入 FlowContext。 */
    public static void set(FlowContext context, long contextLength) {
        if (context == null) {
            return;
        }
        if (!isAllowed(contextLength)) {
            throw new IllegalArgumentException("contextLength must be one of " + CONTEXT_LENGTH_OPTIONS);
        }
        context.put(CONTEXT_LENGTH_KEY, contextLength);
    }

    /** 复制父会话的有效上下文窗口；父会话缺失或非法时写入固定默认值。 */
    public static long copy(AgentSession parent, AgentSession child) {
        long contextLength = resolve(parent);
        set(child, contextLength);
        return contextLength;
    }
}
