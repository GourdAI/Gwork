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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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
        } catch (Exception ignored) {
        }
        return result;
    }

    private void save(List<Map> projects) {
        try {
            Path file = storeFile();
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
            Files.write(file, arr.toJson().getBytes("UTF-8"));
        } catch (Exception ignored) {
        }
    }
}
