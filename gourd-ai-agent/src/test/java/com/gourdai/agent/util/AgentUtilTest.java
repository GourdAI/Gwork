package com.gourdai.agent.util;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.message.AssistantMessage;

import static org.junit.jupiter.api.Assertions.*;

/**
 * AgentUtil.getResultContentWithoutReasoning 单元测试 — 覆盖 think 标签投影剥离与
 * 「正文引用 </think> 字面量」的防误截回归（2026-08-18 线上事故：正文前半段被整段切掉）。
 *
 * @author oisin
 */
public class AgentUtilTest {

    // ==================== 边界 ====================

    @Test
    @DisplayName("null 消息返回空串")
    void nullMessage() {
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(null));
    }

    @Test
    @DisplayName("空内容返回空串")
    void emptyContent() {
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("")));
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage((String) null)));
    }

    // ==================== 标准投影形态 ====================

    @Test
    @DisplayName("标准投影 <think>推理</think>正文 → 剥出纯正文")
    void standardProjection() {
        AssistantMessage m = new AssistantMessage("<think>让我想想</think>你好，很高兴见到你！");
        assertEquals("你好，很高兴见到你！", AgentUtil.getResultContentWithoutReasoning(m));
    }

    @Test
    @DisplayName("投影形态：闭标签后正文引用 </think> 字面量 → 字面量完整保留（防误截回归）")
    void projectionWithLiteralInBody() {
        String body = "messages 方言在正文到达时发送 `</think>` 闭帧（L938），非流式拼 <think>\\n\\n 推理 </think>\\n\\n 正文。";
        AssistantMessage m = new AssistantMessage("<think>推理内容</think>" + body);
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m));
    }

    @Test
    @DisplayName("投影未闭合（纯思考/被截断的流）→ 返回空串")
    void unclosedProjection() {
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("<think>只有思考没有闭合")));
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("<think>")));
    }

    // ==================== 非投影形态：一律原样，绝不截断 ====================

    @Test
    @DisplayName("纯正文（无标签）→ 原样返回")
    void plainContent() {
        assertEquals("你好", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("你好")));
    }

    @Test
    @DisplayName("官方 openai-responses 聚合裸拼（推理+正文无标签）→ 原样返回（不截断，重复治理交由库层投影）")
    void bareConcatenation() {
        String s = "用户要求用一句话回复问候，需要简洁友好。你好，很高兴见到你！";
        assertEquals(s, AgentUtil.getResultContentWithoutReasoning(new AssistantMessage(s)));
    }

    @Test
    @DisplayName("裸拼正文引用 </think> 字面量 → 原样返回（旧实现会切掉前半段，本用例为回归红线）")
    void bareConcatenationWithLiteral() {
        // 旧实现：getResultContent()=stripThinkTags 会返回 " 闭帧说明..." —— 前半段全部丢失
        String s = "先说结论再解释：闭帧是 `</think>` 字面量，正文其余部分完整保留。";
        assertEquals(s, AgentUtil.getResultContentWithoutReasoning(new AssistantMessage(s)));
    }

    @Test
    @DisplayName("正文以 </think> 字样开头但无 <think> 开标签 → 不视为投影，原样返回")
    void literalAtHead() {
        String s = "</think> 只是正文里引用的字面量";
        assertEquals(s, AgentUtil.getResultContentWithoutReasoning(new AssistantMessage(s)));
    }

    @Test
    @DisplayName("thinking 流式帧（isThinking=true 的增量，非投影形态）→ 原样返回")
    void thinkingDeltaFrame() {
        // 4.1：思考帧为 text="" + thinking=内容 + isThinking=true
        AssistantMessage delta = new AssistantMessage("", "用户要求", true);
        assertEquals("用户要求", AgentUtil.getResultContentWithoutReasoning(delta));
    }

    @Test
    @DisplayName("thinking 首帧字面量 <think>（未闭合）→ 返回空串，不外发标签")
    void thinkingOpenFrameLiteral() {
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("", "<think>", true)));
    }

    // ==================== 流式思考前缀精确剥离（2026-08-19 线上事故：思考内引用 </think> 字面量时启发式切错位置） ====================

    @Test
    @DisplayName("精确前缀：思考内引用 </think> 字面量 → 正文完整剥出（启发式会泄漏思考中段，本用例为回归红线）")
    void streamedPrefixWithLiteralInReasoning() {
        String reasoning = "分析：正文里出现了 `</think>` 字面量（讨论思考标签机制本身），启发式 indexOf 会切错位置。";
        String body = "排查完毕，根因已定位。";
        AssistantMessage m = new AssistantMessage("<think>" + reasoning + "</think>" + body);

        // 旧实现（启发式）：取第一个 </think>（思考内字面量）之后 → 思考中段泄漏
        // 新实现：流式累积前缀精确匹配 → 纯正文
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m, "<think>" + reasoning + "</think>"));
    }

    @Test
    @DisplayName("精确前缀：思考与正文均引用 </think> 字面量 → 双重歧义下仍正确剥离")
    void streamedPrefixWithLiteralInBoth() {
        String reasoning = "思考：模型输出了 </think> 标签";
        String body = "结论：真闭帧在 L938，正文中引用的 `</think>` 字面量也完整保留。";
        AssistantMessage m = new AssistantMessage("<think>" + reasoning + "</think>" + body);

        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m, "<think>" + reasoning + "</think>"));
    }

    @Test
    @DisplayName("精确前缀：纯思考无正文（思考后直接调工具/截断）→ 返回空串")
    void streamedPrefixReasoningOnly() {
        String reasoning = "让我想想该调哪个工具";
        AssistantMessage m = new AssistantMessage("<think>" + reasoning + "</think>");

        assertEquals("", AgentUtil.getResultContentWithoutReasoning(m, "<think>" + reasoning + "</think>"));
    }

    @Test
    @DisplayName("精确前缀不匹配（上游行为变化/累积不完整）→ 退回启发式，不误切")
    void streamedPrefixMismatch() {
        String body = "你好，很高兴见到你！";
        AssistantMessage m = new AssistantMessage("<think>推理内容</think>" + body);

        // 前缀与 content 不匹配（累积丢失了部分帧）→ 退回启发式仍能正确剥出正文
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m, "<think>推理内容残缺"));
    }

    @Test
    @DisplayName("精确前缀为 null/空（非流式或无思考帧）→ 等价单参版本")
    void streamedPrefixNullOrEmpty() {
        String body = "你好";
        AssistantMessage m = new AssistantMessage("<think>推理</think>" + body);

        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m, null));
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(m, ""));
        assertEquals("你好", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("你好"), ""));
    }

    // ==================== 前缀规范化：inline-think 闭标签帧携带正文头（Qwen 风格） ====================

    @Test
    @DisplayName("inline-think 闭标签帧携带正文头 → 截断后正文头完整保留（回归红线：不截断会吞正文头）")
    void inlineThinkClosingFrameCarriesBodyHead() {
        String reasoning = "分析 Qwen 风格内联思考";
        String bodyHead = "结论先行：";
        String bodyRest = "正文剩余部分。";
        // 聚合 content：闭标签帧含正文头（方言 new AssistantMessage("</think>"+正文头, true)）
        String content = "<think>" + reasoning + "</think>" + bodyHead + bodyRest;
        AssistantMessage m = new AssistantMessage(content);

        // 逐帧累积的原始前缀（末帧 = "</think>"+正文头，thinking=true）
        String rawPrefix = "<think>" + reasoning + "</think>" + bodyHead;
        int lastFrameStart = ("<think>" + reasoning).length();

        String normalized = AgentUtil.normalizeStreamedReasoningPrefix(rawPrefix, lastFrameStart);
        assertEquals("<think>" + reasoning + "</think>", normalized);

        // 未规范化直接剥离 → 正文头被吞（旧缺陷，断言度量）
        assertEquals(bodyRest, AgentUtil.getResultContentWithoutReasoning(m, rawPrefix));
        // 规范化后剥离 → 正文完整（修复后行为）
        assertEquals(bodyHead + bodyRest, AgentUtil.getResultContentWithoutReasoning(m, normalized));
    }

    @Test
    @DisplayName("末思考帧为纯 </think> 标签帧（anthropic/responses/gemini）→ 截断为 no-op")
    void tagFrameLastIsNoop() {
        String reasoning = "思考：正文里出现了 </think> 字面量";
        String prefix = "<think>" + reasoning + "</think>";
        int lastFrameStart = ("<think>" + reasoning).length(); // 末帧 = "</think>"

        assertEquals(prefix, AgentUtil.normalizeStreamedReasoningPrefix(prefix, lastFrameStart));

        String body = "正文完整。";
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(
                new AssistantMessage(prefix + body),
                AgentUtil.normalizeStreamedReasoningPrefix(prefix, lastFrameStart)));
    }

    @Test
    @DisplayName("末思考帧不含 </think>（流被截断）→ 原样返回")
    void lastFrameWithoutCloseTag() {
        String raw = "<think>思考中途被截断";
        assertEquals(raw, AgentUtil.normalizeStreamedReasoningPrefix(raw, 7));
    }

    @Test
    @DisplayName("帧起点无效（-1/越界）或前缀为空 → 原样返回")
    void invalidLastFrameStart() {
        String raw = "<think>推理</think>";
        assertEquals(raw, AgentUtil.normalizeStreamedReasoningPrefix(raw, -1));
        assertEquals(raw, AgentUtil.normalizeStreamedReasoningPrefix(raw, raw.length()));
        assertEquals(raw, AgentUtil.normalizeStreamedReasoningPrefix(raw, raw.length() + 5));
        assertNull(AgentUtil.normalizeStreamedReasoningPrefix(null, -1));
        assertEquals("", AgentUtil.normalizeStreamedReasoningPrefix("", 0));
    }

    @Test
    @DisplayName("思考内引用 </think> 字面量 + inline-think 闭标签帧携带正文头 → 双重场景仍正确")
    void literalInReasoningPlusInlineClosingFrame() {
        String reasoning = "思考：模型输出了 </think> 标签";
        String body = "结论：正文完整。";
        String content = "<think>" + reasoning + "</think>" + body;

        // 帧序：<think>帧 / 思考帧（含字面量） / 闭标签帧（</think>+正文头）
        String rawPrefix = "<think>" + reasoning + "</think>" + body;
        int lastFrameStart = ("<think>" + reasoning).length();

        String normalized = AgentUtil.normalizeStreamedReasoningPrefix(rawPrefix, lastFrameStart);
        assertEquals("<think>" + reasoning + "</think>", normalized);
        assertEquals(body, AgentUtil.getResultContentWithoutReasoning(
                new AssistantMessage(content), normalized));
    }
}
