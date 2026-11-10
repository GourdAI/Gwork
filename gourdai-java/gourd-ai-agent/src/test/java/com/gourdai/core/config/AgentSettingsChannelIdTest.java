package com.gourdai.core.config;

import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.ProviderDo;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 渠道唯一 id 身份测试：providers 以 {@code id} 为不变身份、models 以 {@code providerId}
 * 关联渠道；名称退化为展示标签。覆盖旧配置内存迁移（id 回填）、同渠道分裂块归并、
 * 改名身份稳定、级联删除按 id 匹配四条主线。
 */
class AgentSettingsChannelIdTest {

    private ModelDo model(String name, String provider) {
        ModelDo modelDo = new ModelDo();
        modelDo.setName(name);
        modelDo.setModel(name);
        modelDo.setProvider(provider);
        return modelDo;
    }

    private List<String> keys(AgentSettings settings) {
        return new ArrayList<>(settings.getModels().keySet());
    }

    /** 旧配置形态：providers 无 id、models 无 providerId。 */
    private AgentSettings legacySettings() {
        AgentSettings settings = new AgentSettings();

        ProviderDo aiOnly = new ProviderDo();
        aiOnly.setName("AiOnly");
        aiOnly.setApiUrl("https://api.aionly.com");
        settings.putProvider("AiOnly", aiOnly);

        // 分裂块：同渠道模型被历史增量同步劈成两段（198 + 4 的最小复现）
        settings.getModels().put("AiOnly-m1", model("AiOnly-m1", "AiOnly"));
        settings.getModels().put("AiOnly-m2", model("AiOnly-m2", "AiOnly"));
        settings.getModels().put("Other-x", model("Other-x", "Other"));
        settings.getModels().put("AiOnly-m3", model("AiOnly-m3", "AiOnly"));
        return settings;
    }

    @Test
    void putProviderGeneratesStableChannelId() {
        AgentSettings settings = new AgentSettings();
        ProviderDo provider = new ProviderDo();
        provider.setName("P");
        settings.putProvider("P", provider);

        String id = settings.getProviders().get("P").getId();
        Assertions.assertNotNull(id);
        Assertions.assertEquals(12, id.length());

        // replaceProvider 改名：id 恒延续（身份不变）
        ProviderDo renamed = new ProviderDo();
        renamed.setName("P2");
        Assertions.assertTrue(settings.replaceProvider("P", "P2", renamed));
        Assertions.assertEquals(id, settings.getProviders().get("P2").getId());
    }

    @Test
    void ensureChannelIdsBackfillsProviderIdsAndModelProviderIds() {
        AgentSettings settings = legacySettings();
        Assertions.assertNull(settings.getModels().get("AiOnly-m1").getProviderId());

        settings.ensureChannelIds();

        String id = settings.getProviders().get("AiOnly").getId();
        Assertions.assertNotNull(id);
        for (String key : Arrays.asList("AiOnly-m1", "AiOnly-m2", "AiOnly-m3")) {
            Assertions.assertEquals(id, settings.getModels().get(key).getProviderId());
        }
        // 孤儿渠道（providers 表没有 Other）：保持无 id，走名称回退
        Assertions.assertNull(settings.getModels().get("Other-x").getProviderId());

        // 幂等：二次调用不再改动
        settings.ensureChannelIds();
        Assertions.assertEquals(id, settings.getProviders().get("AiOnly").getId());
    }

    @Test
    void splitChannelBlocksMergeByIdAfterMigration() {
        AgentSettings settings = legacySettings();
        // 迁移前：名称键也能归组（同名称），但迁移后必须按 id 归组——此处验证整体链路
        settings.ensureChannelIds();

        List<String> split = new ArrayList<>();
        Assertions.assertTrue(settings.normalizeModelProviderOrder(split));
        Assertions.assertEquals(Arrays.asList("AiOnly"), split);
        Assertions.assertEquals(
                Arrays.asList("AiOnly-m1", "AiOnly-m2", "AiOnly-m3", "Other-x"),
                keys(settings));
        // 归组后再次归组为 no-op
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
    }

    @Test
    void renameKeepsChannelIdentityAndRegroupsById() {
        AgentSettings settings = legacySettings();
        settings.ensureChannelIds();
        String id = settings.getProviders().get("AiOnly").getId();
        // 先把历史分裂块归并，再验证改名不破坏渠道身份与区块连续性
        settings.normalizeModelProviderOrder();

        // 渠道改名：provider 表键与模型展示名更新，providerId 不动
        ProviderDo renamed = new ProviderDo();
        renamed.setName("AiOnly-雪峰");
        renamed.setApiUrl("https://api.aionly.com");
        Assertions.assertTrue(settings.replaceProvider("AiOnly", "AiOnly-雪峰", renamed));
        Map<String, String> renamedModels = settings.renameProviderModels("AiOnly", "AiOnly-雪峰");
        Assertions.assertEquals(3, renamedModels.size());

        for (ModelDo m : settings.getModels().values()) {
            if (m.getName().startsWith("AiOnly-雪峰-")) {
                Assertions.assertEquals(id, m.getProviderId());
                Assertions.assertEquals("AiOnly-雪峰", m.getProvider());
            }
        }
        // 分组键仍为该渠道 id：归组 no-op（区块连续未被改名破坏）
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
    }

    @Test
    void cascadeRemoveMatchesByChannelIdEvenWithStaleDisplayName() {
        AgentSettings settings = legacySettings();
        settings.ensureChannelIds();

        // 模拟展示名漂移：模型 provider 字段仍是旧名，但 providerId 已绑定渠道 id
        settings.updateModel("AiOnly-m2", copy -> copy.setProvider("StaleName"));

        List<String> removed = settings.removeProviderCascade("AiOnly", null);
        Assertions.assertEquals(Arrays.asList("AiOnly-m1", "AiOnly-m2", "AiOnly-m3"), removed);
        Assertions.assertEquals(Arrays.asList("Other-x"), keys(settings));
        Assertions.assertTrue(settings.getProviders().isEmpty());
    }

