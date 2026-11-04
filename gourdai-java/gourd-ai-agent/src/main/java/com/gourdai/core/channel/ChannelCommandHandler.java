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

import com.gourdai.harness.HarnessEngine;
import com.gourdai.core.portal.web.ProjectService;
import com.gourdai.core.portal.web.SessionLocator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * IM 通道命令处理器 —— 处理来自 IM 的会话选择与切换逻辑。
 *
 * <p>基于状态机模式处理 IM 消息：
 * <ul>
 *   <li>IDLE 状态：收到任意消息时展示会话列表，进入 AWAITING_SELECTION</li>
 *   <li>AWAITING_SELECTION 状态：收到数字回复时完成选择，进入 ACTIVE</li>
 *   <li>ACTIVE 状态：检测 /switch 等命令，非命令消息返回 false 表示应转发给 AI</li>
 * </ul>
 * </p>
 *
 * @author oisin
 */
public class ChannelCommandHandler {
    private static final Logger LOG = LoggerFactory.getLogger(ChannelCommandHandler.class);

    private final ChannelRoutingTable routingTable;
    private final HarnessEngine engine;
    private final SessionLocator sessionLocator;
    private final ProjectService projectService;

    /**
     * 缓存已展示给用户的会话列表（channelName -> 有序列表）
     * 用于通过编号匹配用户选择
     */
    private final Map<String, List<SessionInfo>> pendingSelections = new ConcurrentHashMap<>();

    public ChannelCommandHandler(ChannelRoutingTable routingTable, HarnessEngine engine,
                                 SessionLocator sessionLocator, ProjectService projectService) {
        this.routingTable = routingTable;
        this.engine = engine;
        this.sessionLocator = sessionLocator;
        this.projectService = projectService;
    }

    /**
     * 处理 IM 收到的消息，返回 true 表示消息已被命令处理器消费（不需要转发给 AI）。
     *
     * @param channelName  通道名称（wechat/feishu/dingtalk）
     * @param text         用户发送的文本消息
     * @param replyCallback 回复回调，用于向 IM 用户发送消息
     * @return true 表示消息已处理（命令或选择），false 表示应转发给 AI
     */
    public boolean handleMessage(String channelName, String text, ReplyCallback replyCallback) {
        if (text == null || text.isEmpty()) {
            return false;
        }

        String trimmed = text.trim();
        ChannelState state = routingTable.getState(channelName);

        // 无论什么状态，命令优先处理
        if (trimmed.equals("/switch") || trimmed.equals("/切换")) {
            return handleSwitchCommand(channelName, replyCallback);
        }
        if (trimmed.equals("/new") || trimmed.equals("/新建")) {
            return handleNewCommand(channelName, replyCallback);
        }
        if (trimmed.equals("/help") || trimmed.equals("/帮助")) {
            return handleHelpCommand(replyCallback);
        }

        switch (state) {
            case IDLE:
                // 未绑定会话，展示列表让用户选择
                return handleIdleState(channelName, trimmed, replyCallback);

            case AWAITING_SELECTION:
                // 等待用户回复数字
                return handleAwaitingSelection(channelName, trimmed, replyCallback);

            case ACTIVE:
                // 已绑定会话，检查是否有其他命令
                return false; // 非命令消息，转发给 AI

            default:
                return false;
        }
    }

    /**
     * IDLE 状态：智能处理
     * - 无会话时自动创建，直接转发消息给 AI
     * - 仅一个会话时自动绑定，直接转发
     * - 多个会话时展示列表
     */
    private boolean handleIdleState(String channelName, String text, ReplyCallback replyCallback) {
        List<SessionInfo> sessions = listSessions();
        if (sessions.isEmpty()) {
            // 无已有会话，自动创建新会话并转发消息（IM 自动新建的是全局会话，无所属根）
            String newSessionId = SessionLocator.PREFIX_WORK + Long.toString(System.currentTimeMillis(), 36);
            routingTable.setActiveSession(channelName, newSessionId); // 内部已设状态为 ACTIVE
            return false; // 返回 false 让消息转发给 AI
        }

        if (sessions.size() == 1) {
            // 仅一个会话，自动绑定
            SessionInfo only = sessions.get(0);
            routingTable.setActiveSession(channelName, only.sessionId, only.projectRoot); // 内部已设状态为 ACTIVE
            return false; // 返回 false 让消息转发给 AI
        }

        // 多个会话，展示列表让用户选择
        showSessionList(channelName, sessions, null, replyCallback);
        routingTable.setState(channelName, ChannelState.AWAITING_SELECTION);
        return true;
    }

