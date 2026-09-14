package com.gourdai.core.portal.web.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * 模型信息
 * 支持 OpenAI、Anthropic、Ollama 等多种格式
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModelInfo {
    private String id;
    private String object;
    private long created;
    private String ownedBy;
    /** 扩展字段：chat / image */
    private String type;

    /** 接口类型：openai / openai-responses / anthropic / gemini（按模型单独配置） */
    private String standard;

    // Anthropic 扩展字段
    private String displayName;
    private Map<String, Object> capabilities;

    /**
     * 模型支持的接口类型（部分中转厂商在 /models 返回，如 ["anthropic"]、["openai"]）。
     * 用于自动推断该模型的对话接口协议 {@link #standard}。
     */
    private List<String> supportedEndpointTypes;

    /** 是否为手动添加的模型（动态刷新时不被清除） */
    @Builder.Default
    private boolean manual = false;

    /** 按模型的启用状态（null 表示未单独设置，回退到所属供应商的启用状态） */
    private Boolean enabled;

    /**
     * 根据 supported_endpoint_types 推断对话接口协议，映射到前端 STANDARD_OPTIONS 的取值。
     * 按厂商返回顺序取第一个可识别项（原生协议通常排在前）；无法识别时返回 {@code null}，
     * 由上层回退到默认的 openai（Chat Completions）。
     *
     * @param endpointTypes /models 返回的 supported_endpoint_types 列表
     * @return openai / openai-responses / anthropic / gemini，或 null
     */
    public static String inferStandard(List<String> endpointTypes) {
        if (endpointTypes == null || endpointTypes.isEmpty()) {
            return null;
        }
        for (String raw : endpointTypes) {
            if (raw == null) {
                continue;
            }
            String t = raw.trim().toLowerCase();
            if (t.isEmpty()) {
                continue;
            }
            if (t.contains("anthropic") || t.contains("claude")) {
                return "anthropic";
            }
            if (t.contains("gemini") || t.contains("google")) {
                return "gemini";
            }
            // openai 的 responses 接口：openai-response(s) / responses
            if (t.contains("response")) {
                return "openai-responses";
            }
            if (t.contains("openai") || t.contains("chat")) {
                return "openai";
            }
        }
        return null;
    }
}
