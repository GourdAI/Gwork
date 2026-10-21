package com.gourdai.core.config;

import org.noear.snack4.ONode;
import org.noear.solon.core.util.IoUtil;
import org.noear.solon.net.http.HttpUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 *
 * @author oisin
 *
 */
public class AgentFlags {
    private final static Logger LOG = LoggerFactory.getLogger(AgentFlags.class);
    public final static String NAME_CONFIG_YML = "config.yml";
    public final static String NAME_SETTINGS_JSON = "settings.json";
    public final static String NAME_AGENTS_MD = "AGENTS.md";

    public final static String X_SESSION_ID = "X-Session-Id";
    public final static String X_SESSION_CWD = "X-Session-Cwd";

    public final static String FLAG_VERSION = "version";

    public final static String FLAG_RUN = "run";
    public final static String FLAG_SERVE = "serve";
    public final static String FLAG_ACP = "acp";
    public final static String FLAG_WEB = "web";
    public final static String FLAG_CLI = "cli";

    /** 远端部署模式标记（见 远程工作区方案.md 方案 A）：桌面端 SSH 部署链启动远端 jar 时注入
     * {@code -Dgwork.remote=true}。meta 接口据此回告前端「当前后端跑在远程主机」，前端可渲染远程徽标。 */
    public final static String PROP_REMOTE = "gwork.remote";

    /** 远端模式 Web Basic Auth 凭据（优先 {@code GWORK_WEB_AUTH} 环境变量，回退
     * {@code -Dgwork.web.auth} 系统属性）。
     * 由桌面端在每次连接时随机生成注入。环境变量优先的原因（P1-3 修复）：命令行
     * -D 参数在远端 ps -ef 下对同机所有用户可见，JAVA_TOOL_OPTIONS 还会把内容整行
     * 写进 "Picked up …" 日志；环境变量仅 /proc/PID/environ（属主可读）。
     * 仅存远端进程内存，不落盘；优先级高于 settings.json 的 webAuthUser/webAuthPass
     * （远端机器的 settings 属于远端用户，桌面端不应写入；且凭据随连接生成、
     * 断连即换，落盘无意义）。 */
    public final static String PROP_REMOTE_WEB_AUTH = "gwork.web.auth";

    /** 凭据注入的环境变量名（见 {@link #PROP_REMOTE_WEB_AUTH}，优先生效）。 */
    public final static String ENV_REMOTE_WEB_AUTH = "GWORK_WEB_AUTH";

    public final static String SCOPE_USER = "user"; //作用域：用户（用局）
    public final static String SCOPE_LOCAL = "workspace"; //作用域：本地

    /**
     * 当前后端版本号（带前导 {@code v}，展示形态）。
     *
     * <p><b>版本体系已从日期形态（{@code v2026.6.21}）切换为语义化版本（{@code v0.2.3}）。</b>
     * 切换到语义化版本时有个必须同步改的隐患：旧 {@link #checkUpdate()} 用
     * {@code DateUtil.parseTry(version.substring(1))} 把版本号当**日期**比较；
     * 换成 {@code 0.2.3} 后该解析恒返 null，旧逻辑会直接跳过比较、
     * **永远判「无新版本」且不报任何异常** —— 更新检测就这样静默失效。
     * 故本方法必须与 {@link #compareVersions} 配合使用，绝不能再拿版本号去当日期解析。</p>
     *
     * <p>本值是后端的**唯一权威**：pom 的 {@code project.version}、{@code setup/info.json}、
     * 两个 setup 脚本的下载地址、桌面壳（Electron/Tauri）的版本声明、README 徐标全部与它对齐。</p>
     */
    public static String getVersion() {
        return "v0.2.3";
    }

    private static String lastVersion;

    public static String getLastVersion() {
        if (lastVersion == null) {
            try {
                String json = HttpUtils.http("https://www.gourd-ai.cn/info.json")
                        .timeout(2)
                        .get();

                lastVersion = ONode.ofJson(json).get("cli_version").getValueAs();
            } catch (Throwable e) {
                LOG.warn("Update detection failed: {}", e.getMessage());
            }
        }

        return lastVersion;
    }


    /**
     * 检查是否有新版本。
     *
     * <p>远端 {@code info.json} 的 {@code cli_version} 与本地 {@link #getVersion()} 都按
     * 语义化版本比较（见 {@link #compareVersions}）。任一侧解析不出数字段时一律返回
     * {@code false}：宁可漏提示一次，也不能因为远端返回脏数据就弹一个假的更新提示。</p>
     */
    public static boolean checkUpdate() {
        return isRemoteNewer(getLastVersion(), getVersion());
    }

