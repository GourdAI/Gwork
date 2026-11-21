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
package com.gourdai.agent.react.intercept;

import com.gourdai.agent.react.AbsReActInterceptor;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Nullable;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * 避免逻辑死循环拦截器 (Loop Breaker) — 建议式，永不阻断、永不停机。
 *
 * <p>2026-11-20 重设计（用户拍板，竞品对齐；Rust 内核 react/mod.rs 同步同语义）：</p>
 * <ol>
 *   <li><b>完整参数指纹</b>：旧 canonicalArgsOf 把每个参数值截断到 120 字符。
 *       实测 work-mwod1kcs：12 条共享超长路径前缀（{@code $f='C:\Apps\HBuilderX\...'}）
 *       但 Pattern 各不相同的排查命令被截成同一指纹 → 3 次提醒耗尽 → Rust 侧硬停
 *       448 回合的健康调试任务。现改为深度 key 排序 + 完整值哈希，零截断。</li>
 *   <li><b>连续链 + 升级式提醒</b>（DSH repeat-tool-reminder 语义，阈值 3/5/8）：
 *       任何不同调用重置链；每档阈值只提醒一次，超过最高档沉默。
 *       Claude Code / Codex 无行为级检测器，DSH 有但「Advisory, not veto」——
 *       其设计笔记明确否决「高阈值升级为 block」，理由是误伤合法轮询/复查。
 *       本拦截器同口径：只注入提醒，不改 route、不挂起、不停机。</li>
 *   <li><b>进展感知</b>：同指纹但结果内容不同（轮询产出新信息）、或上一轮有
 *       成功的 write/edit（改一版测一版），链重置为 1——重复≠无产出。</li>
 * </ol>
 */
@Preview("3.8.1")
public class StopLoopInterceptor extends AbsReActInterceptor {
    private static final Logger log = LoggerFactory.getLogger(StopLoopInterceptor.class);
    private static final String EXTRAS_CHAIN_KEY = "stoploop_chain";

    /** DSH repeat-tool-reminder 默认阈值：连续重复 3/5/8 次各提醒一次，之后沉默。 */
    static final int[] REMINDER_THRESHOLDS = {3, 5, 8};

    /**
     * 成功执行即改变工作区状态的工具。两次相同探测之间夹着一次成功写入，
     * 说明世界变了——重跑同一探测是合法验证（edit → 重启 → 轮询），不是打转。
     */
    private static final Set<String> STATE_MUTATING_TOOLS = new HashSet<>(Arrays.asList(
            "write", "edit", "multiedit", "notebookedit"));

    /** 兼容旧构造签名：窗口参数已废弃（连续链语义下无窗口），仅保留编译兼容。 */
    public StopLoopInterceptor(int maxRepeatCount, int windowSize) {
        // 参数不再参与行为：阈值固定为 DSH 默认 [3,5,8]，链语义无窗口。
    }

    public StopLoopInterceptor() {
    }

    /** 连续重复链状态（每 trace 一条，存 extras；任何不同调用重置）。 */
    private static class Chain {
        String fingerprint;
        int count;
        /** 已触发到第几档阈值（REMINDER_THRESHOLDS 下标）。 */
        int fired;
        /** 上一轮各调用结果的哈希（按批内顺序）。 */
        List<Integer> lastResults;
        /** 上一轮是否有成功的状态变更工具（write/edit）。 */
        boolean prevMutated;
        /** 本轮结果哈希累积（onObservation 填充，onThought 消费）。 */
        List<Integer> roundResults = new ArrayList<>();
        /** 本轮是否出现成功的状态变更工具。 */
        boolean roundMutated;
    }

    private Chain chainOf(ReActTrace trace) {
        Chain chain = trace.getExtraAs(EXTRAS_CHAIN_KEY);
        if (chain == null) {
            chain = new Chain();
            trace.setExtra(EXTRAS_CHAIN_KEY, chain);
        }
        return chain;
    }

