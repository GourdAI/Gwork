package com.gourdai.agent.react.intercept;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

class ContextCompressionInterceptorLongTest {
    @Test void defaultLongBudgetAndValidation() throws Exception {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();
        Method threshold = ContextCompressionInterceptor.class.getDeclaredMethod("finalTokenThreshold", org.noear.solon.ai.chat.ChatModel.class);
        threshold.setAccessible(true);
        assertEquals(102_400, threshold.invoke(interceptor, new Object[]{null}));
        assertThrows(IllegalArgumentException.class, () -> interceptor.setDefaultContextLength(0));
        interceptor.setDefaultContextLength(Long.MAX_VALUE);
        assertEquals(Integer.MAX_VALUE, threshold.invoke(interceptor, new Object[]{null}));
    }

    @Test void copyPreservesExplicitConfiguration() {
        ContextCompressionInterceptor interceptor = new ContextCompressionInterceptor();
        interceptor.setCompressionRatio(67);
        interceptor.setDefaultContextLength(256_000L);
        interceptor.setMinReservedMessages(25);
        ContextCompressionInterceptor copy = interceptor.copyWith(60);
        assertEquals(256_000L, copy.getDefaultContextLength());
        // minReservedMessages 为私有字段，其行为由 copyWith 源码和后续压缩测试覆盖。
    }
}
