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

import org.noear.snack4.ONode;
import org.noear.solon.core.util.Assert;
import org.noear.solon.net.websocket.WebSocket;
import org.noear.solon.net.websocket.listener.SimpleWebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * TerminalGate —— Code 模式本地终端 WebSocket 网关。
 *
 * <p>每个前端终端标签建立一条独立的 WebSocket 连接（{@code /web/terminal}）。
 * 连接建立时在所选项目目录下启动一个常驻 shell 子进程（Windows 用 {@code cmd.exe}，
 * 类 Unix 用 {@code $SHELL}/bash），通过后台线程把子进程的 stdout/stderr 流式推给前端，
 * 前端键入的命令则原样写入子进程 stdin。因是常驻 shell，{@code cd} 等状态会自然保留。</p>
 *
 * <h3>协议（JSON 文本帧）</h3>
 * <ul>
 *   <li>客户端 → 服务端：{@code {"type":"input","data":"ls\n"}}、
 *       {@code {"type":"busyQuery","id":"..."}}</li>
 *   <li>服务端 → 客户端：{@code {"type":"output","data":"..."}}、{@code {"type":"exit","code":0}}、
 *       {@code {"type":"busy","id":"...","busy":true|false}}</li>
 * </ul>
 *
 * <p>busyQuery 供前端「关闭终端标签」决策：shell 存在存活后代进程（正在跑命令）才视为忙，
 * 空闲 shell 关闭无需确认。仅凭连接存活判断会把完全空闲的终端误报为「仍在运行」。</p>
 *
 * <p>说明：未使用原生 PTY，故不支持完整 ANSI 光标控制（如 vim/top 全屏程序表现受限），
 * 但满足日常命令执行（构建、git、脚本运行等）需求，且零外部依赖、跨平台。</p>
 *
 * @author oisin
 * @see WebController
 */
public class TerminalGate extends SimpleWebSocketListener {
    private static final Logger LOG = LoggerFactory.getLogger(TerminalGate.class);

    private static final boolean IS_WINDOWS =
            System.getProperty("os.name", "").toLowerCase().contains("win");

    /** 启动工作区（前端未传 cwd 时的兜底目录）。 */
    private final File workspaceDir;

    /** socket.id -> 该连接绑定的 shell 会话。 */
    private final Map<String, ShellSession> sessions = new ConcurrentHashMap<>();

    /**
     * Windows 版本 banner 缓存（实例级，与网关同生命周期）。
     * 无参 cmd 形态自带版本横幅而 /K 形态不输出（实测对照），故用一次性无参进程
     * 采集横幅供 /K 会话首帧补发；采集失败（超时/异常）缓存 null 不再重试，
     * 首帧退化为仅提示符，不影响终端可用性。
     */
    private volatile String bannerCache;
    private volatile boolean bannerProbed = false;

    public TerminalGate(String workspace) {
        this.workspaceDir = new File(workspace);
    }

    @Override
    public void onOpen(WebSocket socket) {
        // 前端以 ?cwd=<项目根> 传入工作目录；为空或非法则退回启动工作区。
        String cwd = socket.param("cwd");
        File dir = workspaceDir;
        if (Assert.isNotEmpty(cwd) && cwd.indexOf("..") < 0) {
            File d = new File(cwd);
            if (d.isDirectory()) {
                dir = d;
            }
        }

        try {
            ShellSession session = new ShellSession(socket, dir);
            sessions.put(socket.id(), session);
            session.start();
        } catch (Exception e) {
            LOG.warn("[TerminalGate] shell 启动失败: {}", e.getMessage());
            sendJson(socket, new ONode().set("type", "output")
                    .set("data", "\r\n[终端启动失败] " + e.getMessage() + "\r\n"));
            safeClose(socket);
        }
    }

