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
package com.gourdai.ai.util;

import org.noear.solon.util.CallableTx;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Predicate;

/**
 * 重试任务
 *
 * @author noear
 * @since 3.10.5
 */
public class RetryTask {
    private static final Logger LOG = LoggerFactory.getLogger(RetryTask.class);

    public static final int DEFAULT_MAX_RETRIES = 3;
    public static final long DEFAULT_INITIAL_DELAY_MS = 1000L;
    public static final long DEFAULT_MAX_DELAY_MS = 30 * 1000L; // 默认最大等待 30 秒

    public interface RetryListener {
        void onRetry(int attempt, Throwable e);
    }

    //最大重试次数
    private int maxRetries = DEFAULT_MAX_RETRIES;
    //初始延迟毫秒数
    private long initialDelayMs = DEFAULT_INITIAL_DELAY_MS;
    //最大延迟毫秒数（Cap）
    private long maxDelayMs = DEFAULT_MAX_DELAY_MS;
    //重试监听
    private RetryListener retryListener;
    //异常是否允许重试
    private Predicate<Throwable> retryPredicate = e -> true;
    //确定性错误（不可重试的 HTTP 状态码）快速失败开关；默认启用，判定口径见 LlmRetryPolicy
    private boolean failFastOnDeterministicError = true;
    //总时长预算（纳秒）；<=0 表示「未配置」，此时不做任何总时长约束，行为与历史版本逐字一致
    private long totalDeadlineNanos = 0L;

    public RetryTask maxRetries(int maxRetries) {
        this.maxRetries = maxRetries;
        return this;
    }

    public RetryTask initialDelayMs(long initialDelayMs) {
        this.initialDelayMs = initialDelayMs;
        return this;
    }

    public RetryTask maxDelayMs(long maxDelayMs) {
        this.maxDelayMs = maxDelayMs;
        return this;
    }


    public RetryTask onRetry(RetryListener retryListener) {
        this.retryListener = retryListener;
        return this;
    }

    /**
     * 设置异常重试条件。返回 false 时立即抛出原始异常，不再通知监听器或退避等待。
     *
     * <p>与 {@link #failFastOnDeterministicError(boolean)} 的确定性错误闸门<b>相互独立</b>：
     * 本谓词是调用方显式表达的「这个异常不要重试」，闸门是框架层的「这类错误重试不可能成功」，
     * 两者均为终止重试的独立充分条件，任一命中都会原样抛出原始异常。</p>
     */
    public RetryTask retryIf(Predicate<Throwable> retryPredicate) {
        this.retryPredicate = retryPredicate == null ? e -> true : retryPredicate;
        return this;
    }

    /**
     * 开关：是否对<b>确定性错误</b>快速失败（默认<b>启用</b>）。
     *
     * <p><b>为何默认启用：</b>HTTP 400/401/403/404/405/413/414/422 是「请求本身的确定性缺陷」
     * 或「权限/额度问题」——请求体不会因为再发一次而变得合法，账户余额也不会在退避的几十秒内
     * 自行到账，<b>重试在数学上不可能修复它们</b>。实测会话 {@code work-mu74mh9v}：
     * 同一个 {@code HTTP 400 MissingParameter} 被重试 57 次、烧穿 3 个 2→20 阶梯、耗时 871 秒，
     * 每次都把当时的完整上下文（末轮 579,657 tokens）重新上行，重发 token 上界达该会话账面支出的
     * 118.7%；另有 8 次 {@code HTTP 403 insufficient_user_quota}（余额不足）被反复重试。</p>
     *
     * <p><b>不影响既有语义：</b>重试次数上限、指数退避与抖动算法、总时长预算、监听器通知
     * 全部逐字不变；本开关只<b>新增</b>一条「提前判定为不可重试则立即终止」的路径。
     * 429 限流、408/409、全部 5xx、网络异常/读超时/首信号超时，以及<b>解析不出状态码</b>的异常
     * 一律保持可重试（保守放行），详见 {@link LlmRetryPolicy}。</p>
     *
     * <p><b>终止方式：</b>原样抛出最后一次尝试的<b>真实异常实例</b>（不包装、不换类型、不改消息），
     * 故状态码与网关返回体原文完整保留，上层可将其直接展示给用户。</p>
     *
     * @param enabled false 可关闭本判定，行为退回历史版本（一切异常均按重试处理）
     * @since 4.1
     */
    public RetryTask failFastOnDeterministicError(boolean enabled) {
        this.failFastOnDeterministicError = enabled;
        return this;
    }

