package com.gourdai.core.portal.web.model;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Ollama 协议实现
 * 接口：GET {baseUrl}/api/tags
 */
@Slf4j
public class OllamaModelsAdapter implements ModelsAdapter {

    @Override
    public String getStandard() {
        return "ollama";
    }

    @Override
    public List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey) {
        String modelsUrl = ModelsHttp.requireHttpUrl(deriveModelsUrl(baseUrl), "Ollama");
        List<ModelInfo> result = new ArrayList<>();

        try {
            HttpUtils http = HttpUtils.http(modelsUrl).timeout(15);

            if (headers != null) {
                headers.forEach(http::header);
            }
            if (apiKey != null && !apiKey.isEmpty()) {
                http.header("Authorization", "Bearer " + apiKey);
            }

            String body = ModelsHttp.getBody(http, "Ollama");

            ONode root;
            try {
                root = ONode.ofJson(body);
            } catch (Throwable e) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[Ollama] invalid JSON response", e);
            }
            ONode models = root.get("models");
            if (models == null || !models.isArray()) {
                throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                        "[Ollama] missing models array");
            }
            for (int i = 0; i < models.size(); i++) {
                    ONode item = models.get(i);
                    String name = item.get("name").getString();
                    long created = System.currentTimeMillis() / 1000;
                    if (item.exists("modified_at")) {
                        try {
                            created = java.time.Instant.parse(item.get("modified_at").getString()).getEpochSecond();
                        } catch (Exception ignored) {
                        }
                    }
                    result.add(ModelInfo.builder()
                            .id(name)
                            .object("model")
                            .created(created)
                            .ownedBy("ollama")
                            .type("chat")
                            .build());
            }
        } catch (ModelsFetchException e) {
            log.warn("[Ollama] model fetch failed: reason={}, status={}", e.getReason(), e.getStatus());
            throw e;
        } catch (Exception e) {
            log.warn("[Ollama] invalid models response", e);
            throw new ModelsFetchException(ModelsFetchReason.INVALID_RESPONSE, 200,
                    "[Ollama] invalid models response", e);
        }

        return result;
    }

    private String deriveModelsUrl(String baseUrl) {
        String base = baseUrl == null ? "" : baseUrl.replaceAll("/+$", "");
        if (base.endsWith("/api/tags")) return base;
        return base + "/api/tags";
    }
}
