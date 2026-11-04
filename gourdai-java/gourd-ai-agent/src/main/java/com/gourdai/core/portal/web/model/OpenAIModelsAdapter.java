package com.gourdai.core.portal.web.model;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * OpenAI 兼容协议实现
 * 接口：GET {baseUrl}/models
 */
@Slf4j
public class OpenAIModelsAdapter implements ModelsAdapter {

@Override
    public String getStandard() {
        return "openai";
    }

    @Override
    public List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey) {
        String modelsUrl = ModelsHttp.requireHttpUrl(deriveModelsUrl(baseUrl), "OpenAI");
        List<ModelInfo> result = new ArrayList<>();

        try {
            HttpUtils http = HttpUtils.http(modelsUrl).timeout(15);

            if (headers != null) {
                headers.forEach(http::header);
            }
            if (apiKey != null && !apiKey.isEmpty()
                    && (headers == null || !headers.containsKey("Authorization"))) {
                http.header("Authorization", "Bearer " + apiKey);
            }

            String body = ModelsHttp.getBody(http, "OpenAI");

            ONode root;
            try {
                root = ONode.ofJson(body);
            } catch (Throwable e) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[OpenAI] invalid JSON response", e);
            }
            ONode data = root.get("data");
            if (data == null || !data.isArray()) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[OpenAI] missing data array");
            }
            for (ONode item : data.getArray()) {
                    ModelInfo modelInfo = item.toBean(ModelInfo.class);

                    // supported_endpoint_types 为下划线命名，toBean 不会自动映射；
                    // 手动解析并据此推断该模型的对话接口协议（识别不了则留空，前端回退 openai）。
                    ONode endpointsNode = item.get("supported_endpoint_types");
                    if (endpointsNode != null && endpointsNode.isArray()) {
                        List<String> endpointTypes = new ArrayList<>();
                        for (ONode ep : endpointsNode.getArray()) {
                            endpointTypes.add(ep.getString());
                        }
                        modelInfo.setSupportedEndpointTypes(endpointTypes);
                        modelInfo.setStandard(ModelInfo.inferStandard(endpointTypes));
                    }

                    result.add(modelInfo);
            }
        } catch (ModelsFetchException e) {
            log.warn("[OpenAI] model fetch failed: reason={}, status={}", e.getReason(), e.getStatus());
            throw e;
        } catch (Exception e) {
            log.warn("[OpenAI] invalid models response", e);
            throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                    "[OpenAI] invalid models response", e);
        }

        return result;
    }

    private String deriveModelsUrl(String baseUrl) {
        String base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        if (base.endsWith("/models")) return base;
        if (base.endsWith("/v1")) return base + "/models";
        return base + "/v1/models";
    }
}
