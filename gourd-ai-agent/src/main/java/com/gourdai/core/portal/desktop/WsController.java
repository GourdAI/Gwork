package com.gourdai.core.portal.desktop;

import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.ChatConfig;
import com.gourdai.harness.HarnessEngine;
import org.noear.solon.annotation.*;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.BuildInfo;
import com.gourdai.core.portal.web.model.ModelInfo;
import com.gourdai.core.portal.desktop.provider.ModelProvider;
import com.gourdai.core.portal.desktop.provider.ModelProviderFactory;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Result;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ws Chat Controller
 *
 * @author oisin
 */
public class WsController {
    private static final Logger LOG = LoggerFactory.getLogger(WsController.class);

    private final HarnessEngine engine;
    private final ModelProviderFactory modelProviderFactory;

    public WsController(HarnessEngine engine, ModelProviderFactory modelProviderFactory) {
        this.engine = engine;
        this.modelProviderFactory = modelProviderFactory;
    }

    /**
     * 获取消息详细记录信息
     *
     * <p>{@code version} 保持原语义不动；额外并列 {@code buildId} / {@code buildTime} 构建指纹，
     * 便于 CLI / 桌面端命令行侧核对当前 jar 是否为本次构建产物。</p>
     */
    @Get
    @Mapping("/version")
    public Result<Map> version() {
        Map<String, String> data = new LinkedHashMap<>();
        data.put("version", AgentFlags.getVersion());
        data.put("workspace", engine.getWorkspace());
        data.put("buildId", BuildInfo.getBuildId());
        data.put("buildTime", BuildInfo.getBuildTime());
        return Result.succeed(data);
    }


    /**
     * 通过 ModelProviderFactory 从远程 API 获取可用模型列表
     */
    @Get
    @Mapping("/chat/models/fetch")
    public Result<List<Map>> fetchModels(@Param("apiUrl") String apiUrl, @Param("apiKey") String apiKey, @Param("provider") String provider) throws Exception {
        if (Assert.isEmpty(apiUrl)) {
            return Result.failure("apiUrl is required");
        }

        ModelProvider modelProvider = modelProviderFactory.getProvider(provider);
        String baseUrl = modelProvider.deriveBaseUrl(apiUrl);
        List<ModelInfo> models = modelProvider.fetchModels(baseUrl, null, apiKey);

        List<Map> list = new ArrayList<>();
        for (ModelInfo mi : models) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", mi.getId());
            item.put("object", mi.getObject());
            item.put("ownedBy", mi.getOwnedBy());

            ChatConfig config = new ChatConfig();
            config.setName(mi.getObject());
            config.setApiUrl(apiUrl);
            config.setApiKey(apiKey);
            config.setModel(mi.getObject());
            engine.removeModel(mi.getObject());
            engine.addModel(config);
            list.add(item);
        }

        return Result.succeed(list);
    }

    /**
     * 动态添加模型配置
     */
    @Post
    @Mapping("/chat/models/add")
    public Result modelsAdd(Context ctx) throws Exception {
        ONode root = ONode.ofJson(ctx.body());

        String apiUrl = root.get("apiUrl").getString();
        String apiKey = root.get("apiKey").getString();
        String model = root.get("model").getString();
        String provider = root.get("provider").getString();

        if (Assert.isEmpty(apiUrl) || Assert.isEmpty(model)) {
            return Result.failure("apiUrl and model are required");
        }

        String name = root.get("name").getString();
        if (Assert.isEmpty(name)) {
            name = model;
        }

        ChatConfig config = new ChatConfig();
        config.setName(name);
        config.setApiUrl(apiUrl);
        config.setApiKey(apiKey);
        config.setModel(model);

        // timeout
        String timeout = root.get("timeout").getString();
        if (Assert.isNotEmpty(timeout)) {
            config.setTimeout(java.time.Duration.parse(timeout));
        }

        // userAgent
        String userAgent = root.get("userAgent").getString();
        if (Assert.isNotEmpty(userAgent)) {
            config.setUserAgent(userAgent);
        }
        engine.removeModel(model);
        engine.addModel(config);

        LOG.info("[Web] Model added: {}", name);
        return Result.succeed(name);
    }

    /**
     * 动态移除模型配置
     */
    @Post
    @Mapping("/chat/models/remove")
    public Result modelsRemove(@Param("modelName") String modelName) throws Exception {
        if (Assert.isEmpty(modelName)) {
            return Result.failure("modelName is required");
        }

        if (modelName.equals(engine.getMainModel().getNameOrModel())) {
            return Result.failure("Cannot remove the active main model");
        }

        engine.removeModel(modelName);

        LOG.info("[Web] Model removed: {}", modelName);
        return Result.succeed();
    }
}
