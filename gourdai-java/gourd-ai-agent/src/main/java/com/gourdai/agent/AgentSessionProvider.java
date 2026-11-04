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
package com.gourdai.agent;

import org.noear.solon.lang.NonNull;
import org.noear.solon.lang.Preview;

/**
 * Agent 会话提供者（Session 工厂/加载器）
 *
 * <p>核心职责：基于业务实例标识维护和检索 Agent 运行状态。</p>
 *
 * @author oisin
 * @since 3.8.1
 */
@Preview("3.8.1")
@FunctionalInterface
public interface AgentSessionProvider {
    /**
     * 获取指定实例的会话
     *
     * <p>逻辑约定：</p>
     * <ul>
     * <li>若会话已存在，则返回现有实例（保持上下文连续）。</li>
     * <li>若不存在，则按需创建（Lazy loading）并初始化新会话。</li>
     * </ul>
     *
     * @param instanceId instanceId 会话实例标识
     * @return 关联的 AgentSession 实例（不应返回 null）
     */
    @NonNull
    AgentSession getSession(String instanceId);

    /**
     * 移除（驱逐）指定实例的会话
     *
     * <p>用于会话被删除时，从内部缓存中清理其运行状态，避免残留实例在后续
     * 持久化（如 addMessage/updateSnapshot）时重建已删除的落盘文件。</p>
     *
     * <p>默认实现为空操作（无缓存的提供者无需处理）。</p>
     *
     * @param instanceId 会话实例标识
     */
    default void removeSession(String instanceId) {
        //默认无操作
    }
}