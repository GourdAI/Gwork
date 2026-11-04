/*
 * Copyright 2017-2026 noear.org and authors
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

/**
 * 用量口径归一工具：把不同接口规范（乃至不同框架版本）返回的输入 token 口径，统一成
 * <b>「输入 = 真实送进模型的全部 token（含缓存创建 + 缓存读取）」</b>，并据此计算缓存命中率。
 *
 * <p><b>为什么需要归一：</b>各家对「输入 token 是否已包含缓存」的口径并不一致：
 * <ul>
 *   <li>OpenAI 兼容：{@code prompt_tokens} <b>已包含</b>缓存命中部分（{@code cached_tokens} 是其子集）；</li>
 *   <li>Anthropic/Claude 原生：{@code input_tokens} <b>不含</b>缓存，缓存创建/读取是并列的独立计数。</li>
 * </ul>
 *
 * <p><b>为什么不按方言判定（重要）：</b>历史实现靠「模型是不是 Anthropic」来决定要不要叠加缓存，
 * 这是一个<b>脆弱假设</b>——上游的 anthropic 方言解析器可能在某个版本里
 * 自行把三项加好后再返回（即口径已归一）。一旦如此，按方言无条件叠加就会<b>重复计入缓存</b>，
 * 使 Claude 场景的输入 token 虚高近一倍，且不会报错（静默错误，极难发现）。
 *
 * <p><b>本类的判据是版本无关且方言无关的数值自洽性检查：</b>
 * 缓存创建与缓存读取都是「输入」的组成部分，若上游已归一，必然满足
 * {@code promptTokens >= cacheCreation + cacheRead}；只有当
 * {@code promptTokens < cacheCreation + cacheRead} 时，才说明 promptTokens 是<b>不含缓存</b>的裸增量，
 * 需要叠加。该判据对 OpenAI 口径天然安全（其 cached 是 prompt 的子集，恒不进入叠加分支），
 * 因此无需再识别方言，升级依赖也不会算错。
 *
 * @author oisin
 */
public final class UsageNormalizer {
    private UsageNormalizer() {
    }

    /**
     * 归一「输入 token」口径，使返回值恒为「含缓存的真实输入」。
     *
     * <p>判据见类注释：仅当 {@code promptTokens} 明显不含缓存（小于缓存两项之和）时才叠加，
     * 否则视为上游已归一，原样返回。</p>
     *
     * @param promptTokens  上游返回的输入 token（可能含或不含缓存）
     * @param cacheCreation 缓存创建输入 token
     * @param cacheRead     缓存读取输入 token
     * @return 含缓存的真实输入 token（负数入参按 0 处理）
     */
    public static long normalizeInputTokens(long promptTokens, long cacheCreation, long cacheRead) {
        long prompt = Math.max(0, promptTokens);
        long created = Math.max(0, cacheCreation);
        long read = Math.max(0, cacheRead);
        long cacheTotal = created + read;

        if (prompt < cacheTotal) {
            // promptTokens 是不含缓存的裸增量（Anthropic 原生口径，或上游未归一）→ 叠加
            return prompt + cacheTotal;
        }
        // promptTokens 已含缓存（OpenAI 兼容口径，或上游已归一）→ 不再叠加，避免重复计入
        return prompt;
    }

    /**
     * 计算缓存命中率（百分比，0~100）：{@code cacheRead / 归一后的输入}。
     *
     * <p>分母必须使用{@link #normalizeInputTokens 归一后}的输入，否则 Anthropic 场景下
     * 分母是不含缓存的裸增量，命中率会被高估甚至恒定 100%。</p>
     *
     * @param normalizedInputTokens 归一后的输入 token（含缓存）
     * @param cacheRead             缓存读取输入 token
     * @return 命中率百分比（保留 2 位小数）；无输入或无命中时返回 0
     */
    public static double cacheHitRate(long normalizedInputTokens, long cacheRead) {
        if (normalizedInputTokens <= 0 || cacheRead <= 0) {
            return 0d;
        }
        double rate = cacheRead * 100d / normalizedInputTokens;
        if (rate > 100d) {
            // 理论不可达（cacheRead 是输入的子集）；上游口径异常时封顶，避免出现 >100% 的怪值
            rate = 100d;
        }
        return Math.round(rate * 100d) / 100d;
    }
}
