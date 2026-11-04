package com.gourdai.core.portal.web;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 单轮耗时与输出速度（TurnTimer / TurnTiming）行为测试。
 *
 * <p>与旧版本的区别：旧测试主要靠读 {@code WebStreamBuilder.java} 源码断言字符串形态，
 * 只能证明「代码长成某个样子」，证明不了口径正确。本测试用<b>确定性时钟</b>驱动真实的
 * 事件时序（可见帧 / 用量结算 / 工具执行间隙），直接断言算出来的数值。</p>
 *
 * <p>核心被测口径：TPS 的分子分母必须同范围——{@code generatedTokens} 只累加那些
 * 解码段被成功计时的调用，{@code generationMs} 只累加解码段本身，工具执行与等待间隙不得计入。</p>
 */
@DisplayName("单轮耗时：解码段计时与 TTFT 口径")
class TurnTimingTraceTest {

    /** 可推进的假时钟（纳秒），让时序完全确定，不依赖真实耗时。 */
    private static final class FakeClock implements LongSupplier {
        private long nanos = 1_000_000_000L;

        void advanceMs(long ms) {
            nanos += ms * 1_000_000L;
        }

        @Override
        public long getAsLong() {
            return nanos;
        }
    }

    @Test
    @DisplayName("工具执行时间不得计入解码段：TPS 分母只含模型真正在吐字的时间")
    void toolExecutionTimeIsExcludedFromGeneration() {
        FakeClock clock = new FakeClock();
        long startNanos = clock.getAsLong();
        TurnTimer timer = new TurnTimer(startNanos, clock);

        // 第 1 次模型调用：等 500ms 出首字，解码 1000ms，产出 100 token
        clock.advanceMs(500);
        timer.onVisibleOutput();
        clock.advanceMs(1000);
        timer.onUsageSettled(100);

        // 工具执行 8 秒——这段时间模型完全没在解码，绝不能进 TPS 分母
        clock.advanceMs(8000);

        // 第 2 次模型调用：解码 1000ms，产出 100 token
        timer.onVisibleOutput();
        clock.advanceMs(1000);
        timer.onUsageSettled(100);

        TurnTiming t = timer.finish(System.currentTimeMillis());

        assertEquals(2000L, t.getGenerationMs(), "解码段只应累计两次 1000ms，8 秒工具执行必须被排除");
        assertEquals(200L, t.getGeneratedTokens(), "配对 token 为两次调用之和");
        // 真实解码速度 = 200 / 2s = 100 tokens/s；若误用总时长(10.5s)做分母只有 19 tokens/s
        double tps = t.getGeneratedTokens() * 1000.0 / t.getGenerationMs();
        assertEquals(100.0, tps, 0.001, "TPS 必须反映解码速度，而非被工具时间稀释的伪吞吐");
    }