    /**
     * 设置重试的<b>总时长预算</b>（可选能力，默认不启用）。
     *
     * <p>动机：本类原本只有「重试次数 × 单次尝试时长 + 退避等待」的<b>隐式</b>上界，
     * 单次尝试很慢时（弱网、模型长挂）总耗时会被放大到次数倍，用户侧表现为「任务像死了一样」。</p>
     *
     * <p><b>语义（严格限定，避免改变既有行为）：</b></p>
     * <ul>
     *   <li><b>未配置</b>（不调用本方法，或传 null/零/负值）：完全无约束，与历史版本行为一致；</li>
     *   <li>计时自 {@code callWithRetry} 进入起算（{@code System.nanoTime}）；</li>
     *   <li>仅在两个裁决点生效：①准备发起<b>下一次</b>尝试之前；②准备进入<b>退避等待</b>之前。
     *       <b>绝不打断已在进行中的尝试</b>，故实际最坏耗时 ≈ 预算 + 一次单次尝试上限；</li>
     *   <li><b>首次尝试永不受预算约束</b>：预算再小也至少发一次，不构成功能性倒退；</li>
     *   <li>预算耗尽时<b>抛出最后一次的真实异常</b>（不包装、不换类型），使上层按异常类型
     *       分流用户文案的逻辑保持不变；同时打一条 WARN 留痕。</li>
     * </ul>
     *
     * <p>与 {@link #retryIf(Predicate)} 相互独立、可共存：{@code retryIf} 判定「这个异常该不该重试」，
     * 本预算判定「还有没有时间再重试」，两者均为「终止重试」的<b>独立</b>充分条件。</p>
     *
     * @param totalDeadline 总时长预算；null / 零 / 负值 均视为不启用
     */
    public RetryTask totalDeadline(Duration totalDeadline) {
        if (totalDeadline == null || totalDeadline.isZero() || totalDeadline.isNegative()) {
            this.totalDeadlineNanos = 0L;
        } else {
            try {
                this.totalDeadlineNanos = totalDeadline.toNanos();
            } catch (ArithmeticException e) {
                // 预算大到纳秒溢出（>292 年）等价于「无上限」，按未配置处理，不让配置失误抛异常
                this.totalDeadlineNanos = 0L;
            }
        }
        return this;
    }

