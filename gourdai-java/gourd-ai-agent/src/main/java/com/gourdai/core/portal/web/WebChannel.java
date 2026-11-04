package com.gourdai.core.portal.web;

import com.gourdai.harness.HarnessEngine;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Post;
import com.gourdai.core.channel.ChannelCommandHandler;
import com.gourdai.core.channel.ChannelRoutingTable;
import com.gourdai.core.channel.dingtalk.DingTalkLink;
import com.gourdai.core.channel.feishu.FeishuLink;
import com.gourdai.core.channel.wechat.WeChatClient;
import com.gourdai.core.channel.wechat.WeChatLink;

import org.noear.solon.core.handle.Result;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Web 通道控制器 —— 统一管理多渠道即时通讯的绑定、解绑与状态查询。
 *
 * <p><b>职责说明：</b>
 * 提供基于 HTTP 的 REST 接口，供前端页面完成即时通讯通道的扫码绑定、凭证绑定、
 * 解绑以及状态轮询等操作。每个通道对应一组绑定/解绑/状态接口。</p>
 *
 * <p><b>支持的通道类型：</b>
 * <ul>
 *   <li>微信（WeChat）—— 通过扫码登录方式绑定</li>
 *   <li>飞书（Feishu）—— 通过 App ID / App Secret 凭证方式绑定，基于 WebSocket Stream 通信</li>
 *   <li>钉钉（DingTalk）—— 通过 AppKey / AppSecret 凭证方式绑定，基于 Stream 通信</li>
 * </ul>
 *
 * <p><b>架构位置：</b>
 * 位于 portal.web 层，作为 Web 控制器接收前端请求，将通道操作委托给
 * {@link WeChatLink}、{@link FeishuLink}、{@link DingTalkLink} 等通道适配器执行。
 * 实现 {@link Runnable} 接口，在启动时同时拉起所有通道的长连接。</p>
 *
 * @author oisin
 */
public class WebChannel implements Runnable{

    /** 微信通道适配器，负责扫码登录、会话绑定与消息转发 */
    private final WeChatLink weChatLink;

    /** 飞书通道适配器，负责 WebSocket Stream 连接、会话绑定与消息转发 */
    private final FeishuLink feishuLink;

    /** 钉钉通道适配器，负责 Stream 连接、会话绑定与消息转发 */
    private final DingTalkLink dingTalkLink;

    /** 全局路由表，管理通道 -> 活跃会话的映射 */
    private final ChannelRoutingTable routingTable;

    /** 命令处理器，处理 IM 中的会话选择/切换命令 */
    private final ChannelCommandHandler commandHandler;

    private static final Set<String> VALID_CHANNELS = new HashSet<>(Arrays.asList("wechat", "feishu", "dingtalk"));

    /**
     * 构造函数：初始化全局路由表、命令处理器及三个通道适配器。
     *
     * @param engine         AI 能力引擎，供各通道适配器调用模型能力
     * @param webGate        Web 网关，提供公共配置与回调上下文
     * @param sessionLocator 会话目录定位器（解析 chat/code 会话落盘目录）
     * @param projectService 项目登记服务（枚举 code 会话所在项目）
     */
    public WebChannel(HarnessEngine engine, WebGate webGate,
                      SessionLocator sessionLocator, ProjectService projectService) {

        this.routingTable = new ChannelRoutingTable();
        this.commandHandler = new ChannelCommandHandler(routingTable, engine, sessionLocator, projectService);

        // 从文件恢复路由状态
        routingTable.load();

        this.weChatLink = new WeChatLink(engine, webGate, routingTable, commandHandler);
        this.feishuLink = new FeishuLink(engine, webGate, routingTable, commandHandler);
        this.dingTalkLink = new DingTalkLink(engine, webGate, routingTable, commandHandler);
    }

    /**
     * 启动所有通道适配器的长连接监听。
     * 依次启动微信、飞书、钉钉三个通道的运行循环。
     * 同时执行旧绑定数据的自动迁移（首次升级时设置默认路由）。
     */
    @Override
    public void run() {
        weChatLink.run();
        feishuLink.run();
        dingTalkLink.run();

        // 自动迁移：如果旧绑定存在但路由表为空，将第一个已绑定的会话设为活跃会话
        migrateOldBindings();
    }

