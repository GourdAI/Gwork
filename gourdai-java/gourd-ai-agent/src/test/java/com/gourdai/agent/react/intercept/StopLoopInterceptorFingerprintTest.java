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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 循环检测「完整参数指纹 + 连续链 3/5/8 建议式提醒 + 进展感知」的行为测试。
 *
 * <p>2026-11-20 重设计（work-mwod1kcs 误杀复盘，Rust react/mod.rs 同步同语义）：
 * 旧「窗口频率 + 120 字符截断」把 12 条共享长路径前缀但 Pattern 不同的排查命令
 * 判成同一指纹并硬停任务。新口径：完整值哈希零截断；连续链计数（任何不同调用重置）；
 * 3/5/8 各提醒一次后沉默，永不阻断/停机；同调用但结果变化、或上轮成功 write/edit，
 * 链重置（重复≠无产出）。</p>
 *
 * @author oisin
 */
class StopLoopInterceptorFingerprintTest {

    /** 构造带单工具调用的 AssistantMessage。 */
    private static AssistantMessage toolCallMsg(String toolName, Map<String, Object> args) {
        List<ToolCall> calls = new ArrayList<>();
        calls.add(new ToolCall("0", "call-1", toolName, "{}", args == null ? new HashMap<>() : args));
        return AssistantMessage.snapshot("正文", "", calls, null, null, null, null);
    }

    /** 构造无工具调用的纯文本思考 AssistantMessage（模拟意图声明场景）。 */
    private static AssistantMessage textMsg(String content) {
        return AssistantMessage.snapshot(content, "", null, null, null, null, null);
    }

