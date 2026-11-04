/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Handler;
import org.noear.solon.core.util.DateUtil;
import org.noear.solon.server.util.OutputUtils;
import org.noear.solon.web.staticfiles.StaticConfig;
import org.noear.solon.web.staticfiles.StaticMappings;
import org.noear.solon.web.staticfiles.StaticMimes;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.net.URL;
import java.net.URLConnection;
import java.util.Date;

/**
 * 静态资源处理器（替代 solon-web-staticfiles 的 {@code StaticResourceHandler}）。
 *
 * <p><b>为什么必须替换：</b>框架自带的 {@code StaticResourceHandler} 用一个
 * <b>类加载时刻初始化的静态 final 字段</b>（{@code modified_time = new Date()}）作为
 * <b>所有</b>静态资源的 {@code Last-Modified} 响应头（进程级常量，不是每个文件的真实 mtime）。
 * 后果是一条隐蔽的缓存死锁：</p>
 *
 * <ol>
 *   <li>浏览器首次加载资源，把 {@code Last-Modified = 进程启动时刻} 存进缓存；</li>
 *   <li>此后每次普通刷新（甚至带 {@code If-Modified-Since} 的 revalidate 请求）都发送该值；</li>
 *   <li>服务端比较恒相等 → 恒回 {@code 304} → 浏览器一直用旧缓存，<b>即使磁盘文件已更新</b>；</li>
 *   <li>前端表现为「改了代码、刷新、甚至重启服务，界面纹丝不动」——实测中曾导致整个新功能
 *       （权限选择器、访问档位面板）对用户不可见，排查成本极高。</li>
 * </ol>
 *
 * <p>本类被 {@code App} 在插件加载完成后前插到 handler pipeline 首部（见 App 内注释），
 * 命中并处理文件后旧 handler 不再执行，从而将其完全替换。Last-Modified 语义：</p>
 * <ul>
 *   <li>磁盘文件（含 debug 模式下的 target/classes）：用文件<b>真实 mtime</b>——改完文件
 *       刷新即生效；</li>
 *   <li>jar 内资源（无单独 mtime，进程生命周期内内容不变）：回落到进程启动时刻，
 *       重启后 LM 变化 → 缓存自然失效，与框架原语义等价。</li>
 * </ul>
 *
 * <p>与旧实现的其余差异（均为刻意简化，当前仓库无此场景）：不探测 {@code .gz}/{@code .br}
 * 预压缩变体（static 目录无此类文件）；mime 解析失败时同样不处理（交后续路由），
 * 与旧行为一致。</p>
 *
 * @author oisin
 */
public class GworkStaticResourceHandler implements Handler {

    /** 进程启动时刻：jar 内资源（无文件 mtime）的回退 Last-Modified。 */
    private static final long STARTUP_MS = ManagementFactory.getRuntimeMXBean().getStartTime();

    @Override
    public void handle(Context ctx) throws Throwable {
        if (ctx.getHandled()) {
            return;
        }
        // 与框架一致：只处理 GET（HEAD/OPTIONS 等一律交后续链）
        if (!"GET".equals(ctx.method())) {
            return;
        }

        String path = ctx.pathNew();
        String ext = extOf(path);
        if (ext == null || ext.isEmpty()) {
            return;
        }

        String contentType = resolveContentType(ext);
        if (contentType == null) {
            return;
        }

        URL url = StaticMappings.find(path);
        if (url == null) {
            return;
        }

        // 与框架一致：命中即标记 handled（含 304 分支），后续 pipeline 不再尝试
        ctx.setHandled(true);

        File file = resolveFile(url);
        long lastModifiedMs = (file != null) ? file.lastModified() : STARTUP_MS;
        String lastModified = DateUtil.toGmtString(new Date(lastModifiedMs));

        // 强缓存开关：app.yml 显式设为 0（协商缓存）；响应已带 Cache-Control 时不覆盖。
        if (ctx.headerOfResponse("Cache-Control") == null) {
            ctx.headerSet("Cache-Control", "max-age=" + StaticConfig.getCacheMaxAge());
        }
        ctx.headerSet("Last-Modified", lastModified);

        if (isNotModified(ctx.header("If-Modified-Since"), lastModified)) {
            ctx.status(304);
            return;
        }

        ctx.contentType(contentType);

        if (file != null) {
            try (InputStream in = new FileInputStream(file)) {
                OutputUtils.global().outputStream(ctx, in, file.length(), contentType);
            }
        } else {
            // jar 内资源（或其它协议）：与框架一致的 URLConnection 路径（禁用 URL 级缓存）。
            URLConnection conn = url.openConnection();
            conn.setUseCaches(false);
            try (InputStream in = conn.getInputStream()) {
                long len = conn.getContentLengthLong();
                if (len <= 0) {
                    len = in.available();
                }
                OutputUtils.global().outputStream(ctx, in, len, contentType);
            }
        }
    }

    /** URL → 本地文件；非 file 协议或指向目录/不存在时返回 null（走 jar 回退语义）。 */
    private static File resolveFile(URL url) {
        try {
            if ("file".equals(url.getProtocol())) {
                File f = new File(url.toURI());
                if (f.isFile()) {
                    return f;
                }
            }
        } catch (Exception ignored) {
            // 解析失败按非文件处理
        }
        return null;
    }

    /**
     * 304 判定 seam（包内可见，供单测直接驱动）：If-Modified-Since 与当前 Last-Modified
     * 完全相等时视为未修改。
     *
     * <p>为什么用精确相等而不是「不晚于」：浏览器回传的 IMS 是我们下发过的原值，
     * 精确相等语义明确且无跨秒边界窗口；文件一经更新（mtime 变化 → 新 Last-Modified），
     * 旧 IMS 必然不再相等 → 200 全量返回，这正是「改完前端刷新即生效」所依赖的性质。</p>
     */
    static boolean isNotModified(String ifModifiedSince, String lastModified) {
        return ifModifiedSince != null && lastModified != null && ifModifiedSince.equals(lastModified);
    }

    /** 取扩展名（.js/.css/...），无扩展名返回 null；与框架 findByExtName 同口径。 */
    static String extOf(String path) {
        if (path == null) {
            return null;
        }
        int idx = path.lastIndexOf('.');
        idx = Math.max(idx, path.lastIndexOf('/'));
        idx = Math.max(idx, path.lastIndexOf('?'));
        if (idx != -1 && path.charAt(idx) == '.') {
            return path.substring(idx).toLowerCase();
        }
        return null;
    }

    /**
     * MIME 解析：先查静态扩展表，再回退 {@code Utils.mime}；均未命中返回 null
     * （与框架行为一致：mime 空则不处理，交后续路由）。
     */
    static String resolveContentType(String ext) {
        try {
            String mime = StaticMimes.findByExt(ext);
            if (mime != null && !mime.isEmpty()) {
                return mime;
            }
            mime = org.noear.solon.Utils.mime(ext);
            if (mime != null && !mime.isEmpty()) {
                return mime;
            }
        } catch (Throwable ignored) {
            // 解析失败视为不可服务（与框架一致）
        }
        return null;
    }
}
