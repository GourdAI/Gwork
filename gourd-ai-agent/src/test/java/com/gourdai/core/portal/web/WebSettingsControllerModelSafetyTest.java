package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.ProviderDo;
import com.gourdai.core.portal.web.market.MarketManager;
import com.gourdai.core.portal.web.model.ModelInfo;
import com.gourdai.core.portal.web.model.ModelsAdapter;
import com.gourdai.core.portal.web.model.ModelsAdapterManager;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;

class WebSettingsControllerModelSafetyTest {
    @TempDir
    Path configHome;
    private String originalGworkHome;
    private String originalUserDir;

    @BeforeEach
    void isolateSettingsFiles() {
        originalGworkHome = System.getProperty("gwork.home");
        originalUserDir = System.getProperty("user.dir");
        System.setProperty("gwork.home", configHome.toString());
        System.setProperty("user.dir", configHome.toString());
    }

    @AfterEach
    void restoreSettingsLocations() {
        restoreSystemProperty("gwork.home", originalGworkHome);
        restoreSystemProperty("user.dir", originalUserDir);
    }

    @Test
    void providersFetchBindsStoredKeyToStoredUrlAndStandard() {
        AgentSettings settings = new AgentSettings();
        ProviderDo stored = new ProviderDo();
        stored.setName("Safe");
        stored.setApiUrl("https://safe.example/v1");
        stored.setApiKey("stored-secret");
        stored.setStandard("stored-standard");
        settings.putProvider("Safe", stored);

        CapturingAdapter storedAdapter = new CapturingAdapter("stored-standard");
        CapturingAdapter attackerAdapter = new CapturingAdapter("attacker-standard");
        ModelsAdapterManager adapters = new ModelsAdapterManager();
        adapters.registerProvider(storedAdapter);
        adapters.registerProvider(attackerAdapter);
        WebSettingsController controller = new WebSettingsController(null, settings, new MarketManager(), adapters);

        Result result = controller.providersFetch(
                "https://attacker.example/collect", "", "attacker-standard", "Safe");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertEquals("https://safe.example/v1", storedAdapter.apiUrl);
        Assertions.assertEquals("stored-secret", storedAdapter.apiKey);
        Assertions.assertEquals(1, storedAdapter.calls);
        Assertions.assertEquals(0, attackerAdapter.calls, "保存密钥不得交给请求方指定的协议适配器");
    }

    @Test
    void modelUpdateDoesNotTouchEngineWhenConfigReplacementFails() throws Exception {
        Path workspace = Files.createTempDirectory("gwork-controller-update-test");
        ModelDo original = model("P-old", "old");
        AgentSettings settings = new AgentSettings() {
            @Override
            public synchronized boolean replaceModelInPlace(String oldKey, ModelDo newModel) {
                return false;
            }
        };
        settings.addModelInProviderBlock(original);
        settings.setDefaultModel("P-old");
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork")
                .modelAdd(original)
                .defaultModel("P-old")
                .build();
        WebSettingsController controller = new WebSettingsController(engine, settings);

        Result result = controller.llmModelsUpdate("P-old", model("P-new", "new"), true);

        Assertions.assertNotEquals(200, result.getCode());
        Assertions.assertTrue(engine.hasModel("P-old"));
        Assertions.assertFalse(engine.hasModel("P-new"));
        Assertions.assertEquals("P-old", engine.getDefaultModel());
    }

    @Test
    void providerSyncClearsNullableFieldsCopiesScopeAndRepairsEngineDefault() throws Exception {
        Path workspace = Files.createTempDirectory("gwork-controller-model-test");
        AgentSettings settings = new AgentSettings();
        ProviderDo provider = new ProviderDo();
        provider.setName("P");
        provider.setStandard("openai");
        provider.setApiUrl("https://new.example/v1");
        provider.setApiKey("new-key");
        provider.setScope("workspace");
        provider.setTimeout(null);
        ModelInfo retained = new ModelInfo();
        retained.setId("keep");
        provider.setModels(Collections.singletonList(retained));
        settings.putProvider("P", provider);

        ModelDo removed = model("P-remove", "remove");
        ModelDo keep = model("P-keep", "keep");
        keep.setScope("user");
        keep.setTimeout(Duration.ofSeconds(90));
        keep.setContextLength(128000);
        settings.addModelInProviderBlock(removed);
        settings.addModelInProviderBlock(keep);
        settings.setDefaultModel("P-remove");

        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork")
                .modelAdd(removed)
                .modelAdd(keep)
                .defaultModel("P-remove")
                .build();
        WebSettingsController controller = new WebSettingsController(engine, settings);

        Result result = controller.providersSyncModels("{\"providerName\":\"P\"}");

        Assertions.assertEquals(200, result.getCode());
        Assertions.assertFalse(settings.getModels().containsKey("P-remove"));
        ModelDo synced = settings.getModels().get("P-keep");
        Assertions.assertEquals("workspace", synced.getScope());
        // ChatConfig 将 null 解释为恢复框架默认超时（当前为 90 秒），故验证旧自定义值已被清除，
        // 而不是错误地要求 getter 返回 null。
        Assertions.assertEquals(new ModelDo().getTimeout(), synced.getTimeout());
        Assertions.assertEquals(0, synced.getContextLength());
        Assertions.assertEquals("P-keep", settings.getDefaultModel());
        Assertions.assertEquals("P-keep", engine.getDefaultModel());
    }

    private static void restoreSystemProperty(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    private static ModelDo model(String name, String modelId) {
        ModelDo model = new ModelDo();
        model.setName(name);
        model.setModel(modelId);
        model.setProvider("P");
        model.setApiUrl("https://old.example/v1");
        model.setApiKey("old-key");
        model.setStandard("openai");
        return model;
    }

    private static class CapturingAdapter implements ModelsAdapter {
        private final String standard;
        private String apiUrl;
        private String apiKey;
        private int calls;

        private CapturingAdapter(String standard) {
            this.standard = standard;
        }

        @Override
        public String getStandard() {
            return standard;
        }

        @Override
        public java.util.List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey) {
            this.apiUrl = baseUrl;
            this.apiKey = apiKey;
            calls++;
            return Collections.emptyList();
        }
    }
}
