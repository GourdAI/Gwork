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

import org.noear.solon.core.handle.Result;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/**
 * 文件服务 —— 封装工作区文件浏览、搜索、读取等操作的核心业务逻辑。
 *
 * <p>提供工作区目录结构的层级化浏览、关键词文件搜索、文件内容读取等能力。</p>
 *
 * <h3>设计说明</h3>
 * <ul>
 *   <li>通过 workspace 路径构造，所有文件操作均基于此路径</li>
 *   <li>内部维护排除目录列表，自动过滤构建产物、IDE 配置等无需展示的目录</li>
 *   <li>供 WebController 直接调用，Controller 层仅做参数解析和结果转发</li>
 * </ul>
 *
 * @author oisin
 * @see WebController
 */
public class FileService {
    /** 工作区根目录路径 */
    private final String workspace;

    /**
     * 文件树浏览时排除的目录/文件名称集合。
     * <p>包含各类构建产物、IDE 配置、版本控制等无需展示的条目，
     * 如 .git、.idea、node_modules、target、__pycache__ 等。</p>
     *
     * <p>注意：不再一刀切隐藏所有点前缀条目（如 .gitignore、.env 等需要可见），
     * 仅按本清单精确排除；清单与 {@link com.gourdai.core.portal.WorkspaceWatcher} 保持一致。</p>
     */
    private static final Set<String> EXCLUDED_DIRS = new HashSet<>(Arrays.asList(
            // 项目元数据 & IDE
            ".gwork", ".gwork-remote", ".gourdai", ".claude", ".opencode",
            ".idea", ".vscode", ".settings",
            // 版本控制 & 构建工具
            ".git", ".gradle", ".mvn",
            // 运行时缓存
            ".pytest_cache", "__pycache__",
            ".DS_Store",
            // 依赖目录
            "node_modules", "venv", "vendor",
            // 构建输出
            "target", "build"
    ));

    /** 原始字节预览流的最大文件大小：50MB（图片/PDF/音视频预览用） */
    public static final long RAW_MAX_SIZE = 50L * 1024 * 1024;

    /**
     * 文件扩展名 → Content-Type 映射（原始字节预览流用）。
     * <p>覆盖前端可预览的图片/PDF/音视频类型；未命中返回 {@code application/octet-stream}。</p>
     */
    private static final Map<String, String> CONTENT_TYPES = new HashMap<>();
    static {
        // 图片
        CONTENT_TYPES.put("png", "image/png");
        CONTENT_TYPES.put("jpg", "image/jpeg");
        CONTENT_TYPES.put("jpeg", "image/jpeg");
        CONTENT_TYPES.put("gif", "image/gif");
        CONTENT_TYPES.put("webp", "image/webp");
        CONTENT_TYPES.put("bmp", "image/bmp");
        CONTENT_TYPES.put("ico", "image/x-icon");
        CONTENT_TYPES.put("avif", "image/avif");
        CONTENT_TYPES.put("svg", "image/svg+xml");
        // PDF
        CONTENT_TYPES.put("pdf", "application/pdf");
        // 音频
        CONTENT_TYPES.put("mp3", "audio/mpeg");
        CONTENT_TYPES.put("wav", "audio/wav");
        CONTENT_TYPES.put("ogg", "audio/ogg");
        CONTENT_TYPES.put("m4a", "audio/mp4");
        CONTENT_TYPES.put("aac", "audio/aac");
        CONTENT_TYPES.put("flac", "audio/flac");
        // 视频
        CONTENT_TYPES.put("mp4", "video/mp4");
        CONTENT_TYPES.put("webm", "video/webm");
    }

    /**
     * 按文件名推断 Content-Type。
     *
     * @param fileName 文件名（含扩展名）
     * @return 对应的 MIME 类型；未知扩展名返回 {@code application/octet-stream}
     */
    public static String contentTypeOf(String fileName) {
        if (fileName == null) return "application/octet-stream";
        int dot = fileName.lastIndexOf('.');
        if (dot < 0 || dot == fileName.length() - 1) return "application/octet-stream";
        String ext = fileName.substring(dot + 1).toLowerCase();
        String type = CONTENT_TYPES.get(ext);
        return type != null ? type : "application/octet-stream";
    }

