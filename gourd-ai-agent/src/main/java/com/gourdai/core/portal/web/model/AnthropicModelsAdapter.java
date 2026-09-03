package com.gourdai.core.portal.web.model;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpUtils;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Anthropic 协议实现
 * 接口：GET {baseUrl}/v1/models
 */
@Slf4j
public class AnthropicModelsAdapter implements ModelsAdapter {

    @Override
    public String getStandard() {
        return "anthropic";
    }

    @Override
    public List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey) {
        String modelsUrl = ModelsHttp.requireHttpUrl(deriveModelsUrl(baseUrl), "Anthropic");
        List<ModelInfo> result = new ArrayList<>();

        try {
            HttpUtils http = HttpUtils.http(modelsUrl).timeout(15);

            if (headers != null) {
                headers.forEach(http::header);
            }
            if (apiKey != null && !apiKey.isEmpty()
                    && (headers == null || !headers.containsKey("x-api-key"))) {
                http.header("x-api-key", apiKey);
            }
            // Anthropic 需要 anthropic-version 头部
            if (headers == null || !headers.containsKey("anthropic-version")) {
                http.header("anthropic-version", "2023-06-01");
            }

            String body = ModelsHttp.getBody(http, "Anthropic");

            ONode root;
            try {
                root = ONode.ofJson(body);
            } catch (Throwable e) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[Anthropic] invalid JSON response", e);
            }
            ONode data = root.get("data");
            if (data == null || !data.isArray()) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[Anthropic] missing data array");
            }
            for (ONode item : data.getArray()) {
                    ModelInfo modelInfo = ModelInfo.builder()
                            .id(item.get("id").getString())
                            .object(item.get("type").getString())
                            .created(parseCreatedAt(item.get("created_at").getString()))
                            .ownedBy("anthropic")
                            .type("chat")
                            .standard("anthropic")
                            .displayName(item.get("display_name").getString())
                            .maxInputTokens(item.get("max_input_tokens").getLong())
                            .maxTokens(item.get("max_tokens").getLong())
                            .capabilities(parseCapabilities(item.get("capabilities")))
                            .build();
                    result.add(modelInfo);
            }
        } catch (ModelsFetchException e) {
            log.warn("[Anthropic] model fetch failed: reason={}, status={}", e.getReason(), e.getStatus());
            throw e;
        } catch (Exception e) {
            log.warn("[Anthropic] invalid models response", e);
            throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                    "[Anthropic] invalid models response", e);
        }

        return result;
    }

    private String deriveModelsUrl(String baseUrl) {
        String base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        if (base.endsWith("/models")) return base;
        if (base.endsWith("/v1")) return base + "/models";
        return base + "/v1/models";
    }

    private long parseCreatedAt(String createdAt) {
        if (createdAt == null || createdAt.isEmpty()) {
            return System.currentTimeMillis() / 1000;
        }
        try {
            return java.time.Instant.parse(createdAt).getEpochSecond();
        } catch (Exception e) {
            return System.currentTimeMillis() / 1000;
        }
    }

    private Map<String, Object> parseCapabilities(ONode capabilitiesNode) {
        if (capabilitiesNode == null || capabilitiesNode.isNull()) {
            return null;
        }
        Map<String, Object> capabilities = new HashMap<>();
        // 将 ONode 转换为 Map<String, ONode>
        Map<String, ONode> nodeMap = capabilitiesNode.toBean(Map.class);
        if (nodeMap == null) {
            return null;
        }
        for (Map.Entry<String, ONode> entry : nodeMap.entrySet()) {
            String key = entry.getKey();
            ONode value = entry.getValue();
            if (value.isObject()) {
                capabilities.put(key, parseCapabilities(value));
            } else if (value.isBoolean()) {
                capabilities.put(key, value.getBoolean());
            } else if (value.isNumber()) {
                capabilities.put(key, value.getLong());
            } else {
                capabilities.put(key, value.getString());
            }
        }
        return capabilities;
    }
}
