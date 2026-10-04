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
package com.gourdai.harness.agent;

import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActResponse;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.session.InMemoryAgentSession;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 子代理「失败不得报成功」契约测试（行为 + 接线）。
 *
 * <p>背景（work-munh72qj 排查结论）：模型服务故障时子代理以道歉文案收尾（abnormal=true），
 * 但 taskDo 三个分支（detached/同步/流式）只看「拿到 RunEndEvent」就报 success=true，
 * 父代理把道歉文案当真实结论编进汇总——信封撒谎。</p>
 *
 * <p>修复口径：{@code isHealthyRunEnd(runEnd, session)} = {@code !abnormal || isPending}。
 * 挂起（ask_user/HITL）虽然也置 abnormal=true（单参 setFinalAnswer），但它是流程控制
 * 而非失败，必须排除；用户主动中断不打 abnormal，天然不受影响。</p>
 *
 * @author oisin
 */
public class TaskTalentHealthyRunEndTest {

    // ── 行为断言：isHealthyRunEnd 判定式 ──────────────────

    private static RunEndEvent endEventOf(ReActTrace trace) {
        ReActResponse resp = new ReActResponse(InMemoryAgentSession.of("s"), trace,
                com.gourdai.ai.chat.message.ChatMessage.ofAssistant("内容"));
        return new RunEndEvent(resp);
    }

    @Test
    @DisplayName("abnormal RunEnd（模型失败/超时兜底）不得判为健康")
    public void abnormalRunEndMustNotBeHealthy() {
        ReActTrace trace = new ReActTrace();
        trace.setFinalAnswer("抱歉，模型服务响应超时。..."); // 单参重载 → abnormal=true

        Assertions.assertFalse(TaskTalent.isHealthyRunEnd(endEventOf(trace), InMemoryAgentSession.of("s")),
                "abnormal=true（非挂起）是失败兜底，必须如实上报 failure");
    }

    @Test
    @DisplayName("正常完成的 RunEnd 判为健康")
    public void normalRunEndMustBeHealthy() {
        ReActTrace trace = new ReActTrace();
        trace.setFinalAnswer("真实结论", false); // 双参重载显式 abnormal=false

        Assertions.assertTrue(TaskTalent.isHealthyRunEnd(endEventOf(trace), InMemoryAgentSession.of("s")),
                "正常完成必须保持 success=true（不得误伤）");
    }

    @Test
    @DisplayName("挂起态的 abnormal（ask_user/HITL 文案）不得判为失败")
    public void pendingRunEndMustNotBeTreatedAsFailure() {
        ReActTrace trace = new ReActTrace();
        trace.setFinalAnswer("等待用户作答..."); // 单参重载 → abnormal=true（挂起文案同路径）

        InMemoryAgentSession session = InMemoryAgentSession.of("pending-session");
        session.pending(true, "等待用户作答");

        Assertions.assertTrue(TaskTalent.isHealthyRunEnd(endEventOf(trace), session),
                "挂起是流程控制不是失败：ask_user/HITL 恢复路径不得被误报为 failure");
    }

    @Test
    @DisplayName("null runEnd 交由调用方的 CANCELLED 分支处理（不在此误判）")
    public void nullRunEndDefersToCallerCancelledBranch() {
        Assertions.assertTrue(TaskTalent.isHealthyRunEnd(null, InMemoryAgentSession.of("s")),
                "null 的语义由调用方专门分支处理（取消路径），本方法不得越权改判");
    }

    // ── 接线断言：三个分支都必须接上判定 ──────────────────

    private static final Path SOURCE = Paths.get(
            "src/main/java/com/gourdai/harness/agent/TaskTalent.java");

    @Test
    @DisplayName("taskDo 三个分支（detached/同步/流式）都必须调用 isHealthyRunEnd")
    public void allThreeBranchesMustApplyHealthCheck() throws IOException {
        assertTrueFile();
        String src = readSource();
        String body = extractMethodBody(src, "taskDo");

        int wired = countOccurrences(body, "isHealthyRunEnd(runEnd, session)")
                + countOccurrences(body, "isHealthyRunEnd(response, session)");
        Assertions.assertTrue(wired >= 3,
                "三个分支都必须接上健康判定（detached 用 runEnd、同步用 runEnd、流式用 response），"
                        + "实际 " + wired + " 处——漏一处该分支的信封就继续撒谎\n"
                        + "（detached: " + body.contains("isHealthyRunEnd(runEnd, session)")
                        + ", 同步: " + body.contains("isHealthyRunEnd(runEnd, session)")
                        + ", 流式: " + body.contains("isHealthyRunEnd(response, session)") + "）");
    }

    @Test
    @DisplayName("失败结果必须加 SUBAGENT_FAILURE_PREFIX 且信封 result_status 如实")
    public void failureResultMustCarryPrefixAndHonestStatus() throws IOException {
        String src = readSource();
        String body = extractMethodBody(src, "taskDo");

        Assertions.assertTrue(body.contains("SUBAGENT_FAILURE_PREFIX + result"),
                "失败时结果必须拼接失败前缀（父代理与用户识别「这不是结论」的第一线索）\n");
        Assertions.assertTrue(body.contains("formatTaskResp(task, resultOk, result, isMultitask)"),
                "信封 result_status 必须取 resultOk 而非写死 true\n");
        // AgentEndEvent 的 success 同样必须用 resultOk（流式分支）
        int agentEndWithOk = countOccurrences(body, "new AgentEndEvent(task.agent_name, task.description, resultOk, result");
        Assertions.assertTrue(agentEndWithOk >= 1,
                "流式分支的 AgentEndEvent success 必须取 resultOk（前端卡片失败态依赖它）\n");
        int emitWithOk = countOccurrences(body, "emitBackgroundEnd(__sessionId, task, invocationId, resultOk, result)");
        Assertions.assertTrue(emitWithOk >= 1,
                "detached 分支的 emitBackgroundEnd success 必须取 resultOk（后台卡片失败态依赖它）\n");
    }

    // ── 辅助 ──────────────────────────────────────────────

    private static void assertTrueFile() throws IOException {
        Assertions.assertTrue(Files.exists(SOURCE), "源码文件应存在: " + SOURCE.toAbsolutePath());
    }

    private static String readSource() throws IOException {
        Path p = SOURCE;
        if (Files.exists(p) == false) {
            p = Paths.get("..").resolve(SOURCE.toString()).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "源码文件应存在: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    private static String extractMethodBody(String src, String methodName) {
        java.util.regex.Matcher sig = java.util.regex.Pattern.compile(
                "(?:public|private|protected)\\s+String\\s+" + java.util.regex.Pattern.quote(methodName) + "\\s*\\(")
                .matcher(src);
        Assertions.assertTrue(sig.find(), "应能找到方法 " + methodName);
        int open = src.indexOf('{', src.indexOf(')', sig.end()));
        Assertions.assertTrue(open >= 0, "应能找到方法体起点");

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
        Assertions.fail("方法体大括号未配平: " + methodName);
        return "";
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