    /**
     * 远端版本是否比本地新（{@link #checkUpdate()} 的纯函数内核）。
     *
     * <p><b>为什么单独抽出来</b>：{@link #checkUpdate()} 需要发 HTTP 请求，无法在单测中稳定复现；
     * 而“脏数据不能引发异常”这个分支又恰恰最容易写错——{@link #compareVersions} 解析失败时返回
     * {@code null}，直接写 {@code compareVersions(...) > 0} 会因 {@code Integer} 自动拆箱抛
     * {@link NullPointerException}。抽出纯函数后，这条分支才能被真实测到。</p>
     *
     * @param remote 远端版本号（如 {@code info.json} 的 {@code cli_version}），可为 null
     * @param local  本地版本号，可为 null
     * @return 远端严格高于本地时 true；任一为 null 或无法解析时 false（宁可不提示，也不弹假的更新提示）
     */
    static boolean isRemoteNewer(String remote, String local) {
        Integer result = compareVersions(remote, local);
        // 必须显式判空：compareVersions 解析失败返回 null，直接比较会拆箱 NPE。
        return result != null && result > 0;
    }

    /**
     * 语义化版本比较。
     *
     * <p>支持的形态：{@code v1.2.3} / {@code 1.2.3} / {@code 1.2.3-beta.1}，段数不足时以 0 补齐
     * （{@code 0.2} 等价于 {@code 0.2.0}）。比较按数值而非字典序，故 {@code 0.10.0 > 0.9.9}。
     * 预发布后缀存在的那个版本小于同号正式版（{@code 1.0.0-beta < 1.0.0}），与 semver 一致。</p>
     *
     * <p>容错：前导 {@code v} 大小写不忌；某段含非数字（如 {@code 1.2.x}）时该段按 0 计；
     * 主版本段完全解析不出数字时返回 {@code null}，由调用方决定降级策略（不抛异常）。</p>
     *
     * @return 正数表示 {@code left} 更新，负数表示 {@code right} 更新，0 表示同版；无法解析时 {@code null}
     */
    static Integer compareVersions(String left, String right) {
        int[] l = parseVersion(left);
        int[] r = parseVersion(right);
        if (l == null || r == null) {
            return null;
        }
        // 预发布标记接在最后一个段上：下标 3 位是标记，值 1=正式版 0=预发布
        for (int i = 0; i < 3; i++) {
            if (l[i] != r[i]) {
                return l[i] > r[i] ? 1 : -1;
            }
        }
        return Integer.compare(l[3], r[3]);
    }

