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
package com.gourdai.agent.trace;

import com.gourdai.ai.AiUsage;
import org.noear.solon.lang.Preview;

import java.io.Serializable;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 智能体执行指标统计
 *
 * @author oisin
 * @since 3.8.1
 */
@Preview("3.8.1")
public class Metrics implements Serializable {
    private transient final ReentrantLock LOCK = new ReentrantLock();

    /**
     * 总耗时（毫秒）
     */
    private volatile long totalDuration;

    /**
     * 输入令牌数（口径已归一：<b>恒为含缓存的真实输入</b>）。
     *
     * <p><b>为什么在采集端归一：</b>各家对「输入是否含缓存」口径不一（Anthropic 原生不含、OpenAI 已含），
     * 且子代理可使用<b>另一家厂商</b>的模型，其指标会通过 {@link #addMetrics} 并入父 trace。
     * 若把归一留到展示端再做，面对的就是<b>跨方言混合和</b>，判据不再自洽（会把 OpenAI 那部分已含的缓存重复计入）。
     * 故必须在 {@link #addUsage} 逐条累加时、于各自方言的上下文内完成归一。</p>
     */
    private volatile long promptTokens;
    private volatile long completionTokens;
    private volatile long totalTokens;

    /**
     * 缓存创建输入令牌数（Prompt Caching：本次写入缓存的 token）
     */
    private volatile long cacheCreationInputTokens;
    /**
     * 缓存读取输入令牌数（Prompt Caching：本次命中缓存、按折扣计费的 token）
     */
    private volatile long cacheReadInputTokens;


    // --- Setter & Accumulator Methods ---

    public void setTotalDuration(long totalDuration) {
        this.totalDuration = totalDuration;
    }

    public void setPromptTokens(long promptTokens) {
        this.promptTokens = promptTokens;
    }

    public void setCompletionTokens(long completionTokens) {
        this.completionTokens = completionTokens;
    }

    public void setTotalTokens(long totalTokens) {
        this.totalTokens = totalTokens;
    }

    public void setCacheCreationInputTokens(long cacheCreationInputTokens) {
        this.cacheCreationInputTokens = cacheCreationInputTokens;
    }

    public void setCacheReadInputTokens(long cacheReadInputTokens) {
        this.cacheReadInputTokens = cacheReadInputTokens;
    }

    public void reset() {
        LOCK.lock();

        try {
            this.totalDuration = 0;
            this.promptTokens = 0;
            this.completionTokens = 0;
            this.totalTokens = 0;
            this.cacheCreationInputTokens = 0;
            this.cacheReadInputTokens = 0;
        } finally {
            LOCK.unlock();
        }
    }

    public void addMetrics(Metrics metrics) {
        LOCK.lock();

        try {
            this.promptTokens += metrics.promptTokens;
            this.completionTokens += metrics.completionTokens;
            this.totalTokens += metrics.totalTokens;
            this.cacheCreationInputTokens += metrics.cacheCreationInputTokens;
            this.cacheReadInputTokens += metrics.cacheReadInputTokens;
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 累加单条真实用量。
     *
     * <p>输入令牌在此处<b>逐条归一</b>为「含缓存的真实输入」（见 {@link UsageNormalizer}）：
     * 每条 usage 都在自己方言的上下文内判定，因此跨厂商（父/子代理不同模型）求和后依旧正确。</p>
     */
    public void addUsage(AiUsage usage) {
        LOCK.lock();

        try {
            this.promptTokens += UsageNormalizer.normalizeInputTokens(
                    usage.promptTokens(), usage.cacheCreationInputTokens(), usage.cacheReadInputTokens());
            this.completionTokens += usage.completionTokens();
            this.totalTokens += usage.totalTokens();
            this.cacheCreationInputTokens += usage.cacheCreationInputTokens();
            this.cacheReadInputTokens += usage.cacheReadInputTokens();
        } finally {
            LOCK.unlock();
        }
    }


    // --- Getter Methods ---

    public long getTotalDuration() {
        return totalDuration;
    }

    /**
     * 输入令牌数（口径已归一：恒为含缓存的真实输入，无需再叠加缓存）
     */
    public long getPromptTokens() {
        return promptTokens;
    }

    public long getCompletionTokens() {
        return completionTokens;
    }

    public long getTotalTokens() {
        return totalTokens;
    }

    public long getCacheCreationInputTokens() {
        return cacheCreationInputTokens;
    }

    public long getCacheReadInputTokens() {
        return cacheReadInputTokens;
    }

    @Override
    public String toString() {
        return "Metrics{" +
                "totalDuration=" + totalDuration +
                ", promptTokens=" + promptTokens +
                ", completionTokens=" + completionTokens +
                ", totalTokens=" + totalTokens +
                ", cacheCreationInputTokens=" + cacheCreationInputTokens +
                ", cacheReadInputTokens=" + cacheReadInputTokens +
                '}';
    }
}