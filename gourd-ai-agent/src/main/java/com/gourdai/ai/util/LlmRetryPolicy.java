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
package com.gourdai.ai.util;

import com.gourdai.ai.chat.LlmHttpStatusException;
import org.noear.solon.Utils;
import org.noear.solon.net.http.HttpResponseException;

import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 重试可行性判定：<b>确定性错误不重试</b>。
 *
 * <p><b>背景（实测事故）：</b>会话 {@code work-mu74mh9v} 中，一个请求构造期的
 * {@code HTTP 400 MissingParameter: missing 'input.type' parameter} 被物理重试了
 * <b>57 次</b>，烧穿 3 个完整的 2→20 重试阶梯，累计 <b>871 秒</b>；每次都把当时的完整上下文
 * （末轮 579,657 tokens）重新上行一遍，重发 token 上界达该会话账面支出的 <b>118.7%</b>。
 * 同期另有 8 次 {@code HTTP 403 insufficient_user_quota}（余额不足）被反复重试。
 * 全局普查（94 会话 / 8,231 轮）为 1,296 次重试、29 个烧穿阶梯、重发上界 1.23 亿 tokens。</p>
 *
 * <p><b>判据：</b>400/401/403/404/405/413/414/422 属于<b>请求本身的确定性缺陷</b>或
 * <b>权限/额度问题</b>——请求体不会因为再发一次而变得合法，账户余额也不会在退避的几十秒内
 * 自行到账。<b>重试在数学上不可能修复它们</b>，每一次重试都是纯粹的 token 与时间浪费。
 * 反之，408/409/429/5xx 与网络类异常是<b>瞬态</b>的，重试正是既有自愈能力的价值所在，
 * 必须原样保留（尤其 429 限流：退避后重试是唯一正确解）。</p>
 *
 * <p><b>状态码来源（按可信度降序）：</b></p>
 * <ol>
 *   <li>{@link LlmHttpStatusException#httpStatus()}：本项目 HTTP 失败路径
 *       （{@code LlmErrorMessages#httpErrorOf}，流式与非流式共用）构建的<b>类型化</b>状态码，
 *       是判定的<b>主路径</b>；</li>
 *   <li>{@link HttpResponseException#code()}：底座 HTTP 客户端直接抛出的异常，
 *       覆盖未经 {@code httpErrorOf} 改造的调用路径；</li>
 *   <li><b>兜底</b>：以上都取不到时，才退化为从异常消息里用正则提取状态码。
 *       这是<b>不得已的兜底</b>——消息会被网关层层包装、可能本地化，可靠性远低于类型化字段；
 *       故正则一律<b>锚定关键字</b>（{@code HTTP 400} / {@code 400 from POST} /
 *       {@code Response code: 400} / {@code "code":400} / {@code status=400}），
 *       绝不匹配裸数字，避免把 token 数、耗时等无关数字误认成状态码。</li>
 * </ol>
 *
 * <p><b>保守原则：</b>解析不出状态码（返回 {@link #UNKNOWN_STATUS}）时<b>一律按可重试处理</b>。
 * 未知错误可能是弱网、断流、首信号超时等真正的瞬态故障，把它们误判为致命会让既有自愈能力
 * 直接失效——「少省一点重试」远比「该重试时不重试」安全。</p>
 *
 * @author oisin
 * @since 4.1
 */
public final class LlmRetryPolicy {
    /** 状态码未知（不可解析）；此时一律按可重试处理 */
    public static final int UNKNOWN_STATUS = 0;

    /** 因果链最大下钻深度：防御性上限，防自引用循环导致死循环 */
    private static final int MAX_CAUSE_DEPTH = 8;

    /** 单条异常消息参与兜底正则扫描的字符上限：错误体可能极长，扫前缀已足够定位状态码 */
    private static final int MAX_SCAN_CHARS = 4096;

    /**
     * <b>不可重试</b>的 HTTP 状态码白名单（命中即立即失败，不消耗重试预算）。
     *
     * <ul>
     *   <li>400 Bad Request：请求体不合法（缺参/形状错），重发同一请求必然同样失败；</li>
     *   <li>401 Unauthorized / 403 Forbidden：鉴权失败或<b>额度不足</b>，与请求次数无关；</li>
     *   <li>404 Not Found：端点/模型名不存在，属配置错误；</li>
     *   <li>405 Method Not Allowed：方法不被允许，确定性；</li>
     *   <li>413 Payload Too Large / 414 URI Too Long：请求<b>体积</b>超限，
     *       在重试窗口内上下文只会更大不会更小，重试必然同样失败；</li>
     *   <li>422 Unprocessable Entity：语义校验不通过，确定性。</li>
     * </ul>
     *
     * <p><b>刻意排除</b>（保持可重试）：408 请求超时、409 冲突（可能瞬态）、
     * <b>429 限流（必须重试，退避后通常即可恢复）</b>、以及全部 5xx 服务端错误。</p>
     */
    public static final Set<Integer> NON_RETRYABLE_STATUS = Set.of(400, 401, 403, 404, 405, 413, 414, 422);

    /**
     * 兜底正则（<b>仅在类型化状态码取不到时使用</b>），按可信度<b>降序</b>排列：
     * 越靠前的形态越权威，故按「正则优先级 → 因果链深度」的顺序扫描，
     * 使本项目自己的 {@code HTTP <code>} 前缀永远压过响应体里嵌套的其它数字。
     */
    private static final Pattern[] FALLBACK_PATTERNS = {
            //本项目 LlmErrorMessages#httpErrorText 的固定前缀："HTTP 400 Bad Request: ..." / "HTTP 400: ..."
            Pattern.compile("\\bHTTP\\s*[:#]?\\s*(\\d{3})\\b", Pattern.CASE_INSENSITIVE),
            //底座 HttpResponseException 的消息形态："400 from POST https://..."
            Pattern.compile("\\b(\\d{3})\\s+from\\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\b", Pattern.CASE_INSENSITIVE),
            //网关包装形态："Response code: 400"
            Pattern.compile("\\bResponse\\s+code\\s*[:=]\\s*(\\d{3})\\b", Pattern.CASE_INSENSITIVE),
            //JSON 错误体形态："code":400 / "status":400 / "statusCode":400 / "http_status":400
            Pattern.compile("\"(?:code|status|statusCode|status_code|httpStatus|http_status)\"\\s*:\\s*(\\d{3})\\b", Pattern.CASE_INSENSITIVE),
            //键值对形态：status=400 / statusCode: 400
            Pattern.compile("\\b(?:statusCode|status_code|httpStatus|http_status|status|code)\\s*[=:]\\s*(\\d{3})\\b", Pattern.CASE_INSENSITIVE),
    };

    private LlmRetryPolicy() {
    }

    /**
     * 判定该异常是否为「重试不可能修复」的确定性失败。
     *
     * @param e 待判定异常，可为 null
     * @return true 表示应立即失败、不消耗重试预算
     */
    public static boolean isNonRetryable(Throwable e) {
        int status = resolveHttpStatus(e);
        return status > 0 && NON_RETRYABLE_STATUS.contains(status);
    }

    /**
     * 判定该异常是否为<b>超时类</b>失败（沿因果链测量）。
     *
     * <p><b>为何要把它单独识别出来：</b>超时与其它可重试错误（429/5xx）的<b>成本结构截然不同</b>。
     * 429/5xx 是上游<b>拒收</b>请求，重试几乎不产生 token 开销；而超时意味着请求<b>已被受理</b>、
     * 上游正在（或已经）完整生成并计费，只是结果没有按时回来。每重试一次，就把完整上下文
     * 重新上行一次、让上游重新生成一次——且越是大上下文越容易超时，形成「越杀越费」的正反馈。
     * 故调用方应对这类失败另设<b>更严的次数上限</b>（见 {@code ReasonTask} 的 {@code retryIf} 接线），
     * 而不是跟 429 共用同一个大预算。</p>
     *
     * <p><b>只认类型，不做消息匹配：</b>「timeout」这个词会出现在各种不相干的网关文案里
     * （如模型参数名、配置提示），按文本匹配会把无关错误误判为超时并提前放弃重试。</p>
     *
     * <p><b>刻意不包含</b> {@code InterruptedIOException}：它在本项目表达的是「用户取消/线程中断」
     * （见 {@code ChatRequestDescDefault#execWithTotalCap}），与超时语义正交，且已由 {@code RetryTask}
     * 的中断分支先行终止。</p>
     *
     * @param e 待判定异常，可为 null
     * @since 4.1
     */
    public static boolean isTimeoutLike(Throwable e) {
        Throwable cur = e;
        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (cur instanceof java.util.concurrent.TimeoutException
                    || cur instanceof java.net.SocketTimeoutException
                    || cur instanceof java.net.http.HttpTimeoutException) {
                return true;
            }
            cur = cur.getCause();
        }
        return false;
    }

    /**
     * {@link #isNonRetryable(Throwable)} 的反向表达，供 {@code retryIf} 谓词直接使用。
     *
     * <p>注意：本方法<b>不</b>判断「这个异常一定可以重试成功」，只判断「没有被认定为确定性失败」，
     * 因此对 null 与不可解析异常均返回 true（保守放行）。</p>
     */
    public static boolean isRetryable(Throwable e) {
        return !isNonRetryable(e);
    }

    /**
     * 从异常因果链中解析真实的 HTTP 状态码。
     *
     * <p>先做一遍<b>全链类型化</b>扫描（{@link LlmHttpStatusException} 优先于
     * {@link HttpResponseException}），都取不到才走消息正则兜底。</p>
     *
     * @param e 待解析异常，可为 null
     * @return 状态码；{@link #UNKNOWN_STATUS}（0）表示无法解析
     */
    public static int resolveHttpStatus(Throwable e) {
        if (e == null) {
            return UNKNOWN_STATUS;
        }

        //1) 类型化：本项目自己的 HTTP 异常，状态码最权威
        int status = scanChain(e, LlmHttpStatusException.class, (LlmHttpStatusException hit) -> hit.httpStatus());
        if (isValidStatus(status)) {
            return status;
        }

        //2) 类型化：底座 HTTP 客户端异常（覆盖未经 httpErrorOf 改造的路径）
        status = scanChain(e, HttpResponseException.class, HttpResponseException::code);
        if (isValidStatus(status)) {
            return status;
        }

        //3) 兜底：从消息里按正则提取（详见类注释，可靠性低于类型化字段）
        for (Pattern pattern : FALLBACK_PATTERNS) {
            status = scanChainMessage(e, pattern);
            if (isValidStatus(status)) {
                return status;
            }
        }

        return UNKNOWN_STATUS;
    }

    /** 状态码是否形似合法 HTTP 状态码（三位数，100..599） */
    private static boolean isValidStatus(int status) {
        return status >= 100 && status <= 599;
    }

    /** 沿因果链查找首个指定类型并按 extractor 取值；未命中返回 {@link #UNKNOWN_STATUS} */
    private static <T> int scanChain(Throwable e, Class<T> type, java.util.function.ToIntFunction<T> extractor) {
        Throwable cur = e;
        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (type.isInstance(cur)) {
                int status = extractor.applyAsInt(type.cast(cur));
                if (isValidStatus(status)) {
                    return status;
                }
            }
            cur = cur.getCause();
        }
        return UNKNOWN_STATUS;
    }

    /**
     * 兜底扫描：对因果链上每条非空消息套用同一正则，取<b>最左</b>匹配。
     *
     * <p>「最左优先」是刻意的：本项目组装的消息形如
     * {@code HTTP 502: upstream said: HTTP 400 bad}，最左的那个才是<b>本次响应</b>的真实状态码，
     * 右侧的是被引用的下游文本。</p>
     */
    private static int scanChainMessage(Throwable e, Pattern pattern) {
        Throwable cur = e;
        for (int depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
            String message = cur.getMessage();
            if (Utils.isNotEmpty(message)) {
                if (message.length() > MAX_SCAN_CHARS) {
                    message = message.substring(0, MAX_SCAN_CHARS);
                }
                Matcher matcher = pattern.matcher(message);
                if (matcher.find()) {
                    try {
                        int status = Integer.parseInt(matcher.group(1));
                        if (isValidStatus(status)) {
                            return status;
                        }
                    } catch (NumberFormatException ignore) {
                        //正则已限定三位数字，理论不可达；防御性忽略后继续下钻
                    }
                }
            }
            cur = cur.getCause();
        }
        return UNKNOWN_STATUS;
    }
}
