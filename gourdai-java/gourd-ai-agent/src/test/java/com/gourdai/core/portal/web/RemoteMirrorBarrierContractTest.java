package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;

/**
 * 远程工作区「模型镜像链屏障化」契约。
 *
 * <p>背景（2026-10 用户拍板）：镜像只活在远端进程内存（{@link AgentSettings#applyRemoteMirror}
 * 置 mirrored 后拒绝落盘），远端进程一旦重启，镜像静默消失而桌面壳毫不知情。此后两条链
 * （Web {@code /web/gate} 与桌面 {@code /ws}）取模型时 {@code engine.getModelOrMain} 返回 null，
 * null 一路流到 {@code ReActAgentConfig} 构造器的 {@code Objects.requireNonNull}，用户看到的是
 * 裸 NPE 文案「chatModel is required」——既看不出是配置问题还是程序缺陷，也不知道该修哪里。</p>
 *
 * <p>本测试锁定两件事：</p>
 * <ol>
 *   <li><b>可探测</b>：镜像世代号（{@link AgentSettings#getMirrorGeneration()}）随每次成功应用
 *       镜像单调递增、进程内起始为 0、拒绝路径不递增；并经
 *       {@code GET /web/settings/mirror-state} 回告给桌面壳（非远端模式也正常返回，不拒绝）。</li>
 *   <li><b>可读</b>：四处 {@code chatModel == null} 拦截点必须走可读业务错误，且按 mirrored 态
 *       分流文案（镜像失效 → 提示重连/等待自愈；本机未配 → 指引设置页）。</li>
 * </ol>
 *
 * <p><b>为什么第 2 条用源码契约而不是行为测试：</b>四个拦截点分别位于两条 WebSocket 链的
 * 私有方法深处（{@code performAgentTaskAsync} / {@code startSyncRun} / {@code onMessage} /
 * {@code handleHitlAction}），驱动它们需要真实 WebSocket 连接与订阅时序；而「删掉拦截后
 * 行为静默退回裸 NPE」正是本仓反复出现的失效形态。故按既有先例
 * （{@link AccessModeSwitchWiringTest}）锁源码形态，且<b>一律先去注释</b>——本仓踩过
 * 「存在型断言被注释骗绿」：文案只写在注释里、代码里根本没拦，断言照样全绿。</p>
 */
class RemoteMirrorBarrierContractTest {

    @AfterEach
    void clearProps() {
        System.clearProperty(AgentFlags.PROP_REMOTE);
    }

    private static final String MIRROR_JSON = "{"
            + "\"defaultModel\":\"M-home\","
            + "\"providers\":{"
            + "  \"Home\":{\"name\":\"Home\",\"standard\":\"openai\",\"apiUrl\":\"https://home.example/v1\",\"apiKey\":\"sk-home-secret\"}"
            + "},"
            + "\"models\":{"
            + "  \"M-home\":{\"model\":\"qwen3\",\"name\":\"M-home\",\"provider\":\"Home\",\"enabled\":true},"
            + "  \"M-off\":{\"model\":\"qwen3-off\",\"name\":\"M-off\",\"provider\":\"Home\",\"enabled\":false}"
            + "}}";

    /** 镜像态文案关键字（远端模型表为空）：与 WebGate/WsGate 两处常量字面一致。 */
    private static final String KEY_MIRROR_TEXT = "远程模型配置未同步或镜像已失效";

    /** 非镜像态文案关键字（本机未配模型）：与 WebGate/WsGate 两处常量字面一致。 */
    private static final String KEY_LOCAL_TEXT = "未配置可用模型";

    // ===================== 一、世代号：可探测 =====================

