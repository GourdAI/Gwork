package com.gourdai.core.config;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 更新检测的版本比较契约（{@link AgentFlags#compareVersions}）。
 *
 * <p><b>为什么必须有这一组测试</b>：版本号从日期形态（{@code v2026.6.21}）切换为语义化版本
 * （{@code v0.2.3}）时，旧的 {@code checkUpdate()} 依赖 {@code DateUtil.parseTry} 把版本当日期解析。
 * 换成 {@code 0.2.3} 后该解析恒返 null，而原实现对此**既不报错也不打日志**，只是跳过比较、
 * 永远返回「无新版本」——这是一个安静到没人会发现的失效。故这里逐条钉死版本比较的行为，
 * 尤其是“按数值而不是按字典序”这条：用字符串比较的话 {@code 0.10.0} 会被判成小于 {@code 0.9.9}。</p>
 *
 * <p>断言一律用行为（比较结果）而不是源码字符串，避免把实现细节锁成契约。</p>
 */
class VersionCompareTest {

    /** 升序的三个版本，后者必须大于前者。 */
    @Test
    void numericSegmentsCompareByValueNotLexicographically() {
        Assertions.assertTrue(AgentFlags.compareVersions("v0.10.0", "v0.9.9") > 0,
                "0.10.0 必须大于 0.9.9（按字典序比较会得出相反结论）");
        Assertions.assertTrue(AgentFlags.compareVersions("v0.9.9", "v0.10.0") < 0,
                "反向比较必须是负数");
        Assertions.assertTrue(AgentFlags.compareVersions("v10.0.0", "v9.9.9") > 0,
                "主版本段同理");
    }

    /** 同版本必须返回 0，包括带不带 v 前缀、有没有补零段的情况。 */
    @Test
    void equalVersionsReturnZero() {
        Assertions.assertEquals(0, AgentFlags.compareVersions("v0.2.3", "v0.2.3").intValue());
        Assertions.assertEquals(0, AgentFlags.compareVersions("0.2.3", "v0.2.3").intValue(),
                "前导 v 不应影响相等判定");
        Assertions.assertEquals(0, AgentFlags.compareVersions("v0.2", "v0.2.0").intValue(),
                "段数不足按 0 补齐，0.2 等价于 0.2.0");
    }

    /** 预发布后缀：同号版本下预发布小于正式版。 */
    @Test
    void prereleaseIsLowerThanReleaseWithSameCore() {
        Assertions.assertTrue(AgentFlags.compareVersions("v0.2.3", "v0.2.3-beta.1") > 0,
                "已发布的 0.2.3 要比 0.2.3-beta.1 新，否则用户会收到降级提示");
        Assertions.assertTrue(AgentFlags.compareVersions("v0.2.3-beta.1", "v0.2.3") < 0,
                "预发布版不应被判成比正式版新");
    }

    /** 无法解析时返回 null，而不是抛异常或假装相等。 */
    @Test
    void unparsableReturnsNull() {
        Assertions.assertNull(AgentFlags.compareVersions(null, "v0.2.3"));
        Assertions.assertNull(AgentFlags.compareVersions("v0.2.3", null));
        Assertions.assertNull(AgentFlags.compareVersions("vNext", "v0.2.3"),
                "完全不含数字的串必须判为无法解析");
    }

    /**
     * 脏数据不得引发异常：这是抽 {@link AgentFlags#isRemoteNewer} 出来的直接动机。
     *
     * <p>若某天有人把判空去掉（写成 {@code compareVersions(...) > 0}），Integer 拆箱会抛
     * {@link NullPointerException}，而调用方在守护线程里 catch Throwable 什么都不打——
     * 表现就是“更新检测莫名其妙不工作了”。这里锁定“不抛、返 false”的退化语义。</p>
     */
    @Test
    void unparsableRemoteMustNotTriggerOrThrow() {
        Assertions.assertFalse(AgentFlags.isRemoteNewer(null, "v0.2.3"));
        Assertions.assertFalse(AgentFlags.isRemoteNewer("v0.2.3", null));
        Assertions.assertFalse(AgentFlags.isRemoteNewer("vNext", "v0.2.3"),
                "远端脏数据不能弹假的更新提示");
        Assertions.assertFalse(AgentFlags.isRemoteNewer("v", "v0.2.3"));
    }

    /**
     * 红线：当前后端版本必须能被同一套比较逻辑解析。
     *
     * <p>这条守的是「切换版本体系时漏改 {@link AgentFlags#checkUpdate()}」这个具体事故：
     * 只要 getVersion() 的形态与 compareVersions 的解析能力不匹配，更新检测就会静默失效。</p>
     */
    @Test
    void currentVersionMustBeComparable() {
        String current = AgentFlags.getVersion();
        Assertions.assertNotNull(AgentFlags.compareVersions(current, current),
                "当前版本号必须能被 compareVersions 解析: " + current);
        Assertions.assertTrue(AgentFlags.isRemoteNewer("v999.0.0", current),
                "远端更高版本必须能识别为“有更新”");
        Assertions.assertFalse(AgentFlags.isRemoteNewer(current, current),
                "同版本不得提示更新");
    }
}
