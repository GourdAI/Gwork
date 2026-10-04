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
import com.gourdai.ai.chat.interceptor.ToolChain;
import com.gourdai.ai.chat.interceptor.ToolRequest;
import com.gourdai.ai.chat.tool.ToolResult;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.function.Function;

/**
 * 工具结果净化拦截器 (Result Sanitizer)
 * <p>负责在 Observation 阶段对原始数据进行脱敏、降噪与长度截断，确保上下文精简安全。</p>
 */
@Preview("3.8.1")
public class ToolSanitizerInterceptor extends AbsReActInterceptor {
    private static final Logger log = LoggerFactory.getLogger(ToolSanitizerInterceptor.class);

    /** 宽松档（上下文充裕）：与 TerminalTalent 的默认输出上限对齐 */
    public static final int CAP_RELAXED = 64_000;
    /** 中等档（上下文较紧） */
    public static final int CAP_MODERATE = 24_000;
    /** 严格档（上下文吃紧） */
    public static final int CAP_STRICT = 8_000;

    private final int maxObservationLength;
    private Function<ToolResult, ToolResult> customSanitizer;
    /** 上下文压力探针（按会话取），由宿主注入；为 null 时使用固定上限 */
    private java.util.function.ToDoubleFunction<ReActTrace> pressureSupplier;
    /**
     * 本轮推理开始时快照的上下文压力。
     *
     * <p>{@code onReasonStart} → 模型返回 tool_calls → {@code interceptTool} 属于同一轮、
     * 同一个 agent 实例（本拦截器由 {@code AgentFactory} 每个 agent 单独 new，非全局单例），
     * 故在此处缓存压力是安全的，且避开了 {@code ToolRequest} 不携带 trace 的限制。</p>
     */
    private volatile double currentPressure = 0.0d;

    public ToolSanitizerInterceptor(int maxObservationLength) {
        this.maxObservationLength = maxObservationLength;
    }

    public ToolSanitizerInterceptor(int maxObservationLength, Function<ToolResult, ToolResult> customSanitizer) {
        this.maxObservationLength = maxObservationLength;
        this.customSanitizer = customSanitizer;
    }

    public ToolSanitizerInterceptor() {
        this(CAP_RELAXED);
    }

    public void setCustomSanitizer(Function<ToolResult, ToolResult> sanitizer) {
        this.customSanitizer = sanitizer;
    }

    /**
     * 注入上下文压力探针，启用<b>动态调档</b>。
     *
     * <p>从源头减少进入上下文的量，是唯一<b>零信息损失</b>的省法——
     * 工具可以分页重调，而摘要一旦丢弃就找不回来了。</p>
     *
     * <p><b>为何按 trace 取</b>：压力是会话级状态。若探针不区分会话，
     * A 会话的高压力会把 B 会话的工具输出上限误压到严格档。</p>
     */
    public void setPressureSupplier(java.util.function.ToDoubleFunction<ReActTrace> pressureSupplier) {
        this.pressureSupplier = pressureSupplier;
    }

    /** 本轮推理开始：快照当前会话的上下文压力，供本轮工具输出调档使用。 */
    @Override
    public void onReasonStart(ReActTrace trace, StringBuilder systemPromptBuf) {
        if (pressureSupplier == null) {
            return;
        }
        try {
            currentPressure = pressureSupplier.applyAsDouble(trace);
        } catch (Exception e) {
            currentPressure = 0.0d;
        }
    }

    /** 按当前上下文占用确定本次的输出上限。 */
    private int resolveCap() {
        if (pressureSupplier == null) {
            return maxObservationLength;
        }
        double pressure = currentPressure;

        int dynamic;
        if (pressure >= 0.75d) {
            dynamic = CAP_STRICT;
        } else if (pressure >= 0.60d) {
            dynamic = CAP_MODERATE;
        } else {
            dynamic = CAP_RELAXED;
        }
        // 不得超过构造时的硬上限
        return Math.min(dynamic, maxObservationLength);
    }

    @Override
    public ToolResult interceptTool(ToolRequest req, ToolChain chain) throws Throwable {
        ToolResult result = chain.doIntercept(req);

        // 1. 容错处理：避免给模型返回 null 导致推理异常
        if (ToolResult.isEmpty(result) || Assert.isEmpty(result.getContent())) {
            return new ToolResult("[No output from tool]");
        }

        // 2. 业务逻辑净化（脱敏、格式化）
        if (customSanitizer != null) {
            result = customSanitizer.apply(result);
        }

        // 3. 物理长度保护（按上下文压力动态调档）
        int cap = resolveCap();
        if (result.getContent().length() > cap) {
            if (log.isDebugEnabled()) {
                log.debug("Tool [{}] output truncated: {} -> {} chars",
                        chain.getTool().name(), result.getContent().length(), cap);
            }
            result = new ToolResult(truncateKeepHeadTail(result.getContent(), cap));
        }

        return result;
    }

    /** 头部占 cap 的比例：尾部权重大，因为关键结论几乎都在输出末尾。 */
    private static final double HEAD_RATIO = 0.4d;

    /**
     * 超长工具输出截断：保留头 {@value #HEAD_RATIO} + 尾部其余，中间插省略标记。
     *
     * <p><b>为何不能只保留头部：</b>旧实现是 {@code substring(0, cap)}，而本工程工具的关键结论
     * 几乎全在末尾——{@code [exit_code=N]}、{@code BUILD SUCCESS/FAILURE}、
     * {@code Tests run: x, Failures: y}、堆栈的 {@code Caused by}。全截掉后模型看到的是
     * 「一堆日志 + 没有结果」，典型后果是把已成功的构建当未知状态重跑一遍，或把失败当通过。</p>
     *
     * <p><b>为何切点要内缩：</b>中文/emoji 在 UTF-16 下占两个 char，按固定下标硬切会产生孤立
     * 代理项，序列化成 JSON 发给模型时变 U+FFFD 或直接被判非法字符。</p>
     *
     * <p>抽成 static 是为了可测：本拦截器依赖 ToolChain/ReActTrace，原先这段逻辑无任何测试覆盖，
     * 改坏了也全绿。</p>
     *
     * @param raw 原始输出（调用方已保证 length &gt; cap）
     * @param cap 本次允许的上限（resolveCap 按上下文压力动态调档）
     */
    static String truncateKeepHeadTail(String raw, int cap) {
        if (raw == null || cap <= 0 || raw.length() <= cap) {
            return raw;
        }
        int head = (int) (cap * HEAD_RATIO);
        int tail = cap - head;

        if (head > 0 && Character.isHighSurrogate(raw.charAt(head - 1))) {
            head--; // 不把高代理项留在头部末尾
        }
        int tailStart = raw.length() - tail;
        if (tailStart < raw.length() && Character.isLowSurrogate(raw.charAt(tailStart))) {
            tailStart++; // 不把低代理项留在尾部开头
        }
        // 无需处理窗口重叠：前提是 raw.length() > cap = head + tail，故 tailStart - head >= 1
        return raw.substring(0, head)
                + "\n... [" + (tailStart - head) + " chars truncated — head and tail preserved."
                + " Use pagination/offset to fetch the middle content.] ...\n"
                + raw.substring(tailStart);
    }
}