/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.core.channel;

/**
 * IM 通道状态枚举
 *
 * <p>描述通道在会话路由中的当前阶段：</p>
 * <ul>
 *   <li>IDLE —— 未绑定任何会话，下次收到消息时展示会话列表</li>
 *   <li>AWAITING_SELECTION —— 已展示会话列表，等待用户回复数字编号选择</li>
 *   <li>ACTIVE —— 已绑定活跃会话，消息正常转发给 AI</li>
 * </ul>
 *
 * @author oisin
 */
public enum ChannelState {
    /**
     * 未绑定会话，等待用户选择
     */
    IDLE,

    /**
     * 已展示会话列表，等待用户回复编号
     */
    AWAITING_SELECTION,

    /**
     * 已绑定活跃会话，正常转发消息
     */
    ACTIVE
}
