/* ===== kernel-bridge.js =====
   桌面壳（Tauri）下把 API 请求从「同源相对路径」改写为「内核绝对地址」。

   ── 为什么需要这一层 ──────────────────────────────────────────────
   Tauri 用 asset 协议托管 frontendDist，页面源是 http://tauri.localhost，
   而 Rust 内核跑在 http://127.0.0.1:<随机端口>。前端全部 API 调用都写成
   同源相对路径（'/web/chat/meta'、'/web/gate'），在 asset 协议下会解析到
   tauri.localhost：
     · HTTP  → SPA fallback 返回 200 + index.html（不是 JSON），业务静默失败；
     · WS    → ERR_CONNECTION_REFUSED，聊天流完全不通。
   实测证据（CDP 探针，2026-10-26）：
     fetch('/web/chat/meta')            → 200，响应体是 <!DOCTYPE html>
     ws://tauri.localhost/web/gate      → ERR_CONNECTION_REFUSED ×7
     fetch('http://127.0.0.1:P/web/chat/meta') → 200，真 JSON
     ws://127.0.0.1:P/web/gate          → OPEN

   ── 为什么改写而不是逐处改调用点 ──────────────────────────────────
   前端有 186 处 API 路径字面量、分布在 30 个文件（$.ajax 127 / fetch 19 /
   XHR.open 17 / WebSocket 2），且 WS 那两处是用 window.location.host 现拼的。
   逐处改既容易漏，也会让「浏览器直连」与「桌面壳」两套地址逻辑长期并存。
   统一在网络层改写，业务代码一行不动。

   ── 浏览器模式零影响 ──────────────────────────────────────────────
   只有 Rust 侧注入了 window.__GWORK_KERNEL_ORIGIN__ 才激活。
   `gwork --serve N --static ui` 直连时该变量不存在，本文件立即 return，
   fetch / XHR / WebSocket 全部保持原生实现，相对路径照常工作。

   ── 只改写 API，不改写静态资源 ────────────────────────────────────
   /js/ /css/ /monaco/ /layui/ /highlight/ /img/ /locales/ 由 asset 协议正常
   提供，必须留在 tauri.localhost；只有 API 前缀（/web/、/chat/channel/）
   需要打到内核。误改静态资源会让页面白屏。

   引入位置：index.html 的第一个 <script src>，早于 layui 与所有 app-*.js。
   必须这么早——任何业务脚本一旦先发出请求，改写就来不及了。 */