    /**
     * AWAITING_SELECTION 状态：处理用户数字选择
     */
    private boolean handleAwaitingSelection(String channelName, String text, ReplyCallback replyCallback) {
        List<SessionInfo> sessions = pendingSelections.get(channelName);
        if (sessions == null || sessions.isEmpty()) {
            // 列表丢失，重新展示
            sessions = listSessions();
            if (sessions.isEmpty()) {
                replyCallback.reply("当前没有任何对话会话。");
                routingTable.setState(channelName, ChannelState.IDLE);
                return true;
            }
            showSessionList(channelName, sessions, null, replyCallback);
            return true;
        }

        // 尝试解析数字
        try {
            int num = Integer.parseInt(text.trim());
            if (num == 0) {
                // 新建对话
                return handleNewCommand(channelName, replyCallback);
            }
            if (num < 1 || num > sessions.size()) {
                replyCallback.reply("请输入有效的编号 (0-" + sessions.size() + ")，0 为新建对话");
                return true;
            }

            SessionInfo selected = sessions.get(num - 1);
            routingTable.setActiveSession(channelName, selected.sessionId, selected.projectRoot);
            pendingSelections.remove(channelName);
            replyCallback.reply("已切换到对话: " + selected.label + "\n现在可以直接发消息了。");
            return true;
        } catch (NumberFormatException e) {
            // 非数字，提示重新选择
            replyCallback.reply("请回复数字编号来选择对话，或发送 /help 查看帮助。");
            return true;
        }
    }

    /**
     * /switch 命令：展示会话列表供切换
     */
    private boolean handleSwitchCommand(String channelName, ReplyCallback replyCallback) {
        List<SessionInfo> sessions = listSessions();
        if (sessions.isEmpty()) {
            replyCallback.reply("当前没有任何对话会话。");
            return true;
        }

        String currentSessionId = routingTable.getActiveSession(channelName);
        showSessionList(channelName, sessions, currentSessionId, replyCallback);
        routingTable.setState(channelName, ChannelState.AWAITING_SELECTION);
        return true;
    }

    /**
     * /new 命令：创建新对话并激活
     */
    private boolean handleNewCommand(String channelName, ReplyCallback replyCallback) {
        String newSessionId = SessionLocator.PREFIX_WORK + Long.toString(System.currentTimeMillis(), 36);
        routingTable.setActiveSession(channelName, newSessionId);
        pendingSelections.remove(channelName);
        replyCallback.reply("已创建新对话，现在可以直接发消息了。");
        return true;
    }

    /**
     * /help 命令
     */
    private boolean handleHelpCommand(ReplyCallback replyCallback) {
        replyCallback.reply(
                "可用命令:\n" +
                "  /new 或 /新建 - 创建新对话\n" +
                "  /switch 或 /切换 - 切换到其他对话\n" +
                "  /help 或 /帮助 - 显示此帮助\n\n" +
                "直接发送消息即可与当前对话的 AI 交流。"
        );
        return true;
    }

    /**
     * 展示会话列表
     */
    private void showSessionList(String channelName, List<SessionInfo> sessions,
                                  String currentSessionId, ReplyCallback replyCallback) {
        pendingSelections.put(channelName, sessions);

        StringBuilder sb = new StringBuilder();
        sb.append("请选择对话（回复数字）:\n");
        sb.append("0. [新建对话]\n");
        for (int i = 0; i < sessions.size(); i++) {
            SessionInfo s = sessions.get(i);
            String marker = (s.sessionId.equals(currentSessionId)) ? " [当前]" : "";
            sb.append(i + 1).append(". ").append(s.label).append(marker).append("\n");
        }
        replyCallback.reply(sb.toString().trim());
    }

