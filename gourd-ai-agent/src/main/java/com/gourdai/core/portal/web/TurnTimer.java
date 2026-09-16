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
package com.gourdai.core.portal.web;

import java.time.Duration;
import java.util.function.LongSupplier;

/**
 * 单轮耗时与输出速度测量器（per-turn，非线程安全）。
 *
 * <p>每次 {@code buildTurnFlux} 订阅创建一个实例，按事件到达顺序喂入，轮次结束时产出
 * {@link TurnTiming}。之所以独立成类而非内联在流里，是为了让口径逻辑可被单元测试用
 * 真实事件序列驱动验证（流内联的写法只能靠源码字符串护栏，测不出行为）。</p>
 *
 * <h3>为什么需要「解码段」而不是直接用轮次总时长</h3>
 * <p>一轮 ReAct 可能包含多次模型调用，其间穿插工具执行、审批等待与子代理调度。
 * 轮次总时长里这些间隙全都算在内，而 {@code outputTokens} 只在模型解码时增长，
 * 两者统计范围不同。本类把时间切成「解码段」：</p>
 * <pre>
 *   [可见输出帧 ... 可见输出帧] → 用量结算 → (工具执行/等待，不计) → [下一段] → ...
 * </pre>
 * <p>每段从该次调用的首个可见输出帧起算，到该次调用的用量结算（{@code ContextUsageEvent}）止，
 * 并与该次结算上报的 output token 严格配对累加。工具执行时间天然落在段与段之间，不被计入。</p>
 *
 * <h3>单调时钟</h3>
 * <p>时长一律由 {@link System#nanoTime()} 推导，避免 NTP 校时/休眠唤醒导致负耗时或
 * 离谱的 TPS。墙钟只在测试注入时被替换。</p>
 *
 * @author oisin
 */
final class TurnTimer {

    /** 单调时钟纳秒源（可注入，便于测试构造确定性时序）。 */
    private final LongSupplier nanoSource;

    /** 本轮订阅时刻（纳秒，单调）。 */
    private final long turnStartNanos;

    /** 首个可见输出帧到达时刻（纳秒），null = 本轮尚未产出任何可见输出。 */
    private Long firstVisibleNanos;

    /** 当前解码段起点（纳秒），null = 当前不在解码段内（尚未开始，或已被上一次结算收口）。 */
    private Long segmentStartNanos;

    /** 已收口的解码段累计时长（纳秒）。 */
    private long generationNanos;

    /** 与 {@link #generationNanos} 配对的输出 token 累计。 */
    private long generatedTokens;

    /** 是否至少完整收口过一段（决定 generationMs/generatedTokens 是否可下发）。 */
    private boolean hasClosedSegment;

    TurnTimer(long turnStartNanos, LongSupplier nanoSource) {
        this.turnStartNanos = turnStartNanos;
        this.nanoSource = nanoSource;
    }

    /** 以当前单调时刻为起点创建。 */
    static TurnTimer start() {
        return new TurnTimer(System.nanoTime(), System::nanoTime);
    }

    /**
     * 记录一个<b>真正下发给用户的主代理可见内容帧</b>。
     *
     * <p>调用方必须只在帧确认要下发时才调用（已排除空帧、被过滤的内部工具帧与子代理帧），
     * 否则 TTFT 会被用户根本看不到的事件提前触发。</p>
     */
    void onVisibleOutput() {
        long now = nanoSource.getAsLong();
        if (firstVisibleNanos == null) {
            firstVisibleNanos = now;
        }
        if (segmentStartNanos == null) {
            // 新解码段开始：上一段已被用量结算收口，其间的工具执行时间不计入
            segmentStartNanos = now;
        }
    }

    /**
     * 一次主代理模型调用的用量结算（{@code ContextUsageEvent}）：收口当前解码段。
     *
     * <p>未开始解码段就结算（如本次调用无任何可见输出）时，只能放弃该段——没有起点就没有
     * 可信的时长，把它按 0 计入会让 TPS 虚高。对应的 token 也一并不计，保证分子分母同进同出。</p>
     *
     * @param outputTokens 本次调用上报的输出 token 数
     */
    void onUsageSettled(long outputTokens) {
        if (segmentStartNanos == null) {
            return;
        }
        long elapsed = nanoSource.getAsLong() - segmentStartNanos;
        segmentStartNanos = null;
        if (elapsed <= 0) {
            // 时长不可信（时钟异常或瞬时完成），放弃该段而非记 0：0 分母会制造无穷大 TPS
            return;
        }
        generationNanos += elapsed;
        if (outputTokens > 0) {
            generatedTokens += outputTokens;
        }
        hasClosedSegment = true;
    }

    /**
     * 轮次结束：产出不可变快照。
     *
     * @param turnStartMs 本轮订阅的墙钟时刻；{@code <= 0} 表示无起始时间，返回空快照
     */
    TurnTiming finish(long turnStartMs) {
        if (turnStartMs <= 0) {
            return TurnTiming.EMPTY;
        }

        // 总时长由单调时钟推导，秒与毫秒同源换算，避免「28s vs 27993ms」这类自相矛盾
        long elapsedMs = Math.max(0L, (nanoSource.getAsLong() - turnStartNanos) / 1_000_000L);
        Long elapsedSeconds = Duration.ofMillis(elapsedMs).getSeconds();

        Long ttftMs = null;
        if (firstVisibleNanos != null) {
            ttftMs = Math.max(0L, (firstVisibleNanos - turnStartNanos) / 1_000_000L);
        }

        Long generationMs = null;
        Long generatedTokensOut = null;
        // 必须同时有时长与 token 才下发：只有其一时相除没有意义，前端应显示占位符
        if (hasClosedSegment && generatedTokens > 0) {
            long genMs = generationNanos / 1_000_000L;
            if (genMs > 0) {
                generationMs = genMs;
                generatedTokensOut = generatedTokens;
            }
        }

        return new TurnTiming(elapsedSeconds, elapsedMs, ttftMs, generationMs, generatedTokensOut);
    }
}
