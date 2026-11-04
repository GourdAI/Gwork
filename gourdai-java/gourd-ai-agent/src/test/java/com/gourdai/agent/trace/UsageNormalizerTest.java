package com.gourdai.agent.trace;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * {@link UsageNormalizer} 用量口径归一测试。
 *
 * <p>核心红线：无论上游（各版本 / 各方言）是否已把缓存并入 promptTokens，
 * 归一结果都必须等于「含缓存的真实输入」，绝不重复计入缓存。</p>
 */
public class UsageNormalizerTest {

    // ==================== normalizeInputTokens ====================

    @Test
    @DisplayName("未归一（Anthropic 原生口径）：promptTokens 不含缓存 → 需叠加")
    public void normalize_notNormalized_shouldAdd() {
        // input_tokens=100（裸增量），cacheCreation=2000，cacheRead=8000
        assertEquals(10100, UsageNormalizer.normalizeInputTokens(100, 2000, 8000));
    }

    @Test
    @DisplayName("已归一（框架新版 anthropic 解析器已加好）：不得重复叠加")
    public void normalize_alreadyNormalized_shouldNotDoubleCount() {
        // 上游已返回 10100 = 100 + 2000 + 8000，若再叠加会虚高到 20100
        assertEquals(10100, UsageNormalizer.normalizeInputTokens(10100, 2000, 8000));
    }

    @Test
    @DisplayName("OpenAI 兼容口径：cached 是 prompt 的子集 → 原样返回")
    public void normalize_openAiStyle_shouldNotAdd() {
        // prompt_tokens=10000 已含 cached_tokens=8000
        assertEquals(10000, UsageNormalizer.normalizeInputTokens(10000, 0, 8000));
    }

    @Test
    @DisplayName("无缓存（未开启 Prompt Caching）：原样返回")
    public void normalize_noCache_shouldReturnPrompt() {
        assertEquals(5000, UsageNormalizer.normalizeInputTokens(5000, 0, 0));
    }

    @Test
    @DisplayName("边界：全 0 / 负数入参按 0 处理，不抛异常")
    public void normalize_zeroAndNegative() {
        assertEquals(0, UsageNormalizer.normalizeInputTokens(0, 0, 0));
        assertEquals(0, UsageNormalizer.normalizeInputTokens(-1, -1, -1));
        assertEquals(100, UsageNormalizer.normalizeInputTokens(100, -5, 0));
    }

    @Test
    @DisplayName("边界：prompt 恰好等于缓存之和 → 视为已归一，不叠加")
    public void normalize_promptEqualsCacheSum_shouldNotAdd() {
        assertEquals(10000, UsageNormalizer.normalizeInputTokens(10000, 2000, 8000));
    }

    @Test
    @DisplayName("仅缓存创建（首轮写入缓存）：未归一时叠加")
    public void normalize_onlyCacheCreation() {
        assertEquals(3000, UsageNormalizer.normalizeInputTokens(1000, 2000, 0));
    }

    // ==================== cacheHitRate ====================

    @Test
    @DisplayName("命中率：cacheRead / 归一后输入")
    public void hitRate_normal() {
        // 8000 / 10000 = 80%
        assertEquals(80.0d, UsageNormalizer.cacheHitRate(10000, 8000), 0.001);
    }

    @Test
    @DisplayName("命中率：保留 2 位小数")
    public void hitRate_twoDecimals() {
        // 8123 / 10000 = 81.23%
        assertEquals(81.23d, UsageNormalizer.cacheHitRate(10000, 8123), 0.001);
        // 1 / 3 = 33.333...% → 33.33%
        assertEquals(33.33d, UsageNormalizer.cacheHitRate(3, 1), 0.001);
    }

    @Test
    @DisplayName("命中率：无命中 / 无输入 → 0")
    public void hitRate_zero() {
        assertEquals(0d, UsageNormalizer.cacheHitRate(10000, 0), 0.001);
        assertEquals(0d, UsageNormalizer.cacheHitRate(0, 0), 0.001);
        assertEquals(0d, UsageNormalizer.cacheHitRate(0, 8000), 0.001);
        assertEquals(0d, UsageNormalizer.cacheHitRate(-1, 8000), 0.001);
    }