    /**
     * 构造函数。
     *
     * @param workspace 工作区根目录路径
     */
    public FileService(String workspace) {
        this.workspace = workspace;
    }

    /**
     * 解析有效根目录。
     * <p>Code 模式会传入所选项目根 {@code root}；为空时回退到启动工作区。
     * 该工具运行于用户本机（localhost 单用户），允许指向任意本地项目目录，
     * 但所有子操作仍强制约束在此根目录之内（防止 {@code ..} 越界）。</p>
     *
     * @param root 可选的项目根目录绝对路径
     * @return 规范化后的根目录 Path
     */
    private Path resolveRoot(String root) {
        String base = (root != null && !root.trim().isEmpty()) ? root.trim() : workspace;
        return Paths.get(base).toAbsolutePath().normalize();
    }

    // ==================== 公开业务方法 ====================

    /**
     * 工作区文件树浏览。
     * <p>以工作区根目录为基准，按指定路径和深度返回目录结构。
     * 点前缀文件（如 .gitignore、.env）正常展示，仅排除 {@link #EXCLUDED_DIRS} 中的条目。</p>
     *
     * @param path  相对路径，基于根目录；为空时从根目录开始
     * @param depth 展开深度，默认为 1（仅展开第一层）
     * @param root  可选的项目根目录（Code 模式），为空则使用启动工作区
     * @return 文件树列表，每项包含 name、path、type、expanded、children
     */
    public Result<List<Map>> tree(String path, Integer depth, String root) {
        if (depth == null || depth < 1) depth = 1;
        if (path == null) path = "";
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }

        java.nio.file.Path workspacePath = resolveRoot(root);
        java.nio.file.Path target = workspacePath.resolve(path).toAbsolutePath().normalize();

        if (!target.startsWith(workspacePath)) {
            return Result.failure(403, "Access denied");
        }
        if (!target.toFile().exists() || !target.toFile().isDirectory()) {
            return Result.failure(404, "Directory not found");
        }