    @Override
    public void onMessage(WebSocket socket, String text) {
        ShellSession session = sessions.get(socket.id());
        if (session == null) {
            return;
        }
        try {
            ONode root = ONode.ofJson(text);
            String type = root.get("type") != null ? root.get("type").getString() : null;
            if ("input".equals(type)) {
                ONode dataNode = root.get("data");
                if (dataNode != null) {
                    session.write(dataNode.getString());
                }
            } else if ("busyQuery".equals(type)) {
                ONode idNode = root.get("id");
                String id = idNode != null ? idNode.getString() : null;
                sendJson(socket, new ONode().set("type", "busy")
                        .set("id", id != null ? id : "")
                        .set("busy", session.isBusy()));
            }
            // 其余类型（如 resize）当前无 PTY，忽略即可。
        } catch (Exception e) {
            LOG.debug("[TerminalGate] 消息处理异常: {}", e.getMessage());
        }
    }

    @Override
    public void onClose(WebSocket socket) {
        ShellSession session = sessions.remove(socket.id());
        if (session != null) {
            session.destroy();
        }
    }

    @Override
    public void onError(WebSocket socket, Throwable error) {
        ShellSession session = sessions.remove(socket.id());
        if (session != null) {
            session.destroy();
        }
    }

    private static void sendJson(WebSocket socket, ONode node) {
        try {
            socket.send(node.toJson());
        } catch (Exception e) {
            LOG.debug("[TerminalGate] 发送失败: {}", e.getMessage());
        }
    }

    private static void safeClose(WebSocket socket) {
        try {
            socket.close();
        } catch (Exception ignored) {
        }
    }

    /**
     * 后代进程是否为真实工作负载。Windows 上 conhost.exe 是 cmd.exe 的固有子进程
     * （实测：空闲 cmd 亦恒有一个 conhost 后代），若不过滤则 busyQuery 恒为忙，
     * 空闲终端关 tab 也会弹确认框。conhost 是控制台宿主而非用户命令，排除之；
     * 其余后代（ping/mvn/node 等）一律视为忙。非 Windows 无此固有子进程，恒真。
     */
    static boolean isRealWorkload(ProcessHandle h) {
        if (!IS_WINDOWS) {
            return true;
        }
        String name = h.info().command().orElse("");
        int slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        return !"conhost.exe".equalsIgnoreCase(name);
    }

    /**
     * 采集 Windows 版本 banner（无参 cmd 首两行输出），供 /K 会话首帧补发。
     * 限时 2 秒：采集进程不等待其退出，读完即弃（daemon 语义由 JVM 回收）。
     */
    String windowsBanner() {
        if (bannerProbed) {
            return bannerCache;
        }
        bannerProbed = true;
        try {
            ProcessBuilder pb = new ProcessBuilder("cmd.exe");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            StringBuilder sb = new StringBuilder();
            try (InputStream in = p.getInputStream()) {
                byte[] buf = new byte[2048];
                long deadline = System.currentTimeMillis() + 2000;
                while (System.currentTimeMillis() < deadline && sb.length() < 512) {
                    if (in.available() <= 0) {
                        Thread.sleep(50);
                        continue;
                    }
                    int n = in.read(buf);
                    if (n < 0) {
                        break;
                    }
                    sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                }
            } finally {
                p.destroyForcibly();
            }
            String raw = sb.toString();
            int idx = raw.indexOf('\n');
            if (idx > 0 && idx + 1 < raw.length() && raw.charAt(idx + 1) != '\n') {
                int idx2 = raw.indexOf('\n', idx + 1);
                if (idx2 > idx + 1) {
                    bannerCache = raw.substring(0, idx2 + 1);
                }
            }
        } catch (Exception e) {
            LOG.debug("[TerminalGate] banner 采集失败: {}", e.getMessage());
        }
        return bannerCache;
    }

