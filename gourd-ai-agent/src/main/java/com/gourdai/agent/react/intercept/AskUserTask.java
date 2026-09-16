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

import org.noear.solon.lang.Preview;

import java.io.Serializable;
import java.util.List;
import java.util.Map;

/**
 * ask_user 结构化问答挂起任务实体
 *
 * <p>承载发起提问瞬间的问题清单快照，随会话快照持久化；供 UI 层渲染问答卡、
 * 并在用户回答后作为恢复执行时回填答案文本的输入。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class AskUserTask implements Serializable {
    /** 发起提问的工具名称（目前恒为 ask_user；答案存储键按其拼接，保留字段以对齐协议） */
    private String toolName;
    /** 结构化问题清单快照（提问瞬间的原始 questions 参数） */
    private List<Map<String, Object>> questions;
    /**
     * 触发挂起的那一次工具调用标识（同源于 ActionTask 的 actionId）。
     *
     * <p>用于识别「同一轮提问」：UI 层据此对重复下发的 question 帧做幂等处理（保留已作答进度），
     * 而不同 actionId 视为新一轮提问。（ask_user 不建工具卡，故不涉及骨架卡配对。）</p>
     *
     * <p><b>可能为 null</b>：会话快照以 JSON 持久化，本字段新增前落盘的挂起任务恢复后取不到值，
     * 消费方必须保留「从本次工具调用参数回退 questions」的降级路径。</p>
     */
    private String actionId;
    /** 挂起创建时刻（epoch 毫秒） */
    private long createdAt;

    public AskUserTask() {
        //用于反序列化
    }

    public AskUserTask(String toolName, List<Map<String, Object>> questions, String actionId) {
        this(toolName, questions, actionId, System.currentTimeMillis());
    }

    public AskUserTask(String toolName, List<Map<String, Object>> questions, String actionId, long createdAt) {
        this.toolName = toolName;
        this.questions = questions;
        this.actionId = actionId;
        this.createdAt = createdAt;
    }

    /**
     * 获取发起提问的工具名
     */
    public String getToolName() {
        return toolName;
    }

    /**
     * 获取结构化问题清单快照
     */
    public List<Map<String, Object>> getQuestions() {
        return questions;
    }

    /**
     * 获取触发挂起的调用标识；旧快照恢复时为 {@code null}
     */
    public String getActionId() {
        return actionId;
    }

    /**
     * 获取挂起创建时刻（epoch 毫秒）
     */
    public long getCreatedAt() {
        return createdAt;
    }

    @Override
    public String toString() {
        return "AskUserTask{" +
                "toolName='" + toolName + '\'' +
                ", questions=" + questions +
                ", actionId='" + actionId + '\'' +
                ", createdAt=" + createdAt +
                '}';
    }
}
