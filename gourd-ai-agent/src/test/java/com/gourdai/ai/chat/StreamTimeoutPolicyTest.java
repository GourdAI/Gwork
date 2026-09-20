package com.gourdai.ai.chat;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 弱网优化（2026-09-18）：流式超时拆分的策略单元。
 *
 * <p>TTFT（首帧）沿用配置值（排队 + 慢网 + 推理模型首 token 慢，不宜收紧）；
 * 帧间空闲独立预算，取「配置值与 [15s, 60s] 区间」的夹取值：</p>
 * <ul>
 *     <li>默认 120s / 90s 等宽松配置 → 收紧到 60s（断流快速发现，弱网体验主要收益项）；</li>
 *     <li>30s 等更严的用户显式配置 → 尊重用户，不做放松；</li>
 *     <li>5s / 300ms 等极端短配置 → 抬到 15s 下限，避免对合法慢流误杀。</li>
 * </ul>
 */
class StreamTimeoutPolicyTest {

    @Test
    void idleTimeoutIsCappedAt60s() {
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(120)));
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(90)));
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(60)));
    }

    @Test
    void idleTimeoutRespectsTighterUserConfig() {
        assertEquals(Duration.ofSeconds(30),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(30)));
        assertEquals(Duration.ofSeconds(15),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(15)));
    }

    @Test
    void idleTimeoutHasFloorForExtremeShortConfig() {
        assertEquals(Duration.ofSeconds(15),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(5)));
        assertEquals(Duration.ofSeconds(15),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofMillis(300)));
    }
}
