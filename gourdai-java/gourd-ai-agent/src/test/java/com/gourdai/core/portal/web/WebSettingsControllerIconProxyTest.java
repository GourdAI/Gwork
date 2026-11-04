package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * 技能图标代理的安全门禁测试 — {@link WebSettingsController#fetchIcon(String)}。
 *
 * <p>本端点是「用户可控 URL 的服务端 fetch」，即 SSRF 面：市场元数据的 iconUrl
 * 与已安装元数据的 iconUrl 都可被上游/本地文件影响，最终拼进 /skills/icon?url=。
 * 门禁契约：</p>
 * <ul>
 *   <li>仅 http/https；file/jar/gopher 等 scheme 一律 null；</li>
 *   <li>主机落在回环/私网/链路本地/组播/任意地址/IPv6 ULA 一律 null（含解析失败）；</li>
 *   <li>重定向手动限跳且每跳重新校验（由 fetchIcon 循环结构保证，此处锁常量）。</li>
 * </ul>
 *
 * <p>不发起真实外网请求：本类只测「拒绝面」（纯本地判定），公网拉取的成功路径
 * 由集成环境人工验收，避免单测依赖外网。</p>
 */
class WebSettingsControllerIconProxyTest {

    @Test
    @DisplayName("非 http(s) scheme 一律拒绝")
    void rejectsNonHttpSchemes() {
        Assertions.assertNull(WebSettingsController.fetchIcon("file:///C:/Windows/win.ini"));
        Assertions.assertNull(WebSettingsController.fetchIcon("jar:file:///x.zip!/a.png"));
        Assertions.assertNull(WebSettingsController.fetchIcon("gopher://127.0.0.1:6379/_INFO"));
        Assertions.assertNull(WebSettingsController.fetchIcon("//example.com/a.png"), "协议相对 URL 不得放行");
        Assertions.assertNull(WebSettingsController.fetchIcon("/web/settings/skills/installed"), "站内相对路径不得被代理");
        Assertions.assertNull(WebSettingsController.fetchIcon(null));
        Assertions.assertNull(WebSettingsController.fetchIcon(""));
    }

    @Test
    @DisplayName("内网/回环/链路本地/组播主机一律拒绝（SSRF 门禁）")
    void rejectsPrivateHosts() {
        Assertions.assertNull(WebSettingsController.fetchIcon("http://127.0.0.1:8080/admin"), "回环必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://localhost/x.png"), "localhost 必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://192.168.1.10/x.png"), "私网必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://10.0.0.5/x.png"), "私网必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://172.16.3.4/x.png"), "私网必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://169.254.169.254/latest/meta-data/"),
                "云元数据地址必须拒绝（SSRF 经典靶）");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://[fd12:3456:789a::1]/x.png"), "IPv6 ULA 必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://[::1]/x.png"), "IPv6 回环必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://0.0.0.0/x.png"), "任意地址必须拒绝");
        Assertions.assertNull(WebSettingsController.fetchIcon("http://not-a-real-host.invalid/x.png"),
                "解析失败的主机必须拒绝");
    }

    @Test
    @DisplayName("isPrivateHost 判定面：公网主机放行、内网形态拒绝")
    void privateHostPredicate() {
        Assertions.assertTrue(WebSettingsController.isPrivateHost(null));
        Assertions.assertTrue(WebSettingsController.isPrivateHost(""));
        Assertions.assertTrue(WebSettingsController.isPrivateHost("127.0.0.1"));
        Assertions.assertTrue(WebSettingsController.isPrivateHost("192.168.0.9"));
        Assertions.assertFalse(WebSettingsController.isPrivateHost("example.com"),
                "公网主机不得被误拒（误拒=所有图标 404）");
    }

    @Test
    @DisplayName("重定向与体积上限常量必须为正且保守")
    void redirectAndSizeLimits() {
        Assertions.assertTrue(WebSettingsController.ICON_MAX_REDIRECTS >= 1
                        && WebSettingsController.ICON_MAX_REDIRECTS <= 5,
                "重定向上限应保守（CDN 一跳足够）: " + WebSettingsController.ICON_MAX_REDIRECTS);
        Assertions.assertTrue(WebSettingsController.ICON_MAX_BYTES >= 64 * 1024
                        && WebSettingsController.ICON_MAX_BYTES <= 8 * 1024 * 1024,
                "图标体积上限应在合理区间: " + WebSettingsController.ICON_MAX_BYTES);
    }
}
