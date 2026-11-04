/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.command.builtin;

import com.gourdai.ai.chat.content.ImageBlock;
import org.noear.solon.core.handle.UploadedFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Loop 任务级附件存储 —— {@code <workspace>/.gwork/loops/<taskId>/attachments/} 目录的读写与清理。
 *
 * <p>与前台会话附件（{@code <sessionDir>/uploads/}）刻意分目录：任务附件的生命周期跟随任务定义
 * （创建/更新时写入，删除任务时清理），每轮定时执行都会被重新注入 Prompt；会话附件的生命周期
 * 跟随一次对话。两者若共用目录，删任务会连带删掉用户会话里的历史附件。</p>
 *
 * <p>存储形态是「附件目录内的简单文件名」：{@link LoopTask#getAttachmentPaths()} 记的就是这个文件名，
 * 类型由同序的 {@link LoopTask#getAttachmentTypes()} 声明（{@code image} / {@code file}）。
 * 之所以不存绝对路径，是因为工作区目录可能整体搬迁（远端部署、换机恢复），
 * 绝对路径会在搬迁后集体失效，而「目录 + 文件名」始终可由当前 workspace 重新解析。</p>
 *
 * <p>安全口径与 {@code WebGate.sanitizeAttachmentPath} 一致：文件名中出现目录分隔符、{@code ..}、
 * 以 {@code .} 开头、含 {@code \0}、Windows 保留设备名一律判非法；落盘前再做一次
 * {@code startsWith(root)} 兜底比对，双重保证不会穿出附件目录。</p>
 *
 * @author oisin
 * @see LoopStateManager#getStateDir(String, String)
 */
public final class LoopAttachments {
    private static final Logger LOG = LoggerFactory.getLogger(LoopAttachments.class);

    /**
     * 按 taskId 的写互斥锁（2026-10-17 加固）。
     *
     * <p>save / update 定义写 / prune 三步若并发交错，会产生「定义指着已删字节」的悬空引用；
     * uniqueName 的 exists 探测与 copy 也是 check-then-act。以 taskId 为粒度的锁把
     * 同一任务的写链路串行化（不同任务互不阻塞）。锁表无界但条目极小（任务数级），
     * 任务删除不摘锁：残留一个空 StripedLock 对象无实质代价，摘除反而引入 use-after-remove 竞态。</p>
     */
    private static final java.util.concurrent.ConcurrentHashMap<String, Object> TASK_LOCKS =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 取（或建）某任务的写锁对象。 */
    private static Object taskLock(String taskId) {
        return TASK_LOCKS.computeIfAbsent(taskId, k -> new Object());
    }

    /** 附件在任务状态目录内的子目录名。 */
    public static final String ATTACHMENTS_DIR = "attachments";

    /**
     * 单个文件名（含扩展名）的最大长度。
     *
     * <p>Windows 单段文件名上限为 255，但附件目录还要叠上 workspace 前缀（路径总长限制），
     * 故取更保守的 180；超长时保留扩展名并截断主名，而不是整条拒绝——用户上传的截图名
     * 常常带一长串时间戳，直接拒绝会让他看到「附件莫名消失」。</p>
     */
    private static final int MAX_NAME_LENGTH = 180;

    /**
     * 同名冲突时的计数后缀重试上限。
     *
     * <p>超过即判非法：正常场景下同名文件不可能达到这个数量，命中说明目录里存在异常膨胀，
     * 继续无限探测只会把一次上传放大成上万次磁盘 stat。</p>
     */
    private static final int MAX_UNIQUE_ATTEMPTS = 1000;

    /** 支持的图片扩展名集合（与 WebGate 的图片判定同口径）。 */
    private static final Set<String> IMAGE_EXTENSIONS = org.noear.solon.Utils.asSet(
            ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg");

    /** Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9），忽略大小写、扩展名与尾随点/空格。 */
    private static final Set<String> WINDOWS_RESERVED_NAMES = org.noear.solon.Utils.asSet(
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9");

    private LoopAttachments() {
    }

    /**
     * 一次保存的结果。
     *
     * <p>{@code names} / {@code types} 严格同序且等长（落盘成功的条目），
     * {@code rejected}（文件名非法）与 {@code failed}（写盘 IO 失败）用于让调用方区分
     * 「用户传的名字不合法」与「磁盘出问题」，从而回不同的错误码。</p>
     */
    public static final class Saved {
        private final List<String> names;
        private final List<String> types;
        private final int rejected;
        private final int failed;

        Saved(List<String> names, List<String> types, int rejected, int failed) {
            this.names = names;
            this.types = types;
            this.rejected = rejected;
            this.failed = failed;
        }

        /** 落盘成功的文件名清单（附件目录内的简单文件名），与 {@link #getTypes()} 同序。 */
        public List<String> getNames() {
            return names;
        }

        /** 落盘成功条目的类型声明（{@code image} / {@code file}），与 {@link #getNames()} 同序。 */
        public List<String> getTypes() {
            return types;
        }

        /** 因文件名非法被跳过的条数。 */
        public int getRejected() {
            return rejected;
        }

        /** 因写盘失败被跳过的条数。 */
        public int getFailed() {
            return failed;
        }

        /** 是否一条也没存下（调用方据此明确失败，绝不静默当成上传成功）。 */
        public boolean isEmpty() {
            return names.isEmpty();
        }
    }

    // ==================== 目录解析 ====================

    /**
     * 解析任务附件目录：{@code <workspace>/<loops>/<taskId>/attachments}。
     *
     * @param workspace 工作空间根绝对路径（与 LoopScheduler 持久化任务时用的同一口径）
     * @param taskId    任务 ID
     * @return 附件目录路径（不保证已存在，写入前需 createDirectories）
     */
    public static Path dir(String workspace, String taskId) {
        return LoopStateManager.getStateDir(workspace, taskId).resolve(ATTACHMENTS_DIR);
    }

    /**
     * 解析任务附件目录（File 形态，供只需要 {@code java.io.File} 的调用方使用）。
     */
    public static java.io.File dirAsFile(String workspace, String taskId) {
        return dir(workspace, taskId).toFile();
    }

    /**
     * 解析附件目录内某个文件名的绝对路径；名字非法或会穿出附件目录时返回 null。
     *
     * <p>读盘（注入 Prompt、算 size）与删盘（prune / deleteAll）都必须走这里，
     * 保证「能被写进去的名字」与「能被读出来的名字」是同一套校验。</p>
     */
    public static Path resolve(String workspace, String taskId, String name) {
        String safe = sanitizeName(name);
        if (safe == null) {
            return null;
        }
        Path root = dir(workspace, taskId).toAbsolutePath().normalize();
        Path file = root.resolve(safe).normalize();
        return file.startsWith(root) ? file : null;
    }

    // ==================== 名称校验 ====================

    /**
     * 校验并规范化「附件目录内的简单文件名」。
     *
     * <p>拒绝：null / 空白、含 {@code \0}、含目录分隔符（{@code /} 或 {@code \}）、含 {@code ..}、
     * 以 {@code .} 开头（{@code .} / {@code ..} / 隐藏名）、Windows 保留设备名。
     * 超长名保留扩展名截断（见 {@link #MAX_NAME_LENGTH}）。</p>
     *
     * @param name 待校验的文件名
     * @return 合法时返回 trim（必要时截断）后的名字，非法时返回 null
     */
    public static String sanitizeName(String name) {
        if (name == null) {
            return null;
        }
        String n = name.trim();
        if (n.isEmpty() || n.indexOf('\0') >= 0) {
            return null;
        }
        // 浏览器上传的 IE 风格全路径（C:\dir\a.png / dir/a.png）在此被拒，而不是被当成一个怪名字落盘
        if (n.contains("/") || n.contains("\\") || n.contains("..")) {
            return null;
        }
        if (n.startsWith(".")) {
            return null;
        }
        if (isWindowsReservedName(n)) {
            return null;
        }
        if (n.length() > MAX_NAME_LENGTH) {
            n = truncateKeepExtension(n);
            if (n.isEmpty() || isWindowsReservedName(n)) {
                return null;
            }
        }
        return n;
    }

    /**
     * 判定文件名是否为 Windows 保留设备名。
     *
     * <p>Windows 会在任意目录下把 {@code CON}、{@code NUL.txt} 这类名字解释为设备而非普通文件，
     * 于是「落盘成功」与「能读回来」两件事在此类名字上并不等价；直接判非法比事后调试便宜。</p>
     */
    static boolean isWindowsReservedName(String name) {
        if (name == null || name.isEmpty()) {
            return false;
        }
        String base = name;
        int dot = base.indexOf('.');
        if (dot >= 0) {
            base = base.substring(0, dot);
        }
        base = base.trim();
        // 尾随点/空格在 Windows 上会被文件名语义吞掉（"CON." 仍是 CON）
        while (!base.isEmpty() && (base.endsWith(".") || base.endsWith(" "))) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.isEmpty()) {
            return false;
        }
        return WINDOWS_RESERVED_NAMES.contains(base.toUpperCase(Locale.ROOT));
    }

    /** 超长名截断：保留扩展名，主名从尾部截掉多余字符。 */
    private static String truncateKeepExtension(String name) {
        String ext = extOfName(name);
        int budget = MAX_NAME_LENGTH - ext.length();
        if (budget <= 0) {
            // 扩展名本身就超长：整体截断，扩展名不再保留
            return name.substring(0, MAX_NAME_LENGTH);
        }
        return name.substring(0, budget) + ext;
    }

    /**
     * 取文件名的小写扩展名（含点号），与 WebGate 的 {@code extOfName} 同口径。
     *
     * @param name 文件名，可为 null
     * @return {@code .ext} 形态；无扩展名时返回空串
     */
    public static String extOfName(String name) {
        if (name == null) {
            return "";
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return "";
        }
        return name.substring(dot).toLowerCase(Locale.ROOT);
    }

    /**
     * 判定附件是否按图片（多模态）处理。
     *
     * <p>必须由调用方声明类型而不能只看扩展名：前端允许把一张 png 当普通文件引用
     * （{@code attachmentType='file'}），按扩展名判定会把这种附件错误升级成多模态图片。</p>
     *
     * @param ext           扩展名（含点号，如 ".png"）
     * @param declaredType  前端声明的类型（{@code image} / {@code file}）
     * @return true 表示应作为图片处理
     */
    public static boolean isImage(String ext, String declaredType) {
        return "image".equals(declaredType) && IMAGE_EXTENSIONS.contains(ext);
    }

    /**
     * 扩展名映射为图片 MIME（未匹配时默认 {@code image/png}），与 WebGate 同口径。
     */
    public static String imageMime(String ext) {
        if (ext == null) {
            return "image/png";
        }
        switch (ext) {
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".gif":
                return "image/gif";
            case ".webp":
                return "image/webp";
            case ".bmp":
                return "image/bmp";
            case ".svg":
                return "image/svg+xml";
            case ".png":
            default:
                return "image/png";
        }
    }

    // ==================== 写入 ====================

    /**
     * 把上传的附件落盘到任务附件目录。
     *
     * <p>同名冲突不覆盖，而是加计数后缀（{@code a.png} → {@code a-1.png} → {@code a-2.png}）：
     * 任务附件是长期持久化的，覆盖会让「任务定义里记着的那条附件」在执行时悄悄换成另一份内容
     * （尤其是 {@code loop/update} 追加新上传时），这种分叉在事后几乎无法排查。</p>
     *
     * <p>单条失败只跳过该条（计入 {@code rejected} / {@code failed}），不整批失败：
     * 其余附件与任务定义本身照常生效。</p>
     *
     * @param workspace 工作空间根绝对路径
     * @param taskId    任务 ID
     * @param files     上传件数组，可为 null
     * @param types     与 files 同序的类型声明（{@code image} / {@code file}），可为 null
     * @return 保存结果；{@code files} 为空时返回空结果（不创建目录）
     * @throws IOException 附件目录不可用（无法创建）时抛出，调用方应明确失败
     */
    public static Saved save(String workspace, String taskId, UploadedFile[] files, String[] types) throws IOException {
        List<String> names = new ArrayList<>();
        List<String> typesOut = new ArrayList<>();
        int rejected = 0;
        int failed = 0;
        if (files == null || files.length == 0) {
            return new Saved(names, typesOut, rejected, failed);
        }

        // 同一任务的写链路串行化：防并发 save 互覆字节、防 save 与 prune 交错出悬空引用
        synchronized (taskLock(taskId)) {
            Path root = dir(workspace, taskId);
            Files.createDirectories(root);
            Path attachmentsRoot = root.toAbsolutePath().normalize();
            // 本批内已用掉的名字：同一次上传里出现两个同名文件时，第二个也要拿到独立名字
            Set<String> taken = new HashSet<>();

            for (int i = 0; i < files.length; i++) {
                UploadedFile file = files[i];
                if (file == null) {
                    continue;
                }
                String safe = sanitizeName(file.getName());
                if (safe == null) {
                    LOG.warn("[LoopAttachments] rejected unsafe attachment name for task {}: {}", taskId, file.getName());
                    rejected++;
                    continue;
                }
                String declared = (types != null && i < types.length) ? types[i] : null;
                String unique = uniqueName(attachmentsRoot, safe, taken);
                if (unique == null) {
                    LOG.warn("[LoopAttachments] cannot allocate unique name for task {}: {}", taskId, safe);
                    rejected++;
                    continue;
                }
                Path target = attachmentsRoot.resolve(unique);
                // 兜底：即便名字已通过校验，也再确认没有穿出附件目录
                if (!target.startsWith(attachmentsRoot)) {
                    LOG.warn("[LoopAttachments] attachment escaped attachments dir for task {}: {}", taskId, unique);
                    rejected++;
                    continue;
                }
                try (java.io.InputStream in = file.getContent();
                     java.io.OutputStream out = Files.newOutputStream(target,
                             java.nio.file.StandardOpenOption.CREATE_NEW)) {
                    // CREATE_NEW（2026-10-17 加固）：exists 探测与写盘非原子，并发下两路可能拿到
                    // 同一「唯一」名；REPLACE_EXISTING 会让后写者静默覆盖先写者字节——正是类注释
                    // 承诺要杜绝的「定义里记着的附件悄悄换内容」。已存在时抛 FileAlreadyExistsException，
                    // 计为 failed 留痕（锁内并发仅剩跨进程/跨实例，概率极低）。
                    // 注：CREATE_NEW 是 OpenOption，InputStream 版 Files.copy 只收 CopyOption，
                    // 故走 newOutputStream + transferTo（顺带补齐输入流关闭，旧 copy 不关流）。
                    in.transferTo(out);
                } catch (java.nio.file.FileAlreadyExistsException e) {
                    LOG.warn("[LoopAttachments] attachment name raced for task {}: {}", taskId, unique);
                    failed++;
                    continue;
                } catch (IOException | RuntimeException e) {
                    LOG.warn("[LoopAttachments] failed to save attachment {} for task {}: {}", unique, taskId, e.toString());
                    failed++;
                    continue;
                }
                taken.add(unique.toLowerCase(Locale.ROOT));
                names.add(unique);
                typesOut.add(isImage(extOfName(unique), declared) ? "image" : "file");
            }
            return new Saved(Collections.unmodifiableList(names), Collections.unmodifiableList(typesOut), rejected, failed);
        }
    }

    /**
     * 为待落盘文件名分配一个目录内唯一的名字：不冲突时原样返回，冲突时在主名后加 {@code -N} 计数后缀。
     *
     * @param root     附件目录（已规范化）
     * @param name     已通过 {@link #sanitizeName} 校验的文件名
     * @param takenInBatch 本批已占用的名字（小写）
     * @return 唯一名字；探测次数用尽时返回 null
     */
    private static String uniqueName(Path root, String name, Set<String> takenInBatch) {
        String candidate = name;
        String ext = extOfName(name);
        String base = name.substring(0, name.length() - ext.length());
        for (int i = 0; i < MAX_UNIQUE_ATTEMPTS; i++) {
            String key = candidate.toLowerCase(Locale.ROOT);
            boolean taken = takenInBatch.contains(key);
            if (!taken) {
                try {
                    taken = Files.exists(root.resolve(candidate));
                } catch (RuntimeException e) {
                    // 名字里含平台不接受的字符时 exists 可能抛 InvalidPathException：换一个候选名继续
                    taken = true;
                }
            }
            if (!taken) {
                return candidate;
            }
            // 【先预算主名再拼后缀】计数后缀恰挂在主名尾部：若先拼后缀再整体截断，
            // 截断会把后缀切掉、候选名塌缩回已存在的原名，1000 次探测全命中后返回 null，
            // 上传被静默计为 rejected（2026-10-17 review 实锤：sanitize 后恰好顶到长度上限的长名必现）。
            String suffix = "-" + (i + 1);
            int baseBudget = MAX_NAME_LENGTH - ext.length() - suffix.length();
            if (baseBudget < 1) {
                baseBudget = 1; // 极端超长扩展名：保 1 字符主名，总长略超上限仍远小于 Windows 255
            }
            String cappedBase = base.length() <= baseBudget ? base : base.substring(0, baseBudget);
            candidate = cappedBase + suffix + ext;
        }
        return null;
    }

    // ==================== 读取 ====================

    /**
     * 列出附件目录内的现有文件（文件名 → 字节大小），供 list/get 接口回 {@code attachmentSizes}。
     *
     * <p>目录不存在时返回空 Map；目录不可读时留痕并返回空 Map（读元信息失败不该让任务列表接口 500）。</p>
     */
    public static Map<String, Long> listMeta(String workspace, String taskId) {
        Map<String, Long> out = new LinkedHashMap<>();
        Path root = dir(workspace, taskId);
        if (!Files.isDirectory(root)) {
            return out;
        }
        try (Stream<Path> stream = Files.list(root)) {
            stream.filter(Files::isRegularFile)
                    .sorted()
                    .forEach(p -> {
                        String name = p.getFileName().toString();
                        long size;
                        try {
                            size = Files.size(p);
                        } catch (IOException | RuntimeException e) {
                            LOG.warn("[LoopAttachments] failed to read size of {}: {}", p, e.toString());
                            size = -1L;
                        }
                        out.put(name, size);
                    });
        } catch (IOException | RuntimeException e) {
            LOG.warn("[LoopAttachments] failed to list attachments dir {} for task {}: {}", root, taskId, e.toString());
            return out;
        }
        return out;
    }

    /**
     * 按给定文件名清单同序取大小；读不到的条目填 {@code -1}（保持与 paths 一一对应，前端不会错位）。
     */
    public static List<Long> sizesOf(Map<String, Long> meta, List<String> names) {
        List<Long> out = new ArrayList<>();
        if (names == null) {
            return out;
        }
        for (String name : names) {
            Long size = meta == null ? null : meta.get(name);
            out.add(size != null ? size : -1L);
        }
        return out;
    }

    /**
     * 把任务附件目录解析为「可注入本轮 Prompt」的素材（Path 形态的核心实现）。
     *
     * @param attachmentsRoot 附件目录（{@code <stateDir>/attachments}）
     * @see #resolveRefs(String, String, List, List, List, List)
     */
    public static void resolveRefs(Path attachmentsRoot, List<String> names, List<String> types,
                                   List<ImageBlock> imageBlocks, List<String> filePaths) {
        if (names == null || names.isEmpty() || attachmentsRoot == null) {
            return;
        }
        Path root = attachmentsRoot.toAbsolutePath().normalize();
        for (int i = 0; i < names.size(); i++) {
            String raw = names.get(i);
            String declared = (types != null && i < types.size()) ? types.get(i) : null;
            try {
                String safe = sanitizeName(raw);
                if (safe == null) {
                    LOG.warn("[LoopAttachments] skipped malformed attachment name: {}", raw);
                    continue;
                }
                Path file = root.resolve(safe).normalize();
                // 兜底：即便名字已通过校验，也再确认没有穿出附件目录
                if (!file.startsWith(root) || !Files.isRegularFile(file)) {
                    LOG.warn("[LoopAttachments] attachment missing under {}, skipped: {}", root, raw);
                    continue;
                }
                String name = file.getFileName().toString();
                if (!isImage(extOfName(name), declared)) {
                    filePaths.add(file.toString());
                    continue;
                }
                byte[] bytes = Files.readAllBytes(file);
                imageBlocks.add(ImageBlock.ofBase64(Base64.getEncoder().encodeToString(bytes), imageMime(extOfName(name))));
            } catch (IOException | RuntimeException e) {
                // 单条读失败只跳过并留痕：绝不因一个附件损坏而让整轮定时执行失败
                LOG.warn("[LoopAttachments] failed to read attachment {}: {}", raw, e.toString());
            }
        }
    }

    /**
     * 解析任务附件为「可注入本轮 Prompt」的素材：图片读成 base64 图片块，普通文件回绝对路径。
     *
     * <p>与前台 {@code WebGate.resolveAttachmentRefs} 同口径：类型由调用方声明（不按扩展名猜），
     * 单条读盘失败只跳过并留痕，绝不因一个附件损坏而让整轮定时执行失败。</p>
     *
     * @param workspace   工作空间根绝对路径
     * @param taskId      任务 ID
     * @param names       附件文件名清单（{@link LoopTask#getAttachmentPaths()}）
     * @param types       与 names 同序的类型声明（{@link LoopTask#getAttachmentTypes()}），可为 null
     * @param imageBlocks 输出参数：图片块按序追加
     * @param filePaths   输出参数：普通文件的<b>绝对路径</b>按序追加（AI 需据此真的读到文件）
     */
    public static void resolveRefs(String workspace, String taskId, List<String> names, List<String> types,
                                   List<ImageBlock> imageBlocks, List<String> filePaths) {
        if (names == null || names.isEmpty()) {
            return;
        }
        resolveRefs(dir(workspace, taskId), names, types, imageBlocks, filePaths);
    }

    // ==================== 清理 ====================

    /**
     * 删除附件目录内不在 keep 清单中的文件（{@code loop/update} 移除部分附件时使用）。
     *
     * <p>keep 中的每条都会先过 {@link #sanitizeName}：非法名字既不会被当成「保留」，
     * 也不会让 prune 去删一个由用户可控字符串拼出来的路径。只删普通文件，不动子目录
     * （附件目录当前不放子目录，保守处理避免误删状态目录里的其它内容）。</p>
     *
     * @param workspace 工作空间根绝对路径
     * @param taskId    任务 ID
     * @param keep      需要保留的文件名清单（null 视为空 → 删光目录内文件）
     */
    public static void prune(String workspace, String taskId, List<String> keep) {
        Path root = dir(workspace, taskId);
        if (!Files.isDirectory(root)) {
            return;
        }
        Set<String> keepSet = new HashSet<>();
        if (keep != null) {
            for (String name : keep) {
                String safe = sanitizeName(name);
                if (safe != null) {
                    keepSet.add(safe.toLowerCase(Locale.ROOT));
                }
            }
        }
        Path attachmentsRoot = root.toAbsolutePath().normalize();
        // 与 save 同一把任务锁：防「save 刚落盘、prune 按旧清单把它当孤儿删掉」的交错
        synchronized (taskLock(taskId)) {
            try (Stream<Path> stream = Files.list(attachmentsRoot)) {
                List<Path> files = stream.filter(Files::isRegularFile).collect(java.util.stream.Collectors.toList());
                for (Path file : files) {
                    String name = file.getFileName().toString();
                    if (keepSet.contains(name.toLowerCase(Locale.ROOT))) {
                        continue;
                    }
                    try {
                        Files.deleteIfExists(file);
                    } catch (IOException | RuntimeException e) {
                        LOG.warn("[LoopAttachments] failed to prune attachment {} for task {}: {}", file, taskId, e.toString());
                    }
                }
            } catch (IOException | RuntimeException e) {
                LOG.warn("[LoopAttachments] failed to list attachments dir for pruning, task {}: {}", taskId, e.toString());
            }
        }
    }

    /**
     * 删除任务的全部附件（含附件目录本身）。任务被移除时调用，避免状态目录里留下无主字节。
     *
     * <p>删除失败只留痕不抛出：任务已经从调度器与任务文件里摘掉了，
     * 让 HTTP 请求因「附件目录删不掉」而失败对用户毫无意义。</p>
     */
    public static void deleteAll(String workspace, String taskId) {
        Path root = dir(workspace, taskId);
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> stream = Files.walk(root)) {
            // 先删文件再删目录（深度倒序）
            List<Path> paths = stream.sorted((a, b) -> b.getNameCount() - a.getNameCount())
                    .collect(java.util.stream.Collectors.toList());
            for (Path p : paths) {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException | RuntimeException e) {
                    LOG.warn("[LoopAttachments] failed to delete attachment path {} for task {}: {}", p, taskId, e.toString());
                }
            }
        } catch (IOException | RuntimeException e) {
            LOG.warn("[LoopAttachments] failed to walk attachments dir for task {}: {}", taskId, e.toString());
        }
    }

    /**
     * 附件目录当前占用的字节数（诊断/日志用），目录不存在或不可读时返回 0。
     */
    public static long totalSize(String workspace, String taskId) {
        long total = 0L;
        for (Long size : listMeta(workspace, taskId).values()) {
            if (size != null && size > 0) {
                total += size;
            }
        }
        return total;
    }

    /**
     * 把外部传入的「保留清单」规范化：逐条 {@link #sanitizeName}，非法条目丢弃，返回去重后的有序清单。
     *
     * <p>{@code loop/update} 用它处理前端提交的 {@code attachmentKeepPaths}：前端可能回传绝对路径、
     * 带 {@code attachments/} 前缀的相对路径，或已被手工编辑过的脏值，统一在此收敛成简单文件名。</p>
     */
    public static List<String> normalizeNames(List<String> raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) {
            return out;
        }
        Set<String> seen = new HashSet<>();
        for (String item : raw) {
            if (item == null) {
                continue;
            }
            String trimmed = item.trim();
            // 含 .. 的条目一律 fail-closed 丢弃，不做 basename 宽容解释：
            // 「../evil.png」被重解释成「evil.png」会把用户意图之外的另一个文件标记为保留，
            // 同时把它真正想保留的那个文件删掉——这种静默改意图比直接拒绝更难排查。
            if (trimmed.isEmpty() || trimmed.contains("..")) {
                LOG.warn("[LoopAttachments] dropped malformed attachment keep entry: {}", item);
                continue;
            }
            String safe = sanitizeName(basename(trimmed));
            if (safe == null || !seen.add(safe.toLowerCase(Locale.ROOT))) {
                continue;
            }
            out.add(safe);
        }
        return out;
    }

    /**
     * 从可能带目录前缀的字符串里取最后一段文件名（{@code attachments/a.png} / {@code C:\x\a.png} → {@code a.png}）。
     *
     * <p>注意：这只用于「宽容地理解前端回传」，安全边界仍由 {@link #sanitizeName} 承担；
     * 含 {@code ..} 的条目在 {@link #normalizeNames} 里已被提前丢弃，不会走到这里被重解释。</p>
     */
    private static String basename(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.trim();
        int slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return slash >= 0 ? s.substring(slash + 1) : s;
    }

    /**
     * 便捷解析：直接给出附件目录的字符串形态（供日志与错误信息使用）。
     */
    public static String dirPath(String workspace, String taskId) {
        return Paths.get(dir(workspace, taskId).toString()).toAbsolutePath().normalize().toString();
    }
}