    /**
     * 单条 WebSocket 连接对应的 shell 子进程会话。
     * （非 static 内部类：start() 需经实例的 {@link #windowsBanner()} 取首帧 banner 缓存。）
     */
    private class ShellSession {
        private final WebSocket socket;
        private final Process process;
        private final OutputStream stdin;
        private volatile boolean closed = false;

        ShellSession(WebSocket socket, File dir) throws IOException {
            this.socket = socket;

            ProcessBuilder pb;
            if (IS_WINDOWS) {
                // cmd.exe 从 stdin 逐行读取命令；redirectErrorStream 合并 stderr 便于顺序输出。
                // UTF-8 代码页经 /K 启动参数执行：若改为连接后写 stdin（历史做法），cmd 会
                // 回显该行，用户未输入任何命令却看到一条「chcp 65001 >nul」幽灵命令。
                pb = new ProcessBuilder("cmd.exe", "/K", "chcp 65001 >nul");
            } else {
                String shell = System.getenv("SHELL");
                if (shell == null || shell.trim().isEmpty()) {
                    shell = "/bin/bash";
                }
                // -i 交互模式，保留提示符与别名等交互特性。
                pb = new ProcessBuilder(shell, "-i");
            }
            pb.directory(dir);
            pb.redirectErrorStream(true);
            // 关闭 git 等命令的终端提示，避免子进程等待无处输入的密码提示而挂死。
            pb.environment().put("GIT_TERMINAL_PROMPT", "0");

            this.process = pb.start();
            this.stdin = process.getOutputStream();
        }

        void start() {
            // Windows 首帧补版本 banner：/K 启动形态不输出无参形态自带的版本横幅
            // （实测三形态对照：仅无参形态有），不补则用户打开终端只见提示符。
            // 必须在 reader 线程启动前发送，保证 banner 恒在首帧、不被 prompt 抢序。
            if (IS_WINDOWS) {
                String banner = windowsBanner();
                if (banner != null && !banner.isEmpty()) {
                    sendJson(socket, new ONode().set("type", "output").set("data", banner));
                }
            }
            // 输出读取线程：把子进程输出按块流式推给前端。
            Thread reader = new Thread(() -> pump(process.getInputStream()), "terminal-reader");
            reader.setDaemon(true);
            reader.start();

            // 退出监听线程：进程结束后通知前端并关闭连接。
            Thread waiter = new Thread(() -> {
                try {
                    int code = process.waitFor();
                    if (!closed) {
                        sendJson(socket, new ONode().set("type", "exit").set("code", code));
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } finally {
                    safeClose(socket);
                }
            }, "terminal-waiter");
            waiter.setDaemon(true);
            waiter.start();
        }

        /**
         * shell 是否正在执行命令：存在「真实工作负载」后代进程即忙。
         * ProcessHandle 跨平台，无需解析平台命令；查询异常按空闲处理（进程树不可读
         * 通常意味着 shell 本身已不可用）。
         */
        boolean isBusy() {
            try {
                return process.toHandle().descendants().anyMatch(TerminalGate::isRealWorkload);
            } catch (Exception e) {
                return false;
            }
        }

        private void pump(InputStream in) {
            byte[] buf = new byte[4096];
            try {
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (closed) {
                        break;
                    }
                    String chunk = new String(buf, 0, n, StandardCharsets.UTF_8);
                    sendJson(socket, new ONode().set("type", "output").set("data", chunk));
                }
            } catch (IOException e) {
                // 进程结束或流关闭，正常退出。
            }
        }

        void write(String data) {
            if (closed || data == null) {
                return;
            }
            try {
                stdin.write(data.getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (IOException e) {
                LOG.debug("[TerminalGate] 写入 stdin 失败: {}", e.getMessage());
            }
        }

        void destroy() {
            closed = true;
            try {
                stdin.close();
            } catch (Exception ignored) {
            }
            try {
                process.destroy();
                // 给一点时间优雅退出，超时则强杀。
                if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (Exception e) {
                process.destroyForcibly();
            }
        }
    }
}
