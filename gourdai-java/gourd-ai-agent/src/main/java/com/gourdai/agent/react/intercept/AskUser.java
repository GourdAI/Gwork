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

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.util.AskUserTool;
import org.noear.snack4.ONode;
import org.noear.solon.core.util.Assert;
import org.noear.solon.lang.Preview;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ask_user 结构化问答交互助手
 *
 * <p>提供面向业务层（如 Web 控制器）的便捷 API。主要用于：</p>
 * <ul>
 * <li><b>任务探知</b>：通过 {@link #getPendingTask} 获取当前会话中被挂起的提问任务。</li>
 * <li><b>答案回填</b>：通过 {@link #submit} 提交用户答案，驱动 Agent 恢复执行。</li>
 * <li><b>文本格式化</b>：通过 {@link #formatAnswerText} 把结构化答案转为供模型阅读的文本。</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class AskUser {
    /**
     * 挂起任务存储 Key
     */
    public static final String TASK_KEY = "_ask_user_task_";
    /**
     * 答案存储前缀（完整键 = 前缀 + toolName）
     */
    public static final String ANSWER_PREFIX = "_ask_user_answer_";
    /**
     * 答案归属标识存储前缀（完整键 = 前缀 + toolName），值为产生该答案的那次提问的 actionId
     *
     * <p>答案键是会话级全局单键，而挂起任务可能在答案被消费前就消失（用户改发普通消息、
     * 会话被新一轮任务冲掉等）。此时残留的答案会变成「幽灵答案」——下一次模型真的提问时
     * 被当作本次回答直接回填，用户根本看不到卡片就被替模型作了答。记录归属后，
     * 消费方可判定「这份答案是不是属于这一次提问」，不属于就丢弃并正常挂起。</p>
     */
    public static final String ANSWER_OWNER_PREFIX = "_ask_user_answer_owner_";
    /**
     * 挂起原因文案
     */
    public static final String PENDING_REASON = "等待用户回答";

    /**
     * 获取会话中当前挂起的提问任务
     *
     * @return 挂起的任务实体，若无挂起则返回 null
     */
    public static AskUserTask getPendingTask(AgentSession session) {
        return session.getContext().getAs(TASK_KEY);
    }

    /**
     * 判定当前挂起的提问是否「真的还能被恢复」
     *
     * <p><b>为什么只有任务实体在还不够</b>：挂起任务是会话上下文里的普通键，而会话的挂起态
     * （{@code stopped}）由执行引擎维护。用户在提问帧到达前抢先发了一条普通消息时，新一轮任务会
     * {@code ReActTrace#prepare} 重置挂起态并把路由推到 END 正常结束，但<b>没有任何一处清理过
     * 挂起任务实体</b>——于是留下「任务实体还在、会话却早已不挂起」的僵尸组合。</p>
     *
     * <p>此时若仍按「有任务实体就能恢复」行事，恢复出来的那一轮会因路由停在 END 而空转
     * （0 token、十几毫秒直接结束），拦截器的 onAction/onObservation 一次都不会执行，
     * 现场自然也不会被清理，于是「重发提问帧 → 用户作答 → 空转 → 再重发」无限自激，
     * 表现为问答卡不停闪烁且永不自愈。</p>
     *
     * <p>会话挂起态随快照持久化（快照顶层 {@code stopped} 字段），故重启后判定依然可靠。</p>
     *
     * @return 存在挂起任务且会话确实处于挂起态时为 true
     */
    public static boolean isResumable(AgentSession session) {
        return session != null && getPendingTask(session) != null && session.isPending();
    }

    /**
     * 提交用户答案
     *
     * <p>写入 {@code ANSWER_PREFIX + task.getToolName()} 键；无挂起任务时按工具名常量兜底，
     * 保证在旧快照等异常场景下答案仍能被拦截器读到。</p>
     *
     * @param session     Agent 会话
     * @param answersJson 用户答案 JSON（格式：{"answers":[{"index":0,"text":"...","skipped":false,"custom":false}]}）
     */
    public static void submit(AgentSession session, String answersJson) {
        AskUserTask task = getPendingTask(session);
        submit(session, answersJson, (task == null) ? null : task.getActionId());
    }

    /**
     * 提交用户答案并记录归属
     *
     * <p>归属标识即产生该答案的那次提问的 {@code actionId}（同源于工具调用 id）。
     * 恢复回放时消费的是同一个工具调用，故标识可原样比对；为 null 时（旧快照无该字段）
     * 不写归属键，消费方按兼容口径放行。</p>
     *
     * @param actionId 产生该答案的提问的调用标识，可为 null
     */
    public static void submit(AgentSession session, String answersJson, String actionId) {
        String toolName = toolNameOf(getPendingTask(session));

        session.getContext().put(ANSWER_PREFIX + toolName, answersJson);

        if (Assert.isNotEmpty(actionId)) {
            session.getContext().put(ANSWER_OWNER_PREFIX + toolName, actionId);
        } else {
            // 归属未知：显式清掉上一次的归属，避免旧标识张冠李戴到这份新答案上
            session.getContext().remove(ANSWER_OWNER_PREFIX + toolName);
        }
    }

    /**
     * 读取指定工具的答案
     *
     * @return 答案 JSON 字符串；未提交过则返回 null
     */
    public static String getAnswer(AgentSession session, String toolName) {
        return session.getContext().getAs(ANSWER_PREFIX + toolName);
    }

    /**
     * 判定已提交的答案是否归属于指定的那次调用
     *
     * <p><b>两个向后兼容的放行口</b>（宁可保守，也不能让用户白答一次）：归属键缺失
     * （旧快照/旧版本提交的答案）、或本次调用没有标识时，一律放行按旧行为处理。
     * 仅在<b>两边都有标识且不相等</b>时判定为不归属。</p>
     *
     * @param actionId 本次工具调用的标识
     */
    public static boolean ownsAnswer(AgentSession session, String toolName, String actionId) {
        String owner = session.getContext().getAs(ANSWER_OWNER_PREFIX + toolName);
        if (Assert.isEmpty(owner) || Assert.isEmpty(actionId)) {
            return true;
        }
        return owner.equals(actionId);
    }

    /**
     * 清理指定工具的答案与其归属标识（幂等）
     */
    public static void clear(AgentSession session, String toolName) {
        session.getContext().remove(ANSWER_PREFIX + toolName);
        session.getContext().remove(ANSWER_OWNER_PREFIX + toolName);
    }

    /**
     * 丢弃当前挂起的提问现场（幂等）
     *
     * <p>用于「这次提问已经不可能再被恢复」的场景：清理挂起任务实体、答案与归属标识，
     * 使会话回到干净状态。返回被清掉的任务实体，供调用方取 {@code actionId} 通知前端收卡——
     * 不通知的话，那张卡会永远停在等待作答态。</p>
     *
     * @return 被清理掉的挂起任务；本就没有挂起任务时返回 null
     */
    public static AskUserTask discardPending(AgentSession session) {
        if (session == null) {
            return null;
        }

        AskUserTask task = getPendingTask(session);
        session.getContext().remove(TASK_KEY);
        clear(session, toolNameOf(task));
        return task;
    }

    /**
     * 取任务的工具名，缺失时回退到默认工具名
     *
     * <p>{@code toolName} 随会话快照持久化，旧快照或异常写入都可能取不到值。而它同时是
     * 答案存储键的组成部分与下发前端的帧字段：前者取空会让清理打在错误的键上（残留答案变幽灵），
     * 后者取空会让落盘的历史帧缺字段。故读取一律经由本方法兜底，不在调用处各写一份。</p>
     *
     * @param task 挂起任务，可为 null
     * @return 任务的工具名；缺失时为 {@link AskUserTool#TOOL_NAME}
     */
    public static String toolNameOf(AskUserTask task) {
        return (task != null && Assert.isNotEmpty(task.getToolName()))
                ? task.getToolName()
                : AskUserTool.TOOL_NAME;
    }

    /**
     * 判定这份答案里是否存在「用户真的给出了内容」的条目（非跳过且文本非空）
     *
     * <p>用于区分「用户确实回答了」与「用户只是想把卡片关掉」：后者不应再为它发起
     * 一轮模型调用（既浪费 token，也不符合用户放弃作答的意图）。坏 JSON 一律视为无内容。</p>
     */
    public static boolean hasMeaningfulAnswer(String answersJson) {
        ONode arrayNode = parseAnswersArray(answersJson);
        if (arrayNode == null) {
            return false;
        }

        for (ONode item : arrayNode.getArray()) {
            if (item == null || !item.isObject()) {
                continue;
            }

            ONode skippedNode = valueOf(item, "skipped");
            if (skippedNode != null && Boolean.TRUE.equals(skippedNode.getBoolean(false))) {
                continue;
            }

            ONode textNode = valueOf(item, "text");
            if (textNode != null && Assert.isNotEmpty(textNode.getString())) {
                return true;
            }
        }

        return false;
    }

    /**
     * 容错解析答案 JSON 中的 answers 数组
     *
     * <p>坏 JSON、结构不符（根非对象/answers 非数组）一律返回空列表，调用方无需自行捕获异常。</p>
     *
     * @param answersJson 答案 JSON 字符串
     * @return 答案项列表（每项为 Map）；无法解析时为空列表
     */
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> parseAnswers(String answersJson) {
        ONode arrayNode = parseAnswersArray(answersJson);
        if (arrayNode == null) {
            return Collections.emptyList();
        }

        List<Map<String, Object>> answers = new ArrayList<>();
        for (ONode item : arrayNode.getArray()) {
            if (item != null && item.isObject()) {
                answers.add(item.toBean(Map.class));
            }
        }
        return answers;
    }

    /**
     * 格式化答案文本（供模型阅读）
     *
     * <p>按 questions 顺序逐题输出：题号、问题文本（含补充说明）与用户回答；
     * 跳过的题输出「（用户跳过）」，自定义回答输出「（用户自定义回答）」前缀，
     * index 越界的回答项直接忽略（不参与渲染）。
     * 坏 JSON 或结构不符时原文透传，保证模型至少能看到原始内容而不丢信息。</p>
     *
     * <p><b>题面缺失时不丢答案</b>：questions 为空（旧快照丢失且本次调用参数也没带 questions）时，
     * 按 answers 自身顺序裸列回答——宁可模型看不到题目，也不能让用户白答一次。</p>
     *
     * @param questions   问题清单（可为 null/空，此时按 answers 顺序裸列回答）
     * @param answersJson 用户答案 JSON 字符串
     * @return 供模型阅读的格式化文本
     */
    public static String formatAnswerText(List<Map<String, Object>> questions, String answersJson) {
        if (Assert.isEmpty(answersJson)) {
            return answersJson;
        }

        ONode arrayNode = parseAnswersArray(answersJson);
        if (arrayNode == null) {
            return answersJson; // 坏 JSON/结构不符 → 原文透传
        }

        // index（0-based）→ 答案节点；越界索引只入表不出渲染，天然被忽略
        Map<Integer, ONode> answerByIndex = new HashMap<>();
        for (ONode item : arrayNode.getArray()) {
            if (item == null || !item.isObject()) {
                continue;
            }

            ONode indexNode = valueOf(item, "index");
            if (indexNode == null) {
                continue;
            }

            Integer index = indexNode.getInt(-1);
            if (index != null && index >= 0) {
                answerByIndex.put(index, item);
            }
        }

        StringBuilder sb = new StringBuilder();
        sb.append("用户对提问的回答如下：\n");

        if (Assert.isEmpty(questions)) {
            // 题面丢失：退化为裸列答案，避免只回一个空标题让用户的回答凭空消失
            return appendAnswersOnly(sb, arrayNode);
        }

        int seq = 1;
        for (int i = 0; i < questions.size(); i++) {
            Map<String, Object> question = questions.get(i);
            if (question == null) {
                continue;
            }

            String header = asString(question.get("header"));
            String detail = asString(question.get("detail"));

            sb.append(seq++).append(". ").append(header);
            if (Assert.isNotEmpty(detail)) {
                sb.append("（").append(detail).append("）");
            }
            sb.append("\n");

            ONode answer = answerByIndex.get(i);
            if (answer == null) {
                sb.append("   → （用户跳过）\n");
                continue;
            }

            ONode skippedNode = valueOf(answer, "skipped");
            if (skippedNode != null && Boolean.TRUE.equals(skippedNode.getBoolean(false))) {
                sb.append("   → （用户跳过）\n");
                continue;
            }

            ONode textNode = valueOf(answer, "text");
            String text = (textNode == null) ? null : textNode.getString();

            if (Assert.isEmpty(text)) {
                // 未标记 skipped 但内容为空：等同于用户未给出有效回答，按跳过呈现
                sb.append("   → （用户跳过）\n");
            } else if (customAnswer(answer)) {
                // 自定义输入未点选候选项：加标记让模型知道用户否决了所有选项、给出的是自己的想法
                sb.append("   → （用户自定义回答）").append(text).append("\n");
            } else {
                sb.append("   → ").append(text).append("\n");
            }
        }

        return sb.toString();
    }

    /**
     * 题面缺失时的降级渲染：按 answers 自身顺序裸列用户回答。
     */
    private static String appendAnswersOnly(StringBuilder sb, ONode arrayNode) {
        int seq = 1;
        for (ONode item : arrayNode.getArray()) {
            if (item == null || !item.isObject()) {
                continue;
            }

            ONode skippedNode = valueOf(item, "skipped");
            boolean skipped = skippedNode != null && Boolean.TRUE.equals(skippedNode.getBoolean(false));

            ONode textNode = valueOf(item, "text");
            String text = (textNode == null) ? null : textNode.getString();

            sb.append(seq++).append(". ");
            if (skipped || Assert.isEmpty(text)) {
                sb.append("（用户跳过）");
            } else {
                if (customAnswer(item)) {
                    sb.append("（用户自定义回答）");
                }
                sb.append(text);
            }
            sb.append("\n");
        }
        return sb.toString();
    }

    /**
     * 提取并校验答案 JSON 中的 answers 数组；无法解析时返回 null。
     */
    private static ONode parseAnswersArray(String answersJson) {
        if (Assert.isEmpty(answersJson)) {
            return null;
        }

        try {
            ONode root = ONode.ofJson(answersJson);
            if (root == null || !root.isObject()) {
                return null;
            }

            ONode arrayNode = root.get("answers");
            if (arrayNode == null || !arrayNode.isArray()) {
                return null;
            }

            return arrayNode;
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * 读取对象的指定键；缺失或为 null 时返回 null。
     */
    private static ONode valueOf(ONode node, String key) {
        if (node == null) {
            return null;
        }

        ONode value = node.get(key);
        return (value == null || value.isNull()) ? null : value;
    }

    private static String asString(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /**
     * 判定答案项是否为用户自定义输入（未点选候选项，直接手写回答）。
     * 缺失或非真值一律视为点选/旧版答案，不加标记。
     */
    private static boolean customAnswer(ONode answer) {
        ONode customNode = valueOf(answer, "custom");
        return customNode != null && Boolean.TRUE.equals(customNode.getBoolean(false));
    }
}
