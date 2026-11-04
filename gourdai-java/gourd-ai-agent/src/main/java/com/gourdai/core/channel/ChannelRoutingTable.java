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

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import com.gourdai.core.config.AgentFlags;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * IM 通道路由表 —— 管理每个通道当前活跃的会话。
 *
 * <p>维护 channelName -> {@link ChannelRoute}（活跃会话 + 项目根）的映射关系，
 * 支持持久化到本地文件，重启后自动恢复路由状态。</p>
 *
 * <p><b>为什么要记 projectRoot：</b>项目会话（统一 {@code work-} 前缀，有所属根）落盘在
 * <b>所选项目目录</b> {@code <projectRoot>/.gwork/sessions/} 下，且 AI 工具需要以该目录为
 * 工作根。IM 消息流入时并不带请求头，只能靠路由表把 projectRoot 一并存下来，
 * 才能在重启后仍正确定位项目会话的落盘目录与工具 cwd。全局会话该字段为空。</p>
 *
 * @author oisin
 */
public class ChannelRoutingTable {
    private static final Logger LOG = LoggerFactory.getLogger(ChannelRoutingTable.class);

    private static final String STORE_FILE = "routing-state.json";

    /**
     * channelName -> ChannelRoute（活跃会话 + 项目根）
     */
    private final Map<String, ChannelRoute> routingMap = new ConcurrentHashMap<>();

    /**
     * channelName -> ChannelState (状态机)
     */
    private final Map<String, ChannelState> stateMap = new ConcurrentHashMap<>();

    private final Path storePath;

    public ChannelRoutingTable() {
        this.storePath = Paths.get(AgentFlags.getUserDir(),
                AgentFlags.getHarnessChannels(),
                STORE_FILE).toAbsolutePath();
    }

    /**
     * 获取通道当前活跃的会话 ID
     */
    public String getActiveSession(String channelName) {
        ChannelRoute route = routingMap.get(channelName);
        return route != null ? route.sessionId : null;
    }

    /**
     * 获取通道当前活跃会话的项目根（chat 会话或未登记时返回 null）
     */
    public String getActiveProjectRoot(String channelName) {
        ChannelRoute route = routingMap.get(channelName);
        return route != null ? route.projectRoot : null;
    }

    /**
     * 获取通道当前活跃路由（会话 + 项目根），未绑定时返回 null
     */
    public ChannelRoute getActiveRoute(String channelName) {
        return routingMap.get(channelName);
    }

    /**
     * 设置通道的活跃会话（chat 会话或不关心项目根时使用）
     */
    public void setActiveSession(String channelName, String sessionId) {
        setActiveSession(channelName, sessionId, null);
    }

    /**
     * 设置通道的活跃会话及其项目根（code 会话应传入 projectRoot）
     */
    public void setActiveSession(String channelName, String sessionId, String projectRoot) {
        routingMap.put(channelName, new ChannelRoute(sessionId, projectRoot));
        stateMap.put(channelName, ChannelState.ACTIVE);
        save();
        LOG.info("[Routing] Channel '{}' now routes to session '{}' (root={})", channelName, sessionId, projectRoot);
    }

    /**
     * 获取通道的当前状态
     */
    public ChannelState getState(String channelName) {
        return stateMap.getOrDefault(channelName, ChannelState.IDLE);
    }

    /**
     * 设置通道状态
     */
    public void setState(String channelName, ChannelState state) {
        stateMap.put(channelName, state);
    }

    /**
     * 清除通道路由（断开通道时调用）
     */
    public void removeChannel(String channelName) {
        routingMap.remove(channelName);
        stateMap.remove(channelName);
        save();
    }

    /**
     * 判断指定 sessionId 是否为某通道的当前活跃会话
     */
    public boolean isActiveSession(String channelName, String sessionId) {
        ChannelRoute route = routingMap.get(channelName);
        return route != null && route.sessionId != null && route.sessionId.equals(sessionId);
    }

    /**
     * 获取所有路由映射（供状态查询接口使用）
     */
    public Map<String, ChannelRoute> getAllRouting() {
        return new ConcurrentHashMap<>(routingMap);
    }

    /**
     * 从文件加载路由状态
     */
    public void load() {
        File file = storePath.toFile();
        if (!file.exists()) {
            LOG.debug("[Routing] No routing state file found at {}", storePath);
            return;
        }

        try {
            String content = new String(Files.readAllBytes(storePath), StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(content);

            if (root.isObject()) {
                for (Map.Entry<String, ONode> entry : root.getObject().entrySet()) {
                    String channelName = entry.getKey();
                    ONode node = entry.getValue();
                    String activeSessionId = node.get("activeSessionId").getString();
                    String projectRoot = node.get("projectRoot").getString();
                    if (activeSessionId != null && !activeSessionId.isEmpty()) {
                        routingMap.put(channelName, new ChannelRoute(activeSessionId,
                                (projectRoot != null && !projectRoot.isEmpty()) ? projectRoot : null));
                        stateMap.put(channelName, ChannelState.ACTIVE);
                    }
                }
            }

            LOG.info("[Routing] Loaded routing state: {}", routingMap);
        } catch (Exception e) {
            LOG.warn("[Routing] Failed to load routing state from {}: {}", storePath, e.getMessage());
        }
    }

    /**
     * 持久化路由状态到文件
     */
    public void save() {
        try {
            Files.createDirectories(storePath.getParent());

            if (routingMap.isEmpty()) {
                File file = storePath.toFile();
                if (file.exists()) {
                    file.delete();
                }
                return;
            }

            ONode root = new ONode(Options.of(Feature.Write_PrettyFormat));
            for (Map.Entry<String, ChannelRoute> entry : routingMap.entrySet()) {
                ChannelRoute route = entry.getValue();
                ONode node = new ONode();
                node.set("activeSessionId", route.sessionId);
                if (route.projectRoot != null && !route.projectRoot.isEmpty()) {
                    node.set("projectRoot", route.projectRoot);
                }
                root.set(entry.getKey(), node);
            }

            // 先写临时文件，再原子替换，避免写入中途崩溃导致文件损坏
            Path tmpPath = storePath.resolveSibling(STORE_FILE + ".tmp");
            Files.write(tmpPath, root.toJson().getBytes(StandardCharsets.UTF_8));
            Files.move(tmpPath, storePath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            LOG.debug("[Routing] Saved routing state to {}", storePath);
        } catch (IOException e) {
            LOG.error("[Routing] Failed to save routing state to {}: {}", storePath, e.getMessage());
        }
    }

    /**
     * 单条通道路由：活跃会话 + 其项目根（code 会话）。
     */
    public static class ChannelRoute {
        /** 活跃会话 ID */
        public final String sessionId;
        /** 项目根绝对路径；chat 会话为 null */
        public final String projectRoot;

        public ChannelRoute(String sessionId, String projectRoot) {
            this.sessionId = sessionId;
            this.projectRoot = projectRoot;
        }

        @Override
        public String toString() {
            return projectRoot == null ? sessionId : (sessionId + "@" + projectRoot);
        }
    }
}