    /**
     * 世代号语义：进程内起始 0，每次<b>成功</b>应用镜像 +1。
     *
     * <p>桌面壳的自愈判据完全建立在这个单调性上：壳记住自己上次推送成功时的世代号，
     * 心跳读远端当前值，一旦远端值更小（典型是重启后归零）即判定镜像丢失并重推。
     * 若起始值不是 0、或递增不严格，壳侧比较就会永久错位。</p>
     */
    @Test
    void mirrorGenerationStartsAtZeroAndIncrementsPerSuccessfulApply() {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        AgentSettings settings = new AgentSettings();

        Assertions.assertEquals(0L, settings.getMirrorGeneration(),
                "新进程世代号必须为 0：壳侧靠「远端值 < 自己记录值」判定重启，起始非 0 会让判据失效");
        Assertions.assertFalse(settings.isMirrored());

        settings.applyRemoteMirror(MIRROR_JSON);
        Assertions.assertEquals(1L, settings.getMirrorGeneration(), "第一次成功镜像后世代号必须为 1");
        Assertions.assertTrue(settings.isMirrored());

        settings.applyRemoteMirror(MIRROR_JSON);
        Assertions.assertEquals(2L, settings.getMirrorGeneration(),
                "重复推送同一快照也必须递增：壳侧以「不小于」为健康条件，不递增则无法区分「同一镜像」与「重启后重新镜像」");
        Assertions.assertTrue(settings.isMirrored());
    }

    /**
     * 拒绝路径不得递增世代号。
     *
     * <p>非远端模式下 {@code applyRemoteMirror} 在解析之前就抛 {@link IllegalStateException}。
     * 若这种失败也推进世代号，桌面壳会把「推送被拒」误读成「镜像已生效」，
     * 心跳比对从此永久错位——比完全不暴露世代号更糟。</p>
     */
    @Test
    void mirrorGenerationNotBumpedWhenApplyRejected() {
        System.clearProperty(AgentFlags.PROP_REMOTE);
        AgentSettings settings = new AgentSettings();

        Assertions.assertThrows(IllegalStateException.class, () -> settings.applyRemoteMirror(MIRROR_JSON),
                "本地/CLI 模式必须拒绝镜像载入（既有契约）");

        Assertions.assertEquals(0L, settings.getMirrorGeneration(),
                "被拒绝的应用绝不能推进世代号：否则壳侧把失败误判成生效");
        Assertions.assertFalse(settings.isMirrored());
    }

    /**
     * 解析失败同样不得递增：世代号必须严格对应「真的生效过一次镜像」。
     *
     * <p>递增点位于 {@code applyRemoteMirror} 成功路径末尾（与置 mirrored 同处），
     * 任何早于它的异常都必须让世代号原地不动。</p>
     */
    @Test
    void mirrorGenerationNotBumpedOnMalformedPayload() {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        AgentSettings settings = new AgentSettings();

        Assertions.assertThrows(Exception.class, () -> settings.applyRemoteMirror("{{{ not json"),
                "畸形载荷必须抛异常而不是静默载入半套配置");
        Assertions.assertEquals(0L, settings.getMirrorGeneration(),
                "解析失败不得推进世代号（递增点必须在所有解析成功之后）");
        Assertions.assertFalse(settings.isMirrored(), "解析失败不得置 mirrored（否则 saveToFile 被无谓锁死）");
    }

    // ===================== 二、mirror-state 端点：壳侧探针 =====================

    /**
     * 端点回告三要素：mirrored / generation / modelCount（<b>启用</b>模型数）。
     *
     * <p>modelCount 用启用数而非配置条数：壳侧真正关心的是「远端此刻有没有可用模型」，
     * 配置里躺着的禁用项不该让它误判为健康。</p>
     */
    @Test
    @SuppressWarnings("unchecked")
    void mirrorStateEndpointReportsGenerationAndEnabledModelCount(@TempDir Path workspace) throws Exception {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        AgentSettings settings = new AgentSettings();
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller = new WebSettingsController(engine, settings);

        Result<Map<String, Object>> before = controller.settingsMirrorState();
        Assertions.assertEquals(200, before.getCode());
        Assertions.assertEquals(Boolean.FALSE, before.getData().get("mirrored"));
        Assertions.assertEquals(0L, ((Number) before.getData().get("generation")).longValue());
        Assertions.assertEquals(0, ((Number) before.getData().get("modelCount")).intValue());

        controller.settingsOverlayImport(MIRROR_JSON);

        Result<Map<String, Object>> after = controller.settingsMirrorState();
        Assertions.assertEquals(200, after.getCode());
        Assertions.assertEquals(Boolean.TRUE, after.getData().get("mirrored"),
                "镜像载入后必须回告 mirrored=true");
        Assertions.assertEquals(1L, ((Number) after.getData().get("generation")).longValue(),
                "世代号必须与 applyRemoteMirror 的成功次数一致（壳侧自愈判据）");
        Assertions.assertEquals(1, ((Number) after.getData().get("modelCount")).intValue(),
                "modelCount 只数启用模型：MIRROR_JSON 里 M-off 是 disabled，不得计入");
    }