(function () {
    'use strict';

    var ORIGIN = window.__GWORK_KERNEL_ORIGIN__;
    if (!ORIGIN || typeof ORIGIN !== 'string') return;   // 浏览器模式：不激活

    // 去掉可能的尾斜杠，避免拼出 //web/...
    ORIGIN = ORIGIN.replace(/\/+$/, '');

    /* 需要打到内核的路径前缀。新增 API 命名空间时必须同步这里，
       否则该命名空间在桌面壳下会静默落到 asset 协议上。 */
    var API_PREFIXES = ['/web/', '/chat/channel/'];

    /* 内核的 host（含端口），用于改写 WebSocket 与 location.host 拼接形态。 */
    var KERNEL_HOST = ORIGIN.replace(/^https?:\/\//, '');
    var IS_HTTPS = ORIGIN.indexOf('https://') === 0;

    function isApiPath(p) {
        if (typeof p !== 'string' || p.length === 0) return false;
        for (var i = 0; i < API_PREFIXES.length; i++) {
            if (p.indexOf(API_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    /* 相对 API 路径 → 内核绝对地址。
       只处理「以 / 开头的相对路径」与「已经指向本页 host 的绝对 URL」两种形态：
       · '/web/chat/meta'                        → ORIGIN + path
       · 'http://tauri.localhost/web/gate'       → 换 host（WS 拼接形态）
       · 'https://api.example.com/v1/x'          → 原样放行（外部服务） */
    function rewriteUrl(url) {
        if (typeof url !== 'string' || url.length === 0) return url;

        // 形态一：相对路径
        if (url.charAt(0) === '/' && url.charAt(1) !== '/') {
            return isApiPath(url) ? (ORIGIN + url) : url;
        }

        // 形态二：绝对 URL —— 仅当 host 是本页 host（asset 协议）时才改写
        var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#]*)(.*)$/.exec(url);
        if (!m) return url;
        var scheme = m[1], host = m[2], rest = m[3];
        if (host !== window.location.host) return url;   // 外部地址，放行
        if (!isApiPath(rest)) return url;                // 静态资源，放行

        var nextScheme = scheme;
        if (scheme === 'http' || scheme === 'https') {
            nextScheme = IS_HTTPS ? 'https' : 'http';
        } else if (scheme === 'ws' || scheme === 'wss') {
            nextScheme = IS_HTTPS ? 'wss' : 'ws';
        } else {
            return url;
        }
        return nextScheme + '://' + KERNEL_HOST + rest;
    }

    /* ───────── fetch ───────── */
    if (typeof window.fetch === 'function') {
        var nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                if (typeof input === 'string') {
                    return nativeFetch.call(this, rewriteUrl(input), init);
                }
                // Request 对象形态：只改 URL，其余（method/headers/body）原样保留
                if (input && typeof input.url === 'string') {
                    var next = rewriteUrl(input.url);
                    if (next !== input.url) {
                        return nativeFetch.call(this, new Request(next, input), init);
                    }
                }
            } catch (e) {
                console.warn('[kernel-bridge] fetch rewrite failed', e);
            }
            return nativeFetch.call(this, input, init);
        };
    }

    /* ───────── XMLHttpRequest（jQuery $.ajax / $.get / $.post 全走这里）───────── */
    if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
        var nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            var args = Array.prototype.slice.call(arguments);
            try {
                if (typeof url === 'string') args[1] = rewriteUrl(url);
            } catch (e) {
                console.warn('[kernel-bridge] xhr rewrite failed', e);
            }
            return nativeOpen.apply(this, args);
        };
    }

    /* ───────── WebSocket ─────────
       app-streaming.js / app-terminal.js 用 window.location.host 现拼 ws:// URL，
       在 asset 协议下 host 是 tauri.localhost，必须在这里换掉。 */
    if (typeof window.WebSocket === 'function') {
        var NativeWebSocket = window.WebSocket;
        var WSProxy = function (url, protocols) {
            var next = url;
            try { next = rewriteUrl(url); } catch (e) {
                console.warn('[kernel-bridge] ws rewrite failed', e);
            }
            // 必须用 new 调用原生构造器；直接返回实例会丢掉原型链上的常量
            return protocols === undefined
                ? new NativeWebSocket(next)
                : new NativeWebSocket(next, protocols);
        };
        // 保留静态常量与原型，业务代码可能读 WebSocket.OPEN 等
        WSProxy.prototype = NativeWebSocket.prototype;
        WSProxy.CONNECTING = NativeWebSocket.CONNECTING;
        WSProxy.OPEN = NativeWebSocket.OPEN;
        WSProxy.CLOSING = NativeWebSocket.CLOSING;
        WSProxy.CLOSED = NativeWebSocket.CLOSED;
        window.WebSocket = WSProxy;
    }

    /* 对外暴露，便于诊断与契约测试断言改写规则。 */
    window.__GWORK_KERNEL_BRIDGE__ = {
        origin: ORIGIN,
        host: KERNEL_HOST,
        prefixes: API_PREFIXES.slice(),
        rewriteUrl: rewriteUrl,
        isApiPath: isApiPath
    };

    /* ───────── DOM 属性形态的 API 地址 ─────────
       <img src="/web/..."> 这类地址不经过 fetch / XHR / WebSocket，上面三层
       改写都拦不到；在 asset 协议下它会落到 tauri.localhost 的 SPA fallback，
       拿回 200 + index.html，图片解码失败 → onerror 把 <img> 移除 → 图标永远
       只剩首字母底。

       为什么不用 MutationObserver 事后纠正：innerHTML 插入的 <img> 会立刻发起
       加载，失败即触发业务代码的 onerror="this.remove()"，元素在 observer 回调
       之前就已经被移除，纠正无从下手。

       因此提供同步 helper，由业务代码在**拼 HTML 字符串时**调用：
         window.__gworkApiUrl('/web/settings/skills/icon?url=...')
       浏览器模式下本文件早已 return，helper 不存在，业务代码的兜底分支返回
       原相对路径，行为与改写前完全一致。 */
    window.__gworkApiUrl = function (path) {
        return rewriteUrl(path);
    };
})();