    /**
     * 观察节点：收集进展证据（结果哈希 + 成功写入标志）。
     * 挂起/中断（observation 为空且无结果）不产生证据，也不污染链。
     */
    @Override
    public void onObservation(ReActTrace trace, ToolExchanger toolExchanger,
                              @Nullable ChatMessage observation,
                              @Nullable Throwable error,
                              long durationMs) {
        if (toolExchanger == null) return;
        Chain chain = chainOf(trace);
        String result = toolExchanger.getResult();
        chain.roundResults.add(result == null ? 0 : result.hashCode());
        if (error == null && !toolExchanger.isFailed()
                && STATE_MUTATING_TOOLS.contains(toolExchanger.getToolName())) {
            chain.roundMutated = true;
        }
    }

    @Override
    public void onThought(ReActTrace trace, String thoughtContent, AssistantMessage assistantMessage) {
        if (assistantMessage == null) return;

        String fingerprint = generateNormalizedFingerprint(assistantMessage);
        Chain chain = chainOf(trace);
        // 消费上一轮（onObservation 累积）的证据后清空，供本轮重新累积。
        List<Integer> results = chain.roundResults;
        boolean mutated = chain.roundMutated;
        chain.roundResults = new ArrayList<>();
        chain.roundMutated = false;

        if (fingerprint == null) {
            // 指纹不可靠（参数不可序列化等）：本轮不参与链判定（宁漏勿误判），
            // 但成功写入仍算进展，传递给下一个可判定轮。
            chain.prevMutated |= mutated;
            return;
        }

        int repeats;
        if (fingerprint.equals(chain.fingerprint)) {
            // 首轮无证据（lastResults==null）不算「结果变了」：否则第 2 次重复
            // 永远被误判为新信息，链永远到不了阈值 3。
            boolean resultsChanged = chain.lastResults != null && !chain.lastResults.equals(results);
            boolean newInfo = chain.prevMutated || resultsChanged;
            if (newInfo) {
                // 进展感知：同调用但结果变了 / 上轮成功改过文件 → 链重置。
                chain.count = 1;
                chain.fired = 0;
                chain.lastResults = results;
                chain.prevMutated = mutated;
                return;
            }
            chain.count++;
            repeats = chain.count;
        } else {
            chain.fingerprint = fingerprint;
            chain.count = 1;
            chain.fired = 0;
            chain.lastResults = results;
            chain.prevMutated = mutated;
            return;
        }
        chain.lastResults = results;
        chain.prevMutated = mutated;

        // 每档阈值只触发一次；超过最高档沉默。永不阻断、永不停机。
        if (chain.fired < REMINDER_THRESHOLDS.length && repeats >= REMINDER_THRESHOLDS[chain.fired]) {
            chain.fired++;
            injectReminder(trace, repeats);
        }
    }