    /**
     * 迁移旧的 per-session 绑定到全局路由模式。
     * 如果某通道有旧绑定但路由表中尚无对应记录，取第一个绑定的 sessionId 作为默认活跃会话。
     */
    private void migrateOldBindings() {
        if (routingTable.getActiveSession("wechat") == null) {
            java.util.Set<String> wechatSessions = weChatLink.getBoundSessionIds();
            // 仅当唯一绑定时才自动迁移；多个绑定时不猜（避免无序 iterator 随机顶错活跃会话）
            if (wechatSessions.size() == 1) {
                routingTable.setActiveSession("wechat", wechatSessions.iterator().next());
            }
        }
        if (routingTable.getActiveSession("feishu") == null) {
            java.util.Set<String> feishuSessions = feishuLink.getBoundSessionIds();
            if (feishuSessions.size() == 1) {
                routingTable.setActiveSession("feishu", feishuSessions.iterator().next());
            }
        }
        if (routingTable.getActiveSession("dingtalk") == null) {
            java.util.Set<String> dingtalkSessions = dingTalkLink.getBoundSessionIds();
            if (dingtalkSessions.size() == 1) {
                routingTable.setActiveSession("dingtalk", dingtalkSessions.iterator().next());
            }
        }
    }

    // ==================== 微信（WeChat）通道接口 ====================

    /**
     * 获取微信扫码登录二维码。
     *
     * <p>调用微信接口获取二维码图片及其标识，用于前端展示扫码登录入口。</p>
     *
     * @param sessionId 当前会话标识，用于将二维码与具体会话关联
     * @return 包含 qrcode（二维码标识）、qrcode_img_content（二维码图片内容）、sessionId 的结果
     */
    @Get
    @Mapping("/web/chat/wechat/qrcode")
    public Result<Map> wechatQrcode(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }

        Map<String, String> qrResult = WeChatClient.fetchQRCode();
        if (qrResult == null) {
            return Result.failure("获取微信二维码失败，请确认网络可访问 ilinkai.weixin.qq.com");
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("qrcode", qrResult.get("qrcode"));
        data.put("qrcode_img_content", qrResult.get("qrcode_img_content"));
        data.put("sessionId", sessionId);
        return Result.succeed(data);
    }

    /**
     * 轮询微信扫码状态。
     *
     * <p>根据二维码标识查询当前扫码进度（等待扫码、已扫码待确认、已确认等）。
     * 当状态为 "confirmed" 时，自动将机器人绑定到对应会话。</p>
     *
     * @param qrcode     二维码标识，由 {@link #wechatQrcode} 接口返回
     * @param sessionId  当前会话标识
     * @return 包含扫码状态信息的结果；确认后额外触发自动绑定
     */
    @Get
    @Mapping("/web/chat/wechat/qrcode/status")
    public Result<Map> wechatQrcodeStatus(@Param("qrcode") String qrcode,
                                          @Param("sessionId") String sessionId) {
        if (qrcode == null || qrcode.isEmpty()) {
            return Result.failure("qrcode is required");
        }
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }

        Map<String, String> statusResult = WeChatClient.pollQRStatus(qrcode);
        if (statusResult == null) {
            Map<String, Object> errData = new LinkedHashMap<>();
            errData.put("status", "error");
            return Result.succeed(errData);
        }

        // 扫码确认后自动绑定：提取令牌与用户信息，关联到当前会话
        if ("confirmed".equals(statusResult.get("status"))) {
            String botToken = statusResult.get("bot_token");
            String ilinkBotId = statusResult.get("ilink_bot_id");
            String ilinkUserId = statusResult.get("ilink_user_id");

            weChatLink.bindSession(sessionId, botToken, ilinkBotId, ilinkUserId);
        }

