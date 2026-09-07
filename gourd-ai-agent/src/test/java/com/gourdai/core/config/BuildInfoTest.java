package com.gourdai.core.config;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.util.DateUtil;

/**
 * 构建指纹（{@link BuildInfo}）单元测试。
 *
 * <p>只断言「结构不变量」，不硬编码时间戳与版本字面量，避免每次改版本都要改测试：</p>
 * <ol>
 *   <li>Maven filtering 必须已生效 —— 任何访问器都不得漏出未替换的 {@code ${...}} 字面量；</li>
 *   <li>红线守卫 —— {@link AgentFlags#getVersion()} 必须仍是可被日期解析的纯版本号，
 *       绝不能混入构建指纹。该方法的返回值会被 {@code DateUtil.parseTry(...substring(1))}
 *       当日期解析用于更新检测，一旦被拼接，更新检测将静默失效（无异常、无日志）。</li>
 * </ol>
 *
 * @author oisin
 */
class BuildInfoTest {

    @Test
    void mustNotLeakUnresolvedPlaceholder() {
        String[] values = {
                BuildInfo.getBuildId(),
                BuildInfo.getBuildTime(),
                BuildInfo.getBuildVersion(),
                BuildInfo.getBuildRevision()
        };

        for (String value : values) {
            Assertions.assertNotNull(value, "访问器不得返回 null（缺失时应回落 " + BuildInfo.UNKNOWN + "）");
            Assertions.assertFalse(value.trim().isEmpty(), "访问器不得返回空串（缺失时应回落 " + BuildInfo.UNKNOWN + "）");
            Assertions.assertFalse(value.contains("${"),
                    "Maven filtering 未生效，泄漏了未替换的占位符: " + value);
        }
    }

    @Test
    void buildIdMustBeComposedOfTheOtherFields() {
        Assertions.assertNotNull(BuildInfo.getBuildId());

        if (BuildInfo.UNKNOWN.equals(BuildInfo.getBuildId())) {
            // 单测在无 mvn 构建产物的环境下运行（如 IDE 直接跑）时允许整体降级为 unknown
            Assertions.assertFalse(BuildInfo.isResolved());
            return;
        }

        Assertions.assertTrue(BuildInfo.isResolved());
        Assertions.assertTrue(BuildInfo.getBuildId().contains(BuildInfo.getBuildVersion()),
                "buildId 应内嵌版本号，便于人眼判读");
        Assertions.assertTrue(BuildInfo.getBuildId().endsWith("-" + BuildInfo.getBuildRevision()),
                "buildId 应以 revision 结尾，保证三段式结构稳定");
    }

    /**
     * 红线回归：更新检测所依赖的版本号语义不得被构建指纹污染。
     */
    @Test
    void versionFlagMustRemainDateParsableAndUntouched() {
        String version = AgentFlags.getVersion();

        Assertions.assertNotNull(version);
        Assertions.assertTrue(version.length() > 1, "版本号至少应有前缀 + 日期体: " + version);
        Assertions.assertFalse(version.contains(BuildInfo.getBuildId()),
                "红线：buildId 一旦被拼进 AgentFlags.getVersion()，checkUpdate() 的日期解析将静默失效");
        Assertions.assertFalse(version.contains(BuildInfo.getBuildTime()),
                "红线：buildTime 同理，不得进入 AgentFlags.getVersion()");
        Assertions.assertNotNull(DateUtil.parseTry(version.substring(1)),
                "AgentFlags.getVersion() 去掉前缀后必须仍可被 DateUtil.parseTry 解析，否则更新检测已失效");
    }
}