    /**
     * 非远端模式也正常返回（mirrored=false, generation=0），<b>不拒绝</b>。
     *
     * <p>与 overlay 端点刻意不同：overlay 是写操作，本地模式下开放它毫无意义且白增攻击面；
     * 本端点是只读探针，「未镜像」本身就是有效答案。若这里也拒绝，壳侧就无法区分
     * 「对端不是远端部署」与「探测失败」，自愈逻辑只能靠猜。响应不含任何凭证，无泄漏面。</p>
     */
    @Test
    void mirrorStateEndpointNotRejectedOutsideRemoteMode(@TempDir Path workspace) throws Exception {
        System.clearProperty(AgentFlags.PROP_REMOTE);
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller = new WebSettingsController(engine, new AgentSettings());

        Result<Map<String, Object>> result = controller.settingsMirrorState();

        Assertions.assertEquals(200, result.getCode(),
                "只读探针在非远端模式必须正常返回：拒绝会让壳无法区分「不是远端」与「探测失败」");
        Assertions.assertEquals(Boolean.FALSE, result.getData().get("mirrored"));
        Assertions.assertEquals(0L, ((Number) result.getData().get("generation")).longValue());
    }

    /** 端点路由与响应字段的源码契约（防止改路径/改字段名后壳侧静默读到 undefined）。 */
    @Test
    void mirrorStateEndpointMappingAndPayloadShape() {
        String source = codeOnly(readSource("src/main/java/com/gourdai/core/portal/web/WebSettingsController.java"));
        String body = methodBody(source, "public Result<Map<String, Object>> settingsMirrorState(");

        Assertions.assertTrue(source.matches("(?s).*@Get\\s*@Mapping\\(\"/web/settings/mirror-state\"\\).*"),
                "探针端点必须是 GET 且路径为 /web/settings/mirror-state：桌面壳经隧道直连按此路径探世代");
        Assertions.assertTrue(body.contains("getMirrorGeneration"),
                "响应必须携带世代号：这是壳侧判定「远端进程已重启/镜像已丢失」的唯一判据");
        Assertions.assertTrue(body.contains("isMirrored"), "响应必须携带 mirrored 态");
        Assertions.assertTrue(body.contains("isEnabled"),
                "modelCount 必须按启用态统计：数配置条数会让壳把「全是禁用项」误判为健康");
        Assertions.assertFalse(body.contains("isRemoteDeployed"),
                "本端点不得做远端模式门禁：非远端也要正常回告（见 mirrorStateEndpointNotRejectedOutsideRemoteMode）");
    }

    // ===================== 三、四处拦截点：可读业务错误 =====================

