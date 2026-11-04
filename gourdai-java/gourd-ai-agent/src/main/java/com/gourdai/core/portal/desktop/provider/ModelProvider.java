package com.gourdai.core.portal.desktop.provider;

import com.gourdai.core.portal.web.model.ModelInfo;

import java.util.List;
import java.util.Map;

/**
 * AI 模型 Provider 抽象接口
 * 每个 API 协议（OpenAI、Ollama 等）对应一个实现类
 */
public interface ModelProvider {

    String getProviderName();

    List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey);

    default String deriveBaseUrl(String apiUrl){
        String[] suffixes = {"/api/anthropic/v1/messages","/api/paas/v4/chat/completions",
                "/api/coding/paas/v4/chat/completions",
                "/api/anthropic","/chat/completions", "/images/generations", "/embeddings",
                "/completions", "/api/chat/", "/api/chat",  };
        String url = apiUrl;
        for (String suffix : suffixes) {
            if (url.endsWith(suffix)) {
                url = url.substring(0, url.length() - suffix.length());
            }
        }
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
