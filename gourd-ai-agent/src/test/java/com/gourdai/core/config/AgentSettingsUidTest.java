package com.gourdai.core.config;

import com.gourdai.core.config.entity.ModelDo;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.Map;

/**
 * 服务商改名 / 模型编辑的统计身份（uid）保持测试。
 *
 * <p>uid = {@code SHA-256(provider|model) 前16hex}，是使用统计的归组锚点。本测试锁定两条
 * 「改名不失联」的关键语义：</p>
 * <ol>
 *   <li>provider 改名时必须按「旧名」冻结 uid——否则改后首个 trace 按新名现算，
 *       与账本回填按旧名派生的 uid 分裂；</li>
 *   <li>模型编辑（元数据变化、身份字段不变）必须继承旧 uid——否则一次无关编辑
 *       就会抹掉已冻结的 uid。</li>
 * </ol>
 *
 * @author oisin
 */
public class AgentSettingsUidTest {

    private ModelDo model(String provider, String modelId) {
        ModelDo m = new ModelDo();
        m.setName(provider + "-" + modelId);
        m.setProvider(provider);
        m.setModel(modelId);
        return m;
    }

    /** provider 改名：uid 必须按「旧名」冻结，后续不再随名称变化。 */
    @Test
    public void testRenameProviderFreezesUidFromOldName() {
        AgentSettings settings = new AgentSettings();
        settings.addModelInProviderBlock(model("MAD", "gpt-5.6-sol"));
        Assertions.assertNull(settings.getModels().get("MAD-gpt-5.6-sol").getUid(), "初始无 uid");

        Map<String, String> renamed = settings.renameProviderModels("MAD", "黑驴");
        Assertions.assertEquals("黑驴-gpt-5.6-sol", renamed.get("MAD-gpt-5.6-sol"));

        ModelDo after = settings.getModels().get("黑驴-gpt-5.6-sol");
        Assertions.assertNotNull(after, "改名后模型必须在新 key 下");
        Assertions.assertEquals(ModelDo.uidOf("MAD", "gpt-5.6-sol"), after.getUid(),
                "改名必须冻结旧名派生的 uid");
        Assertions.assertEquals(after.getUid(), after.stableUid(), "已冻结的 uid 不再随新名漂移");
    }

    /** provider 改名：已存在的 uid 必须原样保留（改名不改身份）。 */
    @Test
    public void testRenameProviderKeepsExistingUid() {
        AgentSettings settings = new AgentSettings();
        ModelDo m = model("MAD", "gpt-5.6-sol");
        String frozen = m.stableUid(); // 模拟「本会话已产生 trace、uid 已现算缓存」
        settings.addModelInProviderBlock(m);

        settings.renameProviderModels("MAD", "Mad");
        ModelDo after = settings.getModels().get("Mad-gpt-5.6-sol");
        Assertions.assertNotNull(after);
        Assertions.assertEquals(frozen, after.getUid(), "既有 uid 必须原样保留");
    }

    /** 模型编辑（身份字段 provider|model 不变）：uid 必须继承旧条目，不被一次无关编辑抹掉。 */
    @Test
    public void testModelEditInheritsUidWhenIdentityUnchanged() {
        AgentSettings settings = new AgentSettings();
        ModelDo m = model("黑驴", "gpt-5.6-sol");
        m.stableUid();
        settings.addModelInProviderBlock(m);
        String uid = settings.getModels().get("黑驴-gpt-5.6-sol").getUid();

        // 模拟编辑表单提交：不携带 uid，身份字段不变、其余字段可改
        ModelDo edit = model("黑驴", "gpt-5.6-sol");
        edit.setApiKey("sk-new");
        Assertions.assertTrue(settings.replaceModelInPlace("黑驴-gpt-5.6-sol", edit));

        ModelDo after = settings.getModels().get("黑驴-gpt-5.6-sol");
        Assertions.assertNotNull(after);
        Assertions.assertEquals(uid, after.getUid(), "身份未变的编辑必须继承 uid");
        Assertions.assertEquals("sk-new", after.getApiKey(), "其余字段以新提交为准");
    }

    /** 模型编辑改了身份字段（换模型）：不得继承（视为新身份，避免错误并账）。 */
    @Test
    public void testModelEditDoesNotInheritUidWhenIdentityChanged() {
        AgentSettings settings = new AgentSettings();
        ModelDo m = model("黑驴", "gpt-5.6-sol");
        m.stableUid();
        settings.addModelInProviderBlock(m);

        ModelDo edit = model("黑驴", "gpt-5.7-sol"); // model 身份字段变化
        Assertions.assertTrue(settings.replaceModelInPlace("黑驴-gpt-5.6-sol", edit));

        ModelDo after = settings.getModels().get("黑驴-gpt-5.7-sol");
        Assertions.assertNotNull(after);
        Assertions.assertNull(after.getUid(), "身份字段变化的编辑不继承旧 uid");
        Assertions.assertEquals(ModelDo.uidOf("黑驴", "gpt-5.7-sol"), after.stableUid(),
                "新身份按新名派生，不并入旧账");
    }
}