    /**
     * WebGate 两条链（异步 {@code performAgentTaskAsync} + Loop 同步 {@code startSyncRun}）
     * 都必须在 {@code chatModel == null} 时拦截。
     */
    @Test
    void webGateInterceptsNullChatModelOnBothPaths() {
        String source = readSource("src/main/java/com/gourdai/core/portal/web/WebGate.java");
        String code = codeOnly(source);

        String async = codeOnly(methodBody(source,
                "private void performAgentTaskAsync(AgentSession session, String sessionCwd, Prompt prompt, String selectedModel, String agentName, String accessMode,"));
        String asyncGuard = nullGuardBlock(async, "WebGate.performAgentTaskAsync");
        Assertions.assertTrue(asyncGuard.contains("missingChatModelMessage"),
                "异步链必须走统一 helper（四处共用一套判定与文案，防口径漂移）");
        Assertions.assertTrue(asyncGuard.contains("WebChunk.ofError") && asyncGuard.contains("WebChunk.ofDone"),
                "异步链必须同时发 error 帧与 done 帧：前端 finishStream 靠 done 收敛等待态，只发 error 会让输入框永久停在加载态");
        Assertions.assertTrue(asyncGuard.contains("return"),
                "拦截后必须终止本轮：继续往下构造 ReActAgent 就还是会抛「chatModel is required」");

        String sync = codeOnly(methodBody(source, "private SyncRunHandle startSyncRun("));
        String syncGuard = nullGuardBlock(sync, "WebGate.startSyncRun");
        Assertions.assertTrue(syncGuard.contains("missingChatModelMessage"), "同步链必须走同一 helper");
        Assertions.assertTrue(syncGuard.contains("countDown"),
                "同步链拦截后必须回一个已终止的句柄：调用方会在会话锁外阻塞 await，永不 countDown 等于把 Loop 调度线程永久挂死");
        Assertions.assertTrue(syncGuard.contains("return new SyncRunHandle"),
                "同步链拦截后必须直接返回句柄，不得继续订阅流");
    }

    /**
     * WsGate 两条链（主输入 {@code onMessage} + HITL 恢复 {@code handleHitlAction}）
     * 都必须在 {@code chatModel == null} 时拦截。
     */
    @Test
    void wsGateInterceptsNullChatModelOnBothPaths() {
        String source = readSource("src/main/java/com/gourdai/core/portal/desktop/WsGate.java");

        String onMessage = codeOnly(methodBody(source, "public void onMessage(WebSocket socket, String text)"));
        String onMessageGuard = nullGuardBlock(onMessage, "WsGate.onMessage");
        Assertions.assertTrue(onMessageGuard.contains("missingChatModelMessage"),
                "桌面主输入链必须走统一 helper，并回可读文案而非裸「chatModel is required」");
        Assertions.assertTrue(onMessageGuard.contains("socket.send") && onMessageGuard.contains("return"),
                "桌面主输入链必须发 error 帧并终止：否则 null 继续往下流，handleCommand 的 done 帧还会在 chatModel.getConfig() 上再炸一次 NPE");

        String hitl = codeOnly(methodBody(source, "private void handleHitlAction(WebSocket socket, ONode root)"));
        String hitlGuard = nullGuardBlock(hitl, "WsGate.handleHitlAction");
        Assertions.assertTrue(hitlGuard.contains("missingChatModelMessage"),
                "HITL 恢复轮必须走同一 helper：此时 approve/reject 已落定，裸 NPE 会让用户以为审批本身失败了");
        Assertions.assertTrue(hitlGuard.contains("socket.send") && hitlGuard.contains("return"),
                "HITL 恢复轮必须发 error 帧并终止，不得把 null 交给 o.chatModel(...)");
    }

