package com.gourdai.ai.chat;

import com.gourdai.ai.AiConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 弱网优化（2026-09-18）：三条「超时夹取」策略的契约钉死。
 *
 * <p>本类只测纯函数式的夹取推导，不发任何网络请求：</p>
 * <ul>
 *     <li>{@link ChatRequestDescDefault#resolveCallTotalTimeout(Duration)}：非流式总时长
 *     {@code min(max(configured × 3, 60s), 10min)}；</li>
 *     <li>{@link ChatRequestDescDefault#resolveStreamIdleTimeout(Duration)}：流式帧间空闲
 *     夹取到 [15s, 60s]；</li>
 *     <li>{@code AiConfig#resolveIoTimeout()}：HTTP 读写段 15s 下限（超时判定权归流层）。</li>
 * </ul>
 *
 * <p>三个下限常量（AiConfig#IO_TIMEOUT_FLOOR / AbstractChatDialect#LLM_IO_TIMEOUT_FLOOR /
 * ChatRequestDescDefault#STREAM_IDLE_FLOOR）是<b>刻意同值</b>的分层约定，单独改一处会让
 * HTTP 层先于流层杀掉慢流，绕过流层的防误杀设计，故一并钉死。</p>
 */
class TimeoutClampContractTest {

    @Test
    @DisplayName("非流式总时长：configured × 3；null / 零 / 负值按默认 120s 推导")
    void callTotalTimeout_derivesFromConfiguredTimesThree() {
        // 未配置口径：一律按 CALL_TIMEOUT_DEFAULT(120s) × 3 = 360s
        assertEquals(Duration.ofSeconds(360),
                ChatRequestDescDefault.resolveCallTotalTimeout(null), "null 走默认 120s × 3");
        assertEquals(Duration.ofSeconds(360),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ZERO), "零值走默认 120s × 3");
        assertEquals(Duration.ofSeconds(360),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(-30)), "负值走默认 120s × 3");

        // 默认配置：360s，处于 [60s, 600s] 之内，正常请求不受影响
        assertEquals(Duration.ofSeconds(360),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(120)));
        // ×3 而非 ×1：总时长必须宽于单段 socket 超时，否则推理型模型被误杀
        assertEquals(Duration.ofSeconds(90),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(30)));
    }

    @Test
    @DisplayName("非流式总时长：60s 下限防极端短配置误杀")
    void callTotalTimeout_hasSixtySecondFloor() {
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(5)), "5s × 3 = 15s 被抬到下限");
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(1)));
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofMillis(300)));
        // 边界：恰好等于下限，不被改写
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(20)));
    }

    @Test
    @DisplayName("非流式总时长：10 分钟绝对封顶（非流式期间用户零反馈）")
    void callTotalTimeout_isCappedAtTenMinutes() {
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofMinutes(10)), "10min × 3 = 30min 被封顶");
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofHours(1)));
        // 边界：恰好等于上限，不被改写
        assertEquals(Duration.ofMinutes(10),
                ChatRequestDescDefault.resolveCallTotalTimeout(Duration.ofSeconds(200)));
    }

    @Test
    @DisplayName("非流式总时长：任意输入的结果恒落在 [60s, 600s] 内（无边界反转）")
    void callTotalTimeout_alwaysWithinBounds() {
        Duration[] inputs = {
                Duration.ofMillis(1), Duration.ofMillis(999), Duration.ofSeconds(1),
                Duration.ofSeconds(19), Duration.ofSeconds(20), Duration.ofSeconds(21),
                Duration.ofSeconds(120), Duration.ofSeconds(199), Duration.ofSeconds(200),
                Duration.ofSeconds(201), Duration.ofMinutes(10), Duration.ofHours(1),
                Duration.ofDays(1), null, Duration.ZERO, Duration.ofSeconds(-1)
        };

        for (Duration in : inputs) {
            Duration out = ChatRequestDescDefault.resolveCallTotalTimeout(in);
            assertTrue(out.compareTo(Duration.ofSeconds(60)) >= 0, "低于下限: in=" + in + " out=" + out);
            assertTrue(out.compareTo(Duration.ofMinutes(10)) <= 0, "高于上限: in=" + in + " out=" + out);
        }
    }

    @Test
    @DisplayName("流式帧间空闲：15s 下限 / 原值直通 / 60s 封顶")
    void streamIdleTimeout_isClampedToFifteenToSixtySeconds() {
        assertEquals(Duration.ofSeconds(15),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofMillis(500)), "极端短配置抬到 15s 下限");
        assertEquals(Duration.ofSeconds(30),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(30)), "更严的用户配置不被放松");
        assertEquals(Duration.ofSeconds(60),
                ChatRequestDescDefault.resolveStreamIdleTimeout(Duration.ofSeconds(120)), "宽松配置收紧到 60s 上限");
    }

    @Test
    @DisplayName("流式帧间空闲：任意输入结果恒落在 [15s, 60s] 内，且 floor ≤ cap 无反转")
    void streamIdleTimeout_hasNoBoundaryInversion() throws Exception {
        Duration floor = readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "STREAM_IDLE_FLOOR");
        Duration cap = readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "STREAM_IDLE_CAP");

        assertEquals(Duration.ofSeconds(15), floor);
        assertEquals(Duration.ofSeconds(60), cap);
        assertTrue(floor.compareTo(cap) <= 0, "边界反转：floor(" + floor + ") > cap(" + cap + ")");

        Duration[] inputs = {
                Duration.ofMillis(1), Duration.ofMillis(500), Duration.ofSeconds(5),
                Duration.ofSeconds(15), Duration.ofSeconds(30), Duration.ofSeconds(60),
                Duration.ofSeconds(90), Duration.ofSeconds(120), Duration.ofHours(1)
        };

        for (Duration in : inputs) {
            Duration out = ChatRequestDescDefault.resolveStreamIdleTimeout(in);
            assertTrue(out.compareTo(floor) >= 0, "低于下限: in=" + in + " out=" + out);
            assertTrue(out.compareTo(cap) <= 0, "高于上限: in=" + in + " out=" + out);
        }
    }

    @Test
    @DisplayName("非流式总时长常量：默认 120s / 下限 60s / 上限 10min")
    void callTotalConstantsAreStable() throws Exception {
        assertEquals(Duration.ofSeconds(120),
                readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "CALL_TIMEOUT_DEFAULT"));
        assertEquals(Duration.ofSeconds(60),
                readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "CALL_TOTAL_FLOOR"));
        assertEquals(Duration.ofMinutes(10),
                readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "CALL_TOTAL_CAP"));
    }

    /**
     * {@code AiConfig#resolveIoTimeout()} 是 private 实例方法，且唯一公开出口
     * {@code createHttpUtils()} 需要合法 apiUrl 并真的构造 HttpUtils，
     * 断言目标（三段式超时的读写段取值）也不对外暴露，故此处用反射直调该方法：
     * 这是唯一能对「15s 下限」做精确断言且不触碰主代码可见性的方式。
     */
    @Test
    @DisplayName("AiConfig 的 HTTP 读写段：15s 下限生效，配置更宽时原值直通")
    void aiConfigIoTimeout_hasFifteenSecondFloor() throws Exception {
        Method resolveIoTimeout = AiConfig.class.getDeclaredMethod("resolveIoTimeout");
        resolveIoTimeout.setAccessible(true);

        AiConfig config = new AiConfig();
        // 默认 120s：宽于下限，原值直通
        assertEquals(Duration.ofSeconds(120), resolveIoTimeout.invoke(config), "默认配置应原值直通");

        config.setTimeout(Duration.ofSeconds(30));
        assertEquals(Duration.ofSeconds(30), resolveIoTimeout.invoke(config));

        config.setTimeout(Duration.ofSeconds(15));
        assertEquals(Duration.ofSeconds(15), resolveIoTimeout.invoke(config), "边界值不被改写");

        config.setTimeout(Duration.ofSeconds(5));
        assertEquals(Duration.ofSeconds(15), resolveIoTimeout.invoke(config), "5s 配置必须抬到 15s 下限");

        config.setTimeout(Duration.ofMillis(300));
        assertEquals(Duration.ofSeconds(15), resolveIoTimeout.invoke(config),
                "亚秒配置绝不能落到 0（HttpTimeout.of(0) = 永不超时）");

        // setTimeout(null) 被主代码刻意忽略，只能直接置空字段来覆盖 null 分支
        Field timeoutField = AiConfig.class.getDeclaredField("timeout");
        timeoutField.setAccessible(true);
        timeoutField.set(config, null);
        assertEquals(Duration.ofSeconds(15), resolveIoTimeout.invoke(config), "字段为 null 时按下限兜底");
    }

    @Test
    @DisplayName("分层约定：config / dialect / stream 三处 15s 下限常量必须同值")
    void ioTimeoutFloorsStayAligned() throws Exception {
        Duration configFloor = readStaticDuration("com.gourdai.ai.AiConfig", "IO_TIMEOUT_FLOOR");
        Duration dialectFloor = readStaticDuration("com.gourdai.ai.chat.dialect.AbstractChatDialect", "LLM_IO_TIMEOUT_FLOOR");
        Duration streamFloor = readStaticDuration("com.gourdai.ai.chat.ChatRequestDescDefault", "STREAM_IDLE_FLOOR");

        assertEquals(Duration.ofSeconds(15), configFloor, "AiConfig 的 IO 下限");
        assertEquals(configFloor, dialectFloor, "HTTP 层若比流层更严，流层防误杀设计会被绕过");
        assertEquals(configFloor, streamFloor, "超时判定权必须归流层");
    }

    @Test
    @DisplayName("AiConfig 的建连段固定 10s：建连不陪跑业务超时预算")
    void aiConfigConnectTimeoutIsFixed() throws Exception {
        assertEquals(Duration.ofSeconds(10), readStaticDuration("com.gourdai.ai.AiConfig", "CONNECT_TIMEOUT"));
    }

    /** 用 Class.forName + 反射读取，避免对主代码常量/类型可见性产生编译期依赖。 */
    private static Duration readStaticDuration(String className, String fieldName) throws Exception {
        Field field = Class.forName(className).getDeclaredField(fieldName);
        field.setAccessible(true);
        return (Duration) field.get(null);
    }
}