    /**
     * 从文件系统读取会话列表：全局会话（安装目录，无所属根）+ 各已登记项目下的项目会话。
     *
     * <p>全局会话 projectRoot=null；项目会话带上其项目根，供路由/流入时定位落盘目录与工具 cwd。</p>
     */
    public List<SessionInfo> listSessions() {
        List<SessionInfo> result = new ArrayList<>();

        // 1) 全局会话（安装目录，固定不变）
        collectFrom(sessionLocator.globalSessionsRoot(), SessionLocator.PREFIX_WORK, null, null, result);

        // 2) 各已登记项目下的项目会话
        if (projectService != null) {
            List<Map> projects = projectService.list().getData();
            if (projects != null) {
                for (Map p : projects) {
                    String root = String.valueOf(p.get("path"));
                    if (root == null || root.isEmpty() || "null".equals(root)) continue;
                    Object nmObj = p.get("name");
                    String projectName = nmObj != null ? String.valueOf(nmObj) : new File(root).getName();
                    collectFrom(sessionLocator.sessionsRoot(root), SessionLocator.PREFIX_WORK,
                            root, projectName, result);
                }
            }
        }

        return result;
    }

    /**
     * 扫描单个会话根目录下匹配前缀的会话，追加到结果。
     *
     * @param sessionsDir 会话根目录（如 &lt;root&gt;/.gwork/sessions）
     * @param prefix      会话 ID 前缀（统一 work-）
     * @param projectRoot 项目根（全局会话传 null）
     * @param projectName 项目展示名（用于项目会话标签前缀区分，全局会话传 null）
     * @param result      结果收集列表
     */
    private void collectFrom(File sessionsDir, String prefix, String projectRoot,
                             String projectName, List<SessionInfo> result) {
        if (sessionsDir == null || !sessionsDir.exists() || !sessionsDir.isDirectory()) {
            return;
        }

        File[] dirs = sessionsDir.listFiles(f -> f.isDirectory() && f.getName().startsWith(prefix));
        if (dirs == null) {
            return;
        }

        // 按修改时间倒序
        Arrays.sort(dirs, Comparator.comparingLong(File::lastModified).reversed());

        for (File dir : dirs) {
            String sid = dir.getName();
            File msgFile = new File(dir, sid + ".messages.ndjson");
            if (!msgFile.exists()) continue;

            // 读取标签
            String label = null;
            File labelFile = new File(dir, "label.txt");
            if (labelFile.exists()) {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(new FileInputStream(labelFile), "UTF-8"))) {
                    label = reader.readLine();
                } catch (Exception ignored) {}
            }
            if (label == null || label.isEmpty()) {
                label = extractFirstUserMessage(msgFile);
            }
            if (label == null || label.isEmpty()) continue;

            // 截断过长标签
            if (label.length() > 30) {
                label = label.substring(0, 30) + "...";
            }

            // code 会话加项目名前缀，便于在 IM/配置面板中区分不同项目
            if (projectName != null && !projectName.isEmpty()) {
                label = "[" + projectName + "] " + label;
            }

            result.add(new SessionInfo(sid, label, projectRoot));
        }
    }

    /**
     * 从 ndjson 文件中提取第一条用户消息作为标签
     */
    private String extractFirstUserMessage(File msgFile) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(new FileInputStream(msgFile), "UTF-8"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.contains("\"USER\"")) {
                    // 简单提取 content 字段
                    int contentIdx = line.indexOf("\"content\":\"");
                    if (contentIdx > 0) {
                        int start = contentIdx + 11;
                        int end = line.indexOf("\"", start);
                        if (end > start) {
                            return line.substring(start, Math.min(end, start + 50));
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * 会话信息
     */
    public static class SessionInfo {
        public final String sessionId;
        public final String label;
        /** 项目根绝对路径；chat 会话为 null */
        public final String projectRoot;

        public SessionInfo(String sessionId, String label) {
            this(sessionId, label, null);
        }

        public SessionInfo(String sessionId, String label, String projectRoot) {
            this.sessionId = sessionId;
            this.label = label;
            this.projectRoot = projectRoot;
        }
    }

    /**
     * 回复回调接口
     */
    @FunctionalInterface
    public interface ReplyCallback {
        void reply(String text);
    }
}
