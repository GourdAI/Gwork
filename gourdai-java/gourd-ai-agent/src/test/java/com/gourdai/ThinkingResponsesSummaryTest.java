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
package com.gourdai;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * openai-responses 协议下 thinking 多轮回传的职责边界护栏。
 *
 * <p><b>问题背景</b>：思考模式网关要求把上一轮的推理内容回传，否则 400：
 * "The `reasoning_text` in the thinking mode must be passed back to the API"。</p>
 *
 * <p><b>本测试为何被重写</b>：早先本项目依赖上游 jar，无法修改
 * {@code OpenaiResponsesRequestBuilder}，只能在 {@code ThinkingDepth} 里补
 * {@code reasoning.summary=auto}「隔空喊话」服务端多返回点素材。抽离源码后经核实，
 * 该补丁<b>方向就是错的</b>：</p>
 *
 * <ol>
 *   <li>真正解决 400 的是<b>输入项侧</b>的 reasoning 回放
 *       （{@code appendReasoningInputItem}）：把上一轮 reasoning item 原样回传，
 *       无官方元数据时降级为 {@code {type:"reasoning_text", text:...}}——
 *       恰好就是报错要求的字段。它与配置项侧的 {@code reasoning.summary} 无关。</li>
 *   <li>写显式 {@code reasoning} 反而会让
 *       {@code applyUnifiedReasoningOptions} 开头的
 *       {@code root.hasKey("reasoning") -> return} 提前返回，<b>挡住</b>上游自身的
 *       summary / effort 处理逻辑。</li>
 * </ol>
 *
 * <p>因此职责边界为：<b>ThinkingDepth 只负责档位映射（effort），
 * 协议细节（summary / include / reasoning 回放）全部下沉到方言层。</b></p>
 *
 * @author gourdai
 */
public class ThinkingResponsesSummaryTest {

    private static String readSource(String relative) throws IOException {
        Path p = Paths.get(relative);
        if (!Files.exists(p)) {
            p = Paths.get("gourd-ai-agent/" + relative);
        }
        assertTrue(Files.exists(p), "源文件未找到: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    private static String responsesEffortBody() throws IOException {
        String src = readSource("src/main/java/com/gourdai/core/portal/web/ThinkingDepth.java");
        int branch = src.indexOf("case RESPONSES_EFFORT:");
        assertTrue(branch > 0, "未找到 RESPONSES_EFFORT 分支");
        int next = src.indexOf("case ", branch + "case RESPONSES_EFFORT:".length());
        return next > 0 ? src.substring(branch, next) : src.substring(branch);
    }

    @Test
    @DisplayName("ThinkingDepth 只写 effort：档位映射是它的职责")
    public void responsesEffortWritesEffort() throws IOException {
        String body = responsesEffortBody();

        assertTrue(body.contains("reasoning.put(\"effort\""),
                "RESPONSES_EFFORT 分支必须写入 effort（档位映射是本层职责）");
        assertTrue(body.contains("optionSet(\"reasoning\""),
                "effort 必须经 optionSet(\"reasoning\", ...) 出站");
    }

    @Test
    @DisplayName("【防回归】ThinkingDepth 不得再写 summary：协议细节属方言层")
    public void responsesEffortMustNotWriteSummary() throws IOException {
        String body = responsesEffortBody();

        assertFalse(body.contains("reasoning.put(\"summary\""),
                "不得在此写 summary：真正解决 400 的是方言层的 reasoning 回放"
                        + "（appendReasoningInputItem，无元数据时降级为 reasoning_text），"
                        + "而显式 reasoning 会让上游 applyUnifiedReasoningOptions 提前 return，"
                        + "反而挡住它自己的 summary/effort 处理");
    }

    @Test
    @DisplayName("summary 不出现在任何档位分支中（anthropic/gemini 等协议不认该字段）")
    public void summaryMustNotLeakToAnyShape() throws IOException {
        String src = readSource("src/main/java/com/gourdai/core/portal/web/ThinkingDepth.java");

        // 只统计代码里的字符串字面量 "summary"，注释中的说明性文字不计入。
        int occurrences = 0;
        for (String line : src.split("\\R")) {
            String t = line.trim();
            if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
                continue;
            }
            int idx = t.indexOf("\"summary\"");
            while (idx >= 0) {
                occurrences++;
                idx = t.indexOf("\"summary\"", idx + 1);
            }
        }

        assertEquals(0, occurrences,
                "ThinkingDepth 不应再出现 \"summary\" 字面量，实际 " + occurrences + " 次");
    }

    @Test
    @DisplayName("方言层确实具备 reasoning 回放能力（含 reasoning_text 降级通道）")
    public void dialectOwnsReasoningReplay() throws IOException {
        String builder = readSource(
                "src/main/java/com/gourdai/ai/llm/dialect/openai/OpenaiResponsesRequestBuilder.java");

        assertTrue(builder.contains("appendReasoningInputItem"),
                "方言层必须具备 reasoning 输入项回放能力");
        assertTrue(builder.contains("\"reasoning_text\""),
                "必须保留 reasoning_text 降级通道——这正是思考模式网关要求回传的字段");
        assertTrue(builder.contains("isReasoningReplayEnabled"),
                "必须保留回放开关（对 glm- 等兼容层需要关闭回放）");

        // 该类是 4.1.1 新增，4.1.0 jar 中并不存在；抽离时若漏带，400 会立刻复发。
        Path support = Paths.get(
                "src/main/java/com/gourdai/ai/llm/dialect/openai/OpenaiResponsesMessageStateSupport.java");
        if (!Files.exists(support)) {
            support = Paths.get("gourd-ai-agent/src/main/java/com/gourdai/ai/llm/dialect/openai/"
                    + "OpenaiResponsesMessageStateSupport.java");
        }
        assertTrue(Files.exists(support),
                "OpenaiResponsesMessageStateSupport 必须存在：它承载 reasoning 多轮回放的协议状态");
    }
}
