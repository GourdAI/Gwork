package com.gourdai.ai.mcp.client;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.net.http.HttpTimeout;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * MCP 客户端 HTTP 三段式超时换算的契约（弱网优化，2026-09-18）。
 *
 * <p>钉死两件事：</p>
 * <ol>
 *     <li><b>建连段固定 10s</b>：建连（DNS + TCP + TLS）卡死不应占用整个业务超时预算；</li>
 *     <li><b>读写段 1s 下限</b>：旧实现 {@code HttpTimeout.of((int) timeout.getSeconds())} 会把
 *     亚秒配置截断成 0，而 {@code HttpTimeout.of(0)} 在 OkHttp 语义下 = <b>永不超时</b>，
 *     且绕过 {@code HttpUtils.timeout(int)} 内部的非正数保护——弱网下彻底裸奔。</li>
 * </ol>
 *
 * <p>本测试与被测方法同包：{@code McpClientProperties#resolveHttpTimeout(Duration)} 是包级静态，
 * 同包直调即可，无需反射。{@code HttpTimeout} 的 getter 为
 * {@code getConnectTimeout() / getWriteTimeout() / getReadTimeout()}，均返回 {@link Duration}
 * （已由 class 文件常量池实证）。</p>
 */
class McpHttpTimeoutContractTest {

    /** 建连段：与业务超时无关的固定值。 */
    private static final Duration EXPECT_CONNECT = Duration.ofSeconds(10);

    /** 读写段下限。 */
    private static final Duration EXPECT_IO_FLOOR = Duration.ofSeconds(1);

    @Test
    @DisplayName("亚秒配置（500ms）：建连 10s / 写 1s / 读 1s——绝不能截断成 0")
    void subSecondTimeout_isLiftedToOneSecondFloor() {
        HttpTimeout t = McpClientProperties.resolveHttpTimeout(Duration.ofMillis(500));

        assertNotNull(t);
        assertEquals(EXPECT_CONNECT, t.getConnectTimeout(), "建连段必须固定 10s");
        assertEquals(EXPECT_IO_FLOOR, t.getWriteTimeout(), "写段必须抬到 1s 下限");
        assertEquals(EXPECT_IO_FLOOR, t.getReadTimeout(), "读段必须抬到 1s 下限");
    }

    @Test
    @DisplayName("零值 / null / 负值配置：读写段一律按 1s 下限兜底（HttpTimeout.of(0) = 永不超时）")
    void zeroNullOrNegativeTimeout_fallsBackToFloor() {
        Duration[] degenerate = {Duration.ZERO, null, Duration.ofSeconds(-30), Duration.ofMillis(1)};

        for (Duration in : degenerate) {
            HttpTimeout t = McpClientProperties.resolveHttpTimeout(in);

            assertNotNull(t, "输入=" + in);
            assertEquals(EXPECT_CONNECT, t.getConnectTimeout(), "建连段必须固定 10s，输入=" + in);
            assertEquals(EXPECT_IO_FLOOR, t.getWriteTimeout(), "写段下限失效，输入=" + in);
            assertEquals(EXPECT_IO_FLOOR, t.getReadTimeout(), "读段下限失效，输入=" + in);
        }
    }

    @Test
    @DisplayName("正常配置（30s，MCP 默认）：读写段原值直通，建连段仍为 10s")
    void normalTimeout_passesThroughForIoSegments() {
        HttpTimeout t = McpClientProperties.resolveHttpTimeout(Duration.ofSeconds(30));

        assertEquals(EXPECT_CONNECT, t.getConnectTimeout(), "建连不得陪跑业务超时（旧实现即为 30s）");
        assertEquals(Duration.ofSeconds(30), t.getWriteTimeout());
        assertEquals(Duration.ofSeconds(30), t.getReadTimeout());
    }

    @Test
    @DisplayName("毫秒精度不被丢弃：1500ms 保持 1500ms，而非被 getSeconds() 截断成 1s")
    void subSecondPrecisionIsPreserved() {
        HttpTimeout t = McpClientProperties.resolveHttpTimeout(Duration.ofMillis(1500));

        assertEquals(Duration.ofMillis(1500), t.getWriteTimeout(), "不得退化为整秒截断");
        assertEquals(Duration.ofMillis(1500), t.getReadTimeout(), "不得退化为整秒截断");
    }

    @Test
    @DisplayName("边界值 1s 恰好等于下限，不被改写")
    void exactlyFloorIsUnchanged() {
        HttpTimeout t = McpClientProperties.resolveHttpTimeout(Duration.ofSeconds(1));

        assertEquals(EXPECT_IO_FLOOR, t.getWriteTimeout());
        assertEquals(EXPECT_IO_FLOOR, t.getReadTimeout());
    }

    @Test
    @DisplayName("任意输入：三段均为正值，杜绝 0（永不超时）与负值")
    void allSegmentsAreAlwaysPositive() {
        Duration[] inputs = {
                null, Duration.ZERO, Duration.ofSeconds(-1), Duration.ofMillis(1),
                Duration.ofMillis(500), Duration.ofSeconds(1), Duration.ofSeconds(30),
                Duration.ofMinutes(5)
        };

        for (Duration in : inputs) {
            HttpTimeout t = McpClientProperties.resolveHttpTimeout(in);

            assertTrue(isPositive(t.getConnectTimeout()), "connect 非正，输入=" + in);
            assertTrue(isPositive(t.getWriteTimeout()), "write 非正，输入=" + in);
            assertTrue(isPositive(t.getReadTimeout()), "read 非正，输入=" + in);
        }
    }

    @Test
    @DisplayName("prepare() 走同一套换算：httpTimeout 未显式设置时按 resolveHttpTimeout 填充")
    void prepareUsesSameResolution() {
        McpClientProperties props = new McpClientProperties();
        props.setTimeout(Duration.ofMillis(500));
        props.prepare();

        HttpTimeout t = props.getHttpTimeout();
        assertNotNull(t, "prepare() 必须补齐 httpTimeout");
        assertEquals(EXPECT_CONNECT, t.getConnectTimeout());
        assertEquals(EXPECT_IO_FLOOR, t.getWriteTimeout());
        assertEquals(EXPECT_IO_FLOOR, t.getReadTimeout());

        // 业务超时（requestTimeout / initializationTimeout）仍跟随原配置，不受 HTTP 段下限影响
        assertEquals(Duration.ofMillis(500), props.getRequestTimeout());
        assertEquals(Duration.ofMillis(500), props.getInitializationTimeout());
    }

    @Test
    @DisplayName("显式设置的 httpTimeout 不被 prepare() 覆盖")
    void explicitHttpTimeoutIsRespected() {
        // 用单参 of(Duration) 构造（三段同值），断言不依赖三参重载的参数顺序
        HttpTimeout explicit = HttpTimeout.of(Duration.ofSeconds(7));

        McpClientProperties props = new McpClientProperties();
        props.setHttpTimeout(explicit);
        props.prepare();

        assertEquals(Duration.ofSeconds(7), props.getHttpTimeout().getConnectTimeout(),
                "显式配置被 prepare() 的默认换算覆盖了");
        assertEquals(Duration.ofSeconds(7), props.getHttpTimeout().getWriteTimeout());
        assertEquals(Duration.ofSeconds(7), props.getHttpTimeout().getReadTimeout());
    }

    private static boolean isPositive(Duration d) {
        return d != null && d.isZero() == false && d.isNegative() == false;
    }
}