        Map<String, Object> data = new LinkedHashMap<>(statusResult);
        return Result.succeed(data);
    }

    /**
     * 解绑微信通道。
     *
     * <p>解除指定会话与微信机器人的绑定关系，之后该会话不再接收微信消息。</p>
     *
     * @param sessionId 待解绑的会话标识
     * @return 操作结果
     */
    @Post
    @Mapping("/web/chat/wechat/unbind")
    public Result wechatUnbind(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }

        weChatLink.unbindSession(sessionId);
        return Result.succeed();
    }

    /**
     * 查询会话的微信绑定状态。
     *
     * @param sessionId 待查询的会话标识
     * @return 包含 bound（是否已绑定）的结果
     */
    @Get
    @Mapping("/web/chat/wechat/status")
    public Result<Map> wechatStatus(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("bound", weChatLink.isBound(sessionId));
        return Result.succeed(data);
    }

    // ==================== 飞书（Feishu）通道接口 ====================

    /**
     * 绑定飞书到指定会话。
     *
     * <p>提交飞书应用的 App ID 和 App Secret，启动 WebSocket Stream 连接，
     * 等待飞书侧自动完成事件订阅绑定。</p>
     *
     * @param sessionId  当前会话标识
     * @param appId      飞书应用的 App ID
     * @param appSecret  飞书应用的 App Secret
     * @return 启动成功返回成功结果；失败返回错误提示
     */
    @Post
    @Mapping("/web/chat/feishu/bind")
    public Result feishuBind(@Param("sessionId") String sessionId,
                             @Param("appId") String appId,
                             @Param("appSecret") String appSecret) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (appId == null || appId.isEmpty()) {
            return Result.failure("App ID 是必填项");
        }
        if (appSecret == null || appSecret.isEmpty()) {
            return Result.failure("App Secret 是必填项");
        }
        if (feishuLink == null) {
            return Result.failure("飞书通道未启用");
        }

        boolean ok = feishuLink.startStream(appId, appSecret, sessionId);
        if (!ok) {
            return Result.failure("飞书连接启动失败，请检查 App ID 和 App Secret");
        }
        return Result.succeed();
    }

    /**
     * 解绑飞书通道。
     *
     * <p>解除指定会话与飞书应用的绑定关系，并断开对应的 Stream 连接。</p>
     *
     * @param sessionId 待解绑的会话标识
     * @return 操作结果
     */
    @Post
    @Mapping("/web/chat/feishu/unbind")
    public Result feishuUnbind(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (feishuLink != null) {
            feishuLink.unbindSession(sessionId);
        }
        return Result.succeed();
    }

    /**
     * 查询会话的飞书绑定状态。
     *
     * <p>返回包含 Stream 连接状态的详细信息，供前端轮询判断绑定进度。</p>
     *
     * @param sessionId 待查询的会话标识
     * @return 包含 bound（是否已绑定）、streamStarted（Stream 是否已启动）、pending（是否等待绑定确认）的结果
     */
    @Get
    @Mapping("/web/chat/feishu/status")
    public Result<Map> feishuStatus(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (feishuLink == null) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("bound", false);
            data.put("streamStarted", false);
            data.put("pending", false);
            return Result.succeed(data);
        }
        return Result.succeed(feishuLink.getStreamStatus(sessionId));
    }

    // ==================== 钉钉（DingTalk）通道接口 ====================

    /**
     * 绑定钉钉到指定会话。
     *
     * <p>提交钉钉应用的 AppKey 和 AppSecret，启动 Stream 长连接，
     * 用户在钉钉端向机器人发送消息后自动完成绑定。</p>
     *
     * @param sessionId  当前会话标识
     * @param appKey     钉钉应用的 AppKey
     * @param appSecret  钉钉应用的 AppSecret
     * @return 启动成功返回提示信息；失败返回错误提示
     */
    @Post
    @Mapping("/web/chat/dingtalk/bind")
    public Result dingtalkBind(@Param("sessionId") String sessionId,
                               @Param("appKey") String appKey,
                               @Param("appSecret") String appSecret) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (appKey == null || appKey.isEmpty()) {
            return Result.failure("appKey 不能为空");
        }
        if (appSecret == null || appSecret.isEmpty()) {
            return Result.failure("appSecret 不能为空");
        }
        if (dingTalkLink == null) {
            return Result.failure("钉钉通道未启用");
        }

        boolean ok = dingTalkLink.startStream(appKey, appSecret, sessionId);
        if (!ok) {
            return Result.failure("启动 Stream 连接失败，请检查 AppKey 和 AppSecret");
        }
        return Result.succeed("已启动连接，请在钉钉上发消息给机器人完成绑定");
    }

    /**
     * 解绑钉钉通道。
     *
     * <p>解除指定会话与钉钉应用的绑定关系，并断开对应的 Stream 连接。</p>
     *
     * @param sessionId 待解绑的会话标识
     * @return 操作结果
     */
    @Post
    @Mapping("/web/chat/dingtalk/unbind")
    public Result dingtalkUnbind(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (dingTalkLink != null) {
            dingTalkLink.unbindSession(sessionId);
        }
        return Result.succeed();
    }

    /**
     * 查询会话的钉钉绑定状态。
     *
     * <p>供前端轮询使用，返回 Stream 连接状态与绑定进度。</p>
     *
     * @param sessionId 待查询的会话标识
     * @return 包含 bound（是否已绑定）、streamStarted（Stream 是否已启动）、pending（是否等待绑定确认）的结果
     */
    @Get
    @Mapping("/web/chat/dingtalk/status")
    public Result<Map> dingtalkStatus(@Param("sessionId") String sessionId) {
        if (sessionId == null || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (dingTalkLink == null) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("bound", false);
            data.put("streamStarted", false);
            data.put("pending", false);
            return Result.succeed(data);
        }
        return Result.succeed(dingTalkLink.getStreamStatus(sessionId));
    }

    // ==================== 全局通道配置接口 ====================

    /**
     * 获取所有 IM 通道的全局状态（连接状态 + 路由信息）。
     *
     * @return 各通道的连接状态和当前活跃会话
     */
    @Get
    @Mapping("/chat/channel/status")
    public Result<Map> channelStatus() {
        Map<String, Object> data = new LinkedHashMap<>();

        // 微信状态
        Map<String, Object> wechatStatus = new LinkedHashMap<>();
        wechatStatus.put("connected", weChatLink.isConnected());
        wechatStatus.put("activeSessionId", routingTable.getActiveSession("wechat"));
        wechatStatus.put("activeProjectRoot", routingTable.getActiveProjectRoot("wechat"));
        data.put("wechat", wechatStatus);

        // 飞书状态
        Map<String, Object> feishuStatus = new LinkedHashMap<>();
        feishuStatus.put("connected", feishuLink.isConnected());
        feishuStatus.put("activeSessionId", routingTable.getActiveSession("feishu"));
        feishuStatus.put("activeProjectRoot", routingTable.getActiveProjectRoot("feishu"));
        data.put("feishu", feishuStatus);

        // 钉钉状态
        Map<String, Object> dingtalkStatus = new LinkedHashMap<>();
        dingtalkStatus.put("connected", dingTalkLink.isConnected());
        dingtalkStatus.put("activeSessionId", routingTable.getActiveSession("dingtalk"));
        dingtalkStatus.put("activeProjectRoot", routingTable.getActiveProjectRoot("dingtalk"));
        data.put("dingtalk", dingtalkStatus);

        return Result.succeed(data);
    }

    /**
     * 切换通道的活跃会话（从 Web 配置面板调用）。
     *
     * @param channel     通道名称（wechat/feishu/dingtalk）
     * @param sessionId   目标会话 ID（统一 work- 前缀）
     * @param projectRoot 目标会话的所属根（项目会话必需；全局会话可空）。
     *                    为空时服务端会从已登记项目中反查。
     * @return 操作结果
     */
    @Post
    @Mapping("/chat/channel/routing")
    public Result setRouting(@Param("channel") String channel,
                             @Param("sessionId") String sessionId,
                             @Param(value = "projectRoot", required = false) String projectRoot) {
        if (channel == null || channel.isEmpty()) {
            return Result.failure("channel 不能为空");
        }
        if (!VALID_CHANNELS.contains(channel)) {
            return Result.failure("无效的 channel，仅支持: wechat, feishu, dingtalk");
        }
        if (sessionId == null || sessionId.isEmpty()) {
            return Result.failure("sessionId 不能为空");
        }
        if (sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return Result.failure("Invalid sessionId");
        }
        if (projectRoot != null && projectRoot.contains("..")) {
            return Result.failure("Invalid projectRoot");
        }

        // 未带所属根：从会话列表反查（项目会话拿到其项目根；全局会话 projectRoot=null），
        // 保证路由能定位落盘目录与工具 cwd
        String root = (projectRoot != null && !projectRoot.trim().isEmpty()) ? projectRoot.trim() : null;
        if (root == null) {
            for (ChannelCommandHandler.SessionInfo s : commandHandler.listSessions()) {
                if (sessionId.equals(s.sessionId)) {
                    root = s.projectRoot;
                    break;
                }
            }
        }

        routingTable.setActiveSession(channel, sessionId, root);
        return Result.succeed();
    }

    /**
     * 获取可用会话列表（供配置面板的会话选择下拉框使用）。
     *
     * @return 会话列表
     */
    @Get
    @Mapping("/chat/channel/sessions")
    public Result<List> channelSessions() {
        List<ChannelCommandHandler.SessionInfo> sessions = commandHandler.listSessions();
        List<Map<String, String>> data = new ArrayList<>();
        for (ChannelCommandHandler.SessionInfo s : sessions) {
            Map<String, String> item = new LinkedHashMap<>();
            item.put("sessionId", s.sessionId);
            item.put("label", s.label);
            item.put("projectRoot", s.projectRoot);
            data.add(item);
        }
        return Result.succeed(data);
    }

    // ==================== 通道实例访问器 ====================

    /**
     * 获取微信通道适配器实例。
     *
     * <p>供外部组件（如 Configurator）注册启动或进行额外配置。</p>
     *
     * @return 微信通道适配器
     */
    public WeChatLink getWeChatLink() {
        return weChatLink;
    }

    /**
     * 获取飞书通道适配器实例。
     *
     * @return 飞书通道适配器
     */
    public FeishuLink getFeishuLink() {
        return feishuLink;
    }

    /**
     * 获取钉钉通道适配器实例。
     *
     * @return 钉钉通道适配器
     */
    public DingTalkLink getDingTalkLink() {
        return dingTalkLink;
    }

    /**
     * 获取路由表实例。
     *
     * @return 路由表
     */
    public ChannelRoutingTable getRoutingTable() {
        return routingTable;
    }
}
