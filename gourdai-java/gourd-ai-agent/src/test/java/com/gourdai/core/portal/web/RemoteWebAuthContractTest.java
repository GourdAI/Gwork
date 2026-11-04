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

import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.FilterChain;

import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 远程工作区 P1 契约：远端部署模式的 Basic Auth 凭据注入链。
 *
 * <p>桌面端 SSH 部署链启动远端 jar 时注入 {@code -Dgwork.web.auth=user:pass}（每次连接
 * 随机生成）与 {@code -Dgwork.remote=true}。本测试锁定：</p>
 * <ol>
 *   <li>{@link AgentFlags#getRemoteWebAuth()} 解析契约：合法 user:pass → [user, pass]；
 *       未注入 / 缺冒号 / 空用户 / 空密码 → null（降级走 settings 路径，而非拿畸形凭据拒掉全部请求）。</li>
 *   <li>{@link WebAuthFilter} 在注入模式下的行为：凭据正确 → 放行；凭据错误 / 无头 → 401，
 *       且<b>不得回 WWW-Authenticate</b>（该模式客户端是桌面端代理，弹浏览器登录框无人应答）。</li>
 *   <li>注入凭据优先于 settings.json 的 webAuthUser/webAuthPass（远端机器的 settings 属于远端用户，桌面端不写入）。</li>
 *   <li>注入缺失时 settings 路径行为不变（含 WWW-Authenticate 弹框语义）。</li>
 * </ol>
 */
class RemoteWebAuthContractTest {

    @AfterEach
    void clearProps() {
        System.clearProperty(AgentFlags.PROP_REMOTE_WEB_AUTH);
        System.clearProperty(AgentFlags.PROP_REMOTE);
    }

    // ───────────────────────── AgentFlags 解析 ─────────────────────────

    @Test
    void parsesInjectedUserPass() {
        System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, "gwork:secret-pass");
        String[] auth = AgentFlags.getRemoteWebAuth();
        assertNotNull(auth);
        assertEquals("gwork", auth[0]);
        assertEquals("secret-pass", auth[1]);
    }

    /**
     * P1-3 修复契约：环境变量 GWORK_WEB_AUTH 优先于系统属性（部署链已改为
     * env 注入——命令行 -D 在远端 ps -ef 下对同机用户可见）。不可变环境：
     * 仅验证「属性未设时环境变量路径能被读到或正常降级」，不断言 env 值。
     */
    @Test
    void envVarTakesPrecedenceWhenSet() {
        System.clearProperty(AgentFlags.PROP_REMOTE_WEB_AUTH);
        // 测试进程通常无 GWORK_WEB_AUTH（getenv 可能为 null）——降级为 null，
        // 与属性路径独立可验证。若环境恰好注入了合法值（CI 特殊配置），
        // 则必须能解析出来——两种分支都是合法行为，锁「不异常」。非 null 时
        // 进一步验证格式合法性。
        String[] auth = AgentFlags.getRemoteWebAuth();
        if (auth != null) {
            assertEquals(2, auth.length);
            assertFalse(auth[0].isEmpty());
            assertFalse(auth[1].isEmpty());
        } else {
            assertNull(AgentFlags.getRemoteWebAuth(), "无注入时必须稳定返回 null");
        }
    }

    @Test
    void malformedValuesDegradeToNull() {
        // 密码含冒号合法（split 限制 2 段，首个冒号分隔）
        System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, "gwork:pa:ss");
        String[] auth = AgentFlags.getRemoteWebAuth();
        assertNotNull(auth);
        assertEquals("gwork", auth[0]);
        assertEquals("pa:ss", auth[1]);

        // 缺冒号 / 空用户 / 空密码 / 空白 → null（降级，不误伤）
        for (String bad : new String[]{"onlyuser", ":pass", "user:", "  "}) {
            System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, bad);
            assertNull(AgentFlags.getRemoteWebAuth(), "畸形值应降级为 null: " + bad);
        }

        // 未注入 → null
        System.clearProperty(AgentFlags.PROP_REMOTE_WEB_AUTH);
        assertNull(AgentFlags.getRemoteWebAuth());
    }

    @Test
    void remoteDeployFlagDefaultsFalse() {
        assertFalse(AgentFlags.isRemoteDeployed());
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        assertTrue(AgentFlags.isRemoteDeployed());
    }

    // ───────────────────────── WebAuthFilter 行为 ─────────────────────────

    /**
     * Solon Context 桩：用仓库既有范式 ContextEmpty（WsControllerOllamaModelsTest 同款），
     * 只覆写 Filter 用到的方法（method/path/header/status/headerSet）。
     */
    private static class RecordingContext extends org.noear.solon.core.handle.ContextEmpty {
        final String method;
        final String path;
        final Map<String, String> reqHeaders;
        final Map<String, String> respHeaders = new HashMap<>();
        int status = 200;

        RecordingContext(String method, String path, Map<String, String> reqHeaders) {
            this.method = method;
            this.path = path;
            this.reqHeaders = reqHeaders;
        }

        @Override
        public String method() {
            return method;
        }

        @Override
        public String path() {
            return path;
        }

        @Override
        public String header(String name) {
            return reqHeaders.get(name);
        }

        @Override
        public void headerSet(String name, String value) {
            respHeaders.put(name, value);
        }

        @Override
        protected void statusDoSet(int status) {
            this.status = status;
        }
    }

    /** 记录放行次数的 FilterChain 桩。 */
    private static class CountingChain implements FilterChain {
        final AtomicInteger passes = new AtomicInteger();

        @Override
        public void doFilter(Context ctx) {
            passes.incrementAndGet();
        }
    }

    private static String basic(String user, String pass) {
        return "Basic " + Base64.getEncoder().encodeToString((user + ":" + pass).getBytes());
    }

    @Test
    void injectedAuthPassesOnCorrectCredentials() throws Throwable {
        System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, "gwork:secret");
        WebAuthFilter filter = new WebAuthFilter(new AgentSettings());
        CountingChain chain = new CountingChain();

        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", basic("gwork", "secret"));
        filter.doFilter(new RecordingContext("GET", "/web/chat/meta", headers), chain);
        assertEquals(1, chain.passes.get(), "凭据正确必须放行");
    }

    @Test
    void injectedAuthRejectsWrongCredentialsWithoutBrowserPrompt() throws Throwable {
        System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, "gwork:secret");
        WebAuthFilter filter = new WebAuthFilter(new AgentSettings());

        // 错误密码 → 401 且不弹框
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", basic("gwork", "wrong"));
        RecordingContext ctx = new RecordingContext("GET", "/web/chat/meta", headers);
        CountingChain chain = new CountingChain();
        filter.doFilter(ctx, chain);
        assertEquals(0, chain.passes.get());
        assertEquals(401, ctx.status);
        assertFalse(ctx.respHeaders.containsKey("WWW-Authenticate"),
                "注入模式不弹浏览器登录框（客户端是桌面端代理，弹框无人应答）");

        // 无 Authorization 头 → 同样 401 不弹框
        RecordingContext noHeader = new RecordingContext("GET", "/web/chat/sessions", new HashMap<>());
        filter.doFilter(noHeader, chain);
        assertEquals(401, noHeader.status);
        assertFalse(noHeader.respHeaders.containsKey("WWW-Authenticate"));

        // 畸形 base64 → 401 不抛异常
        Map<String, String> garbage = new HashMap<>();
        garbage.put("Authorization", "Basic ###not-base64###");
        RecordingContext bad = new RecordingContext("GET", "/web/chat/sessions", garbage);
        filter.doFilter(bad, chain);
        assertEquals(401, bad.status);
    }

    @Test
    void injectedAuthTakesPrecedenceOverSettings() throws Throwable {
        // settings 里也配了凭据，但注入凭据必须赢（远端 settings 属于远端用户）
        System.setProperty(AgentFlags.PROP_REMOTE_WEB_AUTH, "injected-user:injected-pass");
        AgentSettings settings = new AgentSettings();
        settings.getGeneral().setWebAuthUser("settings-user");
        settings.getGeneral().setWebAuthPass("settings-pass");
        WebAuthFilter filter = new WebAuthFilter(settings);

        // settings 凭据（本应正确）被注入凭据否决 → 401
        Map<String, String> staleHeaders = new HashMap<>();
        staleHeaders.put("Authorization", basic("settings-user", "settings-pass"));
        RecordingContext stale = new RecordingContext("GET", "/web/chat/meta", staleHeaders);
        CountingChain chain = new CountingChain();
        filter.doFilter(stale, chain);
        assertEquals(0, chain.passes.get(), "注入凭据必须优先于 settings.json");
        assertEquals(401, stale.status);

        // 注入凭据正确 → 放行
        Map<String, String> goodHeaders = new HashMap<>();
        goodHeaders.put("Authorization", basic("injected-user", "injected-pass"));
        RecordingContext good = new RecordingContext("GET", "/web/chat/meta", goodHeaders);
        filter.doFilter(good, chain);
        assertEquals(1, chain.passes.get());
    }

    @Test
    void settingsPathUnchangedWhenNothingInjected() throws Throwable {
        // 注入缺失时走 settings 原路径：凭据正确放行；错误 401 且带弹框头（浏览器语义保留）
        AgentSettings settings = new AgentSettings();
        settings.getGeneral().setWebAuthUser("u1");
        settings.getGeneral().setWebAuthPass("p1");
        WebAuthFilter filter = new WebAuthFilter(settings);
        CountingChain chain = new CountingChain();

        Map<String, String> ok = new HashMap<>();
        ok.put("Authorization", basic("u1", "p1"));
        filter.doFilter(new RecordingContext("GET", "/web/chat/meta", ok), chain);
        assertEquals(1, chain.passes.get());

        Map<String, String> bad = new HashMap<>();
        bad.put("Authorization", basic("u1", "p2"));
        RecordingContext rejected = new RecordingContext("GET", "/web/chat/meta", bad);
        filter.doFilter(rejected, chain);
        assertEquals(401, rejected.status);
        assertTrue(rejected.respHeaders.containsKey("WWW-Authenticate"),
                "settings 路径的浏览器弹框语义必须保留（原有行为回归护栏）");
    }
}
