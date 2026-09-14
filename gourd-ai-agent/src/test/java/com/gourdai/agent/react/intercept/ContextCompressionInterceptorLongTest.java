package com.gourdai.agent.react.intercept;

import com.gourdai.agent.ContextLengthPolicy;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

class ContextCompressionInterceptorLongTest {
    private static Method thresholdMethod() throws Exception {
        // 上下文窗口已改为会话级选择，阈值计算不再接收 ChatModel（模型配置彻底不参与）
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod("finalTokenThreshold", long.class);
        m.setAccessible(true);
        return m;
    }

    private static int thresholdOf(long contextLength) throws Exception {
        return (Integer) thresholdMethod().invoke(new ContextCompressionInterceptor(), contextLength);
    }

    private static int thresholdOf(ContextCompressionInterceptor interceptor, long contextLength) throws Exception {
        return (Integer) thresholdMethod().invoke(interceptor, contextLength);
    }

    @Test void defaultWindowIsSessionDefaultAndValidationHolds() throws Exception {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();

        // 默认窗口 = 会话级默认 256K（用户未选择时的回落值），不再是模型配置或 128K 硬编码
        assertEquals(ContextLengthPolicy.DEFAULT_CONTEXT_LENGTH, interceptor.getDefaultContextLength());

        // 触发阈值 = 窗口 − 输出预留(20K) − 回合缓冲(13K)，而非旧的「窗口 × 80%」。
        // 预留的是绝对量，因为一轮最多新增多少（模型输出 + 工具结果）不随窗口大小线性增长。
        assertEquals(256_000 - 20_000 - 13_000, thresholdOf(256_000L));

        assertThrows(IllegalArgumentException.class, () -> interceptor.setDefaultContextLength(0));

        assertEquals(Integer.MAX_VALUE, thresholdOf(Long.MAX_VALUE));
    }

    @Test void thresholdScalesByAbsoluteReserveAcrossWindows() throws Exception {
        // 200K：effectiveWindow=180K ≥ ... < 400K → buffer 13K
        assertEquals(167_000, thresholdOf(200_000L));

        // 500K：effectiveWindow=480K ≥ 400K → buffer 30K
        assertEquals(450_000, thresholdOf(500_000L));

        // 1M：effectiveWindow=980K ≥ 800K → buffer 50K。
        // 旧的 80% 比例只会给到 800K，白白浪费 130K 可用窗口。
        assertEquals(930_000, thresholdOf(1_000_000L));
    }

    @Test void smallWindowKeepsUsableFloorAndOutputHeadroom() throws Exception {
        // 32K 小窗口：输出预留被钳到 window/4，缓冲被钳到 effectiveWindow/2，
        // 且有 window/2 地板兜底 —— 既不会退化成每轮都压，也仍给一轮输出留出余量。
        int threshold = thresholdOf(32_000L);

        assertTrue(threshold >= 16_000, "小窗口应至少保留一半窗口可用，实际: " + threshold);
        assertTrue(threshold < 32_000, "阈值必须低于窗口本身，实际: " + threshold);
        assertTrue(32_000 - threshold >= 4_000,
                "必须为单轮输出留出余量，实际余量: " + (32_000 - threshold));
    }

    @Test void ratioOnlyPullsTriggerEarlierNeverLater() throws Exception {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();

        int absolute = thresholdOf(interceptor, 200_000L);   // ratio 默认 100 → 纯绝对阈值

        // ratio=50 更激进 → 触发点被拉早
        interceptor.setCompressionRatio(50);
        assertEquals(100_000, thresholdOf(interceptor, 200_000L));
        assertTrue(thresholdOf(interceptor, 200_000L) < absolute);

        // ratio=90 算出 180K > 绝对阈值 167K → 取 min，不得把触发点往后推
        interceptor.setCompressionRatio(90);
        assertEquals(absolute, thresholdOf(interceptor, 200_000L));
    }

    @Test void targetBudgetIsDeeperThanTriggerToAvoidThrashing() throws Exception {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();

        Method m = ContextCompressionInterceptor.class.getDeclaredMethod(
                "resolveTargetBudget", long.class, int.class);
        m.setAccessible(true);

        int trigger = thresholdOf(interceptor, 200_000L);
        int target = (Integer) m.invoke(interceptor, 200_000L, trigger);

        // 压缩后目标水位必须明显低于触发线，否则单次压缩腾出的空间会被
        // 一条大工具结果吃光，长会话陷入「压完没几轮又触发」的抖动。
        assertTrue(target < trigger, "目标水位应低于触发线");
        assertTrue(trigger - target > 50_000,
                "单次压缩应腾出足够空间，实际仅腾出: " + (trigger - target));

        // 目标水位永不高于触发线（否则等于没压）
        assertTrue((Integer) m.invoke(interceptor, 200_000L, 1_000) <= 1_000);
    }

    @Test void copyPreservesExplicitConfiguration() {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();
        interceptor.setCompressionRatio(67);
        interceptor.setDefaultContextLength(512_000L);
        interceptor.setMinReservedMessages(25);
        interceptor.setCompressionTargetRatio(60);
        interceptor.setReservedOutputTokens(8_000);
        interceptor.setIntentChainEnabled(false);
        interceptor.setIntentChainMaxTokens(1_234);

        ContextCompressionInterceptor copy = interceptor.copyWith(60);

        assertEquals(512_000L, copy.getDefaultContextLength());
        assertEquals(60, copy.getCompressionTargetRatio());
        assertEquals(8_000, copy.getReservedOutputTokens());
        assertFalse(copy.isIntentChainEnabled());
        assertEquals(1_234, copy.getIntentChainMaxTokens());
        assertEquals(25, copy.getMinReservedMessages());
    }

    @Test void configurationIsClamped() {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();

        interceptor.setCompressionTargetRatio(1);
        assertEquals(10, interceptor.getCompressionTargetRatio());
        interceptor.setCompressionTargetRatio(999);
        assertEquals(95, interceptor.getCompressionTargetRatio());

        interceptor.setReservedOutputTokens(10);
        assertEquals(1_000, interceptor.getReservedOutputTokens());

        interceptor.setIntentChainMaxTokens(1);
        assertEquals(200, interceptor.getIntentChainMaxTokens());
    }
}
