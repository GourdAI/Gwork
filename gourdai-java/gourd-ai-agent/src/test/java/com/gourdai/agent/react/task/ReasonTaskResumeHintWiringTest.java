/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.agent.react.task;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「重试耗尽兜底文案」必须引导用户断点续跑的接线守护。
 *
 * <p>背景（用户排查 work-munh72qj 得出）：模型服务故障重试耗尽后，{@code handleLastException}
 * 以道歉文案收尾，route=END + abnormal=true。三端（Web/Ws/Cli）已实现中断续跑
 * （canResume→prepareResume 保留断点工作记忆），但旧文案「请稍后重试」让用户以为要
 * 重述整个任务，实际发任意消息即可从断点继续——文案与机制脱节，用户被误导浪费 token。</p>
 *
 * <p>本类为<b>接线守护</b>（口径同 {@code ReasonTaskTimeoutLimitWiringTest}）：
 * handleLastException 是 private 方法且依赖 ReActAgent 实例，行为断言成本高；
 * 用源码扫描守住三个文案分支都必须携带续跑指引，防止未来文案改动悄悄丢掉它。</p>
 *
 * @author oisin
 */
class ReasonTaskResumeHintWiringTest {

    private static final Path SOURCE = Paths.get(
            "src/main/java/com/gourdai/agent/react/task/ReasonTask.java");

    @Test
    @DisplayName("三处兜底文案都必须含「断点续跑」指引")
    void allFallbackMessagesMustCarryResumeHint() throws IOException {
        String body = handleLastExceptionBody();

        // resumeHint 提取为局部变量，三个文案分支拼接引用：断言口径验「行为」而非「实现形状」
        // ——①指引文案本体存在；②三个 setFinalAnswer 分支全部拼接 resumeHint（而非字面重复三遍）。
        assertTrue(body.contains("任务已中断并保留断点"),
                "续跑指引文案本体缺失\n" + body);
        assertTrue(body.contains("String resumeHint ="),
                "指引应提取为局部变量供三个分支复用（避免三份文案口径漂移）\n" + body);

        int setFinalCount = countOccurrences(body, "trace.setFinalAnswer(");
        int withHintCount = countOccurrences(body, "+ resumeHint");
        assertTrue(setFinalCount > 0 && withHintCount >= setFinalCount,
                "三个兜底分支的 setFinalAnswer 必须全部携带 resumeHint（实际 setFinalAnswer="
                        + setFinalCount + ", 携带指引=" + withHintCount + "）\n" + body);
    }

    @Test
    @DisplayName("旧文案「请稍后重试」必须已从三个分支移除（会误导用户重述任务）")
    void oldRetryLaterWordingMustBeGone() throws IOException {
        String body = handleLastExceptionBody();

        // 断言口径：只看三个文案字面量，不看注释（注释里合法地引用旧文案做历史说明）。
        // 提取所有 setFinalAnswer(...) 调用行验证。
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("trace\\.setFinalAnswer\\([^)]*\\)")
                .matcher(body);
        int checked = 0;
        while (m.find()) {
            String call = m.group();
            if (call.contains("请稍后重试")) {
                org.junit.jupiter.api.Assertions.fail(
                        "兜底文案不得再含「请稍后重试」（会误导用户重述任务）: " + call);
            }
            checked++;
        }
        assertTrue(checked >= 3,
                "三个分支的 setFinalAnswer 调用都应被检查到（实际 " + checked + "）\n" + body);
    }

    @Test
    @DisplayName("续跑指引必须说明「无需重述任务」（这是与旧文案的本质差异）")
    void resumeHintMustSayNoNeedToRestate() throws IOException {
        String body = handleLastExceptionBody();

        assertTrue(body.contains("无需重述任务"),
                "指引必须明确告知无需重述任务，否则用户仍会复述整个任务背景\n" + body);
    }

    // ── 辅助 ──────────────────────────────────────────────

    private static String handleLastExceptionBody() throws IOException {
        assertTrue(Files.exists(SOURCE),
                "找不到 ReasonTask 源码（测试须在 gourd-ai-agent 模块目录下运行）: "
                        + SOURCE.toAbsolutePath());
        String src = new String(Files.readAllBytes(SOURCE), StandardCharsets.UTF_8);

        int methodIdx = src.indexOf("private ChatResponse handleLastException");
        assertTrue(methodIdx > 0, "应能找到 handleLastException 方法");

        int open = src.indexOf('{', methodIdx);
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return src.substring(open, i + 1);
                }
            }
        }
        throw new IllegalStateException("方法体大括号未配平");
    }

    private static int countOccurrences(String text, String needle) {
        int count = 0;
        int from = 0;
        while ((from = text.indexOf(needle, from)) >= 0) {
            count++;
            from += needle.length();
        }
        return count;
    }
}