    /**
     * 文案分流契约：必须按 {@code isMirrored()} 二选一，且两条文案都在<b>代码</b>里（非注释）。
     *
     * <p>分流的必要性：两种态的修复动作完全不同。镜像态下远端磁盘那份 settings.json 属于
     * 远端用户自己，让用户「去设置里加模型」是错误指引——正确动作是等壳心跳探测到世代号
     * 归零后自动重推，或重连远程工作区；非镜像态才是真正的「本机没配模型」。</p>
     */
    @Test
    void bothGatesBranchOnMirroredWithReadableTexts() {
        String webGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/web/WebGate.java"));
        String wsGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/desktop/WsGate.java"));

        for (Map.Entry<String, String> entry : Map.of("WebGate", webGate, "WsGate", wsGate).entrySet()) {
            String name = entry.getKey();
            String code = entry.getValue();

            Assertions.assertTrue(code.contains(KEY_MIRROR_TEXT),
                    name + " 必须含镜像失效文案（去注释后仍在，即真的写在代码里）");
            Assertions.assertTrue(code.contains(KEY_LOCAL_TEXT),
                    name + " 必须含未配模型文案（去注释后仍在）");
            Assertions.assertTrue(code.contains("isMirrored"),
                    name + " 必须按 mirrored 态分流文案：单一文案会给镜像场景错误指引（让用户去远端设置页加模型）");
            Assertions.assertTrue(code.matches("(?s).*mirrored\\s*\\?\\s*MSG_MODEL_MISSING_MIRROR\\s*:\\s*MSG_MODEL_MISSING_LOCAL.*"),
                    name + " 的分流必须是「镜像态 → 镜像文案，否则 → 本地文案」，写反会让两类场景互相误导");
            Assertions.assertTrue(code.contains("LOG.warn"),
                    name + " 拦截点必须记 WARN：这是事后区分「镜像丢失」与「用户没配模型」的唯一现场证据");
        }

        // 口径一致性：两个 Gate 面向同一批用户（浏览器前端 / 桌面客户端），文案漂移会造成
        // 「同一个故障在两端说法不同」，客服与日志排查都要猜。
        Assertions.assertTrue(webGate.contains(KEY_MIRROR_TEXT) && wsGate.contains(KEY_MIRROR_TEXT)
                        && webGate.contains(KEY_LOCAL_TEXT) && wsGate.contains(KEY_LOCAL_TEXT),
                "WebGate 与 WsGate 的两条文案必须字面一致（口径漂移会让同一故障在两端说法不同）");
    }

    /**
     * WARN 日志必须带 sessionId 与 mirrored 态。
     *
     * <p>只记「模型为空」的话，事后翻日志无法判断该派给谁修：镜像丢失是运维/自愈问题
     * （壳该重推），用户没配模型是使用问题（该去设置页）。sessionId 则用于把日志与
     * 用户报障的具体会话对上。</p>
     */
    @Test
    void warnLogCarriesSessionIdAndMirroredFlag() {
        String webGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/web/WebGate.java"));
        String wsGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/desktop/WsGate.java"));

        String webHelper = methodBody(webGate, "private String missingChatModelMessage(");
        Assertions.assertTrue(webHelper.contains("sessionId") && webHelper.contains("mirrored"),
                "WebGate 的 WARN 必须同时含 sessionId 与 mirrored 态");
        Assertions.assertTrue(webHelper.contains("LOG.warn"), "必须以 WARN 级别记录（不是 debug/info：这是需要人看的故障现场）");

        String wsHelper = methodBody(wsGate, "private String missingChatModelMessage(");
        Assertions.assertTrue(wsHelper.contains("sessionId") && wsHelper.contains("mirrored"),
                "WsGate 的 WARN 必须同时含 sessionId 与 mirrored 态");
        Assertions.assertTrue(wsHelper.contains("LOG.warn"), "必须以 WARN 级别记录");
    }

    /**
     * mirrored 态必须读<b>容器里那个被 overlay 端点改过的同一实例</b>，不得从磁盘重读。
     *
     * <p>{@code AgentSettings.loadFromFile()} 会新建实例，而 {@code mirrored}/{@code mirrorGeneration}
     * 是纯内存态（镜像刻意不落盘），新实例上永远读到 false——恰好把远程场景误判成本地场景，
     * 给出「去设置页加模型」这条错误指引，比不拦更具误导性。</p>
     */
    @Test
    void mirroredFlagReadFromLiveInstanceNotReloadedFromDisk() {
        String webGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/web/WebGate.java"));
        String wsGate = codeOnly(readSource("src/main/java/com/gourdai/core/portal/desktop/WsGate.java"));

        Assertions.assertFalse(webGate.contains("AgentSettings.loadFromFile"),
                "WebGate 不得用 loadFromFile 判 mirrored：磁盘重读的实例上 mirrored 永远是 false");
        Assertions.assertFalse(wsGate.contains("AgentSettings.loadFromFile"),
                "WsGate 同理不得用 loadFromFile 判 mirrored");
        Assertions.assertTrue(webGate.contains("getBean(AgentSettings.class)"),
                "WebGate 必须取容器单例（App#initAgentSettings 注册的那个实例，与 overlay 端点改的是同一对象）");
        Assertions.assertTrue(wsGate.contains("agentSettings.isMirrored"),
                "WsGate 必须读构造器注入的 agentSettings 实例（Configurator 传入的正是容器单例）");
    }

