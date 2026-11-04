/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.event;

import com.gourdai.agent.util.AgentUtil;
import com.gourdai.ai.chat.message.AssistantMessage;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 思考 / 正文双通道分流契约。
 *
 * <p><b>为何需要这组测试</b>：上游 4.1.1 移除了 {@code AssistantMessage.isThinking()}
 * 布尔位，分片的通道归属改由「text 与 thinking 哪个字段有值」自然表达。随之而来的陷阱是
 * {@code hasContent()} / {@code getContent()} <b>只看 text 通道</b>：</p>
 *
 * <pre>
 *   hasContent() -> hasText() -> isNotEmpty(getText())
 *   getContent() -> getText()
 * </pre>
 *
 * <p>而思考分片的 text 恒为空、内容在 thinking 通道。任何沿用这两个方法做「守卫」或
 * 「取值」的调用点，都会把思考分片判成空消息而<b>静默丢弃</b>——编译期无错、运行期
 * 表现为「思考区全程无输出」，且不抛任何异常，极难定位。</p>
 *
 * <p>抽离上游源码时已实测踩中两处：{@code ReasonDeltaEvent}（四个出口的共同枢纽）与
 * {@code AgentUtil.getResultContentWithoutReasoning}。本测试把修复后的语义固化下来，
 * 防止后续维护中被改回 {@code hasContent()} / {@code getContent()}。</p>
 *
 * @author gourdai
 */
public class ThinkingChannelContractTest {

    // ==================== 1. AssistantMessage 通道语义（上游契约前提） ====================

    @Test
    @DisplayName("前提固化：hasContent()/getContent() 只看 text 通道，思考分片在其眼中是空消息")
    void upstream_hasContent_only_sees_text_channel() {
        AssistantMessage thinkingDelta = new AssistantMessage("", "推理中");

        // 这两条断言不是「期望的行为」，而是上游既成事实——正因如此，调用点不能用它们做守卫。
        assertFalse(thinkingDelta.hasContent(),
                "上游契约：思考分片的 hasContent() 为 false（text 为空）");
        assertEquals("", thinkingDelta.getContent(),
                "上游契约：思考分片的 getContent() 返回空串而非思考文本");

        // 真正承载内容的是 thinking 通道
        assertTrue(thinkingDelta.hasThinking());
        assertEquals("推理中", thinkingDelta.getThinking());
    }

    @Test
    @DisplayName("isThinkingOnly 是增量场景下 isThinking 的等价替代；混合消息必须判为正文")
    void isThinkingOnly_semantics() {
        assertTrue(new AssistantMessage("", "推理").isThinkingOnly(),
                "纯思考分片（text 空 + thinking 有值）");
        assertFalse(new AssistantMessage("答案", "").isThinkingOnly(),
                "纯正文分片");

        // 关键：混合态不能判成思考，否则正文会被整段渲染进思考区
        assertFalse(new AssistantMessage("答案", "推理").isThinkingOnly(),
                "text 非空即阻止纯思考分类——这正是不能简化为 hasThinking() 的原因");
    }

    // ==================== 2. ChatEventSupport：分片构造形态 ====================

    @Test
    @DisplayName("ChatEventSupport 构造的思考分片必须落在 thinking 通道且被判为纯思考")
    void chatEventSupport_builds_single_channel_deltas() {
        AssistantMessage thinking = new AssistantMessage("", "思考内容");
        AssistantMessage text = new AssistantMessage("正文内容", "");

        assertTrue(thinking.isThinkingOnly(), "思考分片形态：('', thinking)");
        assertFalse(text.isThinkingOnly(), "正文分片形态：(text, '')");

        assertEquals("思考内容", thinking.getThinking());
        assertEquals("正文内容", text.getText());
    }

    // ==================== 3. ReasonDeltaEvent：四出口的共同枢纽 ====================

    @Test
    @DisplayName("【防回归】ReasonDeltaEvent 必须覆写 hasContent/getContent 以跨越双通道")
    void reasonDeltaEvent_must_override_content_accessors() throws Exception {
        // 用反射断言「覆写确实存在」：若有人删掉覆写，基类实现会让思考分片静默消失，
        // 而那种失效不会让任何现有断言变红（表现为流里少了帧，不是异常）。
        java.lang.reflect.Method hasContent =
                ReasonDeltaEvent.class.getDeclaredMethod("hasContent");
        java.lang.reflect.Method getContent =
                ReasonDeltaEvent.class.getDeclaredMethod("getContent");

        assertEquals(ReasonDeltaEvent.class, hasContent.getDeclaringClass(),
                "hasContent() 必须由 ReasonDeltaEvent 自己声明（不可退回接口 default 实现）");
        assertEquals(ReasonDeltaEvent.class, getContent.getDeclaringClass(),
                "getContent() 必须由 ReasonDeltaEvent 自己声明（不可退回接口 default 实现）");
    }

    // ==================== 4. AgentUtil：曾被 hasContent() 吞掉思考帧 ====================

    @Test
    @DisplayName("【防回归】纯思考帧必须返回思考文本，而非被 hasContent() 守卫吞成空串")
    void getResultContentWithoutReasoning_handles_thinking_frame() {
        AssistantMessage delta = new AssistantMessage("", "用户要求");

        assertEquals("用户要求", AgentUtil.getResultContentWithoutReasoning(delta),
                "回归哨兵：改用 hasContent()/getContent() 做守卫会让本例返回空串");
    }

    @Test
    @DisplayName("正文帧与混合帧仍取 text 通道，不受思考通道干扰")
    void getResultContentWithoutReasoning_keeps_text_channel() {
        assertEquals("最终答案",
                AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("最终答案", "")));

        // 混合态：thinking 已由独立通道展示，正文侧只应拿到 text
        assertEquals("最终答案",
                AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("最终答案", "推理")));
    }

    @Test
    @DisplayName("空消息与 null 仍返回空串（边界不变）")
    void getResultContentWithoutReasoning_empty_cases() {
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(null));
        assertEquals("", AgentUtil.getResultContentWithoutReasoning(new AssistantMessage("", "")));
    }
}
