package com.gourdai.agent.react.task;

import com.gourdai.agent.react.task.ReasonTask.RetryCostLedger;
import com.gourdai.ai.AiUsage;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code ReasonTask.RetryCostLedger}（物理重试开销累计器）的记账契约。
 *
 * <p><b>要修复的真实事故：</b>会话 {@code work-mu74mh9v} 的快照里
 * {@code gourd_retry_attempts = 20} 而 {@code gourd_retry_prompt_tokens = 0}、
 * {@code gourd_retry_completion_tokens = 0}——重试 20 次却被记成「零开销」，
 * 隐形支出被误读为免费。</p>
 *
 * <p><b>根因（读码实证）：</b>HTTP 400/403 是供应商<b>直接拒收请求</b>，
 * {@code ChatRequestDescDefault#doStream} 走 {@code Flux.error(httpErrorOf(resp))}，
 * 从不进入 {@code parseResp}，故 {@code ChatStreamSession#getTotalUsage()} 恒为 null，
 * ERROR 事件也就没有 usage 块；旧实现遇到 {@code usage == null} 直接 return，
 * 于是「次数记了、token 恒 0」。</p>
 *
 * <p><b>本类钉死的记账口径：</b></p>
 * <ol>
 *     <li><b>测得到就如实累加</b>：上游返回了 usage（429/5xx 常见）→ 计入计量字段，
 *     含缓存明细（漏掉会让上报链路低估输入 token）；</li>
 *     <li><b>测不到绝不伪造</b>：usage 为 null 或全零 → 计入
 *     {@code unmeasuredAttempts} 与 {@code estimatedPromptTokens}（估算，独立字段），
 *     计量字段保持真实的 0；</li>
 *     <li><b>成功尝试的用量归既有账本</b>：{@code succeedAttempt} 必须丢弃快照，
 *     否则与 {@code RESPONSE_END} 重复计入；</li>
 *     <li><b>尝试收口幂等</b>：同一次失败不得被结算两次。</li>
 * </ol>
 *
 * @author oisin
 * @since 4.1
 */
class RetryCostLedgerTest {

    /** 事故现场的末轮上下文规模（真实计量值，用作估算锚点） */
    private static final long INCIDENT_CONTEXT_TOKENS = 579_657L;

    private static AiUsage usage(long prompt, long completion, long think, long cacheCreation, long cacheRead) {
        return AiUsage.builder()
                .promptTokens(prompt)
                .completionTokens(completion)
                .thinkTokens(think)
                .cacheCreationInputTokens(cacheCreation)
                .cacheReadInputTokens(cacheRead)
                .build();
    }

    private static RetryCostLedger ledgerWithAnchor(long anchor) {
        RetryCostLedger ledger = new RetryCostLedger();
        ledger.contextTokensEstimate = anchor;
        return ledger;
    }

    // ---------------- 口径②：测不到绝不伪造 ----------------

    @Test
    @DisplayName("事故复现：上游无 usage 的失败尝试记为「未测量」，而非 0 开销")
    void failedAttemptWithoutUsage_isRecordedAsUnmeasured() {
        RetryCostLedger ledger = ledgerWithAnchor(INCIDENT_CONTEXT_TOKENS);

        ledger.beginAttempt();
        ledger.failAttempt(null);

        assertEquals(1, ledger.attempts, "失败尝试次数必须如实记下");
        assertEquals(1, ledger.unmeasuredAttempts, "usage 缺失必须标注为未测量，不得当成 0 开销");
        assertEquals(0L, ledger.promptTokens, "计量字段保持真实的 0：绝不把估算值混进来");
        assertEquals(0L, ledger.completionTokens);
        assertFalse(ledger.hasMeasuredTokens(), "无任何计量值时不得触发计费上报（宁缺勿伪）");
        assertEquals(INCIDENT_CONTEXT_TOKENS, ledger.estimatedPromptTokens,
                "估算字段如实反映「这次白跑上行了多大的上下文」");
    }

    @Test
    @DisplayName("烧穿 20 次阶梯：未测量次数与估算规模按次累计")
    void twentyBurnedAttempts_accumulateHonestly() {
        RetryCostLedger ledger = ledgerWithAnchor(INCIDENT_CONTEXT_TOKENS);

        //复刻事故：20 次尝试全部被 400 拒收，每次都完整上行同一份上下文
        for (int i = 0; i < 20; i++) {
            ledger.beginAttempt();
            ledger.failAttempt(null);
        }

        assertEquals(20, ledger.attempts);
        assertEquals(20, ledger.unmeasuredAttempts);
        assertEquals(0L, ledger.promptTokens, "20 次都是 0 计量值：这正是「隐形支出」的真相");
        assertEquals(INCIDENT_CONTEXT_TOKENS * 20L, ledger.estimatedPromptTokens,
                "估算累计必须暴露出「20 × 579,657」这个被隐藏的真实规模");
        assertFalse(ledger.hasMeasuredTokens());
    }

    @Test
    @DisplayName("全零 usage（结构存在但无信息）同样按未测量处理")
    void allZeroUsage_isUnmeasured() {
        RetryCostLedger ledger = ledgerWithAnchor(1000L);

        ledger.beginAttempt();
        ledger.failAttempt(AiUsage.builder().build());

        assertEquals(1, ledger.unmeasuredAttempts);
        assertEquals(1000L, ledger.estimatedPromptTokens);
        assertFalse(ledger.hasMeasuredTokens());
    }

    @Test
    @DisplayName("无估算锚点（首轮）时只记次数、不猜数字")
    void withoutAnchor_countsOnly_noFabricatedNumber() {
        RetryCostLedger ledger = ledgerWithAnchor(0L);

        ledger.beginAttempt();
        ledger.failAttempt(null);

        assertEquals(1, ledger.attempts);
        assertEquals(1, ledger.unmeasuredAttempts, "即使无法估算，重试规模仍必须可见");
        assertEquals(0L, ledger.estimatedPromptTokens, "锚点缺失时不得编造估算值");
    }

    // ---------------- 口径①：测得到就如实累加 ----------------

    @Test
    @DisplayName("上游返回 usage 的失败尝试：计量字段如实累加（含缓存明细）")
    void failedAttemptWithUsage_accumulatesMeasuredTokens() {
        RetryCostLedger ledger = ledgerWithAnchor(INCIDENT_CONTEXT_TOKENS);

        ledger.beginAttempt();
        ledger.failAttempt(usage(1200L, 30L, 5L, 100L, 800L));

        assertEquals(1, ledger.attempts);
        assertEquals(0, ledger.unmeasuredAttempts, "拿到了 usage 就不该被标为未测量");
        assertEquals(0L, ledger.estimatedPromptTokens, "已计量时不得使用估算值");
        assertEquals(1200L, ledger.promptTokens);
        assertEquals(30L, ledger.completionTokens);
        assertEquals(5L, ledger.thinkTokens);
        assertEquals(100L, ledger.cacheCreationTokens);
        assertEquals(800L, ledger.cacheReadTokens);
        assertTrue(ledger.hasMeasuredTokens(), "有计量值即应走既有上报链路记账");
    }

    @Test
    @DisplayName("多次计量失败按次累加（429/5xx 网关仍返回 usage 的场景）")
    void multipleMeasuredFailures_sum() {
        RetryCostLedger ledger = ledgerWithAnchor(INCIDENT_CONTEXT_TOKENS);

        ledger.beginAttempt();
        ledger.failAttempt(usage(1000L, 10L, 0L, 0L, 500L));
        ledger.beginAttempt();
        ledger.failAttempt(usage(2000L, 20L, 3L, 50L, 0L));

        assertEquals(2, ledger.attempts);
        assertEquals(0, ledger.unmeasuredAttempts);
        assertEquals(3000L, ledger.promptTokens);
        assertEquals(30L, ledger.completionTokens);
        assertEquals(3L, ledger.thinkTokens);
        assertEquals(50L, ledger.cacheCreationTokens);
        assertEquals(500L, ledger.cacheReadTokens);
    }

    @Test
    @DisplayName("计量与未计量混合：两条轨道互不污染")
    void mixedAttempts_keepTwoTracksSeparate() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        //2 次未测量（400 被拒收）
        ledger.beginAttempt();
        ledger.failAttempt(null);
        ledger.beginAttempt();
        ledger.failAttempt(null);
        //1 次计量（503 但网关给了 usage）
        ledger.beginAttempt();
        ledger.failAttempt(usage(500L, 7L, 0L, 0L, 0L));

        assertEquals(3, ledger.attempts, "总失败次数是两条轨道之和");
        assertEquals(2, ledger.unmeasuredAttempts);
        assertEquals(200L, ledger.estimatedPromptTokens, "估算只覆盖未测量的那 2 次");
        assertEquals(500L, ledger.promptTokens, "计量只覆盖测得到的那 1 次");
        assertEquals(7L, ledger.completionTokens);
        assertTrue(ledger.hasMeasuredTokens());
    }

    @Test
    @DisplayName("负值用量被夹到 0，不产生负数记账")
    void negativeUsage_isClamped() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        ledger.beginAttempt();
        ledger.failAttempt(usage(-5L, 10L, 0L, 0L, 0L));

        assertEquals(0, ledger.unmeasuredAttempts, "completion 有值即属可计量，不因 prompt 为负而改判");
        assertEquals(0L, ledger.promptTokens);
        assertEquals(10L, ledger.completionTokens);
    }

    // ---------------- 口径③④：成功丢弃 + 收口幂等 ----------------

    @Test
    @DisplayName("成功尝试丢弃用量快照：不与 RESPONSE_END 重复计入")
    void succeededAttempt_discardsPendingUsage() {
        RetryCostLedger ledger = ledgerWithAnchor(INCIDENT_CONTEXT_TOKENS);

        ledger.beginAttempt();
        ledger.observeUsage(usage(5000L, 200L, 10L, 0L, 3000L));
        ledger.succeedAttempt();

        assertEquals(0, ledger.attempts, "成功尝试不属于重试开销");
        assertEquals(0L, ledger.promptTokens);
        assertEquals(0L, ledger.completionTokens);
        assertEquals(0, ledger.unmeasuredAttempts);
        assertEquals(0L, ledger.estimatedPromptTokens);
        assertFalse(ledger.hasMeasuredTokens(), "成功用量归既有账本，此处必须为空以免重复上报");
    }

    @Test
    @DisplayName("未收口的失败尝试在下一次 beginAttempt 时被兜底结算")
    void unclosedAttempt_isSettledByNextBegin() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        //模拟「失败但没有 ERROR 事件」（外层 idle-timeout / blockLast 硬兜底）
        ledger.beginAttempt();
        ledger.beginAttempt();

        assertEquals(1, ledger.attempts, "上一次未收口的尝试必须被结算，不得静默丢失");
        assertEquals(1, ledger.unmeasuredAttempts);
    }

    @Test
    @DisplayName("收口幂等：同一次失败不会被结算两次")
    void closeFailedAttempt_isIdempotent() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        ledger.beginAttempt();
        ledger.failAttempt(usage(1000L, 5L, 0L, 0L, 0L));
        //终态失败路径会再兜底调一次
        ledger.closeFailedAttempt();
        ledger.closeFailedAttempt();

        assertEquals(1, ledger.attempts, "重复收口不得重复计数");
        assertEquals(1000L, ledger.promptTokens, "重复收口不得重复累加 token");
    }

    @Test
    @DisplayName("USAGE 帧快照被后续快照覆盖（累计语义，非相加）")
    void observedUsage_isOverwrittenNotSummed() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        ledger.beginAttempt();
        //方言在一步内多次给出的 usage 是整条消息的累计快照，应覆盖而非相加
        ledger.observeUsage(usage(100L, 1L, 0L, 0L, 0L));
        ledger.observeUsage(usage(900L, 9L, 0L, 0L, 0L));
        ledger.failAttempt(null);

        assertEquals(900L, ledger.promptTokens);
        assertEquals(9L, ledger.completionTokens);
    }

    @Test
    @DisplayName("ERROR 事件自带 usage 优先于此前观测到的快照")
    void errorEventUsage_takesPrecedence() {
        RetryCostLedger ledger = ledgerWithAnchor(100L);

        ledger.beginAttempt();
        ledger.observeUsage(usage(100L, 1L, 0L, 0L, 0L));
        //ERROR 事件的 usage 是上游 streamSession 的累计值，已含失败前打捞到的 partial usage
        ledger.failAttempt(usage(1200L, 12L, 0L, 0L, 0L));

        assertEquals(1200L, ledger.promptTokens);
        assertEquals(12L, ledger.completionTokens);
        assertEquals(0, ledger.unmeasuredAttempts);
    }

    @Test
    @DisplayName("全新累计器初值为空：健康回合零开销、零日志")
    void freshLedger_isEmpty() {
        RetryCostLedger ledger = new RetryCostLedger();

        assertEquals(0, ledger.attempts);
        assertEquals(0, ledger.unmeasuredAttempts);
        assertEquals(0L, ledger.promptTokens);
        assertEquals(0L, ledger.completionTokens);
        assertEquals(0L, ledger.estimatedPromptTokens);
        assertFalse(ledger.hasMeasuredTokens());

        //未 beginAttempt 就收口，属无操作
        ledger.closeFailedAttempt();
        assertEquals(0, ledger.attempts);
    }
}
