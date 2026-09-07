package com.gourdai.core.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

/**
 * 构建指纹读取入口。
 *
 * <p>值来自构建期由 Maven filtering 生成的 classpath 资源 {@code /build-info.properties}
 * （模板见 {@code src/main/buildinfo/}，目录刻意放在 {@code src/main/resources} 之外，
 * 以免二进制前端资产被过滤、也避免 app.yml 里的 Solon 运行期占位符被误替换）。</p>
 *
 * <p><b>用途</b>：桌面端覆盖安装时，若旧 jar 被进程占用导致未被真正替换，运行期可通过
 * {@code /web/chat/meta} 暴露的 buildId / buildTime 自证「当前跑的后端与桌面壳不是同一次构建」。</p>
 *
 * <p><b>降级</b>：单测、IDE 直跑 target/classes 等拿不到该资源的场景，所有访问器一律回落
 * {@link #UNKNOWN}，绝不抛异常、绝不阻断启动。</p>
 *
 * <p><b>与 {@link AgentFlags#getVersion()} 的关系</b>：两者语义不同且不可合并。后者是硬编码的
 * 日期形态版本号，会被 {@code DateUtil.parseTry} 当日期解析用于更新检测；构建指纹只用于展示与
 * 比对，任何情况下都不要把它拼进 {@code AgentFlags.getVersion()}。</p>
 *
 * @author oisin
 * @see AgentFlags
 */
public class BuildInfo {
    private final static Logger LOG = LoggerFactory.getLogger(BuildInfo.class);

    /** classpath 资源位置（classes 根，绝对路径） */
    public final static String RESOURCE_BUILD_INFO = "/build-info.properties";

    /** 资源缺失或占位符未被替换时的回落值 */
    public final static String UNKNOWN = "unknown";

    public final static String KEY_VERSION = "build.version";
    public final static String KEY_TIME = "build.time";
    public final static String KEY_REVISION = "build.revision";
    public final static String KEY_ID = "build.id";

    /** 静态缓存：首次访问时加载一次，之后只读（Properties 本身不再变更） */
    private static volatile Properties cached;

    private static Properties props() {
        Properties local = cached;
        if (local == null) {
            synchronized (BuildInfo.class) {
                local = cached;
                if (local == null) {
                    local = load();
                    cached = local;
                }
            }
        }
        return local;
    }

    /**
     * 加载构建指纹资源。任何异常都只记日志并返回空集，保证调用方拿到的一定是可用对象。
     */
    private static Properties load() {
        Properties props = new Properties();
        try (InputStream is = BuildInfo.class.getResourceAsStream(RESOURCE_BUILD_INFO)) {
            if (is == null) {
                // 单测/IDE 直跑属正常场景，降级为 debug 以免污染日志
                LOG.debug("[BuildInfo] {} 不存在，构建指纹回落为 {}", RESOURCE_BUILD_INFO, UNKNOWN);
                return props;
            }
            props.load(new InputStreamReader(is, StandardCharsets.UTF_8));
        } catch (Throwable e) {
            LOG.warn("[BuildInfo] {} 读取失败，构建指纹回落为 {}: {}", RESOURCE_BUILD_INFO, UNKNOWN, e.getMessage());
            props.clear();
        }
        return props;
    }

    /**
     * 取值并清洗：缺失、空串、以及 filtering 未生效残留的 {@code ${...}} 字面量，统一回落 {@link #UNKNOWN}。
     */
    private static String get(String key) {
        try {
            String value = props().getProperty(key);
            if (value == null) {
                return UNKNOWN;
            }
            value = value.trim();
            if (value.isEmpty() || value.startsWith("${")) {
                return UNKNOWN;
            }
            return value;
        } catch (Throwable e) {
            // 兜底：静态初始化/资源解析的任何意外都不得外泄给调用方
            LOG.warn("[BuildInfo] 读取 {} 失败: {}", key, e.getMessage());
            return UNKNOWN;
        }
    }

    /**
     * 可读构建指纹：{@code <版本>-<ISO-8601 UTC 时间>-<短 revision>}，例如
     * {@code 2026.6.21-2026-09-06T06:59:13Z-a1b2c3d}。桌面端比对「后端与壳是否同一次构建」
     * 即用此值，把它当不透明字符串对待（不要尝试拆分或从中反推日期）。
     */
    public static String getBuildId() {
        return get(KEY_ID);
    }

    /**
     * 构建时间，Maven 产物的 ISO-8601 UTC 形态（形如 {@code 2026-09-06T06:59:13Z}，可直接
     * 被前端 {@code new Date(...)} 解析）。
     */
    public static String getBuildTime() {
        return get(KEY_TIME);
    }

    /**
     * 构建对应的制品版本（{@code project.version}）。注意与 {@link AgentFlags#getVersion()} 无关。
     */
    public static String getBuildVersion() {
        return get(KEY_VERSION);
    }

    /**
     * 构建对应的 git 短 revision；本地构建为 {@code local}。
     */
    public static String getBuildRevision() {
        return get(KEY_REVISION);
    }

    /**
     * 构建指纹是否真实可用（false 表示资源缺失，即非 mvn package 产物）。
     */
    public static boolean isResolved() {
        return UNKNOWN.equals(getBuildId()) == false;
    }
}
