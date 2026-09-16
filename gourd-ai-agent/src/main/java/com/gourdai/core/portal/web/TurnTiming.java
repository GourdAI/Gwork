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

/**
 * 单轮耗时指标快照（不可变）。
 *
 * <p>由 {@link TurnTimer} 在一轮任务结束时产出，随 {@code trace} 帧下发并落盘，
 * 供前端「本轮用时」详情卡展示总用时、输出速度（TPS）与首 Token 延迟。</p>
 *
 * <p><b>为什么要把 TPS 的分子分母单独成对下发</b>：轮次总时长里含工具执行、审批等待、
 * 子代理调度与多次模型往返的间隙，而 {@code outputTokens} 又是整轮累计（还会并入子代理产出）。
 * 二者统计范围不同，相除得到的数既不是解码速度也不是可比的吞吐量。故本类额外携带
 * {@link #getGenerationMs()} 与 {@link #getGeneratedTokens()} 这一对<b>同口径</b>值，
 * 前端只用这一对算 TPS。</p>
 *
 * <p>所有字段均可为 null，语义是「本轮没有可测量的该指标」。前端必须显示占位符，
 * 不得用 0 兜底——0 会被读成「瞬时完成」，比缺失更误导。</p>
 *
 * @author oisin
 */
public final class TurnTiming {

    /** 全字段缺失的空快照（无起始时间、或本轮未产生任何可测量输出时使用）。 */
    public static final TurnTiming EMPTY = new TurnTiming(null, null, null, null, null);

    private final Long elapsedSeconds;
    private final Long elapsedMs;
    private final Long ttftMs;
    private final Long generationMs;
    private final Long generatedTokens;

    TurnTiming(Long elapsedSeconds, Long elapsedMs, Long ttftMs, Long generationMs, Long generatedTokens) {
        this.elapsedSeconds = elapsedSeconds;
        this.elapsedMs = elapsedMs;
        this.ttftMs = ttftMs;
        this.generationMs = generationMs;
        this.generatedTokens = generatedTokens;
    }

    /** 单轮总耗时（秒，向下截断）。历史帧一直只有它，前端「用时 28秒」徽标继续读它。 */
    public Long getElapsedSeconds() {
        return elapsedSeconds;
    }

    /** 单轮总耗时（毫秒，未截断）。与 {@link #getElapsedSeconds()} 取自同一个 now，仅精度不同。 */
    public Long getElapsedMs() {
        return elapsedMs;
    }

    /** 首 Token 延迟（毫秒）：订阅时刻 → 第一个真正下发给用户的主代理可见内容帧。 */
    public Long getTtftMs() {
        return ttftMs;
    }

    /** 模型解码总时长（毫秒）：本轮各次主代理模型调用解码段之和，不含工具执行与等待间隙。 */
    public Long getGenerationMs() {
        return generationMs;
    }

    /** 与 {@link #getGenerationMs()} 严格配对的输出 token 数（只统计被成功计时的那些调用）。 */
    public Long getGeneratedTokens() {
        return generatedTokens;
    }
}
