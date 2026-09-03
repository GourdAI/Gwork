package com.gourdai.core.config;

import org.noear.snack4.ONode;
import org.noear.solon.core.util.DateUtil;
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
import java.util.Date;

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

    public final static String SCOPE_USER = "user"; //作用域：用户（用局）
    public final static String SCOPE_LOCAL = "workspace"; //作用域：本地

    public static String getVersion() {
        return "v2026.6.21";
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


    public static boolean checkUpdate() {
        String tmp = getLastVersion();
        if (tmp != null) {
            Date lastDate = DateUtil.parseTry(tmp.substring(1));
            Date currDate = DateUtil.parseTry(getVersion().substring(1));

            if (lastDate != null && currDate != null) {
                if (lastDate.getTime() > currDate.getTime()) {
                    return true;
                }
            }
        }

        return false;
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
     * 马具技能存放区
     */
    public static final String getHarnessSkills() {
        return getHarnessHome() + "skills/";
    }

    /**
     * 马具子代理描述存放区
     */
    public static final String getHarnessAgents() {
        return getHarnessHome() + "agents/";
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
