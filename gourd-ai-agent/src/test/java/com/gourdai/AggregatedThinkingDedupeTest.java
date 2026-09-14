package com.gourdai;

import com.gourdai.agent.util.AgentUtil;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.message.AssistantMessage;
import org.noear.solon.ai.chat.tool.ToolCall;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 聚合思考「终态重放」去重的契约测试。
 *
 * <p><b>与 {@code ThinkingReplaySuppressionTest} 的分工</b>：那一组锁的是<b>下发通道</b>
 * （屏幕不重复渲染）；本组锁的是<b>聚合值</b>。二者必须同时存在——方言补发走
 * {@code acc.addContentItem(...)}，该路径在派生 THINKING_DELTA 事件之外，还会把整段思考
 * 灌进 {@code ChatAccumulator.thinkingBuilder}。故即使流式侧已抑制，聚合消息的
 * {@code thinking} 仍是「全文 × 2」。</p>
 *
 * <p><b>真实代价的准确口径</b>（曾误判为「白烧一倍 wire token」，已按源码核实修正）：
 * {@code OpenaiResponsesRequestBuilder} 出站时<b>优先</b>回放 {@code responses_output_items}
 * 里的原始 output item（含 reasoning、为 API 快照的单份）并直接 return，此时
 * {@code getThinking()} 根本不参与出站。故重复份额的确凿危害是：
 * <ol>
 *   <li><b>上下文压缩预算失真</b>（最普遍）：压缩器估算体积走 {@code getContent()}，
 *       工具调用轮聚合正文为空使 {@code isThinking} 为 true，该方法转而返回思考文本
 *       —— 重复份额全额计入，压缩比预期更早触发；</li>
 *   <li><b>落盘放大</b>：重复思考被写进会话历史 NDJSON；</li>
 *   <li><b>wire 浪费仅限边缘情形</b>：唯有 {@code responses_output_items} 与
 *       {@code reasoning_item_id} / {@code encrypted_content} 同时缺失、退化到
 *       {@code reasoning_text} 兜底分支时，重复份额才上到 wire。</li>
 * </ol></p>
 *
 * <p><b>去重锚的合法性</b>：上游 {@code ChatRequestDescDefault#publishItem} 中
 * {@code acc.appendThinking(acm.getThinkingRaw())} 与
 * {@code THINKING_DELTA.text(acm.getThinkingRaw())} 取自<b>同一个字符串</b>，故流式累积
 * （已抑制重放）与聚合思考逐字同源。本组用例即围绕该前提锁定边界。</p>
 */
public class AggregatedThinkingDedupeTest {
    /** ndjson 铁证中的真实思考全文（71 字符）。 */
    private static final String FULL =
            "The log is about 1.2MB, 11738 lines. Let me search for SOCKS within it.";

    /** 构造聚合消息：复刻 {@code ChatResponseDefault#buildAggregationMessage} 的流式分支形态。 */
    private static AssistantMessage aggregated(String text, String thinking) {
        return new AssistantMessage(
                text,
                thinking,
                text.length() == 0 && thinking.length() > 0,
                null, null, null, null, null);
    }

    @Test
    @DisplayName("铁证复现：聚合思考为「全文 × 2」时折叠为单份，正文不受影响")
    public void dedupe_exact_double_thinking() {
        AssistantMessage message = aggregated("最终答案", FULL + FULL);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw(), "双份思考必须被折叠为单份");
        assertEquals("最终答案", fixed.getTextRaw(), "正文不得被改动");
        assertEquals(FULL + FULL, message.getThinkingRaw(), "入参对象不得被就地修改");
    }

    @Test
    @DisplayName("纯推理轮：无正文（text 为空串）时同样折叠，且 isThinking 语义保持")
    public void dedupe_pure_reasoning_turn() {
        AssistantMessage message = aggregated("", FULL + FULL);
        assertTrue(message.isThinking(), "前提：纯推理轮聚合消息 isThinking 为 true");

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw());
        assertEquals("", fixed.getTextRaw(), "空正文必须保持空串而非变 null");
        assertTrue(fixed.isThinking(), "isThinking 标记必须原样搬运");
    }

    @Test
    @DisplayName("metadata 保真：reasoning_item_id 必须存活，否则出站会退化为回传整段思考（更烧 token）")
    public void dedupe_preserves_metadata() {
        AssistantMessage message = aggregated("答案", FULL + FULL);
        message.addMetadata("reasoning_item_id", "rs_abc123");
        message.addMetadata("reasoning_encrypted_content", "enc_xyz");

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw(), "前提：本例确实触发了折叠");
        assertEquals("rs_abc123", fixed.getMetadata().get("reasoning_item_id"),
                "reasoning_item_id 丢失会让方言从「只回引用」退化为「回传整段思考」");
        assertEquals("enc_xyz", fixed.getMetadata().get("reasoning_encrypted_content"));
    }

    @Test
    @DisplayName("工具调用/推理字段名/搜索结果等字段逐一保真")
    public void dedupe_preserves_all_payload_fields() {
        List<ToolCall> toolCalls = new ArrayList<>();
        toolCalls.add(new ToolCall("0", "call_1", "Read", null, new LinkedHashMap<>()));

        List<Map> toolCallsRaw = new ArrayList<>();
        Map<String, Object> rawCall = new LinkedHashMap<>();
        rawCall.put("id", "call_1");
        toolCallsRaw.add(rawCall);

        List<Map> searchRaw = new ArrayList<>();
        Map<String, Object> rawSearch = new LinkedHashMap<>();
        rawSearch.put("title", "doc");
        searchRaw.add(rawSearch);

        AssistantMessage message = new AssistantMessage(
                "答案", FULL + FULL, false,
                "原始内容", toolCallsRaw, toolCalls, searchRaw, null)
                .reasoningFieldName("reasoning_content");

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw(), "前提：本例确实触发了折叠");
        assertSame(toolCalls, fixed.getToolCalls(), "工具调用必须原样搬运");
        assertSame(toolCallsRaw, fixed.getToolCallsRaw());
        assertSame(searchRaw, fixed.getSearchResultsRaw());
        assertEquals("原始内容", fixed.getContentRaw(),
                "contentRaw 必须显式搬运：构造器收到 null 会用 getContent() 自动回填");
        assertEquals("reasoning_content", fixed.getReasoningFieldName());
    }

    @Test
    @DisplayName("F1 覆盖盒子：appendFinalOutput 路径的「全文 × 3」必须折叠为单份")
    public void dedupe_triple_thinking_from_append_final_output() {
        // appendFinalOutput 自己先 acc.appendThinking(text) 再 addContentItem，后者又被上层
        // publishItem 聚合一次 → 锚 + 2 份重放。单次比对在此必静默失效。
        AssistantMessage message = aggregated("最终答案", FULL + FULL + FULL);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw(), "三份思考必须全部收敛为单份");
        assertEquals("最终答案", fixed.getTextRaw(), "正文不得被改动");
    }

    @Test
    @DisplayName("高重数：任意 N 份（N ≥ 2）均收敛为单份，不依赖具体路径份数")
    public void dedupe_arbitrary_multiplicity() {
        for (int n = 2; n <= 6; n++) {
            StringBuilder repeated = new StringBuilder();
            for (int i = 0; i < n; i++) {
                repeated.append(FULL);
            }

            AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(
                    aggregated("答案", repeated.toString()), FULL);

            assertEquals(FULL, fixed.getThinkingRaw(), "全文 × " + n + " 必须收敛为单份");
        }
    }

    @Test
    @DisplayName("混合形态：尾部整份副本 + 残留后缀重放，两道折叠必须接力")
    public void dedupe_full_copy_plus_suffix_replay() {
        // 形态：锚 + 后缀重放 + 整份副本。先迭代剥掉末尾整份，再由 isThinkingReplay 收尾。
        String suffix = FULL.substring(FULL.length() - 30);
        AssistantMessage message = aggregated("答案", FULL + suffix + FULL);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertEquals(FULL, fixed.getThinkingRaw(), "两种重放形态叠加时仍应收敛为单份");
    }

    @Test
    @DisplayName("自相似锚不得过折：剥离必须保底留下一整份锚长")
    public void keep_anchor_intact_for_self_similar_text() {
        // 极端自相似：锚为 20 个同一字符，聚合值为 30 个。末尾 20 个字符恰与锚相等，
        // 但无条件回退会只剩 10 个字符 —— 连锚本身都没了，属于确凿的数据丢失。
        StringBuilder anchorBuf = new StringBuilder();
        for (int i = 0; i < 20; i++) {
            anchorBuf.append('嗯');
        }
        String anchor = anchorBuf.toString();
        String aggregatedThinking = anchor + anchor.substring(0, 10);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(
                aggregated("答案", aggregatedThinking), anchor);

        assertTrue(fixed.getThinkingRaw().length() >= anchor.length(),
                "无论如何折叠，结果不得短于锚本身（否则屏幕上看过的内容会消失）");
        assertTrue(fixed.getThinkingRaw().startsWith(anchor), "锚必须完整存活");
    }

    @Test
    @DisplayName("整份副本后面还跟着真新内容：形态对不上，按「宁漏杀不误杀」原样保留")
    public void keep_all_when_new_content_follows_copies() {
        // 补发只会追在流的末尾（副本总在最后），故「副本后面还有新内容」并非真实形态。
        // 此时宁可不治，也不为了消除中间副本而冒删错真实增量的风险。
        String fresh = "这是终态补发里真正从未通过流式下发过的新增思考，必须完整保留。";
        AssistantMessage message = aggregated("答案", FULL + FULL + fresh);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertSame(message, fixed, "尾部含新内容说明形态对不上，一律不动");
        assertTrue(fixed.getThinkingRaw().endsWith(fresh), "新增内容不得丢失");
    }

    @Test
    @DisplayName("正常单份思考：聚合思考与锚严格相等时原样返回（零改动）")
    public void keep_when_no_replay() {
        AssistantMessage message = aggregated("答案", FULL);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertSame(message, fixed, "无重放时必须返回原对象，不做任何重建");
    }

    @Test
    @DisplayName("补发含从未下发过的思考：尾巴比锚长 → 判定必为 false，绝不误删")
    public void keep_when_tail_longer_than_anchor() {
        String anchor = "前半段思考内容，长度足够触发判定门限，绝非短帧。";
        String tail = anchor + "这里是从未通过流式下发过的增量补充内容，必须完整保留下来。";
        AssistantMessage message = aggregated("答案", anchor + tail);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, anchor);

        assertSame(message, fixed, "尾巴比锚长说明含新内容，必须整体保留");
        assertEquals(anchor + tail, fixed.getThinkingRaw());
    }

    @Test
    @DisplayName("聚合思考不以锚开头（非同源）→ 原样返回")
    public void keep_when_anchor_not_prefix() {
        AssistantMessage message = aggregated("答案", "完全不同的思考内容，与流式累积对不上。");

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, FULL);

        assertSame(message, fixed);
    }

    @Test
    @DisplayName("短尾巴：低于重放判定门限时放行，不误杀真实短增量")
    public void keep_when_tail_too_short() {
        String anchor = "这是一段足够长的思考内容用于充当锚点。";
        AssistantMessage message = aggregated("答案", anchor + "好的");

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, anchor);

        assertSame(message, fixed, "短增量必须放行（与 isThinkingReplay 的短帧门限一致）");
    }

    @Test
    @DisplayName("边界：message 为 null / 锚为空 / 旧形态消息（textRaw 为 null）一律不动手")
    public void keep_on_boundaries() {
        assertNull(AgentUtil.dedupeAggregatedThinking(null, FULL), "null 入参必须原样返回 null");

        AssistantMessage message = aggregated("答案", FULL + FULL);
        assertSame(message, AgentUtil.dedupeAggregatedThinking(message, null), "锚为 null 时不动手");
        assertSame(message, AgentUtil.dedupeAggregatedThinking(message, ""), "锚为空串时不动手");

        // 旧形态：思考内嵌在废弃的 content 字段里，textRaw 为 null。该字段无法经构造器还原，
        // 重建必丢正文，故必须整体跳过。
        AssistantMessage legacy = new AssistantMessage();
        assertNull(legacy.getTextRaw(), "前提：默认构造的消息 textRaw 为 null");
        assertSame(legacy, AgentUtil.dedupeAggregatedThinking(legacy, FULL),
                "旧形态消息重建会丢正文，必须原样返回");
    }

    @Test
    @DisplayName("与流式抑制协同：抑制后的累积值作锚，恰好把聚合的双份收敛为单份")
    public void works_with_streaming_suppression() {
        String[] tokens = {
                "The log", " is about", " 1.2MB,", " 11738", " lines.", " Let me",
                " search", " for", " SOCKS", " within", " it."
        };

        // 流式侧：11 个真实分片 + 1 帧终态全文重放（重放被抑制，不进累积）
        StringBuilder streamedBuf = new StringBuilder();
        for (String token : tokens) {
            if (!AgentUtil.isThinkingReplay(streamedBuf, token)) {
                streamedBuf.append(token);
            }
        }
        assertEquals(FULL, streamedBuf.toString(), "前提：11 个分片拼接恰为全文");

        boolean replaySuppressed = AgentUtil.isThinkingReplay(streamedBuf, FULL);
        assertTrue(replaySuppressed, "前提：终态全文帧被判为重放");

        // 聚合侧：补发同时灌进了 thinkingBuilder，故聚合值是「全文 × 2」
        AssistantMessage message = aggregated("最终答案", FULL + FULL);

        AssistantMessage fixed = AgentUtil.dedupeAggregatedThinking(message, streamedBuf.toString());

        assertEquals(FULL, fixed.getThinkingRaw(), "聚合值必须收敛为与屏幕一致的单份");
    }

    @Test
    @DisplayName("源码形态：归一必须早于全部下游消费，且锚取未规范化的原始值")
    public void source_shape_guards() throws IOException {
        String src = readSource("gourd-ai-agent/src/main/java/com/gourdai/agent/react/task/ReasonTask.java");

        int dedupeAt = src.indexOf("AgentUtil.dedupeAggregatedThinking(");
        assertTrue(dedupeAt > 0, "ReasonTask 必须调用聚合思考去重");

        // 归一必须发生在写入工作记忆之前（下一轮重发的就是这个对象）
        int lastReasonAt = src.indexOf("trace.setLastReasonMessage(responseMessage)");
        assertTrue(lastReasonAt > dedupeAt,
                "归一必须早于 setLastReasonMessage，否则工作记忆里仍是双份思考");

        // 归一必须发生在审计/思考事件之前，保证全部下游只看到单份
        int reasonEndAt = src.indexOf("onReasonEnd(trace, response, responseMessage");
        assertTrue(reasonEndAt > dedupeAt, "归一必须早于 onReasonEnd 拦截器");

        // 锚必须是未经 </think> 截断的原始值：ATTR_STREAMED_REASONING 已被规范化，不可复用
        assertTrue(src.contains("trace.getExtraAs(ATTR_STREAMED_THINKING_RAW)"),
                "锚必须取未规范化的 ATTR_STREAMED_THINKING_RAW");

        int rawSetAt = src.indexOf("trace.setExtra(ATTR_STREAMED_THINKING_RAW, streamedThinkingRaw)");
        int normalizeAt = src.indexOf("AgentUtil.normalizeStreamedReasoningPrefix(");
        assertTrue(rawSetAt > 0 && normalizeAt > rawSetAt,
                "原始锚必须在规范化之前落盘，确保其未被截断");

        // 每次物理重试都要清掉上一尝试的锚，否则会拿旧响应的思考去比对新响应
        assertTrue(src.contains("trace.removeExtra(ATTR_STREAMED_THINKING_RAW)"),
                "物理重试与无思考分支必须清理原始锚");
    }

    private static String readSource(String relativePath) throws IOException {
        Path path = Paths.get(relativePath);
        if (!Files.exists(path)) {
            // 兼容以模块目录为工作目录运行的场景
            path = Paths.get("..").resolve(relativePath).normalize();
        }

        assertTrue(Files.exists(path), "源码文件必须存在: " + relativePath);
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }
}