    /**
     * 回归护栏：生产真实调用序（WebSettingsController#providersUpdate）是先 replaceProvider
     * （providers 表键已切到新名）再 renameProviderModels（入参仍是旧名）。
     *
     * <p>此时按旧名解析渠道 id 必返 null，「按 id 匹配」退化成名称回退——展示名漂移过的模型
     * 会被漏改名，同一渠道内残留两种展示名，前端按名称分组即裂成两段（用户报的「重复」）。
     * 修复后方法内部需回查新名取得同一渠道 id，三个模型全部迁移。</p>
     */
    @Test
    void renameInProductionOrderStillMatchesByChannelId() {
        AgentSettings settings = legacySettings();
        settings.ensureChannelIds();
        String id = settings.getProviders().get("AiOnly").getId();
        // 展示名漂移：provider 字段是旧旧名，但 providerId 仍绑定渠道 id
        settings.updateModel("AiOnly-m2", copy -> copy.setProvider("StaleName"));
        // 先把历史分裂块归并，再验证改名不破坏渠道身份与区块连续性
        settings.normalizeModelProviderOrder();

        // 生产顺序：先改 providers 表键名，再迁移模型（旧名入参）
        ProviderDo renamed = new ProviderDo();
        renamed.setName("AiOnly-雪峰");
        Assertions.assertTrue(settings.replaceProvider("AiOnly", "AiOnly-雪峰", renamed));
        Map<String, String> renamedModels = settings.renameProviderModels("AiOnly", "AiOnly-雪峰");

        // 三个模型全部迁移（含展示名已漂移的 m2）：渠道内不再残留第二种展示名
        Assertions.assertEquals(3, renamedModels.size());
        Assertions.assertEquals(id, settings.getModels().get("AiOnly-雪峰-m2").getProviderId());
        Assertions.assertEquals("AiOnly-雪峰", settings.getModels().get("AiOnly-雪峰-m2").getProvider());
        // 渠道内展示名唯一：归组 no-op，不会裂成两段
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(
                Arrays.asList("AiOnly-雪峰-m1", "AiOnly-雪峰-m2", "AiOnly-雪峰-m3", "Other-x"),
                keys(settings));
    }

    /**
     * 回归护栏：mergeFrom 从 config.yml 播种模型发生在 loadFromFile 的 ensureChannelIds 之后，
     * 播种进来的模型不带 providerId；若不在播种后补一次回填，它们会退回名称回退匹配、
     * 与同渠道 id 模型分裂成两个区块。
     */
    @Test
    void mergeFromSeedThenBackfillsChannelIds() {
        AgentSettings settings = new AgentSettings();
        ProviderDo provider = new ProviderDo();
        provider.setName("AiOnly");
        settings.putProvider("AiOnly", provider);
        String id = settings.getProviders().get("AiOnly").getId();

        // 播种：props 里的模型只有 provider 名称，无 providerId
        //（AgentProperties 仅 @Getter，按 getModels() 就地添加）
        AgentProperties props = new AgentProperties();
        props.getModels().add(model("AiOnly-m1", "AiOnly"));
        settings.mergeFrom(props);

        Assertions.assertEquals(id, settings.getModels().get("AiOnly-m1").getProviderId());

        // 分裂块仍能被按 id 归并：播种模型与既有同渠道模型同组
        settings.getModels().put("AiOnly-m2", model("AiOnly-m2", "AiOnly"));
        settings.getModels().put("Other-x", model("Other-x", "Other"));
        settings.getModels().put("AiOnly-m3", model("AiOnly-m3", "AiOnly"));
        settings.ensureChannelIds();
        Assertions.assertTrue(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(
                Arrays.asList("AiOnly-m1", "AiOnly-m2", "AiOnly-m3", "Other-x"),
                keys(settings));
    }

    @Test
    void twoChannelsSameUrlStayDistinctGroups() {
        // 用户拍板：不再按地址判定唯一性——同 URL 的两个渠道是两条独立渠道
        AgentSettings settings = new AgentSettings();
        ProviderDo a = new ProviderDo();
        a.setName("AiOnly");
        a.setApiUrl("https://api.aionly.com");
        ProviderDo b = new ProviderDo();
        b.setName("Aionly-雪峰");
        b.setApiUrl("https://api.aionly.com");
        settings.putProvider("AiOnly", a);
        settings.putProvider("Aionly-雪峰", b);

        String idA = settings.getProviders().get("AiOnly").getId();
        String idB = settings.getProviders().get("Aionly-雪峰").getId();
        Assertions.assertNotEquals(idA, idB);

        ModelDo ma = model("AiOnly-m1", "AiOnly");
        ma.setProviderId(idA);
        ModelDo mb = model("Aionly-雪峰-m1", "Aionly-雪峰");
        mb.setProviderId(idB);
        settings.getModels().put(ma.getName(), ma);
        settings.getModels().put(mb.getName(), mb);

        // 两个渠道各自成组、互不合并，顺序保持配置序
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(Arrays.asList("AiOnly-m1", "Aionly-雪峰-m1"), keys(settings));

        // 级联删除只摘自己渠道
        Assertions.assertEquals(Arrays.asList("AiOnly-m1"), settings.removeProviderCascade("AiOnly", null));
        Assertions.assertEquals(Arrays.asList("Aionly-雪峰-m1"), keys(settings));
    }
}
