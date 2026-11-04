package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * 静态资源缓存修复的契约测试。
 *
 * <p>背景（2026-10-16 实证）：solon-web-staticfiles 4.1.0 的 StaticResourceHandler 用
 * 「类加载时刻」做所有静态资源的 Last-Modified（进程级常量），浏览器缓存后恒 304 ——
 * 改前端文件刷新无效，用户看不到新界面。本类锁定三件事：</p>
 *
 * <ol>
 *   <li><b>304 判定</b>：IMS 与 Last-Modified 相等才 304，不等（文件已更新）必须 200；</li>
 *   <li><b>扩展名解析</b>：与框架同口径（含 query string 的路径不误判）；</li>
 *   <li><b>接线不回归</b>（源码扫描）：App 必须在 AppPluginLoadEndEvent 里前插
 *       GworkStaticResourceHandler；handler 必须用文件真实 mtime（file.lastModified），
 *       不得退回进程级常量当 Last-Modified。</li>
 * </ol>
 */
class GworkStaticResourceHandlerTest {

    // ===================== 1. 304 判定 =====================

    @Test
    void notModifiedOnlyWhenExactMatch() {
        String lm = "Thu, 15 Oct 2026 17:14:08 GMT";
        Assertions.assertTrue(GworkStaticResourceHandler.isNotModified(lm, lm),
                "IMS 与 Last-Modified 相等必须判未修改（304 正常协商路径）");
        Assertions.assertFalse(GworkStaticResourceHandler.isNotModified("Thu, 15 Oct 2026 08:02:57 GMT", lm),
                "IMS 是旧值（进程启动时刻）而文件已更新时必须判已修改（200 返回新内容）——"
                        + "这正是缓存死锁的修复点，若此断言失败说明 304 判定又退回了旧口径");
        Assertions.assertFalse(GworkStaticResourceHandler.isNotModified(null, lm),
                "无 IMS 头必须 200（首次请求/强刷路径）");
        Assertions.assertFalse(GworkStaticResourceHandler.isNotModified(lm, null));
    }

    // ===================== 2. 扩展名解析 =====================

    @Test
    void extResolutionMatchesFramework() {
        Assertions.assertEquals(".js", GworkStaticResourceHandler.extOf("/js/app-automation.js"));
        Assertions.assertEquals(".css", GworkStaticResourceHandler.extOf("/css/app.css"));
        Assertions.assertEquals(".json", GworkStaticResourceHandler.extOf("/locales/zh-CN.json"));
        Assertions.assertNull(GworkStaticResourceHandler.extOf("/favicon"),
                "无扩展名不处理（与框架 findByExtName 同口径）");
        Assertions.assertNull(GworkStaticResourceHandler.extOf("/js/app.js?v=1"),
                "带 query string 的路径不得误判扩展名（与框架同口径：? 在最后时返回 null）");
        Assertions.assertNull(GworkStaticResourceHandler.extOf(null));
    }

    // ===================== 3. 接线契约（源码扫描，防静默回退） =====================

    private static String readSource(String rel) throws Exception {
        return new String(Files.readAllBytes(Paths.get(rel)), StandardCharsets.UTF_8);
    }

    @Test
    void appWiresReplacementHandlerInPluginLoadEndEvent() throws Exception {
        String app = readSource("src/main/java/com/gourdai/App.java");
        Assertions.assertTrue(app.contains("AppPluginLoadEndEvent"),
                "App 必须在插件全部加载完成后的事件里挂载替换（过早挂载会被 WebStaticfilesPlugin 前插到其后）");
        Assertions.assertTrue(app.contains("new GworkStaticResourceHandler()"),
                "App 必须注册 GworkStaticResourceHandler（修复静态资源 Last-Modified 冻结）");
        Assertions.assertTrue(app.contains(".handler().prev("),
                "替换 handler 必须前插 pipeline 首部（后插会被旧 handler 抢先处理）");
    }

    @Test
    void handlerUsesRealFileMtimeNotProcessConstant() throws Exception {
        String handler = readSource("src/main/java/com/gourdai/core/portal/web/GworkStaticResourceHandler.java");
        Assertions.assertTrue(handler.contains("file.lastModified()"),
                "文件资源必须用真实 mtime 做 Last-Modified（修复点）");
        Assertions.assertFalse(handler.contains("static final java.util.Date modified_time"),
                "不得退回框架的进程级常量方案");
        Assertions.assertTrue(handler.contains("STARTUP_MS"),
                "jar 内资源应回落到启动时刻（进程内内容不变，语义等价）");
    }
}