    /**
     * 带指数退避和随机抖动的重试实现
     *
     * <p>若通过 {@link #totalDeadline(Duration)} 配置了总时长预算，则自本方法进入起计时；
     * 未配置时不做任何额外判定（零行为变化）。</p>
     *
     * @param callable 业务回调
     */
    public <T, X extends Throwable> T callWithRetry(CallableTx<T, Throwable> callable) throws X, InterruptedException {
        Throwable lastException = null;

        // 总时长预算起算点：budgetNanos <= 0 时下文所有预算分支均短路，仅余一次 nanoTime 取值开销
        final long startNanos = System.nanoTime();
        final long budgetNanos = this.totalDeadlineNanos;

        for (int i = 0; i < maxRetries; i++) {
            if (Thread.interrupted()) {
                break;
            }

            // 预算裁决点①：准备发起下一次尝试之前。
            // i > 0 保证首次尝试永不受约束；此处 lastException 必非空（i>0 即上一次已抛异常），
            // break 后由统一出口抛出「最后一次的真实异常」，不引入新异常类型。
            if (budgetNanos > 0 && i > 0 && (System.nanoTime() - startNanos) >= budgetNanos) {
                logBudgetExhausted(startNanos, budgetNanos, i, lastException, "before next attempt");
                break;
            }

            try {
                return callable.call();
            } catch (Throwable e) {
                lastException = e;

                if(e instanceof NullPointerException){
                    throw (NullPointerException)e;
                }

                if (e instanceof InterruptedException) {
                    throw (InterruptedException) e;
                }

                if (e.getCause() instanceof InterruptedException) {
                    throw (InterruptedException) e.getCause();
                }

                if (!retryPredicate.test(e)) {
                    throwThrowable(e);
                }

                // 确定性错误闸门：与 retryIf / totalDeadline 相互独立，任一命中即终止重试。
                // 400/401/403/404/405/413/414/422 属请求构造期的确定性缺陷或权限/额度问题，
                // 重发同一请求不可能改变结果；不拦则会把 maxRetries 全部烧穿（实测 57 次相同的
                // HTTP 400 / 871 秒 / 重发 token 达账面支出 118.7%）。
                // 原样抛出 e：状态码与网关原文完整保留，上层按异常分流用户文案的逻辑不变。
                if (failFastOnDeterministicError && LlmRetryPolicy.isNonRetryable(e)) {
                    logDeterministicFailure(i + 1, e);
                    throwThrowable(e);
                }

                // 如果还没到最后一次，执行等待逻辑
                if (i < (maxRetries - 1)) {
                    if (retryListener != null) {
                        retryListener.onRetry(i + 1, e);
                    }

                    // 1. 计算基础指数延迟：initialDelay * 2^i
                    long exponentialDelay = initialDelayMs * (1L << i);

                    // 2. 限制在最大延迟范围内
                    long cappedDelay = Math.min(exponentialDelay, maxDelayMs);

                    // 3. 引入随机抖动 (Full Jitter 策略)
                    // 在 0 到 cappedDelay 之间取随机值，能有效平滑瞬时压力
                    long actualDelay = ThreadLocalRandom.current().nextLong(0, cappedDelay + 1);

                    // 预算裁决点②：准备进入退避等待之前。
                    // 剩余预算 < 计划退避时长 → 直接终止，而非「把等待截断到剩余预算」。
                    // 理由：截断等待后剩余预算必归零，下一轮循环的裁决点①必然立即终止，
                    // 那段等待对结果毫无影响，只是把同一个失败结果向后拖延，纯增用户等待；
                    // 直接终止能把真实错误尽早交给上层，正是本预算能力的目的。
                    if (budgetNanos > 0) {
                        long remainingNanos = budgetNanos - (System.nanoTime() - startNanos);
                        if (remainingNanos <= 0L || remainingNanos < actualDelay * 1_000_000L) {
                            logBudgetExhausted(startNanos, budgetNanos, i + 1, e, "before backoff wait");
                            break;
                        }
                    }

                    try {
                        if (actualDelay > 0) {
                            Thread.sleep(actualDelay);
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
        }

        // 统一异常抛出逻辑
        if (lastException == null) {
            // 线程被中断退出，没有业务异常（Thread.interrupted() 为 true 导致 break，未进入 catch）
            throw new InterruptedException("Retry aborted: thread interrupted before any attempt");
        }

        throwThrowable(lastException);
        return null;
    }

    /**
     * 预算耗尽而提前终止重试时的留痕。
     *
     * <p>这是一条“本可重试但主动放弃”的决策，不写日志就无法区分「重试全败」与
     * 「预算耗尽提前放弃」，故必须 WARN 级而非 debug。</p>
     */
    private void logBudgetExhausted(long startNanos, long budgetNanos, int attempts, Throwable lastException, String phase) {
        LOG.warn("Retry aborted: total time budget exhausted at [{}] ({}ms elapsed / {}ms budget / {} attempt(s) made). Last error: {}",
                phase,
                (System.nanoTime() - startNanos) / 1_000_000L,
                budgetNanos / 1_000_000L,
                attempts,
                lastException == null ? "none" : lastException.toString(),
                lastException);
    }

    /**
     * 因「确定性错误」提前终止重试时的留痕。
     *
     * <p>这是一条「本可重试但判定为重试无意义」的决策，不写日志就无法区分「重试全败」与
     * 「快速失败」，故必须 WARN 级。<b>不打堆栈</b>：确定性错误的价值信息全在消息里
     * （状态码 + 网关原文），堆栈只会淹没它并在高频失败时刷爆日志。</p>
     *
     * @param attempts 已发生的尝试次数（含本次失败的这一次）
     */
    private void logDeterministicFailure(int attempts, Throwable e) {
        LOG.warn("Retry aborted: non-retryable deterministic error at attempt {} (httpStatus={}), "
                        + "failing fast without consuming the remaining retry budget. Error: {}",
                attempts, LlmRetryPolicy.resolveHttpStatus(e), e.toString());
    }

    @SuppressWarnings("unchecked")
    private static <X extends Throwable> void throwThrowable(Throwable exception) throws X {
        throw (X) exception;
    }
}