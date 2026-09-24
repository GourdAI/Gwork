package com.gourdai.core.config.entity;

import lombok.Getter;
import lombok.Setter;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.portal.web.model.ModelInfo;

import java.io.Serializable;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * 供应商配置数据对象
 *
 * @author oisin
 */
@Getter
@Setter
public class ProviderDo implements Serializable {
    /**
     * 供应商名称（唯一标识）
     */
    private String name;

    /**
     * 接口规范：openai / ollama / anthropic
     */
    private String standard = "openai";

    /**
     * API 地址
     */
    private String apiUrl;

    /**
     * API 密钥
     */
    private String apiKey;

    /**
     * 请求超时时间（该连接下所有模型共用；为空则用默认值）
     */
    private Duration timeout;

    /**
     * 是否启用
     */
    private boolean enabled = true;

    /**
     * 作用域：global（全局）/ local（工作区）
     */
    private String scope = AgentFlags.SCOPE_USER;

    /**
     * 该供应商下的模型列表（使用 ModelInfo 存储完整模型信息）
     *
     * ProviderDo.name - ModelDo.provider, ModelInfo.id <-> ModelDo.model
     */
    private List<ModelInfo> models = new ArrayList<>();
}
