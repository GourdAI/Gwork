/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.ai;

import org.noear.solon.Utils;
import com.gourdai.ai.util.ProxyDesc;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.net.http.HttpTimeout;
import org.noear.solon.net.http.HttpUtils;
import org.noear.solon.net.http.impl.HttpSslSupplierAny;

import java.io.Serializable;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Ai 接口配置
 *
 * @author noear
 * @since 3.1
 */
public class AiConfig implements Serializable {
    //用于管理显示
    protected @Nullable String name;
    protected @Nullable String description;
    protected long contextLength;
    protected boolean enabled = true;

    protected String apiUrl;
    protected String apiKey;
    protected String standard; //接口规范
    protected String provider;
    protected String model;
    protected final Map<String, String> headers = new LinkedHashMap<>();
    protected String userAgent;
    protected Duration timeout = Duration.ofSeconds(120);

    /** 端点建连超时（DNS + TCP + TLS 握手）：弱网下建连卡死不应占用整个模型超时预算 */
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

    /**
     * 读写超时下限：与 {@code AbstractChatDialect#LLM_IO_TIMEOUT_FLOOR}（15s）刻意保持同值，
     * 后者又与流层帧间空闲下限（{@code ChatRequestDescDefault#STREAM_IDLE_FLOOR}）对齐。
     *
     * <p>语义：断流主防线在流层，socket 读超时若比流层下限更严，慢流会被 HTTP 层先杀，
     * 流层的防误杀设计被绕过；IO 段 ≥ 该下限保证「超时判定权始终归流层」。
     *
     * <p>此处独立定义而非复用方言层常量：本类位于 {@code com.gourdai.ai}，是 dialect 层的
     * 依赖方（依赖方向 dialect → config），反向引用 {@code chat.dialect} 会造成分层倒置。
     * 修改任一处请同步另一处。
     */
    private static final Duration IO_TIMEOUT_FLOOR = Duration.ofSeconds(15);
    protected ProxyDesc proxy; //给配置用
    protected transient Proxy proxyInstance; //给代码用



    /// ///////////////////


    public String getName() {
        return name;
    }


    public String getNameOrModel() {
        if(Assert.isEmpty(name)) {
            return model;
        }

        return name;
    }

    public String getDescription() {
        return description;
    }

    public String getDescriptionOrModel() {
        if(Assert.isEmpty(description)) {
            return model;
        }

        return description;
    }

    public String getApiKey() {
        return apiKey;
    }

    public String getApiUrl() {
        return apiUrl;
    }

    /**
     * 接口规范
     *
     * @since 4.0
     */
    public String getStandard() {
        return standard;
    }

    /**
     * @since 4.0
     */
    public String getStandardOrProvider() {
        if (standard == null) {
            return provider;
        } else {
            return standard;
        }
    }

    public String getProvider() {
        return provider;
    }

    public String getModel() {
        return model;
    }

    public long getContextLength() {
        return contextLength;
    }

    public Map<String, String> getHeaders() {
        return headers;
    }

    public String getUserAgent() {
        return userAgent;
    }

    public Duration getTimeout() {
        return timeout;
    }

    public Proxy getProxy() {
        if (proxyInstance == null) {
            if (proxy != null) {
                proxyInstance = new Proxy(
                        Proxy.Type.valueOf(proxy.type),
                        new InetSocketAddress(proxy.host, proxy.port));
            }
        }

        return proxyInstance;
    }

    /// ///////////////////

    public void setName(String name) {
        this.name = name;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public void setApiUrl(String apiUrl) {
        this.apiUrl = apiUrl;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public void setStandard(String standard) {
        this.standard = standard;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public void setContextLength(long contextLength) {
        this.contextLength = contextLength;
    }

    public void setHeaders(Map<String, String> headers) {
        if (headers != null) {
            this.headers.putAll(headers);
        }
    }

    public void setHeader(String key, String value) {
        headers.put(key, value);
    }

    public void setUserAgent(String userAgent) {
        this.userAgent = userAgent;
    }

    public void setTimeout(Duration timeout) {
        if (timeout != null) {
            this.timeout = timeout;
        }
    }

    public void setProxyInstance(Proxy proxyInstance) {
        this.proxyInstance = proxyInstance;
        this.proxy = null;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    /**
     * 解算 HTTP 层读/写超时：取「配置值与 {@link #IO_TIMEOUT_FLOOR} 下限」中的较大者。
     *
     * <p>与 {@code AbstractChatDialect#buildHttpTimeout} 同一口径；也顺带避开了 0/负值
     * （{@code HttpTimeout.of(0)} 在 OkHttp 语义下 = 永不超时）。
     */
    private Duration resolveIoTimeout() {
        Duration total = getTimeout();

        if (total == null || IO_TIMEOUT_FLOOR.compareTo(total) > 0) {
            return IO_TIMEOUT_FLOOR;
        }

        return total;
    }

    /**
     * 创建 http 请求
     */
    public HttpUtils createHttpUtils() {
        HttpUtils httpUtils = HttpUtils
                .http(getApiUrl())
                .ssl(HttpSslSupplierAny.getInstance())
                // 弱网优化（2026-09-18）：三段式超时——建连 10s 固定、写/读沿用配置值（毫秒精度），
                // 并套 15s IO 下限（与 AbstractChatDialect#buildHttpTimeout 同一口径，超时判定权归流层）。
                // 原 (int) getSeconds() 会把 <1s 配置截断成 0（彻底禁用 HTTP 层超时），
                // 且建连要陪跑配置值（默认 120s），弱网「连不上」表现为前端干等两分钟。
                // 注意 HttpTimeout.of(Duration,Duration,Duration) 参数顺序是 (connect, write, read)。
                .timeout(HttpTimeout.of(CONNECT_TIMEOUT, resolveIoTimeout(), resolveIoTimeout()));

        if (getProxy() != null) {
            httpUtils.proxy(getProxy());
        }

        if (Utils.isNotEmpty(getApiKey())) {
            httpUtils.header("Authorization", "Bearer " + getApiKey());
        }

        if (Utils.isNotEmpty(getUserAgent())) {
            httpUtils.userAgent(getUserAgent());
        }

        httpUtils.headers(getHeaders());

        return httpUtils;
    }

    @Override
    public String toString() {
        return "AiConfig{" +
                "apiUrl='" + apiUrl + '\'' +
                ", apiKey='" + apiKey + '\'' +
                ", standard='" + standard + '\'' +
                ", provider='" + provider + '\'' +
                ", model='" + model + '\'' +
                ", headers=" + headers +
                ", timeout=" + timeout +
                ", proxy=" + getProxy() +
                '}';
    }
}