    /**
     * 连续 onThought count 次（无 onObservation 证据 → 结果恒空、无写入），
     * 返回期间注入的提醒条数。同参无进展的真重复在第 3 次触发首档。
     */
    private static int remindersFor(int repeatCount, AssistantMessage msg) {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 0; i < repeatCount; i++) {
            interceptor.onThought(trace, null, msg);
        }
        return trace.getWorkingMemory().getMessages().size() - before;
    }

    private static boolean loopDetected(int repeatCount, AssistantMessage msg) {
        return remindersFor(repeatCount, msg) > 0;
    }

    /** 模拟一轮：onThought（判定）→ onObservation（喂本轮结果证据）。 */
    private static void round(StopLoopInterceptor interceptor, ReActTrace trace,
                              AssistantMessage msg, String toolName, String result, boolean failed) {
        interceptor.onThought(trace, null, msg);
        ToolExchanger ex = new ToolExchanger(toolName, new HashMap<>());
        ex.setResult(result);
        ex.setFailed(failed);
        interceptor.onObservation(trace, ex, null, null, 1);
    }

    @Test
    @DisplayName("连续 3 次不同文件 read 不触发（用户实测场景复现）")
    void threeDifferentReadsMustNotTrigger() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 1; i <= 3; i++) {
            Map<String, Object> args = new LinkedHashMap<>();
            args.put("file_path", "src/file" + i + ".txt");
            interceptor.onThought(trace, null, toolCallMsg("read", args));
        }
        assertFalse(trace.getWorkingMemory().getMessages().size() > before,
                "读 3 个不同文件是 3 个不同指纹，不得注入循环提醒（用户实测误判场景）");
    }

    @Test
    @DisplayName("同名同参同结果的 read 连续 3 次仍触发（真循环检测能力不得回归）")
    void sameArgsReadStillTriggers() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "src/same.txt");
        assertTrue(loopDetected(3, toolCallMsg("read", args)),
                "同参 read ×3 是真原地打转，必须仍能检测到");
    }

    @Test
    @DisplayName("grep 不同 pattern = 不同指纹；同 pattern 重复仍触发")
    void grepPatternParticipatesInFingerprint() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("pattern", "handleLastException");
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("pattern", "prepareResume");

        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        interceptor.onThought(trace, null, toolCallMsg("grep", a));
        interceptor.onThought(trace, null, toolCallMsg("grep", b));
        interceptor.onThought(trace, null, toolCallMsg("grep", a));
        assertFalse(trace.getWorkingMemory().getMessages().size() > before,
                "交替搜两个不同 pattern 不是循环（连续链语义：任何不同调用重置）");

        assertTrue(loopDetected(3, toolCallMsg("grep", a)),
                "同 pattern grep ×3 是真循环，必须触发");
    }

    @Test
    @DisplayName("key 顺序不同但键值相同的 args 产生相同指纹（规范化生效）")
    void argsKeyOrderMustNotChangeFingerprint() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("file_path", "x.txt");
        a.put("limit", 10);
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("limit", 10);
        b.put("file_path", "x.txt");

        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        // a b a：若 key 顺序参与指纹，a 和 b 是不同指纹，链不断重置，不触发；
        // 规范化后 a==b，3 次同指纹，触发。断言「触发」即证明 key 顺序被正确规范化掉。
        interceptor.onThought(trace, null, toolCallMsg("read", a));
        interceptor.onThought(trace, null, toolCallMsg("read", b));
        interceptor.onThought(trace, null, toolCallMsg("read", a));
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "key 顺序不同的同键值 args 应产生相同指纹（3 次应触发循环提醒）");
    }

    @Test
    @DisplayName("嵌套 Map 的 key 顺序也规范化（深度排序）")
    void nestedKeyOrderMustNotChangeFingerprint() {
        Map<String, Object> inner1 = new LinkedHashMap<>();
        inner1.put("b", 2);
        inner1.put("a", 1);
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("opt", inner1);
        Map<String, Object> inner2 = new LinkedHashMap<>();
        inner2.put("a", 1);
        inner2.put("b", 2);
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("opt", inner2);

        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        interceptor.onThought(trace, null, toolCallMsg("x", a));
        interceptor.onThought(trace, null, toolCallMsg("x", b));
        interceptor.onThought(trace, null, toolCallMsg("x", a));
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "嵌套 key 顺序不同的同键值 args 应产生相同指纹");
    }

    @Test
    @DisplayName("同名不同参的 bash ×3 不再触发（自查场景实测误判源）")
    void bashWithDifferentCommandsMustNotTrigger() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 1; i <= 3; i++) {
            Map<String, Object> args = new LinkedHashMap<>();
            args.put("command", "Select-String -Path file" + i + ".go -Pattern symbol" + i);
            interceptor.onThought(trace, null, toolCallMsg("bash", args));
        }
        assertFalse(trace.getWorkingMemory().getMessages().size() > before,
                "三条不同命令的 bash 是三次实质不同操作，不得误判为循环");
    }

    @Test
    @DisplayName("work-mwod1kcs 回归：共享 >120 字符前缀但 Pattern 不同的 12 条命令零提醒")
    void longSharedPrefixCommandsMustNotCollide() {
        // 旧 canonicalArgsOf 截断到 120 字符：路径前缀吃满预算，Pattern 差异全被
        // 截掉 → 12 条不同排查命令同一指纹 → 3 次提醒耗尽 → Rust 侧硬停 448 回合。
        String prefix = "$f='C:\\Apps\\HBuilderX\\plugins\\uniapp-cli-vite\\node_modules\\@dcloudio\\uni-cli-shared\\lib\\dom2\\web\\@vue\\compiler-sfc\\dist\\compiler-sfc.cjs.js'; ";
        assertTrue(prefix.length() > 120, "前提：前缀超过旧截断预算");
        String[] patterns = {
                "function fileToScope", "function resolveFS", "new ScriptCompileContext",
                "fileToScopeCache", "Unresolvable type reference", "function resolveTypeReference",
                "function recordTypes", "function recordType\\b", "extraOptions",
                "class ScriptCompileContext", "ScriptCompileContext = class", "invalidateTypeCache",
        };
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        for (String p : patterns) {
            Map<String, Object> args = new LinkedHashMap<>();
            args.put("command", prefix + "Select-String -Path $f -Pattern '" + p + "'");
            args.put("timeout", 30000);
            interceptor.onThought(trace, null, toolCallMsg("bash", args));
        }
        assertEquals(before, trace.getWorkingMemory().getMessages().size(),
                "12 条实质不同的排查命令不得触发任何提醒（work-mwod1kcs 误杀回归）");
    }

    @Test
    @DisplayName("同命令 bash ×3 仍触发（真循环检测能力不回归）")
    void sameCommandBashStillTriggers() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "go build ./...");
        assertTrue(loopDetected(3, toolCallMsg("bash", args)),
                "同命令 bash ×3 是真原地打转，必须仍能检测到");
    }

    @Test
    @DisplayName("升级式提醒：3/5/8 各一次，之后沉默，20 轮共 3 条且永不停机")
    void escalationFiresOncePerThresholdThenSilent() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "x");
        AssistantMessage msg = toolCallMsg("bash", args);
        assertEquals(3, remindersFor(20, msg), "3/5/8 各提醒一次，之后沉默");
    }

    @Test
    @DisplayName("进展感知 A：同调用但结果每次不同（轮询产出新信息）→ 零提醒")
    void sameCallChangingResultNeverReminds() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "poll-build-log");
        AssistantMessage msg = toolCallMsg("bash", args);
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 0; i < 12; i++) {
            round(interceptor, trace, msg, "bash", "log line " + i, false);
        }
        assertEquals(before, trace.getWorkingMemory().getMessages().size(),
                "结果不断变化的轮询是合法排查，不得提醒");
    }

    @Test
    @DisplayName("进展感知 B：两次相同探测之间夹成功 edit（改一版测一版）→ 零提醒")
    void successfulEditBetweenProbesNeverReminds() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "check-dev-server");
        AssistantMessage probe = toolCallMsg("bash", args);
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 0; i < 12; i++) {
            // 每轮：edit 成功（状态变更）→ 相同探测、相同结果。
            ToolExchanger edit = new ToolExchanger("edit", new HashMap<>());
            edit.setResult("ok");
            interceptor.onObservation(trace, edit, null, null, 1);
            interceptor.onThought(trace, null, probe);
            ToolExchanger check = new ToolExchanger("bash", new HashMap<>());
            check.setResult("same output");
            interceptor.onObservation(trace, check, null, null, 1);
        }
        assertEquals(before, trace.getWorkingMemory().getMessages().size(),
                "edit→重启→轮询 循环是合法调试（work-mwod1kcs 形态），不得提醒");
    }

    @Test
    @DisplayName("失败的 edit 不算进展：同参同结果重复仍触发")
    void failedEditDoesNotCountAsProgress() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "check");
        AssistantMessage probe = toolCallMsg("bash", args);
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        // 每轮两个调用：失败的 edit + 相同的 bash 探测（真实 ActionTask 顺序：
        // onThought 先于本轮 onObservation，证据喂给下一轮判定）。
        // 第 1 轮建基线（count=1），第 2/3/4 轮同证据递增 → 第 4 轮 count=3 触发。
        for (int i = 0; i < 4; i++) {
            interceptor.onThought(trace, null, probe);
            ToolExchanger edit = new ToolExchanger("edit", new HashMap<>());
            edit.setResult("old_str not found");
            edit.setFailed(true);
            interceptor.onObservation(trace, edit, null, null, 1);
            ToolExchanger check = new ToolExchanger("bash", new HashMap<>());
            check.setResult("same output");
            interceptor.onObservation(trace, check, null, null, 1);
        }
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "失败写入不构成进展，真重复仍须提醒");
    }

    @Test
    @DisplayName("todowrite/todoread 只看名字：同名同参/同名不同参均按名字指纹")
    void todoToolsFingerprintByNameOnly() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("todos", "- [ ] step1\n- [ ] step2");
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("todos", "- [x] step1\n- [ ] step2");

        assertTrue(loopDetected(3, toolCallMsg("todowrite", a)),
                "同名 todowrite ×3 名字指纹相同，应触发提醒");

        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        int before = trace.getWorkingMemory().getMessages().size();
        interceptor.onThought(trace, null, toolCallMsg("todowrite", a));
        interceptor.onThought(trace, null, toolCallMsg("todowrite", b));
        interceptor.onThought(trace, null, toolCallMsg("todowrite", a));
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "清单工具不看参数：a/b/a 三次同名同指纹，应触发");
    }

    @Test
    @DisplayName("纯文本思考：不同内容不同指纹、长文本开头雷同不碰撞")
    void textThoughtFingerprintUsesHashOfLongerPrefix() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        String same60 = "现在我有足够的信息了。排查结论如下：经过对缓存槽位、额度更新、计费落点三个方向的深入排查，";
        String t1 = same60 + "确认 P0 是缓存路由遮蔽，必须修 A。";
        String t2 = same60 + "确认 P0 是额度更新丢用量，必须修 B。";
        String t3 = same60 + "确认 P0 是计费落点错分组，必须修 C。";

        int before = trace.getWorkingMemory().getMessages().size();
        interceptor.onThought(trace, t1, textMsg(t1));
        interceptor.onThought(trace, t2, textMsg(t2));
        interceptor.onThought(trace, t3, textMsg(t3));
        assertFalse(trace.getWorkingMemory().getMessages().size() > before,
                "开头雷同但实质不同的长文本思考，不得被误判为循环（work-mupc5nd0 实测误判形态）");

        assertTrue(loopDetected(3, textMsg(t1)),
                "完全相同的纯文本思考 ×3 是真重复，必须仍能检测到");
    }

    @Test
    @DisplayName("触发提醒时必须打收敛门禁标记（EXTRA_CONVERGE_PENDING）")
    void loopInjectionMustArmConvergeGate() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "src/same.txt");
        for (int i = 0; i < 3; i++) {
            interceptor.onThought(trace, null, toolCallMsg("read", args));
        }
        assertTrue(trace.isConvergePending(),
                "循环提醒注入后必须置位收敛门禁标记，供 ReasonTask 隐式 END 分支做完成校验");
    }

    @Test
    @DisplayName("注入文案不得含「直接输出 Final Answer 结束任务」收敛指令")
    void injectedTextMustNotCommandImmediateFinalAnswer() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "src/same.txt");
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        for (int i = 0; i < 3; i++) {
            interceptor.onThought(trace, null, toolCallMsg("read", args));
        }
        List<com.gourdai.ai.chat.message.ChatMessage> msgs = trace.getWorkingMemory().getMessages();
        assertFalse(msgs.isEmpty(), "触发后应有一条注入消息");
        String injected = msgs.get(msgs.size() - 1).getContent();
        assertFalse(injected.contains("直接输出 Final Answer"),
                "收敛指令会诱导模型把意图声明当最终答案（work-mupc5nd0 实测），已改为完成校验措辞:\n" + injected);
        assertTrue(injected.contains("若尚未完成，请继续执行"),
                "新文案应引导「未完成则继续执行」:\n" + injected);
    }

    @Test
    @DisplayName("提醒永不挂起、永不终止：触发后 route 与 finalAnswer 均不受影响")
    void reminderNeverSuspendsOrTerminates() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "x");
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();
        for (int i = 0; i < 20; i++) {
            interceptor.onThought(trace, null, toolCallMsg("bash", args));
        }
        // 裸 trace 无 session（prepare 未跑）；拦截器若挂起会先 NPE 或置位，两者都算失败。
        assertTrue(trace.getSession() == null || !trace.getSession().isPending(),
                "建议式提醒不得挂起会话");
        assertTrue(trace.getFinalAnswer() == null || trace.getFinalAnswer().isEmpty(),
                "建议式提醒不得强行终止任务");
    }

    @Test
    @DisplayName("args 为 null 与空 map 产生相同指纹（等价处理）")
    void nullArgsEqualsEmptyArgs() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor();
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        interceptor.onThought(trace, null, toolCallMsg("read", null));
        interceptor.onThought(trace, null, toolCallMsg("read", new HashMap<>()));
        interceptor.onThought(trace, null, toolCallMsg("read", null));
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "null args 与空 args 等价：3 次实质相同调用应触发");
    }
}