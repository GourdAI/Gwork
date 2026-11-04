package com.gourdai.ai.chat.dialect;

import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.llm.dialect.anthropic.AnthropicChatDialect;
import org.junit.jupiter.api.Test;
import org.noear.solon.net.http.HttpTimeout;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 弱网优化（2026-09-18）：LLM HTTP 三段式超时的取值契约。
 *
 * <p>建连固定 10s（弱网「连不上」10s 即暴露，不再陪跑配置值 120s）；
 * 写/读取「配置值与 15s 下限」中的较大者（下限与流层帧间下限对齐，
 * 保证超时判定权始终在流层；同时根治 getSeconds() 截断 &lt;1s 配置为 0 的旧缺陷）。</p>
 */
class AbstractChatDialectHttpTimeoutTest {

    private final AbstractChatDialect dialect = new AnthropicChatDialect();

    private HttpTimeout of(Duration configured) {
        ChatConfig config = new ChatConfig();
        config.setTimeout(configured);
        return dialect.buildHttpTimeout(config);
    }

    @Test
    void defaultConfigGetsConnect10sAndIoKeepConfigured() {
        HttpTimeout t = of(Duration.ofSeconds(120));
        assertEquals(Duration.ofSeconds(10), t.getConnectTimeout());
        assertEquals(Duration.ofSeconds(120), t.getWriteTimeout());
        assertEquals(Duration.ofSeconds(120), t.getReadTimeout());
    }

    @Test
    void subSecondConfigIsLiftedToIoFloorNotTruncatedToZero() {
        HttpTimeout t = of(Duration.ofMillis(500));
        assertEquals(Duration.ofSeconds(10), t.getConnectTimeout());
        // 旧实现回归锚点：getSeconds() 截断会把 500ms 变 0（彻底禁用 HTTP 层超时）
        assertEquals(Duration.ofSeconds(15), t.getWriteTimeout());
        assertEquals(Duration.ofSeconds(15), t.getReadTimeout());
    }

    @Test
    void midRangeConfigKeepsExactValueWithMillisecondPrecision() {
        HttpTimeout t = of(Duration.ofMillis(30_500));
        assertEquals(Duration.ofSeconds(10), t.getConnectTimeout());
        assertEquals(Duration.ofMillis(30_500), t.getWriteTimeout());
        assertEquals(Duration.ofMillis(30_500), t.getReadTimeout());
    }
}
