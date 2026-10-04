package com.gourdai.ai.chat;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 弱网优化（2026-09-18）+ 误杀修复（2026-09-30）：流式超时拆分的策略单元。
 *
 * <p>TTFT（首帧）沿用配置值（排队 + 慢网 + 推理模型首 token 慢，不宜收紧）；
 * 帧间空闲独立预算，与配置值等宽并夹取到 [15s, 10min]：</p>
 * <ul>
 *     <li>配置 60s / 90s / 120s / 300s / 500s → 原值直通（2026-09-30 前 90s/120s 会被
 *     固定 60s 上限拦腰截断，误杀帧间隔合法 >60s 的推理型模型慢流）；</li>
 *     <li>30s / 15s 等更严的用户显式配置 → 尊重用户，不做放松；</li>
 *     <li>5s / 300ms 等极端短配置 → 抬到 15s 下限，避免对合法慢流误杀；</li>
 *     <li>≥10min 的荒谬大配置 → 封顶 10min，断流发现窗口不失去意义。</li>
 * </ul>
 */
class StreamTimeoutPolicyTest {

    @Test
    void idleTimeoutMatchesConfiguredWithinWindow() {
        assertEquals(Duration.ofSeconds(120),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(120)));
        assertEquals(Duration.ofSeconds(90),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(90)));
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(60)));
        // 推理型模型长超时路由（如 300s / 500s）：帧间窗口必须与配置等宽，
        // 否则后台成功完成的请求会被前端误判断流（2026-09-30 事故形态）
        assertEquals(Duration.ofSeconds(300),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(300)));
        assertEquals(Duration.ofSeconds(500),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(500)));
    }

    @Test
    void idleTimeoutIsCappedAtTenMinutes() {
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofMinutes(10)), "边界值不被改写");
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofHours(1)));
    }

    @Test
    void idleTimeoutFallsBackToDefaultForInvalidConfig() {
        assertEquals(Duration.ofSeconds(120),
                ChatRequestDescDefault.resolveStreamIdleTimeout(null), "null 按基准 120s 推导");
        assertEquals(Duration.ofSeconds(120),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ZERO));
        assertEquals(Duration.ofSeconds(120),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(-30)));
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