    /**
     * 把版本串解成 {@code [major, minor, patch, releaseFlag]}；解不出主段时返 {@code null}。
     *
     * <p>{@code releaseFlag}：正式版 1、带预发布后缀 0。这样统一在同一个比较循环里处理，
     * 不必在 {@link #compareVersions} 里为后缀单开分支。</p>
     */
    private static int[] parseVersion(String raw) {
        if (raw == null) {
            return null;
        }
        String text = raw.trim();
        if (text.startsWith("v") || text.startsWith("V")) {
            text = text.substring(1);
        }
        // 预发布/构建元数据后缀不参与数字比较，只区分“是不是正式版”
        boolean prerelease = false;
        int cut = text.length();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '-' || c == '+') {
                prerelease = c == '-';
                cut = i;
                break;
            }
        }
        String core = text.substring(0, cut);
        String[] parts = core.split("\\.");
        if (parts.length == 0) {
            return null;
        }
        int[] result = {0, 0, 0, prerelease ? 0 : 1};
        boolean anyNumeric = false;
        for (int i = 0; i < 3 && i < parts.length; i++) {
            String part = parts[i].trim();
            if (part.isEmpty()) {
                continue;
            }
            try {
                result[i] = Integer.parseInt(part);
                anyNumeric = true;
            } catch (NumberFormatException e) {
                // 该段非纯数字（如 1.x）按 0 计，不让脏数据阻断整个比较
            }
        }
        return anyNumeric ? result : null;
    }

    //------------------

    //马具目录（品牌升级 Gourd AI → GWork 后，全局区/工作区目录统一为 .gwork）
    private static final String harnessHome = ".gwork/";

    /** 旧品牌时期的马具目录名（仅用于启动时一次性迁移，勿再用于新路径拼接） */
    private static final String LEGACY_HARNESS_HOME = ".gourdai";

    /** 当前进程工作目录；项目级数据仍以此作为默认工作区根。 */
    public static String getUserDir() {
        return System.getProperty("user.dir");
    }

    /**
     * 用户主目录（操作系统真实 HOME）。
     */
    public static String getUserHome() {
        return System.getProperty("user.home");
    }

    /**
     * 马具全局区落盘基目录（返回值不包含 {@code .gwork}）。
     *
     * <p>解析顺序：trim 后的系统属性 {@code -Dgwork.home} → 环境变量
     * {@code GWORK_HOME} → 旧名 {@code -Dgourdai.home} / {@code GOURDAI_HOME}
     * → {@code user.home}。显式 override 允许启动器把多个入口指向同一全局区。</p>
     *
     * <p><b>行为变更（全局区统一到用户目录）</b>：兜底值由 {@code user.dir}（进程当前
     * 工作目录）改为 {@code user.home}。桌面端与安装脚本生成的启动器都会显式注入
     * {@code -Dgwork.home}，不受影响；但**直接 java -jar 且不带任何注入**的裸 CLI 用法，
     * 全局区会从「当前目录/.gwork」变为「~/.gwork」，升级后位置发生变化，需在发布说明中告知。</p>
     */
    public static String getHarnessBase() {
        String home = trimmed(System.getProperty("gwork.home"));
        if (home == null) {
            home = trimmed(System.getenv("GWORK_HOME"));
        }
        if (home == null) {
            home = trimmed(System.getProperty("gourdai.home"));
        }
        if (home == null) {
            home = trimmed(System.getenv("GOURDAI_HOME"));
        }
        return home != null ? home : trimmed(getUserHome());
    }

    private static String trimmed(String value) {
        if (value == null) {
            return null;
        }
        String result = value.trim();
        return result.isEmpty() ? null : result;
    }

    /**
     * 远端部署模式的 Basic Auth 凭据（环境变量 {@code GWORK_WEB_AUTH} 优先，回退
     * {@code -Dgwork.web.auth} 系统属性）。
     *
     * <p>仅在远端部署模式下由桌面端注入（见 {@link #PROP_REMOTE_WEB_AUTH}）。返回
     * {@code [user, pass]}；未注入/格式非法（缺冒号、空用户名、空密码）一律返回 null
     * ——解析失败降级为「未配置」，走 settings.json 原有路径，而不是拿着畸形凭据拒掉所有请求。</p>
     */
    public static String[] getRemoteWebAuth() {
        String raw = trimmed(System.getenv(ENV_REMOTE_WEB_AUTH));
        if (raw == null) {
            raw = trimmed(System.getProperty(PROP_REMOTE_WEB_AUTH));
        }
        if (raw == null) {
            return null;
        }
        int idx = raw.indexOf(':');
        if (idx <= 0 || idx >= raw.length() - 1) {
            return null;
        }
        return new String[]{raw.substring(0, idx), raw.substring(idx + 1)};
    }

    /** 远端部署模式标记（桌面端 SSH 部署链注入 {@code -Dgwork.remote=true}）。 */
    public static boolean isRemoteDeployed() {
        return Boolean.parseBoolean(trimmed(System.getProperty(PROP_REMOTE)));
    }

    /**
     * 将全局根中的旧 {@code .gourdai} 兼容合并到 {@code .gwork}。
     * 项目根不在此处理；项目级旧目录由 {@link com.gourdai.core.portal.web.SessionLocator} 懒迁移。
     * 目标内容优先补缺，任何失败仅记录日志，不阻断启动。
     */
    public static void migrateLegacyHarnessHome() {
        try {
            String base = getHarnessBase();
            if (base != null && !base.trim().isEmpty()) {
                migrateLegacyDir(Paths.get(base.trim()));
            }
        } catch (Throwable e) {
            LOG.warn("[AgentFlags] Legacy harness home migration failed: {}", e.getMessage());
        }
    }

    private static void migrateLegacyDir(Path root) throws java.io.IOException {
        Path legacy = root.resolve(LEGACY_HARNESS_HOME);
        Path current = root.resolve(harnessHome);
        if (!Files.isDirectory(legacy)) {
            return;
        }
        if (!Files.exists(current)) {
            Files.createDirectories(current);
        }
        // 先整树复制，全部成功后才回收源：中途失败时旧目录仍然完整，下次启动可重跑；
        // 逐文件 move 会在失败时把数据劈成两半，故不再使用。
        java.util.List<Path> copied = new java.util.ArrayList<>();
        mergeLegacyContents(legacy, current, true, copied);
        // 只回收**本次确认复制成功**的源文件。不能改用「目标存在就删源」判定：
        // 冲突项（目标已有同名文件，源压根没被复制）会被误删，比旧 move 实现更激进。
        for (Path source : copied) {
            try {
                Files.deleteIfExists(source);
            } catch (Exception e) {
                LOG.warn("[AgentFlags] 旧文件回收失败 {}: {}", source, e.getMessage());
            }
        }
        deleteEmptyTree(legacy);
        LOG.info("[AgentFlags] 旧马具目录已合并: {} → {}", legacy, current);
    }

    /**
     * 复制旧目录内容到新目录，目标已存在则保留目标（补缺语义）。
     *
     * @param topLevel {@code bin} 与嵌套旧根只在**迁移源根部**具有特殊含义。若在每层递归都跳过
     *                 {@code bin}，会静默丢弃 {@code skills/<name>/bin}、{@code extensions/<name>/bin}
     *                 等合法的嵌套数据。
     * @param copied   收集复制成功的源文件，供调用方在整树完成后统一回收。
     */
    private static void mergeLegacyContents(Path source, Path target, boolean topLevel,
                                            java.util.List<Path> copied) throws java.io.IOException {
        try (java.util.stream.Stream<Path> children = Files.list(source)) {
            for (Path child : children.toList()) {
                String name = child.getFileName().toString();
                if (topLevel) {
                    // 根部 bin 是旧启动器，由 cli-provision/安装脚本重建，不迁移。
                    if ("bin".equals(name)) {
                        continue;
                    }
                    // 修复历史误写入的 .gourdai/.gourdai：嵌套旧根内容直接并入当前根。
                    if (LEGACY_HARNESS_HOME.equals(name) && Files.isDirectory(child)) {
                        mergeLegacyContents(child, target, true, copied);
                        continue;
                    }
                }
                Path destination = target.resolve(name);
                if (Files.isDirectory(child)) {
                    if (Files.exists(destination) && !Files.isDirectory(destination)) {
                        continue;
                    }
                    if (!Files.exists(destination)) {
                        Files.createDirectories(destination);
                    }
                    mergeLegacyContents(child, destination, false, copied);
                } else if (!Files.exists(destination)) {
                    Files.createDirectories(destination.getParent());
                    Files.copy(child, destination);
                    copied.add(child);
                }
            }
        }
    }

    private static void deleteEmptyTree(Path directory) {
        try {
            if (Files.isDirectory(directory)) {
                try (java.util.stream.Stream<Path> children = Files.list(directory)) {
                    children.forEach(AgentFlags::deleteEmptyTree);
                }
                Files.deleteIfExists(directory);
            }
        } catch (Exception ignored) {
            // 兼容迁移失败不应阻断启动；下次启动继续尝试
        }
    }

    public static String getUserExtensions() {
        return Paths.get(getHarnessBase(), getHarnessHome(), "extensions").toString();
    }

    public static URL getConfigUrl() throws MalformedURLException {
        //1. 工作区配置
        Path path = Paths.get(getUserDir(), getHarnessHome(), NAME_CONFIG_YML);
        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        //2. 全局区配置（安装目录）
        path = Paths.get(getHarnessBase(), getHarnessHome(), NAME_CONFIG_YML);

        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        return null;
    }

    public static URL getAgentsUrl() throws MalformedURLException {
        //1. 工作区配置
        Path path = Paths.get(getUserDir(), getHarnessHome(), NAME_AGENTS_MD);
        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        //2. 全局区配置（安装目录）
        path = Paths.get(getHarnessBase(), getHarnessHome(), NAME_AGENTS_MD);

        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        return null;
    }

    public static String getAgentsMd() {
        try {
            URL agentsUrl = getAgentsUrl();

            if (agentsUrl != null) {
                try (InputStream is = agentsUrl.openStream()) {
                    String content = IoUtil.transferToString(is, "utf-8").trim();

                    if (content.length() > 10000) { // 例如限制在 1万字符以内
                        LOG.warn("AGENTS.md is too large, truncating...");
                        return content.substring(0, 10000);
                    }
                    return content;
                }
            }
        } catch (Throwable e) {
            LOG.warn("AGENTS.md load failure: {}", e.getMessage(), e);
        }

        return null;
    }

    /**
     * 马具主目录
     */
    public static final String getHarnessHome() {
        return harnessHome;
    }

    /**
     * 马具会话存放区
     */
    public static final String getHarnessSessions() {
        return getHarnessHome() + "sessions/";
    }

    /**
     * 马具命令描述存放区
     */
    public static final String getHarnessCommands() {
        return getHarnessHome() + "commands/";
    }

    /**
     * 马具记忆存放区
     */
    public static final String getHarnessMemory() {
        return getHarnessHome() + "memory/";
    }

    /**
     * 马具下载存放区
     */
    public static final String getHarnessDownload() {
        return getHarnessHome() + "download/";
    }

    /**
     * 马具连接通道存放区
     */
    public static final String getHarnessChannels() {
        return getHarnessHome() + "channels/";
    }

    /**
     * 马具循环任务状态存放区
     */
    public static final String getHarnessLoops() {
        return getHarnessHome() + "loops/";
    }

    /**
     * 马具循环任务 worktree 存放区
     */
    public static final String getHarnessLoopWorktrees() {
        return getHarnessHome() + "loop-worktrees/";
    }
}