    @Test
    @DisplayName("TTFT 取首个可见输出，后续段不覆盖它")
    void ttftTakesFirstVisibleOutputOnly() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);

        clock.advanceMs(1690);
        timer.onVisibleOutput();
        // 同一段内的后续帧不得改写 TTFT
        clock.advanceMs(300);
        timer.onVisibleOutput();
        timer.onUsageSettled(50);
        // 第二次调用的首帧同样不得改写
        clock.advanceMs(2000);
        timer.onVisibleOutput();
        timer.onUsageSettled(50);

        TurnTiming t = timer.finish(System.currentTimeMillis());
        assertEquals(1690L, t.getTtftMs(), "TTFT 必须是本轮第一个可见输出的时刻");
    }

    @Test
    @DisplayName("无可见输出的轮次：TTFT 与解码段均为 null，不得用 0 兜底")
    void noVisibleOutputKeepsNull() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);

        // 启动即异常/被停止：没有任何可见帧，却可能收到用量结算
        clock.advanceMs(1200);
        timer.onUsageSettled(0);

        TurnTiming t = timer.finish(System.currentTimeMillis());

        assertNull(t.getTtftMs(), "0 会被读成「瞬时响应」，比缺失更误导");
        assertNull(t.getGenerationMs(), "没有解码段起点时不得臆造时长");
        assertNull(t.getGeneratedTokens(), "分子必须与分母同进同出");
        assertNotNull(t.getElapsedMs(), "总时长仍可测量");
    }

    @Test
    @DisplayName("未被计时的调用其 token 不得计入分子（分子分母严格同范围）")
    void uncountedCallTokensAreNotAccumulated() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);

        // 第 1 次调用正常：解码 1000ms / 100 token
        timer.onVisibleOutput();
        clock.advanceMs(1000);
        timer.onUsageSettled(100);

        // 第 2 次调用「无可见输出直接结算」（例如全程只调内部工具）：
        // 没有解码段起点，其 token 不可与任何时长配对，必须整体丢弃
        clock.advanceMs(5000);
        timer.onUsageSettled(9999);

        TurnTiming t = timer.finish(System.currentTimeMillis());

        assertEquals(1000L, t.getGenerationMs());
        assertEquals(100L, t.getGeneratedTokens(), "未计时调用的 9999 token 不得混入，否则 TPS 暴涨");
    }

    @Test
    @DisplayName("总时长的秒与毫秒同源，且由单调时钟推导")
    void elapsedSecondsAndMsShareSameSource() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);

        clock.advanceMs(27_993);
        TurnTiming t = timer.finish(System.currentTimeMillis());

        assertEquals(27_993L, t.getElapsedMs());
        // 后端整秒按向下截断（Duration.getSeconds 语义），前端展示时才做四舍五入
        assertEquals(27L, t.getElapsedSeconds(), "整秒须由同一时长截断得出，不得另取一次时间");
    }

    @Test
    @DisplayName("墙钟回拨不会污染指标：时长一律由单调时钟推导")
    void wallClockGoesBackwardDoesNotBreakMetrics() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);

        timer.onVisibleOutput();
        clock.advanceMs(1000);
        timer.onUsageSettled(100);

        // 传入一个「未来」的墙钟起点（模拟 NTP 校时把系统时间往前调）
        TurnTiming t = timer.finish(System.currentTimeMillis() + 60_000L);

        assertTrue(t.getElapsedMs() >= 0, "总时长不得为负");
        assertEquals(1000L, t.getGenerationMs(), "解码段来自单调时钟，不受墙钟跳变影响");
    }

    @Test
    @DisplayName("无起始时间的轮次返回空快照")
    void missingTurnStartYieldsEmpty() {
        TurnTimer timer = TurnTimer.start();
        TurnTiming t = timer.finish(0L);

        assertNull(t.getElapsedMs());
        assertNull(t.getElapsedSeconds());
        assertNull(t.getTtftMs());
        assertNull(t.getGenerationMs());
    }

    @Test
    @DisplayName("ofTrace 落盘字段完整，且缺指标时不臆造 0")
    void ofTraceCarriesTimingSnapshot() {
        TurnTiming timing = new TurnTiming(27L, 27_993L, 1_690L, 5_000L, 1_410L);
        WebChunk chunk = WebChunk.ofTrace("hy4-preview", 45_100L, 1_600L,
                1_200L, 28_700L, 69.2D, timing, "答案");

        assertEquals("trace", chunk.getType());
        assertEquals(27_993L, chunk.getElapsedMs());
        assertEquals(1_690L, chunk.getTtftMs());
        assertEquals(5_000L, chunk.getGenerationMs(), "解码段须原样下发，供前端算 TPS");
        assertEquals(1_410L, chunk.getGeneratedTokens(), "配对 token 须与解码段同源");
        assertEquals(27L, chunk.getElapsedSeconds());
        // outputTokens 是整轮累计（含子代理），与 generatedTokens 是两个口径，必须并存
        assertEquals(1_600L, chunk.getOutputTokens());
        assertEquals(46_700L, chunk.getTotalTokens());
        assertNotNull(chunk.getCreatedAt());

        WebChunk bare = WebChunk.ofTrace("m", null, null, null, null, null, TurnTiming.EMPTY, null);
        assertNull(bare.getElapsedMs());
        assertNull(bare.getTtftMs());
        assertNull(bare.getGenerationMs());
        assertNull(bare.getGeneratedTokens());
        assertNull(bare.getTotalTokens());
    }

    @Test
    @DisplayName("ofTrace 容忍 null 快照，退化为全空指标而非抛错")
    void ofTraceToleratesNullTiming() {
        WebChunk chunk = WebChunk.ofTrace("m", 1L, 2L, null, null, null, null, "a");

        assertEquals("trace", chunk.getType());
        assertNull(chunk.getElapsedMs());
        assertNull(chunk.getGenerationMs());
    }

    @Test
    @DisplayName("典型多轮 ReAct 时序端到端：数值与手工核算一致")
    void realisticMultiRoundSequence() {
        FakeClock clock = new FakeClock();
        TurnTimer timer = new TurnTimer(clock.getAsLong(), clock);
        List<String> journal = new ArrayList<>();

        // 轮 1：思考 300ms 后出字，解码 700ms，出 210 token，随后调工具耗时 3000ms
        clock.advanceMs(300);
        timer.onVisibleOutput();
        journal.add("first-visible@300");
        clock.advanceMs(700);
        timer.onUsageSettled(210);
        clock.advanceMs(3000);

        // 轮 2：解码 500ms，出 90 token，再调工具 1500ms
        timer.onVisibleOutput();
        clock.advanceMs(500);
        timer.onUsageSettled(90);
        clock.advanceMs(1500);

        // 轮 3：解码 800ms，出 200 token，收尾
        timer.onVisibleOutput();
        clock.advanceMs(800);
        timer.onUsageSettled(200);

        TurnTiming t = timer.finish(System.currentTimeMillis());

        assertEquals(1, journal.size());
        assertEquals(300L, t.getTtftMs());
        assertEquals(2000L, t.getGenerationMs(), "700+500+800，两段工具共 4500ms 被排除");
        assertEquals(500L, t.getGeneratedTokens(), "210+90+200");
        assertEquals(6800L, t.getElapsedMs(), "总时长含工具：300+700+3000+500+1500+800");
        // 解码口径 250 tokens/s；若用总时长做分母会被稀释到 73 tokens/s
        assertEquals(250.0, t.getGeneratedTokens() * 1000.0 / t.getGenerationMs(), 0.001);
    }
}
