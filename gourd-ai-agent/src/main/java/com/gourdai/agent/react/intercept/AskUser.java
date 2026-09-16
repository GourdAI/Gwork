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
        String toolName = (task != null && Assert.isNotEmpty(task.getToolName()))
                ? task.getToolName()
                : AskUserTool.TOOL_NAME;

        session.getContext().put(ANSWER_PREFIX + toolName, answersJson);
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
     * 清理指定工具的答案（幂等）
     */
    public static void clear(AgentSession session, String toolName) {
        session.getContext().remove(ANSWER_PREFIX + toolName);
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
     * 跳过的题输出「（用户跳过）」，index 越界的回答项直接忽略（不参与渲染）。
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
}
