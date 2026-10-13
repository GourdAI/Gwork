/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import org.noear.solon.Utils;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Filter;
import org.noear.solon.core.handle.FilterChain;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;

import java.io.IOException;
import java.util.Base64;

/**
 * Web 访问认证过滤器（Basic Auth）。
 *
 * <p>当用户在「通用设置」中配置了 webAuthUser/webAuthPass 后，
 * 所有 HTTP 请求（含 WebSocket 升级请求）都会校验 Basic Auth 头。
 * 校验失败返回 401，浏览器自动弹出登录框。</p>
 *
 * <p><b>远端部署模式（2026-10 远程工作区 P1）</b>：系统属性
 * {@code -Dgwork.web.auth=user:pass}（由桌面端 SSH 部署链随机生成并注入）优先于
 * settings.json 配置——远端机器的 settings.json 属于远端用户，桌面端不写入；
 * 凭据随每次连接生成、断连即换，仅存远端进程内存。该模式下校验失败不弹浏览器登录框
 * （WWW-Authenticate 会唤起无人应答的登录弹窗），直接 401 让桌面端展示可读错误。</p>
 *
 * @author oisin
 */
public class WebAuthFilter implements Filter {

    private final AgentSettings settings;

    public WebAuthFilter(AgentSettings settings) {
        this.settings = settings;
    }

    @Override
    public void doFilter(Context ctx, FilterChain chain) throws Throwable {
        // ====== CORS 预检请求放行（避免跨域 OPTIONS 被 401 拦截） ======
        if ("OPTIONS".equalsIgnoreCase(ctx.method())) {
            chain.doFilter(ctx);
            return;
        }

        // ====== 白名单：静态资源放行（浏览器弹登录框时会先加载页面资源） ======
        String path = ctx.path();
        if (path.startsWith("/css/")
                || path.startsWith("/js/")
                || path.startsWith("/layui/")
                || path.startsWith("/highlight/")
                || path.startsWith("/img/")
                || path.equals("/favicon.ico")) {
            chain.doFilter(ctx);
            return;
        }

        // ====== 远端部署模式：-Dgwork.web.auth 优先（内存态凭据，见类注释） ======
        String[] injected = AgentFlags.getRemoteWebAuth();
        if (injected != null) {
            if (checkBasicAuth(ctx, injected[0], injected[1])) {
                chain.doFilter(ctx);
            } else {
                // 不回 WWW-Authenticate：该模式客户端是桌面端代理而非浏览器，
                // 弹登录框无人应答；直接 401 让调用方展示可读错误。
                ctx.status(401);
                ctx.output("需要访问认证");
            }
            return;
        }

        // ====== 没设账号密码 → 直接放行 ======
        String user = settings.getGeneral().getWebAuthUser();
        String pass = settings.getGeneral().getWebAuthPass();
        if (Utils.isBlank(user) || Utils.isBlank(pass)) {
            chain.doFilter(ctx);
            return;
        }

        if (checkBasicAuth(ctx, user, pass)) {
            chain.doFilter(ctx);
        } else {
            response401(ctx);
        }
    }

    /** 校验 Authorization: Basic base64(username:password)；凭据任一为空视为未配置（放行路径由调用方处理）。 */
    private boolean checkBasicAuth(Context ctx, String user, String pass) {
        String authorization = ctx.header("Authorization");
        if (Utils.isBlank(authorization) || !authorization.startsWith("Basic ")) {
            return false;
        }
        try {
            String base64 = authorization.substring(6);
            String nameAndPwd = new String(Base64.getDecoder().decode(base64));
            String[] parts = nameAndPwd.split(":", 2);

            return parts.length == 2 && user.equals(parts[0]) && pass.equals(parts[1]);
        } catch (Exception e) {
            return false;
        }
    }

    private void response401(Context ctx) throws IOException {
        ctx.status(401);
        ctx.headerSet("WWW-Authenticate", "Basic realm=\"GWork\"");
        ctx.output("需要访问认证");
    }
}