    private void injectReminder(ReActTrace trace, int count) {
        // 注意：不得使用「直接输出 Final Answer 结束任务」类收敛指令。
        // 实测（work-mupc5nd0）：这句措辞会让模型把一句过渡性意图声明（如
        // 「取证够了，直接修两个 P0」）当最终答案输出，而 NATIVE_TOOL 模式下
        // 「有正文 + 无工具调用」即判 END——任务未完成 Loop 却「正常」结束。
        // 提醒只引导「换角度/不重复」，是否收敛交给模型与收敛门禁（EXTRA_CONVERGE_PENDING）。
        // 文案与 Rust loop_detected_prompt 逐字一致。
        String breakMsg;
        if (count <= REMINDER_THRESHOLDS[0]) {
            breakMsg = "【系统提示：检测到潜在循环 (Loop Detected)】\n" +
                    "系统检测到您已连续 " + count + " 次执行完全相同的工具调用（参数与结果均未变化），可能存在\"原地打转\"的情况。\n\n" +
                    "请审视历史 Observation：如果最近的尝试没有带来有效新线索，请更换思路或换个角度切入；不要重复执行已执行过且未产生新信息的操作。\n" +
                    "若确认任务已全部完成，可给出面向用户的总结作为最终回答；若尚未完成，请继续执行未完成事项。";
        } else {
            breakMsg = "【系统提示：检测到潜在循环 (Loop Detected)】\n" +
                    "您已连续 " + count + " 次执行完全相同的工具调用（参数与结果均未变化）。重复同一调用不会产生新信息。\n\n" +
                    "请不要再以完全相同的参数调用该工具。请执行以下步骤：\n" +
                    "1. **有效性评估**：当前策略已失效，必须更换思路或换个角度切入（换工具、换参数、换排查方向）。\n" +
                    "2. **阻塞上报**：若客观限制导致无法推进，请向用户说明卡点与已排除的方向，请求协助。\n" +
                    "3. **任务完成校验**：若确认任务已全部完成，可给出面向用户的总结作为最终回答；若尚未完成，请继续执行未完成事项。";
        }

        // 注入用户消息到工作记忆（与 auto-rethink 同一机制，参见 ReasonTask）
        trace.getWorkingMemory().addMessage(ChatMessage.ofUser(breakMsg));
        // 打收敛门禁标记：注入过收敛导向指令后，ReasonTask 对首个无工具调用的
        // 纯文本回复不立即判 END，先做完成语义校验（详见 EXTRA_CONVERGE_PENDING）。
        trace.markConvergePending();
        log.warn("ReAct repeat chain reached {} for agent [{}], injected advisory reminder (converge gate armed).", count, trace.getAgentName());

        // 不设 session.pending(true) — 不永久挂起
        // 不设 trace.setFinalAnswer(...) — 不强行终止
        // 不改 route — 当前 tool call 正常执行
        // LLM 在下一轮 Reasoning 时会看到提醒并自纠
    }

    /**
     * 参数敏感工具名单：这些工具参数不同就是<b>实质不同</b>的操作（读另一个文件、搜另一个模式、
     * 跑另一条命令），指纹必须纳入参数，否则「逐个读 5 个不同文件」「连跑 5 条不同命令」
     * 会被误判为原地打转。
     *
     * <p>2026-10-02 口径扩大（用户实测 work-mupc5nd0 复盘）：旧名单只含 read/grep/glob/ls，
     * 自查型任务里连续「bash Select-String 定位不同符号 → read 读不同段落」的节奏中，
     * bash 只看工具名 → 同名指纹迅速 ≥3 → 误注入循环提醒，其「直接输出 Final Answer 结束
     * 任务」措辞诱导模型提前收口（TODO 0/10 未完成 Loop 却「正常」结束）。教训：写工具里
     * 同名不同参的操作也大量存在（Select-String 换 pattern、write 换 file_path），
     * 与其枚举「哪个工具该看参数」，不如反过来枚举<b>不该看参数</b>的少数例外。</p>
     *
     * <p>反例名单（名字即指纹）：todowrite/todoread 等任务清单工具——它们每轮参数必然变化
     * （清单内容随进度变），纳入参数反而把「正常推进任务」误判为不同操作，丢失循环检测能力。</p>
     */
    private static final Set<String> NAME_ONLY_TOOLS = new HashSet<>(Arrays.asList(
            "todowrite", "todoread"));

