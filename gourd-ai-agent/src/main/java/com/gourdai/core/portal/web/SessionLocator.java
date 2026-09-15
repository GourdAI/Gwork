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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
    private static final Logger LOG = LoggerFactory.getLogger(SessionLocator.class);

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
     * <p><b>归属冻结：</b>会话的所属根一旦登记便不再改写——同一会话被重复登记到不同根，
     * 会让它的数据在多个目录各写一份（分居），故第二次起仅告警忽略。重复登记同根幂等。</p>
     *
     * <p><b>数据位置采纳：</b>首次登记前先探测会话既有数据的实际位置——数据已落在某项目根时
     * 采纳该根（而非请求根），数据已在全局区时保持全局语义不做登记。二者都保证
     * 「messages/snapshot/stream 等同目录落盘」，不会因受理时的工作空间状态而把同一会话拆到两处。</p>
     *
     * @param sessionId     会话 ID
     * @param workspaceRoot 所属工作空间根绝对路径；为空则忽略（回退到全局基准目录）
     */
    public void bindSessionRoot(String sessionId, String workspaceRoot) {
        if (sessionId == null || workspaceRoot == null || workspaceRoot.trim().isEmpty()) {
            return;
        }
        String root = normalizeRoot(workspaceRoot.trim());

        // 归属冻结：已登记会话不再改写（防分居）。重复登记同根为幂等空操作。
        String prev = boundRoots.get(sessionId);
        if (prev != null) {
            if (!sameRoot(prev, root)) {
                LOG.warn("[SessionLocator] session {} already bound to '{}', ignore rebind to '{}'",
                        sessionId, prev, root);
            }
            return;
        }

        // 首次登记：家目录必须跟随既有数据位置，防止产生分居
        String dataHome = detectDataHome(sessionId, root);
        if (dataHome == null) {
            // 所有已知位置均无数据：全新会话，采用请求根
            dataHome = root;
        } else if (sameRoot(dataHome, globalBase)) {
            // 数据只落在全局区：保持全局语义（未登记即全局），不登记
            return;
        }

        boundRoots.put(sessionId, dataHome);
        saveBoundRoots();
    }

    /** 规范化根路径（绝对化 + normalize），使同一目录的不同写法收敛为统一形态。 */
    private static String normalizeRoot(String root) {
        try {
            return Paths.get(root).toAbsolutePath().normalize().toString();
        } catch (Throwable e) {
            return root;
        }
    }

    /** 两个根是否指向同一目录（Windows 大小写不敏感）。 */
    private static boolean sameRoot(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return normalizeRoot(a).equalsIgnoreCase(normalizeRoot(b));
    }

    /**
     * 探测会话既有数据（messages/snapshot/stream/label/uploads 等任意文件）的实际所在根。
     *
     * <p>扫描范围为全局基准目录、全部已登记根与请求根；优先返回请求根（若其已含数据），
     * 否则返回数据最新的根；全部无数据返回 {@code null}。</p>
     */
    private String detectDataHome(String sessionId, String requestedRoot) {
        java.util.LinkedHashMap<String, File> candidates = new java.util.LinkedHashMap<>();
        candidates.put(normalizeRoot(globalBase), new File(globalBase));
        for (String r : registeredRoots()) {
            candidates.putIfAbsent(normalizeRoot(r), new File(r));
        }
        candidates.putIfAbsent(normalizeRoot(requestedRoot), new File(requestedRoot));

        String best = null;
        long bestTime = Long.MIN_VALUE;
        for (Map.Entry<String, File> e : candidates.entrySet()) {
            File dir;
            try {
                dir = sessionDir(e.getValue().getPath(), sessionId);
            } catch (Throwable t) {
                continue;
            }
            if (!dirHasData(dir)) {
                continue;
            }
            if (sameRoot(e.getKey(), requestedRoot)) {
                return e.getKey();
            }
            long modified = dir.lastModified();
            if (modified > bestTime) {
                bestTime = modified;
                best = e.getKey();
            }
        }
        return best;
    }

    /** 目录树中是否存在任意真实数据（文件，或含文件的子目录）；空壳目录不算数据。 */
    private static boolean dirHasData(File dir) {
        if (dir == null || !dir.isDirectory()) {
            return false;
        }
        File[] children = dir.listFiles();
        if (children == null || children.length == 0) {
            return false;
        }
        for (File c : children) {
            if (c.isFile()) {
                return true;
            }
            if (c.isDirectory() && dirHasData(c)) {
                return true;
            }
        }
        return false;
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
     * 枚举会话的全部已知落点目录（全局区 + 显式根 + 已登记根 + 全部已登记项目根），按绝对路径去重。
     *
     * <p>供删除链路一次性清理历史分居产生的多份残留：同一会话的目录可能同时存在于
     * 全局区与项目区（引擎侧与 Web 侧曾各写一份），只删解析到的那一份会遗留另一半。</p>
     *
     * <p>候选目录可能不存在，调用方逐项做存在性判断后再删。</p>
     *
     * @param sessionId    会话 ID
     * @param explicitRoot 调用方持有的显式根提示（可为 null）
     * @return 候选目录列表（顺序：全局区 → 显式根 → 已登记根 → 其它已登记项目根）
     */
    public java.util.List<File> allKnownSessionDirs(String sessionId, String explicitRoot) {
        java.util.LinkedHashMap<String, File> out = new java.util.LinkedHashMap<>();
        addSessionDirCandidate(out, globalBase, sessionId);
        if (explicitRoot != null && !explicitRoot.trim().isEmpty()) {
            addSessionDirCandidate(out, explicitRoot.trim(), sessionId);
        }
        String bound = boundRoots.get(sessionId);
        if (bound != null) {
            addSessionDirCandidate(out, bound, sessionId);
        }
        for (String r : registeredRoots()) {
            addSessionDirCandidate(out, r, sessionId);
        }
        return new java.util.ArrayList<>(out.values());
    }

    private void addSessionDirCandidate(Map<String, File> out, String root, String sessionId) {
        try {
            File dir = sessionDir(root, sessionId);
            out.putIfAbsent(dir.getAbsolutePath(), dir);
        } catch (Throwable ignore) {
            // 非法根/会话 ID 直接跳过
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
        return sessionDir(effectiveRoot(sessionId, projectRoot), sessionId);
    }

    /**
     * 解析会话所属的有效根目录（与 {@link #resolveDir(String, String)} 完全同口径）：
     * 显式根 &gt; 会话已登记根 &gt; 全局基准目录。
     *
     * <p>供需要「会话根」而非「会话目录」的清理逻辑使用：删除会话时既要删会话目录
     * （{@code <root>/<harnessSessions>/<sessionId>}），也要按同一根清理旧版账本残留
     * （{@code <root>/.gwork/file-changes}），两者必须出自同一次解析——若在解绑登记后
     * 再解析，会错误回退到全局目录。</p>
     */
    public String effectiveRoot(String sessionId, String projectRoot) {
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
        return root;
    }

    /**
     * 解析会话存储目录（<b>读取专用</b>，带历史落点兜底）。
     *
     * <p><b>为何需要与 {@link #resolveDir(String, String)} 分开：</b>写入侧（工具链的
     * {@code ATTR_CWD}）在无根会话上的兜底值是 {@code workspace}（即 {@code user.dir}，
     * 进程启动目录），而读取侧的兜底值是 {@code globalBase}（即 {@code user.home}）。
     * 二者在桌面端/裸 CLI 下并不相等，于是「无所属根的会话」会出现读写分叉：
     * {@code todowrite} 把 TODO.md 写进 {@code user.dir}，查询接口却去 {@code user.home}
     * 找 → 恒返回「暂无任务清单」，前端任务入口还会随之消失。</p>
     *
     * <p>本方法在标准解析落空（目录里没有目标文件）时，再探一次 {@code workspace} 下的
     * 同名会话目录；命中则返回历史落点，使既有会话立即恢复可读。新写入由
     * {@link #resolveWriteRoot(String, String)} 收敛到统一根，分叉不会继续扩大。</p>
     *
     * @param sessionId   会话 ID
     * @param projectRoot 可选的工作空间根提示
     * @param probeFile   用于判定「该目录确实是这个会话的落点」的文件名（如 {@code TODO.md}）；
     *                    为空时只做目录存在性判定
     * @return 优先返回标准目录；仅当标准目录不含 probeFile 而历史目录含有时，返回历史目录
     */
    public File resolveDirForRead(String sessionId, String projectRoot, String probeFile) {
        File primary = resolveDir(sessionId, projectRoot);
        if (hasProbe(primary, probeFile)) {
            return primary;
        }
        // 标准位置没有：回探写入侧的历史兜底根（workspace），命中才改用
        File legacy = legacyWorkspaceDir(sessionId);
        if (legacy != null && hasProbe(legacy, probeFile)) {
            return legacy;
        }
        return primary;
    }

    /**
     * 解析会话的<b>写入根</b>——与 {@link #resolveDir(String, String)} 完全同源的口径，
     * 供工具链注入 {@code ATTR_CWD} 使用，确保「写进去的目录 == 读出来的目录」。
     *
     * <p>顺序：显式 cwd 提示 &gt; 会话已登记所属根 &gt; 全局基准目录。注意最后一级是
     * {@code globalBase} 而非 {@code workspace}，这正是本次修复的关键：把写入侧的兜底
     * 从 {@code user.dir} 纠正为与读取侧一致的 {@code user.home}。</p>
     *
     * @param sessionId  会话 ID
     * @param sessionCwd 显式工作目录提示，可为空
     * @return 该会话的写入根目录（绝对路径字符串）
     */
    public String resolveWriteRoot(String sessionId, String sessionCwd) {
        if (sessionCwd != null && !sessionCwd.trim().isEmpty()) {
            return sessionCwd.trim();
        }
        String bound = (sessionId == null) ? null : boundRoots.get(sessionId);
        if (bound != null && !bound.isEmpty()) {
            return bound;
        }
        return globalBase;
    }

    /** 写入侧历史兜底根（{@code workspace}）下的会话目录；与全局区相同则返回 null。 */
    private File legacyWorkspaceDir(String sessionId) {
        if (workspace == null || workspace.isEmpty() || workspace.equals(globalBase)) {
            return null;
        }
        try {
            return sessionDir(workspace, sessionId);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 目录是否存在，且（指定 probeFile 时）其中确实存在该文件。 */
    private static boolean hasProbe(File dir, String probeFile) {
        if (dir == null || !dir.isDirectory()) {
            return false;
        }
        if (probeFile == null || probeFile.isEmpty()) {
            return true;
        }
        return new File(dir, probeFile).isFile();
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
                            boundRoots.put(k, normalizeRoot(s));
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
