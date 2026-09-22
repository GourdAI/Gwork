/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.event;

import com.gourdai.ai.chat.ChatAccumulator;
import com.gourdai.ai.chat.event.ChatEvent;
import com.gourdai.ai.chat.event.ChatEventNormalizer;
import com.gourdai.ai.chat.event.ChatEventType;
import com.gourdai.ai.chat.event.ChatStreamContext;
import com.gourdai.ai.chat.event.ChatStreamContextDefault;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.ai.llm.dialect.anthropic.AnthropicResponseParser;
import com.gourdai.ai.llm.dialect.openai.OpenaiResponsesResponseParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 空思考链下的「思考已开始」信号测试。
 *
 * <p><b>缺陷背景</b>：部分模型（Claude 系）会屏蔽思维链明文——思考确实在进行、计费与耗时照常
 * 发生，但思考文本通道全程为空。而链路上每一层都以「有内容」为下发前提（方言的
 * {@code Utils.isNotEmpty} 守卫、{@code ReasonDeltaEvent.hasContent()} 守卫），于是整段思考期
 * 零事件：Web 相位停在 waiting，前端持续显示「等待响应」并从头累加计时，直到正文首字才跳变——
 * 可实际上后端早已开始响应。</p>
 *
 * <p>修复方式是让方言在<b>思考块开启</b>时就发出 {@code THINKING_START}（与内容解耦），由
 * {@code ReasonTask} 投影成 {@link ReasonStartEvent} 推进相位。本测试直接驱动真实 parser，
 * 断言「空思考链也有开始信号」「有内容时不重复开块」两条不变量。</p>
 *
 * @author gourdai
 * @since 4.1.1
 */
public class EmptyThinkingPhaseTest {

    /** 驱动 parser 并经归一化器收集事件（与生产链路同构：方言 → normalizer → 订阅方）。 */
    private static final class Collector {
        private final ChatEventNormalizer normalizer = new ChatEventNormalizer();
        private final List<ChatEvent> events = new ArrayList<>();
        private final ChatAccumulator acc = new ChatAccumulator(null, true);
        private final ChatStreamContext ctx;

        private Collector() {
            // ofNoEmit 的 emit 只归并不投递，故用自建上下文把事件同时喂给归一化器，
            // 才能断言订阅方真正收到的序列（重复 START 去重就发生在归一化器内）。
            this.ctx = new ChatStreamContextDefault(null, null, acc, null, 0,
                    event -> normalizer.apply(event, events::add));
        }

        List<ChatEventType> types() {
            List<ChatEventType> types = new ArrayList<>(events.size());
            for (ChatEvent event : events) {
                types.add(event.getType());
            }
            return types;
        }

        int count(ChatEventType type) {
            int n = 0;
            for (ChatEvent event : events) {
                if (event.getType() == type) {
                    n++;
                }
            }
            return n;
        }

        String textOf(ChatEventType type) {
            for (ChatEvent event : events) {
                if (event.getType() == type) {
                    return event.getText();
                }
            }
            return null;
        }
    }

    // ==================== Anthropic：thinking 块 ====================

    @Test
    @DisplayName("Anthropic：thinking 文本为空时，仍发出 THINKING_START（空思考链的唯一相位信号）")
    public void anthropic_emptyThinking_stillEmitsStart() {
        Collector c = new Collector();
        new AnthropicResponseParser().parseStreamResponse(c.ctx,
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}");

        assertEquals(1, c.count(ChatEventType.THINKING_START),
                "空思考块也必须给出开始信号，否则整段思考期零事件、相位停在 waiting");
        assertEquals(0, c.count(ChatEventType.THINKING_DELTA),
                "没有内容就不得伪造增量帧（会渲染出空思考块）");
    }

    @Test
    @DisplayName("Anthropic：thinking 带首片内容时，START 只出现一次且在 DELTA 之前")
    public void anthropic_thinkingWithText_startBeforeDeltaAndNotDuplicated() {
        Collector c = new Collector();
        new AnthropicResponseParser().parseStreamResponse(c.ctx,
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"thinking\",\"thinking\":\"先看进度\"}}");

        // 归一化器按块标识（group+itemId+index）配对：手工补发的 START 与随后的 DELTA 同键，
        // 故 DELTA 不会再触发一次隐式 START。这正是「不重复开块」的保证点。
        assertEquals(1, c.count(ChatEventType.THINKING_START), "同一思考块不得重复开启");
        assertEquals(1, c.count(ChatEventType.THINKING_DELTA));
        assertEquals(ChatEventType.THINKING_START, c.types().get(0), "开始信号必须先于内容");
        assertEquals("先看进度", c.textOf(ChatEventType.THINKING_DELTA));
    }

