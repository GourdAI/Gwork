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
package com.gourdai.ai.chat;

import org.noear.solon.lang.Preview;

/**
 * 携带 <b>HTTP 状态码</b>的模型调用异常。
 *
 * <p><b>为何需要：</b>{@link ChatException} 只有一个 message 字段，HTTP 失败的状态码此前只以
 * {@code "HTTP 400: ..."} 的<b>文本前缀</b>形式存在（见 {@link LlmErrorMessages#httpErrorText}）。
 * 任何需要按状态码分流的逻辑（尤其是「确定性错误不重试」判定）若只能从字符串里捞数字，
 * 就会被网关包装、本地化文案与响应体里嵌套的其它数字干扰，判错即意味着要么白烧重试预算、
 * 要么把瞬态故障误判为致命。本类把状态码提升为<b>类型化字段</b>，使判定可以基于真实取到的值。</p>
 *
 * <p><b>兼容性：</b>继承 {@link ChatException}，故所有 {@code catch (ChatException)} 与
 * {@code instanceof ChatException} 的既有分支逐字不变；message 仍由
 * {@link LlmErrorMessages#httpErrorText} 组装，保留「状态码 + 网关原文」，
 * 上层展示（{@link LlmErrorMessages#describe}）不会丢失任何信息。</p>
 *
 * @author oisin
 * @since 4.1
 */
@Preview("4.1")
public class LlmHttpStatusException extends ChatException {
    /** 状态码未知（如响应未能读出状态行）时的占位值 */
    public static final int UNKNOWN_STATUS = 0;

    //上游返回的 HTTP 状态码；UNKNOWN_STATUS 表示未知
    private final int httpStatus;

    public LlmHttpStatusException(int httpStatus, String message) {
        super(message);
        this.httpStatus = httpStatus;
    }

    public LlmHttpStatusException(int httpStatus, String message, Throwable cause) {
        super(message, cause);
        this.httpStatus = httpStatus;
    }

    /**
     * 上游返回的 HTTP 状态码。
     *
     * @return 真实状态码；{@link #UNKNOWN_STATUS}（0）表示未能取到
     */
    public int httpStatus() {
        return httpStatus;
    }

    /** {@link #httpStatus()} 的 JavaBean 风格别名 */
    public int getHttpStatus() {
        return httpStatus;
    }

    /** 是否确实取到了状态码（未知时不应参与任何按状态码的分流判定） */
    public boolean hasHttpStatus() {
        return httpStatus > 0;
    }
}
