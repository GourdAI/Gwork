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

import org.noear.snack4.ONode;
import org.noear.solon.core.handle.Result;
import com.gourdai.core.config.AgentFlags;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 项目登记服务 —— 管理 Code 模式下用户选择/记忆的本地项目目录列表。
 *
 * <p>列表持久化到安装目录 {@code <安装目录>/.gwork/projects.json}，跨工作区共享，
 * 结构为 {@code [{ "name": "...", "path": "..." }]}（按最近使用排序，最近的在前）。</p>
 *
 * <p>校验规则：路径必须是本机上真实存在的目录；不允许包含 {@code ..}（防止相对越界歧义）。
 * 该服务运行于用户本机单用户场景，因此允许指向任意本地目录（不限制在启动工作区内）。</p>
 *
 * @author oisin
 */
public class ProjectService {
    private static final String FILE_NAME = "projects.json";
    private static final int MAX_PROJECTS = 50;

    /** 同机目录定位（locate）最大 BFS 深度：从每个 root 起最多向下展开 4 层子目录 */
    private static final int LOCATE_MAX_DEPTH = 4;
    /** 同机目录定位（locate）访问目录数上限，防止全盘扫描失控 */
    private static final int LOCATE_MAX_VISITED = 30000;

    /**
     * 同机目录定位（locate）扫描时跳过的目录名：构建产物、依赖缓存与操作系统目录。
     * <p>这些目录既不会是用户项目根，内部又极深极大，进入只会白白消耗扫描配额。</p>
     */
    static final Set<String> SCAN_EXCLUDED = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "node_modules", "target", "build", "venv", "vendor",
            ".git", ".idea", ".vscode",
            "Windows", "Program Files", "Program Files (x86)", "ProgramData",
            "$Recycle.Bin", "AppData", "System Volume Information", "Recovery"
    )));

    /** projects.json 的绝对路径：<安装目录>/.gwork/projects.json */
    private Path storeFile() {
        return Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), FILE_NAME).toAbsolutePath().normalize();
    }

    /**
     * 列出已登记的项目。
     *
     * @return 项目列表，每项含 name、path
     */
    public Result<List<Map>> list() {
        return Result.succeed(load());
    }

    /**
     * 浏览服务端目录（供前端「目录选择器」使用）。
     * <p>返回指定目录下的<b>子目录</b>列表（不含文件），并附带父目录与当前绝对路径，
     * 供前端逐级进入/返回、最终选定某个目录作为项目根。</p>
     *
     * <p>{@code path} 为空时返回一个合理的起点：
     * <ul>
     *   <li>Windows：列出所有盘符（C:\、D:\ …），{@code current} 为空、{@code parent} 为空。</li>
     *   <li>类 Unix：从用户主目录开始。</li>
     * </ul></p>
     *
     * @param path 要浏览的目录绝对路径；为空时返回起点（盘符列表 / 用户主目录）
     * @return 包含 current（当前绝对路径）、parent（父目录，可空）、
     *         separator（路径分隔符）、dirs（子目录数组，每项含 name、path）的结果
     */
    public Result<Map> browse(String path) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("separator", File.separator);

        boolean isWindows = File.separatorChar == '\\';

        // 空路径：Windows 返回盘符根列表；Unix 从用户主目录开始
        if (path == null || path.trim().isEmpty()) {
            if (isWindows) {
                data.put("current", "");
                data.put("parent", null);
                List<Map> roots = new ArrayList<>();
                File[] fsRoots = File.listRoots();
                if (fsRoots != null) {
                    for (File r : fsRoots) {
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("name", r.getAbsolutePath()); // 如 "C:\"
                        item.put("path", r.getAbsolutePath());
                        roots.add(item);
                    }
                }
                data.put("dirs", roots);
                return Result.succeed(data);
            } else {
                path = AgentFlags.getUserHome();
            }
        }

        File dir = new File(path.trim());
        if (!dir.exists() || !dir.isDirectory()) {
            return Result.failure(404, "Directory not found");
        }

        Path abs = dir.toPath().toAbsolutePath().normalize();
        data.put("current", abs.toString());
        Path parent = abs.getParent();
        data.put("parent", parent != null ? parent.toString() : null);

        List<Map> dirs = new ArrayList<>();
        File[] children = dir.listFiles();
        if (children != null) {
            Arrays.sort(children, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
            for (File f : children) {
                // 只列目录；跳过隐藏目录（. 开头）与无权限访问的
                if (!f.isDirectory()) continue;
                if (f.getName().startsWith(".")) continue;
                if (f.isHidden()) continue;
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", f.getName());
                item.put("path", f.getAbsolutePath());
                dirs.add(item);
            }
        }
        data.put("dirs", dirs);
        return Result.succeed(data);
    }

    /**
     * 新增（或置顶已存在的）项目。
     *
     * @param path 项目目录绝对路径
     * @param name 展示名（可空，默认取目录名）
     * @return 更新后的项目列表
     */
    public Result<List<Map>> add(String path, String name) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }

        Path dir = Paths.get(path.trim()).toAbsolutePath().normalize();
        File dirFile = dir.toFile();
        if (!dirFile.exists() || !dirFile.isDirectory()) {
            return Result.failure(404, "Directory not found");
        }

        String absPath = dir.toString();
        String displayName = (name != null && !name.trim().isEmpty())
                ? name.trim()
                : (dir.getFileName() != null ? dir.getFileName().toString() : absPath);

        List<Map> projects = load();
        // 去重：移除同路径旧项，再插到最前（置顶=最近使用）
        projects.removeIf(p -> absPath.equals(String.valueOf(p.get("path"))));

        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", displayName);
        item.put("path", absPath);
        projects.add(0, item);

        while (projects.size() > MAX_PROJECTS) {
            projects.remove(projects.size() - 1);
        }

        save(projects);
        return Result.succeed(projects);
    }

    /**
     * 新建项目：在指定父目录下创建一个新目录，并登记为项目（置顶）。
     * <p>与 {@link #add(String, String)} 的区别：add 要求目录已存在，create 负责先建目录。
     * 目录创建成功后直接复用 {@link #add(String, String)} 完成去重/置顶/持久化，返回结构一致。</p>
     *
     * @param parent 父目录绝对路径；为空时默认用户主目录
     * @param name   新项目目录名（同时作为展示名），不允许含路径分隔符 / \ 、{@code ..} 或 {@code :}
     * @return 更新后的项目列表；参数非法或目录已存在时返回失败
     */
    public Result<List<Map>> create(String parent, String name) {
        if (name == null || name.trim().isEmpty()) {
            return Result.failure(400, "项目名不能为空");
        }
        String cleanName = name.trim();
        // 目录名安全校验：禁止路径穿越与分隔符（跨平台）
        if (cleanName.contains("..") || cleanName.contains("/") || cleanName.contains("\\")
                || cleanName.contains(":")) {
            return Result.failure(400, "项目名包含非法字符");
        }

        String parentPath = (parent != null && !parent.trim().isEmpty())
                ? parent.trim()
                : AgentFlags.getUserHome();
        if (parentPath.contains("..")) {
            return Result.failure(400, "父目录路径非法");
        }

        Path parentDir = Paths.get(parentPath).toAbsolutePath().normalize();
        File parentFile = parentDir.toFile();
        if (!parentFile.exists() || !parentFile.isDirectory()) {
            return Result.failure(404, "父目录不存在");
        }

        Path target = parentDir.resolve(cleanName).normalize();
        // 二次确认解析结果仍在父目录之内（防御拼接绕过）
        if (!target.startsWith(parentDir)) {
            return Result.failure(400, "项目名包含非法字符");
        }
        File targetFile = target.toFile();
        if (targetFile.exists()) {
            return Result.failure(400, "目录已存在");
        }

        try {
            Files.createDirectories(target);
        } catch (Exception e) {
            return Result.failure(500, "创建目录失败：" + e.getMessage());
        }

        // 复用 add 完成登记 + 置顶 + 持久化
        return add(target.toString(), cleanName);
    }

    /**
     * 在指定父目录下新建一个空目录，<b>不登记为项目</b>。
     *
     * <p>与 {@link #create(String, String)} 的区别：create 末尾会 {@code return add(...)}
     * 把新目录登记进 projects.json 并置顶。目录浏览器里「新建文件夹」是<b>导航途中</b>
     * 的动作——用户可能只是想建个中间层目录再往里进，若沿用 create，每建一层就往工作区
     * 下拉里塞一条垃圾项目条目（远端场景更糟：登记写进远端 projects.json，本地列表扇出后
     * 出现一堆无意义远端项目）。故这里只建目录，登记仍由用户最终「选定此目录」触发。</p>
     *
     * <p>安全校验与 create 完全同口径（禁止路径穿越与分隔符、二次确认解析结果仍在父目录内），
     * 避免出现「create 严格、mkdir 宽松」的双标绕过面。</p>
     *
     * @param parent 父目录绝对路径；为空时取用户主目录（与 create 同默认）
     * @param name   新目录名，不允许含路径分隔符 / \ 、{@code ..} 或 {@code :}
     * @return 含 path（新目录绝对路径）与 name 的结果；参数非法或目录已存在时返回失败
     */
    public Result<Map> mkdir(String parent, String name) {
        if (name == null || name.trim().isEmpty()) {
            return Result.failure(400, "目录名不能为空");
        }
        String cleanName = name.trim();
        // 目录名安全校验：禁止路径穿越与分隔符（跨平台，与 create 同口径）
        if (cleanName.contains("..") || cleanName.contains("/") || cleanName.contains("\\")
                || cleanName.contains(":")) {
            return Result.failure(400, "目录名包含非法字符");
        }

        String parentPath = (parent != null && !parent.trim().isEmpty())
                ? parent.trim()
                : AgentFlags.getUserHome();
        if (parentPath.contains("..")) {
            return Result.failure(400, "父目录路径非法");
        }

        Path parentDir = Paths.get(parentPath).toAbsolutePath().normalize();
        File parentFile = parentDir.toFile();
        if (!parentFile.exists() || !parentFile.isDirectory()) {
            return Result.failure(404, "父目录不存在");
        }

        Path target = parentDir.resolve(cleanName).normalize();
        // 二次确认解析结果仍在父目录之内（防御拼接绕过）
        if (!target.startsWith(parentDir)) {
            return Result.failure(400, "目录名包含非法字符");
        }
        File targetFile = target.toFile();
        if (targetFile.exists()) {
            // 已存在（无论是目录还是同名文件）都不静默成功：静默会让用户以为建好了，
            // 随后进入的却是别人的目录 / 一个文件路径。
            return Result.failure(400, "目录已存在");
        }

        try {
            Files.createDirectories(target);
        } catch (Exception e) {
            return Result.failure(500, "创建目录失败：" + e.getMessage());
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("path", target.toString());
        data.put("name", cleanName);
        return Result.succeed(data);
    }

    /**
     * 移除项目登记（不删除磁盘上的实际目录）。
     *
     * @param path 项目目录绝对路径
     * @return 更新后的项目列表
     */
    public Result<List<Map>> remove(String path) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        Path dir = Paths.get(path.trim()).toAbsolutePath().normalize();
        String absPath = dir.toString();

        List<Map> projects = load();
        projects.removeIf(p -> absPath.equals(String.valueOf(p.get("path"))));
        save(projects);
        return Result.succeed(projects);
    }

    /**
     * 重命名项目的展示名（仅修改 projects.json 中的 name，不改动磁盘目录与路径）。
     * <p>与 {@link #add(String, String)} 的区别：rename 为原地修改，保持列表顺序不变
     * （add 会把项目置顶到「最近使用」首位，重命名动作不应污染该排序）。</p>
     *
     * @param path 项目目录绝对路径（须已登记）
     * @param name 新的展示名；为空时恢复为目录名
     * @return 更新后的项目列表；路径未登记时返回失败
     */
    public Result<List<Map>> rename(String path, String name) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }

        Path dir = Paths.get(path.trim()).toAbsolutePath().normalize();
        String absPath = dir.toString();

        List<Map> projects = load();
        Map target = null;
        for (Map p : projects) {
            if (absPath.equals(String.valueOf(p.get("path")))) {
                target = p;
                break;
            }
        }
        if (target == null) {
            return Result.failure(404, "Project not found");
        }

        // 展示名：非空用用户输入（长度限制与会话标签一致），为空恢复为目录名
        String displayName = (name != null && !name.trim().isEmpty())
                ? name.trim()
                : (dir.getFileName() != null ? dir.getFileName().toString() : absPath);
        if (displayName.length() > 50) {
            displayName = displayName.substring(0, 50);
        }

        target.put("name", displayName);
        save(projects);
        return Result.succeed(projects);
    }

    /**
     * 同机目录定位：把浏览器 File System Access API 只能给出的「目录名 + 子目录名指纹」
     * 解析回本机的绝对路径候选。
     *
     * <p>背景：前端原生文件夹选择对话框（File System Access API）出于安全考虑<b>拿不到绝对路径</b>，
     * 只能拿到用户所选目录的名字与其一级子目录名。而后端与浏览器同机运行，因此可以用一次
     * <b>受限扫描</b>把名字解析回绝对路径。</p>
     *
     * <p><b>两阶段定位</b>：阶段一直接拿「已登记项目表」逐条做名称+指纹比对（只 O(登记数) 次 listFiles，
     * 不扫描）——重选已登记目录是最高频场景，而纯 BFS 在目录树深的机器上会先烧光预算
     * （实测 Windows 机 C 盘系统目录 alone 就耗尽 {@value #LOCATE_MAX_VISITED}，返回空候选把前端推入兜底）。
     * 阶段二才做受限 BFS：roots 为 home + 已登记项目的父目录（新兄弟目录是次高频选择）+ 各盘符根，
     * 深度固定 {@value #LOCATE_MAX_DEPTH} 层、访问上限 {@value #LOCATE_MAX_VISITED}、跳过构建/依赖/系统目录
     * （{@link #SCAN_EXCLUDED}）。命中 2 个候选即早停：前端只需要「唯一候选自动选中 / 多个候选让用户挑」。</p>
     *
     * <p><b>指纹为子集语义</b>：{@link #isMatch} 用「提交指纹 ⊆ 实际指纹」判定。浏览器的 webkitdirectory
     * 兜底路径只能看到「含文件的子目录」（空子目录不出现在文件列表里），精确相等会系统性漏配；
     * 子集语义容忍该盲区，同名多候选时仍可由前端消歧列表兜住。</p>
     *
     * <p>返回结果始终为成功（除非名称非法）；扫描过程中的任何异常都不会抛出，
     * 而是返回已收集到的候选，保证前端拿到可用响应。</p>
     *
     * @param name     目录名（浏览器给出的 handle.name）；为空或含路径分隔符/{@code ..}/{@code :} 时返回 400
     * @param children 一级子目录名列表（可为空），归一化后作为匹配指纹
     * @return {@code {"candidates": [绝对路径...], "scanned": 访问目录数}}
     */
    public Result<Map> locate(String name, List<String> children) {
        // 目录名安全校验：与 create 一致，禁止路径穿越与分隔符（跨平台）
        if (name == null || name.trim().isEmpty()) {
            return Result.failure(400, "Invalid name");
        }
        String cleanName = name.trim();
        if (cleanName.contains("..") || cleanName.contains("/") || cleanName.contains("\\")
                || cleanName.contains(":")) {
            return Result.failure(400, "Invalid name");
        }

        boolean windows = File.separatorChar == '\\';
        List<String> wantFingerprint = normalizeFingerprint(children);

        List<String> candidates = new ArrayList<>();
        long scanned = 0L;

        try {
            List<Map> projects = load();
            // 阶段一：已登记项目直接比对（不扫描）。登记表就是「用户选过/登记过的目录」，
            // 重选场景在此 O(登记数) 命中，避免阶段二在深目录树机器上烧光预算后返回空候选。
            candidates.addAll(matchRegistered(projects, cleanName, wantFingerprint, windows));
            if (candidates.size() > 2) {
                candidates = new ArrayList<>(candidates.subList(0, 2));
            }

            if (candidates.size() < 2) {
                scanned = scanFileSystem(projects, cleanName, wantFingerprint, windows, candidates);
            }
        } catch (Exception e) {
            // 扫描失败不抛异常：把已收集的候选返回给前端（可能为空）
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("candidates", candidates);
        data.put("scanned", scanned);
        return Result.succeed(data);
    }

    /**
     * 阶段一：在已登记项目表内按「目录名 + 子目录指纹」直接比对，返回命中的绝对路径（最多 2 条）。
     *
     * <p>纯函数语义（登记表入参），便于单测；路径解析失败的登记项静默跳过。</p>
     *
     * @param projects        登记表（{@link #load()} 的结果，可为 null）
     * @param name            期望目录名
     * @param wantFingerprint 期望指纹（须已归一化）
     * @param windows         是否按 Windows 语义（目录名忽略大小写）比较
     * @return 命中的登记路径列表（最多 2 条）
     */
    static List<String> matchRegistered(List<Map> projects, String name, List<String> wantFingerprint, boolean windows) {
        List<String> out = new ArrayList<>();
        if (projects == null) {
            return out;
        }
        for (Map p : projects) {
            Object rawPath = (p == null) ? null : p.get("path");
            if (rawPath == null) {
                continue;
            }
            try {
                File dir = Paths.get(String.valueOf(rawPath)).toAbsolutePath().normalize().toFile();
                if (isMatch(dir, name, wantFingerprint, windows)) {
                    out.add(dir.toString());
                    if (out.size() >= 2) {
                        break;
                    }
                }
            } catch (Exception ignored) {
                // 登记路径非法（无效盘符等）：跳过该项，不影响其余比对
            }
        }
        return out;
    }

    /**
     * 阶段二：受限 BFS 全盘扫描（仅在阶段一未凑满 2 候选时调用）。
     *
     * <p>roots = 用户主目录 + 已登记项目的父目录 + 各盘符/文件系统根；命中追加进 {@code candidates}
     *（满 2 即停），返回访问过的目录数。包可见 static 以便单测直接驱动优先根逻辑。</p>
     */
    static long scanFileSystem(List<Map> projects, String cleanName, List<String> wantFingerprint,
                               boolean windows, List<String> candidates) {
        long scanned = 0L;
        // roots：用户主目录优先（命中概率最高），其次已登记项目的父目录（新兄弟目录是次高频选择），
        // 最后才是各盘符/文件系统根
        Set<Path> roots = new LinkedHashSet<>();
        String userHome = AgentFlags.getUserHome();
        Path userHomePath = null;
        if (userHome != null && !userHome.trim().isEmpty()) {
            File homeFile = new File(userHome.trim());
            if (homeFile.exists() && homeFile.isDirectory()) {
                // 与子目录的 toRealPath 保持同一归一化口径，便于后续相等比较
                userHomePath = toRealPathOrAbsolute(homeFile.toPath());
                roots.add(userHomePath);
            }
        }
        if (projects != null) {
            for (Map p : projects) {
                Object rawPath = (p == null) ? null : p.get("path");
                if (rawPath == null) {
                    continue;
                }
                try {
                    Path parent = Paths.get(String.valueOf(rawPath)).toAbsolutePath().normalize().getParent();
                    if (parent != null) {
                        roots.add(toRealPathOrAbsolute(parent));
                    }
                } catch (Exception ignored) {
                    // 登记路径非法：跳过，不影响其它根
                }
            }
        }
        File[] fsRoots = File.listRoots();
        if (fsRoots != null) {
            for (File r : fsRoots) {
                if (r == null) continue;
                if (!r.exists() || !r.isDirectory()) continue;
                roots.add(r.toPath().toAbsolutePath().normalize());
            }
        }

        Deque<Object[]> queue = new ArrayDeque<>();
        for (Path root : roots) {
            queue.add(new Object[]{root, 0});
        }
        // 同一个目录可能经不同 root 重复入队（如 home 与 C:\），用已访问集合去重
        Set<Path> visitedPaths = new HashSet<>();

        while (!queue.isEmpty()) {
            Object[] entry = queue.poll();
            Path path = (Path) entry[0];
            int depth = (Integer) entry[1];

            if (!visitedPaths.add(path)) {
                continue;
            }
            if (scanned >= LOCATE_MAX_VISITED) {
                break;
            }
            scanned++;

            File dir = path.toFile();
            // 每个被访问到的目录（含 root 自身，depth=0）都先做一次匹配判定
            if (isMatch(dir, cleanName, wantFingerprint, windows)) {
                String hit = path.toString();
                // 阶段一已命中的登记路径不再重复加入（登记父目录作 root 时会再次扫到它）
                if (!candidates.contains(hit)) {
                    candidates.add(hit);
                    if (candidates.size() >= 2) {
                        break; // 早停：两个候选已足够前端交互
                    }
                }
            }

            if (depth >= LOCATE_MAX_DEPTH) {
                continue; // 不再向下展开
            }

            File[] childFiles = dir.listFiles();
            if (childFiles == null) {
                continue;
            }
            for (File child : childFiles) {
                if (child == null || !child.isDirectory()) continue;
                String childName = child.getName();
                // 跳过隐藏目录（. 开头 / isHidden）与构建、依赖、系统目录
                if (childName.startsWith(".")) continue;
                if (SCAN_EXCLUDED.contains(childName)) continue;
                try {
                    if (child.isHidden()) continue;
                } catch (Exception ignored) {
                    // isHidden 在极端情况下可能抛 SecurityException，忽略后继续
                }

                Path childPath = toRealPathOrAbsolute(child.toPath());
                // 从盘符根扫到 home 时跳过：home 子树已由 userHome root 覆盖，避免重复扫描
                if (userHomePath != null && childPath.equals(userHomePath)) continue;

                queue.add(new Object[]{childPath, depth + 1});
            }
        }
        return scanned;
    }

    /**
     * 把路径归一化为 realpath（解析符号链接）；失败时退化为绝对路径 + normalize。
     */
    private static Path toRealPathOrAbsolute(Path path) {
        try {
            return path.toRealPath();
        } catch (Exception e) {
            return path.toAbsolutePath().normalize();
        }
    }

    /**
     * 归一化「子目录名指纹」，使比较与顺序、大小写、隐藏目录无关。
     *
     * <p>规则：丢弃 null、空串（trim 后）与以 {@code .} 开头的名字（隐藏目录不作为指纹，
     * 浏览器端也拿不到），其余 trim 后按 {@link String#CASE_INSENSITIVE_ORDER} 排序。</p>
     *
     * @param raw 原始子目录名列表（可为 null）；不会被修改
     * @return 归一化后的新列表（永不为 null）
     */
    static List<String> normalizeFingerprint(List<String> raw) {
        List<String> result = new ArrayList<>();
        if (raw == null) {
            return result;
        }
        for (String item : raw) {
            if (item == null) continue;
            String trimmed = item.trim();
            if (trimmed.isEmpty()) continue;
            if (trimmed.startsWith(".")) continue;
            result.add(trimmed);
        }
        result.sort(String.CASE_INSENSITIVE_ORDER);
        return result;
    }

    /**
     * 判定一个目录是否匹配「名称 + 子目录指纹」。
     *
     * <p>目录名比较：Windows 文件系统大小写不敏感，用 {@code equalsIgnoreCase}；其余平台用 {@code equals}。
     * 实际指纹取 {@code dir.listFiles()} 中的子目录（{@code isDirectory()} 且名字不以 {@code .} 开头），
     * 经 {@link #normalizeFingerprint(List)} 归一化后做<b>子集比较</b>（期望 ⊆ 实际）；
     * {@code listFiles()} 返回 null（无权限或 IO 失败）时，实际指纹视为空列表。
     * 子集语义的原因：webkitdirectory 兜底路径拿不到空子目录，精确相等会系统性漏配；
     * 同名多候选仍由前端消歧列表兜住。</p>
     *
     * @param dir             待判定目录
     * @param name            期望目录名
     * @param wantFingerprint 期望指纹（须已归一化）
     * @param windows         是否按 Windows 语义（目录名忽略大小写）比较
     * @return 目录存在、名称与指纹全部匹配时返回 true
     */
    static boolean isMatch(File dir, String name, List<String> wantFingerprint, boolean windows) {
        if (dir == null || name == null) {
            return false;
        }
        if (!dir.exists() || !dir.isDirectory()) {
            return false;
        }
        String dirName = dir.getName();
        boolean nameOk = windows ? name.equalsIgnoreCase(dirName) : name.equals(dirName);
        if (!nameOk) {
            return false;
        }

        List<String> actual = new ArrayList<>();
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child == null || !child.isDirectory()) continue;
                String childName = child.getName();
                if (childName.startsWith(".")) continue;
                actual.add(childName);
            }
        }
        List<String> actualFingerprint = normalizeFingerprint(actual);
        List<String> want = (wantFingerprint != null) ? wantFingerprint : Collections.<String>emptyList();
        return actualFingerprint.containsAll(want);
    }

    // ==================== 内部 ====================

    /**
     * 解析并校验前端工作区头。Code/Chat 工作区只能来自现有项目登记表，避免任意请求头
     * 将记忆读写定向到未授权的本地绝对路径。
     */
    public String resolveRegisteredDirectory(String path) {
        if (path == null || path.trim().isEmpty() || path.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Invalid Session Cwd");
        }
        final Path requested;
        try {
            requested = Paths.get(path.trim()).toAbsolutePath().normalize();
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid Session Cwd", e);
        }
        if (!Files.isDirectory(requested)) {
            throw new IllegalArgumentException("Session Cwd is not an existing directory");
        }
        for (Map project : load()) {
            Object registeredPath = project.get("path");
            if (registeredPath == null) continue;
            try {
                Path registered = Paths.get(String.valueOf(registeredPath)).toAbsolutePath().normalize();
                if (requested.equals(registered)) {
                    return requested.toString();
                }
            } catch (Exception ignored) {
            }
        }
        throw new IllegalArgumentException("Session Cwd is not a registered workspace");
    }

    @SuppressWarnings("unchecked")
    private List<Map> load() {
        List<Map> result = new ArrayList<>();
        try {
            Path file = storeFile();
            if (!Files.exists(file)) {
                return result;
            }
            String json = new String(Files.readAllBytes(file), "UTF-8");
            ONode node = ONode.ofJson(json);
            if (node.isArray()) {
                for (ONode item : node.getArrayUnsafe()) {
                    String p = item.get("path").getString();
                    if (p == null || p.isEmpty()) continue;
                    // 过滤已不存在的目录（保持列表整洁）
                    File f = new File(p);
                    if (!f.exists() || !f.isDirectory()) continue;

                    Map<String, Object> m = new LinkedHashMap<>();
                    String nm = item.get("name").getString();
                    m.put("name", (nm != null && !nm.isEmpty()) ? nm : f.getName());
                    m.put("path", p);
                    result.add(m);
                }
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to load projects.json", e);
        }
        return result;
    }

    private void save(List<Map> projects) {
        try {
            Path file = storeFile();
            Path tmp = file.resolveSibling(FILE_NAME + ".tmp");
            File parent = file.getParent().toFile();
            if (!parent.exists()) {
                parent.mkdirs();
            }
            ONode arr = new ONode().asArray();
            for (Map p : projects) {
                ONode item = arr.addNew();
                item.set("name", String.valueOf(p.get("name")));
                item.set("path", String.valueOf(p.get("path")));
            }
            Files.write(tmp, arr.toJson().getBytes("UTF-8"));
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            throw new RuntimeException("Failed to save projects.json", e);
        }
    }
}
