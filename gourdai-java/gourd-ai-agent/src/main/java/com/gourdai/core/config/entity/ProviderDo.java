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
     * 渠道唯一 id（不变身份）：创建供应商时生成（12 位短 UUID），随 settings.json 持久化。
     *
     * <p><b>身份语义</b>：模型归属、下拉分组、级联删除、同步关联等一切渠道身份判定均以本 id 为准；
     * {@link #name} 退化为纯展示标签，可随意改名而不影响名下模型的归属。同一服务商允许存在
     * 多个渠道（不同 id / 不同密钥），互不混淆。</p>
     *
     * <p>旧配置无此字段：加载时由 {@code AgentSettings#ensureChannelIds()} 在内存回填
     * （按 providers 表键名与 models.provider 名称关联），下次保存自然落盘。</p>
     */
    private String id;

    /**
     * 供应商名称（展示标签；唯一性仅用于 providers 表键冲突校验，不再是模型归属依据）
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
