package com.gourdai.harness.change;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 判定一条路径是否属于「临时产物」，即不该出现在文件变更面板里的东西。
 *
 * <p><b>为什么需要这个类：</b>GWork 有<b>三套</b>独立的目录名单——文件树
 * （{@code FileService.EXCLUDED_DIRS}）、工作区监听（{@code WorkspaceWatcher.EXCLUDED_DIRS}）
 * 与文件变更账本（本包）。前两者各自维护一份内容相同的清单，而账本<b>根本没有这份清单</b>，
 * 于是出现了一个自相矛盾的观感：同一批文件在文件树里看不见，却在「本轮变更」卡片里铺满整屏。
 * 用户实测的正是这个：Agent 为了验证自己改动而写的 {@code .tmp/*.js} 探测脚本、
 * {@code mvn_full.log}、对比截图乃至 {@code .class}，全被当成「产物」列了出来。</p>
 *
 * <p><b>为什么是「路径」而不是「文件名」：</b>按 {@code verify_*.js} / {@code probe_*.js}
 * 这类文件名做启发式过滤看着省事，但任意规则都可能误伤真实源码（例如项目里真有一个
 * {@code verify.js} 单元测试辅助）。目录语义是可靠的：一个叫 {@code .tmp} / {@code target}
 * 的目录，其内容按定义就是可丢弃的。因此这里只认路径段，不猜文件名。</p>
 *
 * <p><b>与文件树保持一致：</b>{@link #EPHEMERAL_DIRS} 刻意包含 {@code FileService.EXCLUDED_DIRS}
 * 的全部成员。不变式是「文件树里看不见的，变更卡里也不该出现」，而不是各写一份再慢慢漂移。
 * 若将来要调整，请改这一处并同步上面两个类——本类的存在就是为了让「哪几份名单要一起改」
 * 这件事有唯一答案。</p>
 *
 * <p><b>系统临时目录单列：</b>验证脚本的<b>首选</b>落点是系统临时目录（{@code java.io.tmpdir}），
 * 它天然在工作区之外。这类路径必须在 {@code validateRelativePath} 抛异常<b>之前</b>被识别，
 * 否则每写一个脚本都会走 catch 分支把本轮标成 {@code possiblyIncomplete}，
 * 把一个「不该显示」的问题恶化成「整轮变更都不可信」。</p>
 */
public final class EphemeralPaths {

    private EphemeralPaths() {
    }

    /**
     * 按目录名整段匹配的临时/可丢弃目录（<b>任意层级</b>都生效）。
     *
     * <p>前两组与 {@code FileService.EXCLUDED_DIRS} 逐字一致（工程元数据/版本控制/依赖/构建输出），
     * 第三组是本次新增的点前缀临时目录。</p>
     *
     * <p><b>只收点前缀形式的临时目录：</b>{@code .tmp}/{@code .scratch} 带前导点，语义上就是
     * 「工具自己的鬼次区」，不可能被误认为交付源码；而裸名 {@code tmp}/{@code temp}
     * 放在深层源码树里时很可能是真实目录（如 {@code src/tmp/}），见 {@link #ROOT_LEVEL_EPHEMERAL}。</p>
     */
    private static final Set<String> EPHEMERAL_DIRS = new HashSet<>(Arrays.asList(
            // —— 与 FileService.EXCLUDED_DIRS 对齐：元数据 & IDE ——
            ".gwork", ".gwork-remote", ".gourdai", ".claude", ".opencode",
            ".idea", ".vscode", ".settings",
            // —— 版本控制 & 构建工具 ——
            ".git", ".gradle", ".mvn",
            // —— 运行时缓存 ——
            ".pytest_cache", "__pycache__",
            // —— 依赖目录 ——
            "node_modules", "venv", "vendor",
            // —— 构建输出 ——
            "target", "build",
            // —— 点前缀临时目录（本次新增）——
            ".tmp", ".temp", ".scratch", ".cache"
    ));

    /**
     * 仅在<b>工作区根一级</b>才视为临时的目录名。
     *
     * <p>为什么区分层级：项目根下的 {@code tmp/}、{@code temp/}、{@code scratch/} 基本可以确定是
     * 丢东西的地方；但同一个名字出现在源码深处（{@code src/tmp/}）时，它很可能是一个真实目录，
     * 盲摸地抹掉会让用户看不到也撤销不了自己的真实文件——这比多显示几行噪声严重得多。</p>
     */
    private static final Set<String> ROOT_LEVEL_EPHEMERAL = new HashSet<>(Arrays.asList(
            "tmp", "temp", "scratch"
    ));

    /**
     * 点前缀形态的临时目录：{@code .tmp-1749...} 这类带后缀的变体（<b>任意层级</b>）。
     *
     * <p>实测来源：{@code .gitignore} 里除了 {@code .tmp/} 还有一条 {@code .tmp-*}，
     * 说明带后缀的临时目录是真实存在的用法，仅靠精确名匹配会漏。</p>
     *
     * <p><b>为什么裸前缀 tmp-/temp- 不在这里：</b>{@code .tmp-} 带前导点，语义上必然是工具鬼次区；
     * 而裸前缀 {@code tmp-} / {@code temp-} 在任意层级都会撞上真实名字——实测
     * {@code src/tmp-utils/Helper.java}、{@code src/tmp-guide.md}、{@code docs/temp-notes.md}
     * 都被旧实现误杀。它们改由 {@link #ROOT_LEVEL_EPHEMERAL_PREFIXES} 只在根一级生效。</p>
     */
    private static final String[] DOT_EPHEMERAL_DIR_PREFIXES = {".tmp-", ".temp-", ".scratch-"};

    /**
     * 裸前缀形态的临时目录，仅<b>工作区根一级</b>生效。
     *
     * <p>与 {@link #ROOT_LEVEL_EPHEMERAL} 同理：项目根下的 {@code tmp-1749/} 是丢东西的地方，
     * 但源码深处的 {@code src/tmp-utils/} 是真实目录。层级是唯一可靠的分辨依据。</p>
     */
    private static final String[] ROOT_LEVEL_EPHEMERAL_PREFIXES = {"tmp-", "temp-", "scratch-"};

    /**
     * 工作区内的相对路径是否落在临时目录里。
     *
     * <p><b>三条判据（都已踩过坑）：</b></p>
     * <ol>
     *   <li><b>先做 {@code ..} 规范化再判段</b>：旧实现直接 split 后跳过 {@code .}/{@code ..}，
     *       于是 {@code ../tmp/evil.js}（工作区<b>之外</b>的同级目录）被当成「根一级 tmp」而静音——
     *       真正的越界写入反而比普通越界更安静。同理 {@code src/../tmp/x} 规范化后是根级 tmp，
     *       旧实现却因为先看到 {@code src} 而判 false（漏过滤）。</li>
     *   <li><b>最后一段是文件名，不按目录名单判</b>：入参是<b>文件</b>的相对路径，
     *       因此末段命中 {@code build}/{@code vendor} 只说明「有个文件叫 build」，不是构建目录。
     *       旧实现在这里误杀 {@code scripts/build}、{@code bin/vendor}。目录名单只对非末段生效。</li>
     *   <li><b>裸名与裸前缀只认根一级</b>：见 {@link #ROOT_LEVEL_EPHEMERAL}。</li>
     * </ol>
     *
     * <p>越出工作区根的路径（如 {@code ../x}）一律返回 false：那不是本类的职责，
     * 应交给 {@code validateRelativePath} 报「不可追踪」并降完整性。</p>
     *
     * @param relativePath 相对工作区根的路径，{@code /} 或 {@code \} 分隔均可；末尾带 {@code /}
     *                     表示目录（此时末段也按目录名单判）
     */
    public static boolean isEphemeralRelative(String relativePath) {
        if (relativePath == null) return false;
        String normalized = relativePath.replace('\\', '/');
        boolean trailingSlash = normalized.endsWith("/");
        List<String> segments = normalizeSegments(normalized);
        // null = 越出工作区根；空 = 路径指向根本身。两者都不该被「临时产物」静音。
        if (segments == null || segments.isEmpty()) return false;

        for (int i = 0; i < segments.size(); i++) {
            String lower = segments.get(i).toLowerCase(Locale.ROOT);
            // Windows 上 .DS_Store 是文件不是目录，但它在 FileService 名单里；
            // 它是唯一以「文件名」形式进入名单的成员，故不分层级、不分段位都认。
            if (".ds_store".equals(lower)) return true;

            boolean lastSegment = i == segments.size() - 1;
            if (lastSegment && !trailingSlash) continue; // 末段是文件名，见上文判据 2

            if (EPHEMERAL_DIRS.contains(lower)) return true;
            boolean rootLevel = i == 0;
            if (rootLevel && ROOT_LEVEL_EPHEMERAL.contains(lower)) return true;
            for (String prefix : DOT_EPHEMERAL_DIR_PREFIXES) {
                if (lower.startsWith(prefix)) return true;
            }
            if (rootLevel) {
                for (String prefix : ROOT_LEVEL_EPHEMERAL_PREFIXES) {
                    if (lower.startsWith(prefix)) return true;
                }
            }
        }
        return false;
    }

    /**
     * 按 {@code /} 切段并消解 {@code .} 与 {@code ..}。
     *
     * @return 规范化后的段列表；若 {@code ..} 把路径推出根之外则返回 {@code null}
     */
    private static List<String> normalizeSegments(String p) {
        List<String> out = new ArrayList<>();
        for (String segment : p.split("/")) {
            if (segment.isEmpty() || ".".equals(segment)) continue;
            if ("..".equals(segment)) {
                if (out.isEmpty()) return null; // 越出工作区根
                out.remove(out.size() - 1);
                continue;
            }
            out.add(segment);
        }
        return out;
    }

    /**
     * 解析目标路径并判定是否为临时产物。
     *
     * <p>三种情况：</p>
     * <ol>
     *   <li><b>绝对路径但不在工作区内</b>：只有落在系统临时目录才跳过；其余（例如写另一个项目）
     *       保持既有语义，交由 {@code validateRelativePath} 报「不可追踪并降低本轮完整性」。</li>
     *   <li><b>绝对路径在工作区内</b>：按工作区内相对路径判定。</li>
     *   <li><b>相对路径</b>：按相对路径判定。</li>
     * </ol>
     *
     * <p>任何解析异常都返回 false（交给既有的严格校验去报错），本方法不吞掉真正的非法路径。</p>
     */
    public static boolean isEphemeralTarget(Path root, String filePath) {
        if (filePath == null) return false;
        String trimmed = filePath.trim();
        if (trimmed.isEmpty() || trimmed.indexOf('\0') >= 0) return false;
        // 逻辑挂载路径（@alias）与 ~ 路径无法在此可靠解析，交给原有校验分支处理
        char first = trimmed.charAt(0);
        if (first == '@' || first == '~') return false;
        try {
            Path supplied = Path.of(trimmed);
            if (supplied.isAbsolute()) {
                Path target = supplied.normalize();
                if (root == null || !target.startsWith(root)) {
                    return isSystemTemp(target);
                }
                return isEphemeralRelative(root.relativize(target).toString());
            }
            return isEphemeralRelative(trimmed);
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 是否位于系统临时目录（{@code java.io.tmpdir}，以及 Unix 上常见的 /tmp、/var/tmp）。
     *
     * <p>用 {@code toRealPath()} 比较是为了吃掉 macOS 的 {@code /var -> /private/var} 符号链接
     * 与 Windows 的 8.3 短名差异；解析失败则退回 normalize 后的字面比较。</p>
     *
     * <p><b>POSIX 候选必须做绝对性校验（已踩）：</b>Windows 上 {@code Path.of("/tmp")}
     * 的 {@code isAbsolute()} 是 <b>false</b>，{@code toAbsolutePath()} 会拼成
     * <b>当前盘符</b>下的 {@code D:\tmp}——而本机 {@code D:\tmp} 确实存在。
     * 若不校验，Windows 用户放在 {@code D:\tmp} 下的任意真实文件都会被当成系统临时产物静音，
     * 且判定结果随进程当前目录漂移。这也是一处「看起来跨平台、实际只在 POSIX 成立」的典型写法。</p>
     */
    public static boolean isSystemTemp(Path target) {
        if (target == null) return false;
        Path normalized = target.normalize();
        for (String candidate : systemTempRoots()) {
            if (candidate == null || candidate.isEmpty()) continue;
            Path tempRoot;
            try {
                Path raw = Path.of(candidate);
                // 相对形态的候选（Windows 上的 "/tmp"）无跨平台语义，直接跳过
                if (candidate.startsWith("/") && !raw.isAbsolute()) continue;
                tempRoot = raw.toAbsolutePath().normalize();
            } catch (Throwable e) {
                continue;
            }
            Path comparableTarget = normalized;
            try {
                // 目标可能尚不存在（before 快照即发生在写入之前），此时只对已存在的临时根取 realPath
                if (java.nio.file.Files.exists(tempRoot)) tempRoot = tempRoot.toRealPath();
                if (java.nio.file.Files.exists(normalized)) comparableTarget = normalized.toRealPath();
            } catch (Throwable ignored) {
                // 保持 normalize 结果
            }
            if (comparableTarget.startsWith(tempRoot)) return true;
        }
        return false;
    }

    private static String[] systemTempRoots() {
        String tmpdir = null;
        try {
            tmpdir = System.getProperty("java.io.tmpdir");
        } catch (Throwable ignored) {
            // SecurityManager 等极端环境下读不到，退回下面的固定候选
        }
        return new String[]{tmpdir, "/tmp", "/var/tmp"};
    }
}
