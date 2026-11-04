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
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 循环检测指纹「只读工具纳入参数」的行为测试。
 *
 * <p>用户实测场景（本轮修复的直接动因）：子代理连续 read 不同文件（每次获取的信息都不同），
 * 旧指纹只看工具名，8 次窗口内 3 次 read 就触发循环提醒，注入的「强制收敛」提示诱导模型
 * 提前收尾——任务没干完就自己停了。</p>
 *
 * <p>修复后：read/grep/glob/ls 的参数参与指纹，读不同文件是不同指纹，不再误判；
 * 同名同参的重复调用（真正的原地打转）仍然能被检测到。</p>
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

    /** 连续 onThought count 次，返回期间是否注入过循环提醒（以工作记忆新增 user 消息为准）。 */
    private static boolean loopDetected(int repeatCount, AssistantMessage msg) {
        StopLoopInterceptor interceptor = new StopLoopInterceptor(); // 默认 (3, 8)
        ReActTrace trace = new ReActTrace();

        int before = trace.getWorkingMemory().getMessages().size();
        for (int i = 0; i < repeatCount; i++) {
            interceptor.onThought(trace, null, msg);
        }
        return trace.getWorkingMemory().getMessages().size() > before;
    }

    @Test
    @DisplayName("同一窗口内 3 次不同文件 read 不触发（用户实测场景复现）")
    void threeDifferentReadsInOneWindowMustNotTrigger() {
        StopLoopInterceptor interceptor = new StopLoopInterceptor(); // (3, 8)
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
    @DisplayName("同名同参的 read 连续 3 次仍触发（真循环检测能力不得回归）")
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
                "交替搜两个不同 pattern 不是循环（A-B-A 型但参数均不同）");

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
        // a b a：若 key 顺序参与指纹，a 和 b 是不同指纹，两次 a + 一次 b 只计 a×2，不触发；
        // 规范化后 a==b，3 次同指纹，触发。断言「触发」即证明 key 顺序被正确规范化掉。
        interceptor.onThought(trace, null, toolCallMsg("read", a));
        interceptor.onThought(trace, null, toolCallMsg("read", b));
        interceptor.onThought(trace, null, toolCallMsg("read", a));
        assertTrue(trace.getWorkingMemory().getMessages().size() > before,
                "key 顺序不同的同键值 args 应产生相同指纹（3 次应触发循环提醒）");
    }

    @Test
    @DisplayName("同名不同参的 bash ×3 不再触发（自查场景实测误判源）")
    void bashWithDifferentCommandsMustNotTrigger() {
        // 2026-10-02 口径反转：旧断言「bash 不同命令 ×3 仍触发」的「危险信号语义」在实测中
        // 是主要误判源（work-mupc5nd0：连续 bash Select-String 定位不同符号 → 同名指纹 ≥3 →
        // 注入「直接输出 Final Answer」式收敛指令 → 模型提前收口，0/10 任务未完成）。
        // 新口径：除任务清单工具（NAME_ONLY_TOOLS）外全部看参数，同名不同参不触发。
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
    @DisplayName("同命令 bash ×3 仍触发（真循环检测能力不回归）")
    void sameCommandBashStillTriggers() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "go build ./...");
        assertTrue(loopDetected(3, toolCallMsg("bash", args)),
                "同命令 bash ×3 是真原地打转，必须仍能检测到");
    }

    @Test
    @DisplayName("todowrite/todoread 只看名字：同名同参/同名不同参均按名字指纹")
    void todoToolsFingerprintByNameOnly() {
        // 清单工具每轮参数必然变化（清单内容随进度变），若纳入参数，正常推进任务会被误判为
        // 不同操作从而丢失检测能力；反之若同名即指纹，连续 todowrite ×3 会被判定为可疑重复
        // ——但这正是「每轮都重写清单却无实质推进」的信号，提醒是合理的。
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

        // 场景复现（work-mupc5nd0 实测形态）：长自查结论开头雷同，仅后半不同。旧口径取前
        // 50 字符裸前缀 → 三次指纹相同 → 误注入收敛指令。新口径：120 字符哈希化，后半差异
        // 参与哈希 → 不同指纹，不触发。前 60 字刻意完全相同（覆盖旧口径的截断窗口），
        // 确保本用例能杀死「退回短前缀」的变异。
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

        // 完全相同文本 ×3 仍必须触发（真重复）
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
