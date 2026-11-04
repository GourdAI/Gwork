package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

/**
 * 模型稳定 uid 的持久化契约测试（防回归）。
 *
 * <p>uid 机制「改名不失联」依赖三条隐式链路，任何一条静默失效都会让统计重新分裂：</p>
 * <ol>
 *   <li>{@code AgentSettings#copyModel} 的 ONode 往返（所有 COW 操作与改名迁移都走它）携带 uid；</li>
 *   <li>settings.json 落盘/加载往返（{@code item.fill(model)} → {@code bindTo}）携带 uid；</li>
 *   <li>trace 帧序列化使用 {@code modelId} 字段名（账本按此字段解析，名称漂移会静默丢归组）。</li>
 * </ol>
 *
 * @author oisin
 */
public class UsageUidRoundTripTest {

    private ModelDo modelWithUid() {
        ModelDo m = new ModelDo();
        m.setName("MAD-gpt-5.6-sol");
        m.setProvider("MAD");
        m.setModel("gpt-5.6-sol");
        m.stableUid();
        return m;
    }

    /** ① copyModel 语义：new ONode().fill(source).toBean(ModelDo.class) 必须保留 uid。 */
    @Test
    public void testCopyModelRoundTripPreservesUid() {
        ModelDo source = modelWithUid();
        String uid = source.getUid();
        ModelDo copy = new ONode().fill(source).toBean(ModelDo.class);
        Assertions.assertEquals(uid, copy.getUid(), "copyModel 往返必须保留 uid（改名迁移依赖）");
        Assertions.assertEquals("MAD", copy.getProvider());
        Assertions.assertEquals("gpt-5.6-sol", copy.getModel());
    }

    /** ② settings 落盘/加载往返：fill → toJson → bindTo 必须保留 uid。 */
    @Test
    public void testSettingsNodeRoundTripPreservesUid() {
        ModelDo source = modelWithUid();
        String uid = source.getUid();

        // 与 AgentSettings.getGlobalJson 的 models 段相同写法
        ONode root = new ONode().asObject();
        ONode models = root.getOrNew("models").asObject();
        ONode item = models.getOrNew("MAD-gpt-5.6-sol").asObject();
        item.fill(source);
        item.remove("userAgent");
        item.remove("contextLength");
        String json = root.toJson();

        Assertions.assertTrue(json.contains("\"uid\""), "settings json 必须携带 uid: " + json);

        AgentSettings loaded = new AgentSettings();
        ONode.ofJson(json).bindTo(loaded);
        ModelDo back = loaded.getModels().get("MAD-gpt-5.6-sol");
        Assertions.assertNotNull(back, "模型必须回读");
        Assertions.assertEquals(uid, back.getUid(), "settings 加载必须恢复 uid");
        Assertions.assertEquals("MAD", back.getProvider());
    }

    /** ③ trace 帧序列化字段名：账本按 modelId 解析，名称漂移会静默丢归组。 */
    @Test
    public void testTraceFrameSerializesModelIdKey() {
        WebChunk chunk = WebChunk.ofTrace("MAD-gpt-5.6-sol", "0123456789abcdef",
                10L, 20L, null, null, 50.0, null, "答案");
        String json = ONode.serialize(chunk);
        ONode node = ONode.ofJson(json);
        Assertions.assertTrue(node.hasKey("modelId"), "序列化必须包含 modelId: " + json);
        Assertions.assertEquals("0123456789abcdef", node.get("modelId").getString());
    }
}
