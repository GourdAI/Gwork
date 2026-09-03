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
package com.gourdai.core.portal.web;

import com.gourdai.agent.AgentSessionProvider;
import com.gourdai.core.config.AgentFlags;
import org.noear.snack4.ONode;

import java.io.File;
import java.nio.file.Paths;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话目录定位器 —— 统一解析 {@code sessionId → 会话存储目录} 的唯一入口。
 *
 * <p>所有会话统一 {@code work-} 前缀，不再区分 chat / code / acp 等模式，
 * 会话归属只看<b>有无所属根</b>：</p>
 * <ul>
 *   <li><b>项目会话</b>（有所属根）：存到 {@code <root>/.gwork/sessions/work-xxx}，
 *       随所选工作空间/项目走。</li>
 *   <li><b>全局会话</b>（无所属根）：存到 {@code <globalBase>/.gwork/sessions/work-xxx}，
 *       即全局对话区。</li>
 * </ul>
 *
 * <h3>会话所属根注册</h3>
 * <p>{@link AgentSessionProvider} 及各类无根提示的异步路径（Loop 执行、IM、流式旁路记录等）
 * 仅能拿到 {@code sessionId}，无法感知所属工作空间。因此 Web 层在处理聊天输入前，先调用
 * {@link #bindSessionRoot(String, String)} 把 {@code sessionId → workspaceRoot} 登记到注册表
 * （内存 + 持久化 {@code session-roots.json}，进程重启后可恢复），
 * 之后 {@link #resolveDir(String, String)} 即可正确解析。</p>
 *
 * @author oisin
 * @see WebController
 * @see FileService
 */
public class SessionLocator {
    /** 统一会话 ID 前缀（chat / code / acp 等历史前缀已废弃，不做兼容） */
    public static final String PREFIX_WORK = "work-";

    /** 项目工作区根，用于项目会话；不承担全局数据存储语义。 */
    private final String workspace;
    /** 全局基准目录，用于全局会话及 session-roots.json。 */
    private final String globalBase;
    /** 马具会话相对存放区，如 ".gwork/sessions/" */
    private final String harnessSessions;

    /** sessionId → 所属工作空间根 的内存登记表（进程内有效，session-roots.json 持久化） */
    private final Map<String, String> boundRoots = new ConcurrentHashMap<>();

    /** 兼容旧调用：workspace 同时作为全局基准目录。 */
    public SessionLocator(String workspace, String harnessSessions) {
        this(workspace, workspace, harnessSessions);
    }

    /**
     * @param workspace 项目工作区根
     * @param globalBase 全局会话、登记表的基准目录
     * @param harnessSessions 会话相对存放区
     */
    public SessionLocator(String workspace, String globalBase, String harnessSessions) {
        this.workspace = workspace;
        this.globalBase = globalBase;
        this.harnessSessions = harnessSessions;
        loadBoundRoots();
    }

    /**
     * 登记会话所属的工作空间根目录（登记后即为项目会话，未登记则落全局区）。
     * <p>在处理该会话的聊天输入之前调用，供后续 {@code AgentSessionProvider}
     * 及无根提示的异步路径（Loop 执行、IM、流式旁路记录等）解析落盘目录；
     * 登记持久化到 {@code session-roots.json}，进程重启不丢失。</p>
     *
     * @param sessionId     会话 ID
     * @param workspaceRoot 所属工作空间根绝对路径；为空则忽略（回退到全局基准目录）
     */
    public void bindSessionRoot(String sessionId, String workspaceRoot) {
        if (sessionId == null || workspaceRoot == null || workspaceRoot.trim().isEmpty()) {
            return;
        }
        String root = workspaceRoot.trim();
        String prev = boundRoots.put(sessionId, root);
        if (prev == null || !prev.equals(root)) {
            saveBoundRoots();
        }
    }

    /**
     * 查询会话已登记的所属工作空间根（未登记返回 null）。
     * 供异步路径（如 Loop 任务执行器）取得会话所属工作空间并透传。
     */
    public String boundRoot(String sessionId) {
        return sessionId == null ? null : boundRoots.get(sessionId);
    }

    /**
     * 全部已登记的工作空间根（去重）。供 IM 通道等项目会话扫描。
     */
    public java.util.Set<String> registeredRoots() {
        return new java.util.LinkedHashSet<>(boundRoots.values());
    }

    /**
     * 会话删除时清除登记，避免注册表残留。
     */
    public void unbind(String sessionId) {
        if (sessionId != null && boundRoots.remove(sessionId) != null) {
            saveBoundRoots();
        }
    }

    /**
     * 解析会话存储目录（不带外部项目根提示，仅用于 {@code AgentSessionProvider}）。
     *
     * @param sessionId 会话 ID
     * @return 该会话的存储目录（绝对、规范化）
     */
    public File resolveDir(String sessionId) {
        return resolveDir(sessionId, null);
    }

    /**
     * 解析会话存储目录（全局 / 项目会话统一逻辑）。
     *
     * @param sessionId   会话 ID
     * @param projectRoot 可选的工作空间根提示（Web 层透传 X-Session-Cwd / root 参数）
     * @return 该会话的存储目录（绝对、规范化）
     */
    public File resolveDir(String sessionId, String projectRoot) {
        // 前置校验：null 会话 ID 按约定抛 IllegalArgumentException
        // （注册表查询不支持 null key，须在查表前拦截；越界字符由 sessionDir 统一收口）
        if (sessionId == null) {
            throw new IllegalArgumentException("Illegal sessionId: null");
        }
        String root = (projectRoot != null && !projectRoot.trim().isEmpty())
                ? projectRoot.trim()
                : boundRoots.get(sessionId);
        if (root == null || root.isEmpty()) {
            // 未登记所属根：全局会话，落全局基准目录
            root = globalBase;
        }
        return sessionDir(root, sessionId);
    }

    /** 全局会话列表的扫描根目录（全局基准目录）。 */
    public File globalSessionsRoot() {
        return sessionsRoot(globalBase);
    }

    /**
     * 会话列表的扫描根目录（全局 / 项目会话通用）。
     * <p>会话均落在所属工作空间的 {@code .gwork/sessions/}，
     * 列表扫描时由调用方指定要查看的工作空间根。</p>
     *
     * @param root 工作空间根目录；为空时回退到全局基准目录（即全局会话区）
     */
    public File sessionsRoot(String root) {
        String effective = (root != null && !root.trim().isEmpty()) ? root.trim() : globalBase;
        return doSessionsRoot(effective);
    }

    private File doSessionsRoot(String root) {
        migrateLegacyWorkspace(root);
        return Paths.get(root, harnessSessions).toAbsolutePath().normalize().toFile();
    }

    /**
     * 品牌升级懒迁移：项目根下旧 {@code .gourdai} 目录一次性改名 {@code .gwork}（幂等）。
     * <p>Code 模式会话/记忆随项目走，而工作区级目录只能在该项目被打开时迁移；
     * 全局区（全局基准目录）已由 {@code App.main} 启动时统一迁移。</p>
     */
    private void migrateLegacyWorkspace(String root) {
        try {
            java.nio.file.Path legacy = Paths.get(root, ".gourdai");
            java.nio.file.Path current = Paths.get(root, AgentFlags.getHarnessHome());
            if (java.nio.file.Files.isDirectory(legacy) && !java.nio.file.Files.exists(current)) {
                java.nio.file.Files.move(legacy, current);
            }
        } catch (Exception e) {
            // 迁移失败不阻断会话解析（下次打开再试）
        }
    }

    /**
     * 登记表持久化文件：{@code <globalBase>/.gwork/session-roots.json}（sessionId → 所属根）。
     */
    private File rootsIndexFile() {
        return Paths.get(globalBase, AgentFlags.getHarnessHome(), "session-roots.json").toFile();
    }

    /**
     * 启动时回读登记表（失败不阻断，全局基准目录兜底）。
     */
    private void loadBoundRoots() {
        try {
            File f = rootsIndexFile();
            if (f.exists()) {
                String json = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
                ONode root = ONode.ofJson(json);
                if (root != null && root.isObject()) {
                    // 注意：getObjectUnsafe 的 value 是 ONode 本体，须用 getString() 取原始字符串；
                    // String.valueOf(ONode) 会拿到带引号/转义的 JSON 表示，导致后续 Paths.get 报非法路径。
                    root.getObjectUnsafe().forEach((k, v) -> {
                        String s = null;
                        if (v instanceof ONode) {
                            s = ((ONode) v).getString();
                        } else if (v != null) {
                            s = String.valueOf(v);
                        }
                        if (s != null && !s.isEmpty()) {
                            boundRoots.put(k, s);
                        }
                    });
                }
            }
        } catch (Exception e) {
            // 登记表损坏不阻断启动
        }
    }

    /**
     * 登记表落盘（仅在登记变化时调用，文件极小）。
     */
    private synchronized void saveBoundRoots() {
        try {
            File f = rootsIndexFile();
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            ONode node = new ONode().asObject();
            for (Map.Entry<String, String> e : boundRoots.entrySet()) {
                node.set(e.getKey(), e.getValue());
            }
            java.nio.file.Files.write(f.toPath(), node.toJson().getBytes("UTF-8"));
        } catch (Exception e) {
            // 持久化失败不影响内存解析
        }
    }

    /**
     * 解析会话目录，并做统一的路径越界防护（所有 resolveDir 调用的唯一收口点）。
     *
     * <p>最终路径为 {@code <root>/<harnessSessions>/<sessionId>}。此处强制校验规范化后的
     * 结果仍落在 {@code <root>/<harnessSessions>/} 之内——即便某个上层调用忘了校验
     * {@code sessionId}（当前各 Web 端点对 {@code ..} 的校验并不一致），带 {@code ..}
     * 或分隔符的 {@code sessionId} 也无法逃逸到会话区之外。{@code root} 亦拒绝空字节。</p>
     *
     * @throws IllegalArgumentException sessionId 越界或含非法字符时抛出，由上层转 4xx
     */
    private File sessionDir(String root, String sessionId) {
        if (sessionId == null || sessionId.indexOf('\0') >= 0
                || sessionId.indexOf('/') >= 0 || sessionId.indexOf('\\') >= 0
                || sessionId.contains("..")) {
            throw new IllegalArgumentException("Illegal sessionId: " + sessionId);
        }
        if (root != null && root.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Illegal project root");
        }

        java.nio.file.Path base = Paths.get(root, harnessSessions).toAbsolutePath().normalize();
        java.nio.file.Path target = base.resolve(sessionId).normalize();
        //规范化后必须仍在会话区之内，杜绝 sessionId 借 .. 逃逸
        if (!target.startsWith(base)) {
            throw new IllegalArgumentException("Illegal sessionId path escape: " + sessionId);
        }
        return target.toFile();
    }
}