    @Test
    @DisplayName("命中率：上游口径异常时封顶 100%，不出现怪值")
    public void hitRate_cap() {
        assertEquals(100d, UsageNormalizer.cacheHitRate(1000, 9999), 0.001);
    }

    @Test
    @DisplayName("命中率：全缓存命中 = 100%")
    public void hitRate_full() {
        assertEquals(100d, UsageNormalizer.cacheHitRate(8000, 8000), 0.001);
    }

    // ==================== 组合：防「恒定 100%」回归 ====================

    @Test
    @DisplayName("回归红线：Anthropic 未归一场景，分母必须用归一后输入，否则命中率会恒定 ~100%")
    public void hitRate_withNormalizedDenominator() {
        long prompt = 100, created = 0, read = 8000;
        long normalized = UsageNormalizer.normalizeInputTokens(prompt, created, read);
        assertEquals(8100, normalized);

        // 正确：8000 / 8100 ≈ 98.77%
        assertEquals(98.77d, UsageNormalizer.cacheHitRate(normalized, read), 0.001);
        // 错误口径（分母用裸 promptTokens=100）会被封顶成 100%，即旧实现的「恒定 100%」症状
        assertEquals(100d, UsageNormalizer.cacheHitRate(prompt, read), 0.001);
    }

    @Test
    @DisplayName("回归红线：已归一场景下命中率不会因重复叠加而被摊薄")
    public void hitRate_alreadyNormalizedNotDiluted() {
        long normalized = UsageNormalizer.normalizeInputTokens(10000, 2000, 8000);
        // 若误叠加成 20000，命中率会从 80% 摊薄到 40%
        assertEquals(80.0d, UsageNormalizer.cacheHitRate(normalized, 8000), 0.001);
    }

    // ==================== 回归红线：跨厂商子代理累加（必须在采集端归一） ====================

    @Test
    @DisplayName("回归红线：逐条归一后求和正确（主 OpenAI + 子代理 Anthropic 混合）")
    public void mixedVendorAccumulation_perUsageNormalizeIsCorrect() {
        // 主代理 OpenAI 口径：prompt 已含 cached
        long a = UsageNormalizer.normalizeInputTokens(10000, 0, 9500);
        assertEquals(10000, a);
        // 子代理 Anthropic 未归一：input 不含缓存
        long b = UsageNormalizer.normalizeInputTokens(100, 0, 8000);
        assertEquals(8100, b);

        // 逐条归一后再累加 = 真值
        assertEquals(18100, a + b);
    }

    @Test
    @DisplayName("回归红线：先累加再归一会把 OpenAI 那部分缓存重复计入（故归一必须下移到采集端）")
    public void mixedVendorAccumulation_normalizeAfterSumIsWrong() {
        // 裸累加（旧行为）：P=10100, C=17500 -> P<C 误判为未归一
        long naiveSumPrompt = 10000 + 100;
        long sumCacheCreation = 0;
        long sumCacheRead = 9500 + 8000;
        long wrong = UsageNormalizer.normalizeInputTokens(naiveSumPrompt, sumCacheCreation, sumCacheRead);

        // 先求和再归一得 27600，而真值是 18100（主代理那 9500 被重复计入）
        assertEquals(27600, wrong);
        assertNotEquals(18100, wrong);
    }

    @Test
    @DisplayName("归一幂等：对已归一的累加值再调用一次不会变化（展示端防御层安全）")
    public void normalize_isIdempotentOnNormalizedSum() {
        long sum = 10000 + 8100;   // 逐条归一后的累加值
        long cacheCreation = 0, cacheRead = 9500 + 8000;
        // 幂等前提：已归一的和必须 >= 缓存之和
        assertTrue(sum >= cacheCreation + cacheRead);
        assertEquals(sum, UsageNormalizer.normalizeInputTokens(sum, cacheCreation, cacheRead));
    }
}