        List<Map> tree = buildTree(target, workspacePath, depth, 1);
        return Result.succeed(tree);
    }

    /**
     * 工作区文件搜索。
     * <p>递归扫描整个根目录，返回路径中包含关键词的文件列表。
     * 排除规则与文件树接口一致：仅排除 EXCLUDED_DIRS 中的条目。</p>
     *
     * @param keyword 搜索关键词，匹配文件路径（大小写不敏感）
     * @param root    可选的项目根目录（Code 模式）
     * @return 匹配的文件列表，每项包含 name、path、type
     */
    public Result<List<Map>> search(String keyword, String root) {
        if (keyword == null || keyword.trim().isEmpty()) {
            return Result.failure(400, "Keyword is required");
        }
        if (keyword.contains("..")) {
            return Result.failure(400, "Invalid keyword");
        }

        java.nio.file.Path workspacePath = resolveRoot(root);
        String kw = keyword.trim().toLowerCase();

        List<Map> results = new ArrayList<>();
        searchFiles(workspacePath.toFile(), workspacePath, kw, results, 0);

        if (results.size() > 200) {
            results = results.subList(0, 200);
        }

        return Result.succeed(results);
    }

    /**
     * 读取文件内容。
     * <p>以根目录为基准，读取指定路径的文件文本内容。
     * 支持安全路径校验和文件大小限制（最大 2MB）。</p>
     *
     * @param path 相对路径，基于根目录
     * @param root 可选的项目根目录（Code 模式）
     * @return 文件信息，包含 content、path、name、size
     */
    public Result<Map> read(String path, String root) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }

        java.nio.file.Path workspacePath = resolveRoot(root);
        java.nio.file.Path target = workspacePath.resolve(path).toAbsolutePath().normalize();

        if (!target.startsWith(workspacePath)) {
            return Result.failure(403, "Access denied");
        }
        if (!target.toFile().exists() || target.toFile().isDirectory()) {
            return Result.failure(404, "File not found");
        }

        File file = target.toFile();
        // 限制文件大小：2MB
        if (file.length() > 2 * 1024 * 1024) {
            return Result.failure(413, "File too large (max 2MB)");
        }

        // 读取文件字节（尝试 UTF-8 解码，失败回退系统默认编码）
        byte[] bytes;
        try {
            bytes = java.nio.file.Files.readAllBytes(target);
        } catch (Exception e) {
            return Result.failure(500, "Failed to read file: " + e.getMessage());
        }

        // 二进制探测：前 8KB 内出现 NUL（0x00）字节即判定二进制，返回 binary 标记而非乱码内容；
        // 前端据此改走预览路径（图片/PDF/音视频）或显示「不支持预览」占位
        int scanLen = Math.min(bytes.length, 8192);
        for (int i = 0; i < scanLen; i++) {
            if (bytes[i] == 0) {
                Map<String, Object> bin = new LinkedHashMap<>();
                bin.put("binary", true);
                bin.put("path", path);
                bin.put("name", file.getName());
                bin.put("size", file.length());
                return Result.succeed(bin);
            }
        }

        String content;
        try {
            content = new String(bytes, "UTF-8");
        } catch (Exception e) {
            content = new String(bytes);
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("content", content);
        data.put("path", path);
        data.put("name", file.getName());
        data.put("size", file.length());

        return Result.succeed(data);
    }

    /**
     * 解析原始字节读取（二进制预览流）的目标文件。
     * <p>沿用与 {@link #read} 一致的路径安全校验（拒绝 {@code ..}、必须位于根目录内），
     * 并限制文件大小（最大 {@link #RAW_MAX_SIZE} = 50MB）。校验通过后返回文件本身，
     * 由调用方负责按正确 Content-Type 输出字节流。</p>
     *
     * @param path 相对路径，基于根目录
     * @param root 可选的项目根目录（Code 模式）
     * @return 成功时 data 为目标文件；失败时携带对应 HTTP 语义错误码（400/403/404/413）
     */
    public Result<File> resolveForRaw(String path, String root) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }

        java.nio.file.Path workspacePath = resolveRoot(root);
        java.nio.file.Path target = workspacePath.resolve(path).toAbsolutePath().normalize();

        if (!target.startsWith(workspacePath)) {
            return Result.failure(403, "Access denied");
        }

        File file = target.toFile();
        if (!file.exists() || file.isDirectory()) {
            return Result.failure(404, "File not found");
        }
        if (file.length() > RAW_MAX_SIZE) {
            return Result.failure(413, "File too large (max 50MB)");
        }

        return Result.succeed(file);
    }

    /**
     * 写入（保存）文件内容。
     * <p>以根目录为基准，将文本内容以 UTF-8 覆盖写入指定路径。
     * 沿用与 {@link #read} 一致的路径安全校验（拒绝 {@code ..}、越界），
     * 并限制内容大小（最大 2MB）。目标必须是已存在的普通文件（编辑器保存场景）。</p>
     *
     * @param path    相对路径，基于根目录
     * @param content 待写入的完整文本内容
     * @param root    可选的项目根目录（Code 模式）
     * @return 保存结果，包含 path、name、size
     */
    public Result<Map> write(String path, String content, String root) {
        if (path == null || path.trim().isEmpty()) {
            return Result.failure(400, "Path is required");
        }
        if (path.contains("..")) {
            return Result.failure(400, "Invalid path");
        }
        if (content == null) {
            content = "";
        }

        java.nio.file.Path workspacePath = resolveRoot(root);
        java.nio.file.Path target = workspacePath.resolve(path).toAbsolutePath().normalize();

        if (!target.startsWith(workspacePath)) {
            return Result.failure(403, "Access denied");
        }

        byte[] bytes;
        try {
            bytes = content.getBytes("UTF-8");
        } catch (Exception e) {
            return Result.failure(500, "Encoding error: " + e.getMessage());
        }
        // 限制写入大小：2MB（与读取一致）
        if (bytes.length > 2 * 1024 * 1024) {
            return Result.failure(413, "Content too large (max 2MB)");
        }

        File file = target.toFile();
        // 仅允许保存已存在的普通文件，避免误建目录/新文件带来的越权风险
        if (!file.exists() || file.isDirectory()) {
            return Result.failure(404, "File not found");
        }

        try {
            java.nio.file.Files.write(target, bytes);
        } catch (Exception e) {
            return Result.failure(500, "Failed to write file: " + e.getMessage());
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("path", path);
        data.put("name", file.getName());
        data.put("size", file.length());

        return Result.succeed(data);
    }

    // ==================== 内部方法 ====================

    /**
     * 递归构建文件树结构。
     * <p>对指定目录进行扫描，目录排在前面、文件排在后面，均按名称字典序排列。
     * 仅跳过 {@link #EXCLUDED_DIRS} 中定义的条目（点前缀文件正常展示）。
     * 当达到最大深度时，目录节点不再展开（children 为 null）。</p>
     *
     * @param dir          当前扫描的目录路径
     * @param workspacePath 工作区根路径，用于计算相对路径
     * @param maxDepth     最大展开深度
     * @param currentDepth 当前递归深度
     * @return 当前层级的文件/目录信息列表
     */
    private List<Map> buildTree(java.nio.file.Path dir, java.nio.file.Path workspacePath, int maxDepth, int currentDepth) {
        File[] files = dir.toFile().listFiles();
        if (files == null) return Collections.emptyList();

        Arrays.sort(files, (a, b) -> {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.getName().compareToIgnoreCase(b.getName());
        });

        List<Map> result = new ArrayList<>();
        for (File f : files) {
            if (EXCLUDED_DIRS.contains(f.getName())) continue;

            Map<String, Object> item = new LinkedHashMap<>();
            item.put("type", f.isDirectory() ? "directory" : "file");

            if (f.isDirectory()) {
                // IDEA 风格紧凑目录：当目录「仅含一个子目录且无文件」时，沿单子链向下折叠到链尾，
                // 合并为一个节点展示（name 以 " \ " 拼接、path 指向链尾真实目录）；任一层出现兄弟节点即停止，保持层级展示。
                // 链探测与 depth 限制无关：即使节点处于折叠态（depth 用尽），名称也展示完整压缩路径。
                java.nio.file.Path chainPath = f.toPath();
                StringBuilder chainName = new StringBuilder(f.getName());
                File[] grandChildren = chainPath.toFile().listFiles();
                while (grandChildren != null) {
                    File onlyDir = null;
                    boolean collapsible = true;
                    for (File g : grandChildren) {
                        if (EXCLUDED_DIRS.contains(g.getName())) continue;
                        if (onlyDir == null && g.isDirectory()) { onlyDir = g; } else { collapsible = false; break; }
                    }
                    if (!collapsible || onlyDir == null) break;
                    chainPath = onlyDir.toPath();
                    chainName.append(" \\ ").append(onlyDir.getName());
                    grandChildren = chainPath.toFile().listFiles();
                }
                item.put("name", chainName.toString());
                item.put("path", workspacePath.relativize(chainPath.toAbsolutePath().normalize()).toString().replace('\\', '/'));
                if (currentDepth < maxDepth) {
                    item.put("expanded", true);
                    item.put("children", buildTree(chainPath, workspacePath, maxDepth, currentDepth + 1));
                } else {
                    item.put("expanded", false);
                    item.put("children", null);
                }
            } else {
                item.put("name", f.getName());
                item.put("path", workspacePath.relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/'));
            }
            result.add(item);
        }
        return result;
    }

    /**
     * 递归搜索匹配关键词的文件。
     *
     * @param dir       当前扫描的目录
     * @param workspacePath 工作区根路径，用于计算相对路径
     * @param keyword   小写化后的搜索关键词
     * @param results   收集结果的列表
     * @param depth     当前递归深度，超过 20 层停止
     */
    private void searchFiles(File dir, java.nio.file.Path workspacePath, String keyword, List<Map> results, int depth) {
        if (depth > 20) return;
        File[] files = dir.listFiles();
        if (files == null) return;

        for (File f : files) {
            if (EXCLUDED_DIRS.contains(f.getName())) continue;

            String relativePath = workspacePath.relativize(f.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/');

            if (relativePath.toLowerCase().contains(keyword)) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("name", f.getName());
                item.put("path", relativePath);
                item.put("type", f.isDirectory() ? "directory" : "file");
                results.add(item);
            }

            if (f.isDirectory()) {
                searchFiles(f, workspacePath, keyword, results, depth + 1);
            }
        }
    }
}