    private String generateNormalizedFingerprint(AssistantMessage message) {
        if (Assert.isNotEmpty(message.getToolCalls())) {
            // 指纹口径：工具名 + 完整规范化参数的哈希。除 NAME_ONLY_TOOLS 反例外全部纳入：
            // 同名不同参的操作（read 换文件、bash 换命令）是实质不同的操作，不应计入循环；
            // 同名同参的重复调用（真正的原地打转）仍能被检测到。
            // 2026-11-20：值不再截断（work-mwod1kcs 误杀根因），哈希保持指纹紧凑。
            StringBuilder sb = new StringBuilder();
            for (ToolCall call : message.getToolCalls()) {
                sb.append("tool:").append(call.getName());
                if (NAME_ONLY_TOOLS.contains(call.getName())) {
                    continue;
                }
                String canonicalArgs = canonicalArgsOf(call);
                if (canonicalArgs == null) {
                    // 参数无法规范化（不可序列化对象等）：本次调用的指纹不可靠，
                    // 放弃整条指纹而非拼入字面量 "null"——后者会让两次不同的
                    // 失败调用指纹相同，误判面原样回归
                    return null;
                }
                sb.append("#args:").append(Integer.toHexString(canonicalArgs.hashCode()));
            }
            return sb.toString();
        } else if (Assert.isNotEmpty(message.getContent())) {
            String content = message.getContent();
            // 提取 Action 块，忽略 Thought 的微小差异
            int actionIdx = content.indexOf("Action:");
            if (actionIdx >= 0) {
                String actionLine = content.substring(actionIdx).trim();
                // 取 Action: 工具名 部分，忽略参数
                int braceIdx = actionLine.indexOf("{");
                if (braceIdx >= 0) {
                    return actionLine.substring(0, braceIdx).trim();
                }
                return actionLine;
            }
            // 如果只有内容，取前 120 个字符作为特征。
            // 2026-10-02：50→120，且改用「哈希化前缀」而非裸前缀——长文本（调查报告/
            // 自查结论）开头极易雷同（「现在我有足够信息…」「已确认…」），裸前缀会让
            // 多轮实质不同的纯文本思考指纹相同。哈希化保留区分度，长度提升降低碰撞。
            // 不再附 turn 戳：附戳会把「真正重复的相同文本」也判为不同，循环检测能力回归。
            String prefix = content.length() > 120 ? content.substring(0, 120) : content;
            return "text:" + Integer.toHexString(prefix.hashCode());
        }
        return null;
    }

    /**
     * 规范化参数串：用于循环指纹的参数差异判定。
     *
     * <p>规范化规则与指纹稳定性目标一致——微小的无关差异（key 顺序、嵌套 key 顺序）
     * 不应产生不同指纹，而实质差异（不同 file_path、不同 pattern）必须产生不同指纹：</p>
     * <ol>
     *   <li>args 为 null/空 → 固定空串（两者等价）；</li>
     *   <li>key 排序后按 {@code k=v} 拼接，value <b>完整</b>参与（2026-11-20 起零截断：
     *       旧 120 字符截断把共享长前缀的不同命令判成同一指纹，work-mwod1kcs 误杀根因）；
     *       嵌套 Map 递归排序，List 保序；</li>
     *   <li>value 为 null → 空串；</li>
     *   <li>序列化异常（不可序列化对象）→ 返回 null，调用方视为「无法指纹」，
     *       该次调用不参与循环计数（宁漏勿误判）。</li>
     * </ol>
     */
    private static String canonicalArgsOf(ToolCall call) {
        Map<String, Object> args = call.getArguments();
        if (args == null || args.isEmpty()) {
            return "";
        }
        try {
            return canonicalValue(args);
        } catch (Throwable e) {
            // 参数含不可序列化对象等极端情况：放弃指纹，不阻断主流程
            log.debug("Loop fingerprint args build failed for tool [{}]", call.getName(), e);
            return null;
        }
    }

    /** 递归规范化：Map 每层 key 排序，List 保序，标量 String.valueOf，零截断。 */
    private static String canonicalValue(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) value;
            List<String> keys = new ArrayList<>();
            for (Object k : map.keySet()) {
                keys.add(String.valueOf(k));
            }
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder();
            for (String key : keys) {
                if (sb.length() > 0) {
                    sb.append('|');
                }
                sb.append(key).append('=').append(canonicalValue(map.get(key)));
            }
            return sb.toString();
        }
        if (value instanceof List) {
            List<?> list = (List<?>) value;
            StringBuilder sb = new StringBuilder();
            sb.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(canonicalValue(list.get(i)));
            }
            sb.append(']');
            return sb.toString();
        }
        return String.valueOf(value);
    }
}