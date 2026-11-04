package com.gourdai;

import com.gourdai.agent.util.AgentUtil;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 思考「终态重放帧」抑制的契约测试。
 *
 * <p><b>缺陷现场</b>：qwen3.8-max 经中转以 {@code openai-responses} 接口访问时，同一段思考
 * 会被渲染两次（屏幕出现两个「思考完成」卡片）。落盘 ndjson 铁证：同一 runId 下 eventSeq
 * 138–148 是 11 个逐 token 的思考帧，eventSeq 149 是<b>同一段全文</b>的单帧思考，两者 phase
 * 均为 thinking，且全文帧排在 context_size 之前 —— 证明它是流内的真 THINKING_DELTA，而非
 * ReasonEndEvent 的聚合补发。</p>
 *
 * <p><b>成因</b>：方言在 {@code response.completed} 用「最终快照 − 已交付 delta」补发未交付
 * 尾部，幂等键为 item_id + content_index/summary_index；中转改写/缺失这些键后差集判定查不到
 * 已交付记录，于是整段思考被当成未交付再发一次。补发走 {@code acc.addContentItem(...)}，由上层
 * 派生成与真实增量完全同形的事件，<b>不带任何终态标记</b>，故只能靠文本比对识别。</p>
 *
 * <p>修复位于 {@code ReasonTask} 的流式循环（单点修复，Web / CLI / ACP / Desktop 四个 portal
 * 同时受益），判定逻辑抽到 {@link AgentUtil#isThinkingReplay} 以便在此直接锁定。</p>
 */
public class ThinkingReplaySuppressionTest {
    /** ndjson 铁证中的真实思考全文（71 字符）。 */
    private static final String FULL =
            "The log is about 1.2MB, 11738 lines. Let me search for SOCKS within it.";

    /** 铁证中的 11 个逐 token 分片，按序拼接恰为 {@link #FULL}。 */
    private static final String[] TOKENS = {
            "The log", " is about", " 1.2MB,", " 11738", " lines.", " Let me",
            " search", " for", " SOCKS", " within", " it."
    };

    /**
     * ReasonTask 流式循环中「思考帧」处理分支的最小复刻：判定为重放则既不下发也不累积，
     * 否则先记录帧起点再累积并下发。字段命名与被修改的现场保持一致，便于对照。
     */
    private static final class ThinkingFrameProbe {
        final StringBuilder streamedReasoningBuf = new StringBuilder();
        final List<String> emitted = new ArrayList<>();
        int lastThinkingFrameStart = -1;
        int suppressed = 0;

        void accept(String thinkingText) {
            if (AgentUtil.isThinkingReplay(streamedReasoningBuf, thinkingText)) {
                suppressed++;
                return;
            }

            lastThinkingFrameStart = streamedReasoningBuf.length();
            streamedReasoningBuf.append(thinkingText);
            emitted.add(thinkingText);
        }
    }

    @Test
    @DisplayName("铁证复现：11 个 token 增量 + 1 帧终态全文 → 只下发 11 帧，累积前缀保持单份")
    public void replayAfterTokenDeltas_isSuppressed() {
        ThinkingFrameProbe probe = new ThinkingFrameProbe();
        for (String token : TOKENS) {
            probe.accept(token);
        }

        // 全部 token 均为真实增量，一个都不能被误杀
        assertEquals(TOKENS.length, probe.emitted.size());
        assertEquals(FULL, probe.streamedReasoningBuf.toString());

        // 终态重放帧：与已累积全文严格相等
        probe.accept(FULL);

        assertEquals(1, probe.suppressed);
        assertEquals(TOKENS.length, probe.emitted.size(), "重放帧不得下发，否则前端出现第二个思考块");
        assertEquals(FULL, probe.streamedReasoningBuf.toString(), "重放帧不得累积，否则前缀变成全文×2");
        assertEquals(FULL.length() - " it.".length(), probe.lastThinkingFrameStart,
                "被抑制的帧不得改写 lastThinkingFrameStart，否则末思考帧定位指向重复帧");
    }

    @Test
    @DisplayName("整段一次给出的方言：单帧思考 + 终态重放同样被抑制")
    public void replayAfterSingleWholeFrame_isSuppressed() {
        ThinkingFrameProbe probe = new ThinkingFrameProbe();
        probe.accept(FULL);
        probe.accept(FULL);

        assertEquals(1, probe.emitted.size());
        assertEquals(1, probe.suppressed);
        assertEquals(FULL, probe.streamedReasoningBuf.toString());
    }

    @Test
    @DisplayName("逐 token 增量零误杀：短帧一律放行（含与历史片段重复的短词）")
    public void shortDeltas_areNeverSuppressed() {
        ThinkingFrameProbe probe = new ThinkingFrameProbe();
        // 同一个短词连续出现多次（思考文本里极常见），必须全部下发
        for (int i = 0; i < 5; i++) {
            probe.accept(" the");
        }
        probe.accept("\n\n");

        assertEquals(6, probe.emitted.size());
        assertEquals(0, probe.suppressed);
    }

    @Test
    @DisplayName("方言标签帧不受影响：</think> 只有 8 字符，低于门限")
    public void thinkTagFrame_isNeverSuppressed() {
        StringBuilder acc = new StringBuilder("<think>某段思考</think>");
        assertFalse(AgentUtil.isThinkingReplay(acc, "</think>"));
    }

    @Test
    @DisplayName("完整后缀重放：补发的是尾段而非全文时也要抑制")
    public void tailSuffixReplay_isSuppressed() {
        String head = "先想清楚用户到底要什么，再决定要不要读文件。";
        String tail = "Let me search for SOCKS within it.";
        StringBuilder acc = new StringBuilder(head).append(tail);

        assertTrue(tail.length() >= 16);
        assertTrue(AgentUtil.isThinkingReplay(acc, tail));
    }

    @Test
    @DisplayName("中段重放：多个 reasoning item 逐个补发时，先补发的那段不在尾部（需 ≥64 字符）")
    public void middleReplay_isSuppressedOnlyWhenLongEnough() {
        String itemA = "第一个推理条目的完整内容，长度必须超过六十四个字符才会启用中段命中这一级判定，"
                + "否则按设计一律放行以避免误杀真实增量，这里再补一句以确保长度达标。";
        String itemB = "第二个推理条目的内容。";
        StringBuilder acc = new StringBuilder(itemA).append(itemB);

        assertTrue(itemA.length() >= 64, "夹具前提：itemA 需达到中段判定门限");
        assertTrue(AgentUtil.isThinkingReplay(acc, itemA), "整体命中已累积文本中间 → 重放");

        // 同为中段命中，但长度落在 [16,64) 区间：宁漏杀不误杀，必须放行
        String shortMiddle = "这是一段中等长度的思考内容，用于验证放行。";
        StringBuilder acc2 = new StringBuilder(shortMiddle).append(itemB);
        assertTrue(shortMiddle.length() >= 16 && shortMiddle.length() < 64, "夹具前提：长度落在放行区间");
        assertFalse(AgentUtil.isThinkingReplay(acc2, shortMiddle));
    }

    @Test
    @DisplayName("真实长增量放行：新内容既非后缀也不在已累积文本中")
    public void freshLongDelta_isNeverSuppressed() {
        StringBuilder acc = new StringBuilder(FULL);
        assertFalse(AgentUtil.isThinkingReplay(acc, "现在改为检查配置文件里的代理设置是否正确。"));
    }

    @Test
    @DisplayName("边界：null、空累积、累积短于本帧一律放行")
    public void boundaries_areSafe() {
        assertFalse(AgentUtil.isThinkingReplay(null, FULL));
        assertFalse(AgentUtil.isThinkingReplay(new StringBuilder(FULL), null));
        assertFalse(AgentUtil.isThinkingReplay(new StringBuilder(), FULL), "首帧无历史可重放");
        assertFalse(AgentUtil.isThinkingReplay(new StringBuilder("The log"), FULL), "累积短于本帧必为新内容");
        assertFalse(AgentUtil.isThinkingReplay(new StringBuilder(FULL), ""));
    }

    @Test
    @DisplayName("抑制后前缀仍可被 normalizeStreamedReasoningPrefix 正确规范化（inline-think 方言）")
    public void suppression_keepsPrefixNormalizable() {
        ThinkingFrameProbe probe = new ThinkingFrameProbe();
        probe.accept("<think>");
        probe.accept("需要先确认代理端口是否被占用，再决定下一步动作。");
        // inline-think 方言的闭标签帧同时携带正文开头
        probe.accept("</think>正文从这里开始");
        String replay = probe.streamedReasoningBuf.toString();
        probe.accept(replay);

        assertEquals(1, probe.suppressed);

        String normalized = AgentUtil.normalizeStreamedReasoningPrefix(
                probe.streamedReasoningBuf.toString(), probe.lastThinkingFrameStart);
        assertTrue(normalized.endsWith("</think>"), "正文头必须被截掉，说明末帧定位未被重放帧污染");
        assertEquals(replay.substring(0, replay.indexOf("</think>") + "</think>".length()), normalized);
    }

    @Test
    @DisplayName("防回归：ReasonTask 的思考帧分支必须先判定重放并 return，再累积")
    public void reasonTask_keepsSuppressionGuard() throws IOException {
        Path path = locate("src/main/java/com/gourdai/agent/react/task/ReasonTask.java");
        assertTrue(Files.exists(path), "未找到 ReasonTask 源码：" + path.toAbsolutePath());

        String src = new String(Files.readAllBytes(path), StandardCharsets.UTF_8);

        int guardAt = src.indexOf("AgentUtil.isThinkingReplay(streamedReasoningBuf, thinkingText)");
        assertTrue(guardAt > 0, "思考帧分支必须调用 AgentUtil.isThinkingReplay 做终态重放抑制");

        int appendAt = src.indexOf("streamedReasoningBuf.append(thinkingText)");
        assertTrue(appendAt > guardAt, "累积必须发生在重放判定之后");

        String guardBlock = src.substring(guardAt, appendAt);
        assertTrue(guardBlock.contains("return;"), "判定为重放时必须 return：既不下发也不累积");

        assertFalse(src.contains("streamedReasoningBuf.append(event.getText())"),
                "旧的无防御写法不得回归");
    }

    /** 兼容两种工作目录：模块目录（Maven 默认）与仓库根目录。 */
    private static Path locate(String relative) {
        Path direct = Paths.get(relative);
        if (Files.exists(direct)) {
            return direct;
        }

        return Paths.get("gourd-ai-agent").resolve(relative);
    }
}
