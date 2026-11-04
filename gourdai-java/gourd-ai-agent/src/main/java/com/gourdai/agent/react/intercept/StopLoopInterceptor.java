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
import com.gourdai.ai.chat.message.AssistantMessage;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.ai.chat.tool.ToolCall;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * 避免逻辑死循环拦截器 (Loop Breaker)
 *
 * <p>通过监控动作意图的滑动窗口频率，防止智能体陷入连续重复或 A-B-A-B 型往复迭代。</p>
 */
@Preview("3.8.1")
public class StopLoopInterceptor extends AbsReActInterceptor {
    private static final Logger log = LoggerFactory.getLogger(StopLoopInterceptor.class);
    private static final String EXTRAS_HISTORY_KEY = "stoploop_history";

    private final int maxRepeatCount;
    private final int windowSize;

    public StopLoopInterceptor(int maxRepeatCount, int windowSize) {
        this.maxRepeatCount = Math.max(2, maxRepeatCount);
        this.windowSize = Math.max(4, windowSize);
    }

    public StopLoopInterceptor() {
        this(3, 8); // 稍微放大窗口，增加容错
    }

    @Override
    public void onThought(ReActTrace trace, String thoughtContent, AssistantMessage assistantMessage) {
        if (assistantMessage == null) return;

        String fingerprint = generateNormalizedFingerprint(assistantMessage);
        if (fingerprint == null) return;

        List<String> history = trace.getExtraAs(EXTRAS_HISTORY_KEY);
        if (history == null) {
            history = new LinkedList<>();
            trace.setExtra(EXTRAS_HISTORY_KEY, history);
        }

        history.add(fingerprint);
        if (history.size() > windowSize) {
            history.remove(0);
        }

        long count = history.stream().filter(fp -> fp.equals(fingerprint)).count();

        if (count >= maxRepeatCount) {
            // --- 核心优化：软提醒 + LLM 自纠（不再 pending 挂起） ---

            // 注意：不得使用「直接输出 Final Answer 结束任务」类收敛指令。
            // 实测（work-mupc5nd0）：这句措辞会让模型把一句过渡性意图声明（如
            // 「取证够了，直接修两个 P0」）当最终答案输出，而 NATIVE_TOOL 模式下
            // 「有正文 + 无工具调用」即判 END——任务未完成 Loop 却「正常」结束。
            // 提醒只引导「换角度/不重复」，是否收敛交给模型与收敛门禁（EXTRA_CONVERGE_PENDING）。
            String breakMsg = String.format(
                    "【系统提示：检测到潜在循环 (Loop Detected)】\n" +
                            "系统检测到您最近 %d 次（连续 %d 次相同）执行了高度相似的操作，可能存在\"原地打转\"的情况。\n\n" +
                            "请立即暂停当前操作思路，审视历史 Observation 并执行以下步骤：\n" +
                            "1. **有效性评估**：如果最近的尝试没有带来有效新线索，说明当前策略已失效，请必须更换思路或换个角度切入。\n" +
                            "2. **避免重复**：不要重复执行已经执行过且未产生新信息的操作。\n" +
                            "3. **任务完成校验**：若确认任务已全部完成，请给出面向用户的完整总结报告作为最终回答；若尚未完成，请继续执行未完成事项。",
                    count, count
            );

            // 注入用户消息到工作记忆（与 auto-rethink 同一机制，参见 ReasonTask）
            trace.getWorkingMemory().addMessage(ChatMessage.ofUser(breakMsg));
            // 打收敛门禁标记：注入过收敛导向指令后，ReasonTask 对首个无工具调用的
            // 纯文本回复不立即判 END，先做完成语义校验（详见 EXTRA_CONVERGE_PENDING）。
            // 这是「软提醒误导模型提前收口」的引擎侧兑底：提醒文案无论怎么措辞，
            // 门禁都能拦住「意图声明被当最终答案」的误判。
            trace.markConvergePending();
            log.warn("ReAct Loop detected for agent [{}], injected self-correction prompt (converge gate armed).", trace.getAgentName());

            // 清除计数，避免注入的消息本身又被算成一次循环
            history.clear();

            // 不设 session.pending(true) — 不永久挂起
            // 不设 trace.setFinalAnswer(...) — 不强行终止
            // 不改 route — 当前 tool call 正常执行
            // LLM 在下一轮 Reasoning 时会看到提醒并自纠
        }
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
            // 指纹口径：工具名 + 参数规范化。除 NAME_ONLY_TOOLS 反例外全部纳入：
            // 同名不同参的操作（read 换文件、bash 换命令）是实质不同的操作，不应计入循环；
            // 同名同参的重复调用（真正的原地打转）仍能被检测到。
            // 反例（todowrite 等）保持只看工具名：清单工具每轮参数必然变化，看参数反而盲。
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
                sb.append("#args:").append(canonicalArgs);
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
     * 只读工具的规范化参数串：用于循环指纹的参数差异判定。
     *
     * <p>规范化规则与指纹稳定性目标一致——微小的无关差异（key 顺序、路径分隔符）
     * 不应产生不同指纹，而实质差异（不同 file_path、不同 pattern）必须产生不同指纹：</p>
     * <ol>
     *   <li>args 为 null/空 → 固定空串（两者等价）；</li>
     *   <li>key 排序后按 {@code k=v} 拼接，value 取 toString 截断到 120 字符
     *       （read 的大 file 内容不在 args 里，args 本身很小，截断只是防御性兼容未来
     *       的大参数字段）；</li>
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
            List<String> keys = new ArrayList<>(args.keySet());
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder();
            for (String key : keys) {
                if (sb.length() > 0) {
                    sb.append('|');
                }
                Object value = args.get(key);
                String valueStr = value == null ? "" : String.valueOf(value);
                if (valueStr.length() > 120) {
                    valueStr = valueStr.substring(0, 120);
                }
                sb.append(key).append('=').append(valueStr);
            }
            return sb.toString();
        } catch (Throwable e) {
            // 参数含不可序列化对象等极端情况：放弃指纹，不阻断主流程
            log.debug("Loop fingerprint args build failed for tool [{}]", call.getName(), e);
            return null;
        }
    }
}