    @Test
    @DisplayName("Anthropic：空 thinking 块后续来了 thinking_delta，仍只开一次块")
    public void anthropic_emptyStartThenDelta_singleBlock() {
        Collector c = new Collector();
        AnthropicResponseParser parser = new AnthropicResponseParser();
        parser.parseStreamResponse(c.ctx,
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}");
        parser.parseStreamResponse(c.ctx,
                "{\"type\":\"content_block_delta\",\"index\":0,"
                        + "\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"晚到的思考\"}}");

        assertEquals(1, c.count(ChatEventType.THINKING_START),
                "先开空块、内容后到，是最常见的形态，不得开出两个块");
        assertEquals(1, c.count(ChatEventType.THINKING_DELTA));
    }

    @Test
    @DisplayName("Anthropic：text 块不受影响，不得误发 THINKING_START")
    public void anthropic_textBlock_noThinkingStart() {
        Collector c = new Collector();
        new AnthropicResponseParser().parseStreamResponse(c.ctx,
                "{\"type\":\"content_block_start\",\"index\":0,"
                        + "\"content_block\":{\"type\":\"text\",\"text\":\"正文\"}}");

        assertEquals(0, c.count(ChatEventType.THINKING_START), "正文块不得进入思考相位");
        assertEquals(1, c.count(ChatEventType.TEXT_DELTA));
    }

    // ==================== OpenAI Responses：reasoning 项 ====================

    @Test
    @DisplayName("Responses：reasoning 项开启即发 THINKING_START，不依赖 summary 是否到达")
    public void responses_reasoningItemAdded_emitsStart() {
        Collector c = new Collector();
        new OpenaiResponsesResponseParser().parseStreamResponse(c.ctx,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,"
                        + "\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\"}}");

        assertEquals(1, c.count(ChatEventType.THINKING_START),
                "屏蔽思维链的端点全程不给 summary/reasoning_text，只有边界事件能表达「已开始思考」");
        assertEquals(0, c.count(ChatEventType.THINKING_DELTA));
    }

    @Test
    @DisplayName("Responses：随后的 summary 增量不再重复开块")
    public void responses_reasoningStartThenSummaryDelta_singleBlock() {
        Collector c = new Collector();
        OpenaiResponsesResponseParser parser = new OpenaiResponsesResponseParser();
        parser.parseStreamResponse(c.ctx,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,"
                        + "\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\"}}");
        parser.parseStreamResponse(c.ctx,
                "{\"type\":\"response.reasoning_summary_text.delta\",\"item_id\":\"rs_1\","
                        + "\"output_index\":0,\"summary_index\":0,\"delta\":\"思考片段\"}");

        assertEquals(1, c.count(ChatEventType.THINKING_START),
                "START 与 DELTA 的块标识同口径（item_id + output_index），必须归为同一个块");
        assertEquals(1, c.count(ChatEventType.THINKING_DELTA));
        assertEquals("思考片段", c.textOf(ChatEventType.THINKING_DELTA));
    }

    @Test
    @DisplayName("Responses：message 项不得误发 THINKING_START")
    public void responses_messageItem_noThinkingStart() {
        Collector c = new Collector();
        new OpenaiResponsesResponseParser().parseStreamResponse(c.ctx,
                "{\"type\":\"response.output_item.added\",\"output_index\":0,"
                        + "\"item\":{\"id\":\"msg_1\",\"type\":\"message\"}}");

        assertEquals(0, c.count(ChatEventType.THINKING_START));
    }

    // ==================== ReasonStartEvent 契约 ====================

    @Test
    @DisplayName("ReasonStartEvent.hasContent() 恒为 false：不得被通用内容通道当成空串帧下发")
    public void reasonStartEvent_hasNoContent() {
        // 各 portal 出口普遍以 hasContent() 作为下发守卫；基类实现判的是 getContent() != null，
        // 而本事件的载体是空助手消息（getContent() 返回空串而非 null），沿用基类会得到 true，
        // 于是被当成「有内容的空串帧」渲染出空泡。
        ReasonStartEvent event = new ReasonStartEvent(new ReActTrace());

        assertFalse(event.hasContent(), "相位信号不是可渲染内容");
        assertTrue(event.getMessage() != null, "载体消息仍需存在，供基类字段访问");
    }
}