    // ===================== 源码读取工具（沿用本仓既有先例） =====================

    private static String readSource(String relativePath) {
        // surefire 的工作目录可能是仓库根或模块目录，两种都要兼容
        Path p = Paths.get(relativePath);
        if (!Files.exists(p)) {
            p = Paths.get("..").resolve(relativePath).normalize();
        }

        Assertions.assertTrue(Files.exists(p), "找不到源文件：" + p.toAbsolutePath());

        try {
            return Files.readString(p);
        } catch (Exception e) {
            throw new IllegalStateException("读取源文件失败：" + p.toAbsolutePath(), e);
        }
    }

    /**
     * 取一个方法体（从签名行到配平的闭合括号），用于只在该方法内做断言。
     *
     * <p>不做「全文搜字符串」：同一个词可能出现在注释、别的方法或 import 里，
     * 那种断言会给出假绿（本仓已有先例：契约测试把缺陷形状锁成正确形状）。</p>
     */
    private static String methodBody(String source, String signature) {
        int start = source.indexOf(signature);
        Assertions.assertTrue(start >= 0, "找不到方法签名：" + signature);

        int brace = source.indexOf('{', start);
        Assertions.assertTrue(brace > 0, "方法签名后没有方法体：" + signature);

        int depth = 0;
        for (int i = brace; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return source.substring(brace, i + 1);
                }
            }
        }

        Assertions.fail("方法体括号不配平：" + signature);
        return null;
    }

    /**
     * 取出 {@code if (chatModel == null) { ... }} 拦截块的块体。
     *
     * <p>为何不只断言「方法体里出现过 chatModel == null」：那只证明写了判定，不证明判定里
     * 真的做了拦截（空块 / 只记日志不返回 都会让裸 NPE 原样重现）。锁块体才能锁住行为。</p>
     *
     * @param code  已去注释的方法体
     * @param where 断言失败消息里的定位名
     */
    private static String nullGuardBlock(String code, String where) {
        int start = code.indexOf("if (chatModel == null)");
        Assertions.assertTrue(start >= 0, where + " 缺少 chatModel == null 拦截："
                + "不拦的话 null 会流到 ReActAgentConfig 的 requireNonNull，用户只看到裸文案「chatModel is required」");

        int brace = code.indexOf('{', start);
        Assertions.assertTrue(brace > 0, where + " 的拦截判定后没有块体");

        int end = code.indexOf('}', brace);
        Assertions.assertTrue(end > brace, where + " 的拦截块没有闭合");

        String block = code.substring(brace + 1, end);
        Assertions.assertFalse(block.trim().isEmpty(), where + " 的拦截块是空的（写了判定但没做任何事）");
        return block;
    }

    /**
     * 去掉注释后的代码文本。
     *
     * <p><b>为什么必须去注释</b>：本仓踩过的坑——把拦截逻辑整段注释掉，
     * {@code contains("文案")} 仍然全绿，因为注释里也写着这些字。存在型断言只有作用在
     * 「去注释后的代码」上才锁得住行为。</p>
     */
    private static String codeOnly(String text) {
        // 行注释
        String noLine = text.replaceAll("(?m)//[^\\n]*", "");
        // 块注释
        return noLine.replaceAll("(?s)/\\*.*?\\*/", "");
    }
}
