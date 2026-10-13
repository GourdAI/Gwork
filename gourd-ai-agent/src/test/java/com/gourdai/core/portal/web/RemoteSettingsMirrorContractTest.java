/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.ProviderDo;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 远程工作区 P4 契约：模型配置内存镜像（方案 A）。
 *
 * <p>用户拍板（2026-10）：远端模型配置走「内存镜像」——桌面端把本机 providers/models/
 * defaultModel 经隧道推送到远端进程内存，断连即焚，远端磁盘零明文残留。本测试锁定：</p>
 * <ol>
 *   <li>{@link AgentSettings#applyRemoteMirror}：仅远端模式可调用（本地/CLI 拒绝）；载入后
 *       providers/models/defaultModel 与镜像一致；<b>替换语义</b>（旧配置不得残留）。</li>
 *   <li>落盘保护：镜像载入后 {@code saveToFile()} 必须拒绝回写——apiKey 落到远端磁盘即永久
 *       泄漏（这是方案 A 的安全根基，与 loadFailed 的「读不出不回写」同为回写门禁）。</li>
 *   <li>{@link WebSettingsController#settingsOverlayImport}：非远端模式拒绝；远端模式导入后
 *       运行时引擎同步（旧模型摘除、新模型注册、默认模型切换）；磁盘 settings.json 不变。</li>
 *   <li>isMirrored 标记：远端导入后 true（端点回告/诊断用）。</li>
 * </ol>
 */
class RemoteSettingsMirrorContractTest {

    @AfterEach
    void clearProps() {
        System.clearProperty(AgentFlags.PROP_REMOTE);
    }

    private static final String MIRROR_JSON = "{"
            + "\"defaultModel\":\"M-home\","
            + "\"providers\":{"
            + "  \"Home\":{\"name\":\"Home\",\"standard\":\"openai\",\"apiUrl\":\"https://home.example/v1\",\"apiKey\":\"sk-home-secret\"}"
            + "},"
            + "\"models\":{"
            + "  \"M-home\":{\"model\":\"qwen3\",\"name\":\"M-home\",\"provider\":\"Home\",\"enabled\":true}"
            + "}}";

    // ───────────────────────── AgentSettings.applyRemoteMirror ─────────────────────────

    @Test
    void mirrorRejectedOutsideRemoteMode() {
        System.clearProperty(AgentFlags.PROP_REMOTE);
        AgentSettings settings = new AgentSettings();
        Assertions.assertThrows(IllegalStateException.class, () -> settings.applyRemoteMirror(MIRROR_JSON),
                "本地/CLI 模式必须拒绝镜像载入（本地配置已在进程里，白开放接口无意义）");
        assertFalse(settings.isMirrored());
    }

    @Test
    void mirrorReplacesProvidersModelsAndDefault() {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        AgentSettings settings = new AgentSettings();

        // 预置一份「远端用户自己的旧配置」：镜像后必须被整体替换，不得残留
        ProviderDo stale = new ProviderDo();
        stale.setName("Stale");
        stale.setApiUrl("https://stale.example/v1");
        stale.setApiKey("stale-key");
        settings.putProvider("Stale", stale);
        ModelDo staleModel = new ModelDo();
        staleModel.setName("M-stale");
        staleModel.setModel("stale-model");
        staleModel.setProvider("Stale");
        settings.addModelInProviderBlock(staleModel);
        settings.setDefaultModel("M-stale");

        settings.applyRemoteMirror(MIRROR_JSON);

        assertEquals(1, settings.getProviders().size());
        assertEquals("sk-home-secret", settings.getProviders().get("Home").getApiKey());
        assertTrue(settings.getModels().containsKey("M-home"));
        assertFalse(settings.getModels().containsKey("M-stale"), "替换语义：旧模型不得残留（新旧混合最难排查）");
        assertEquals("M-home", settings.getDefaultModel());
        assertTrue(settings.isMirrored());
    }

    @Test
    void mirrorBlocksSaveToFile(@TempDir Path dir) throws Exception {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        AgentSettings settings = new AgentSettings();
        settings.applyRemoteMirror(MIRROR_JSON);

        // 把远端全局区指到临时目录，验证 saveToFile 拒绝回写（磁盘无文件产生）
        System.setProperty("gwork.home", dir.toString());
        try {
            settings.saveToFile();
            Path written = dir.resolve(".gwork/settings.json");
            assertFalse(Files.exists(written),
                    "镜像载入后绝不能落盘——apiKey 明文写入远端磁盘即永久泄漏（方案 A 安全根基）");
        } finally {
            System.clearProperty("gwork.home");
        }
    }

    @Test
    void nonMirroredRemoteSaveStillWorks(@TempDir Path dir) throws Exception {
        // 反向护栏：远端模式但未镜像（远端用户自己用 settings 界面）→ 回写不受影响。
        // mirrored 门禁只拦镜像数据，不能误伤远端本机配置的正常保存。
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        System.setProperty("gwork.home", dir.toString());
        try {
            AgentSettings settings = new AgentSettings();
            settings.setDefaultModel("local-only");
            settings.saveToFile();
            assertTrue(Files.exists(dir.resolve(".gwork/settings.json")),
                    "未镜像的远端会话仍可正常保存自己的配置");
        } finally {
            System.clearProperty("gwork.home");
        }
    }

    // ───────────────────────── WebSettingsController.settingsOverlayImport ─────────────────────────

    @Test
    void overlayEndpointRejectedOutsideRemoteMode() throws Exception {
        System.clearProperty(AgentFlags.PROP_REMOTE);
        Path workspace = Files.createTempDirectory("gwork-overlay-test");
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller = new WebSettingsController(engine, new AgentSettings());

        Result result = controller.settingsOverlayImport(MIRROR_JSON);

        Assertions.assertNotEquals(200, result.getCode(), "非远端模式端点必须拒绝");
    }

    @Test
    void overlayEndpointImportsAndSyncsEngine(@TempDir Path workspace) throws Exception {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");

        // 预置远端旧状态：旧 provider/旧模型/旧默认（引擎与 settings 各持一份）
        AgentSettings settings = new AgentSettings();
        ProviderDo stale = new ProviderDo();
        stale.setName("Stale");
        stale.setApiKey("stale-key");
        settings.putProvider("Stale", stale);
        ModelDo staleModel = new ModelDo();
        staleModel.setName("M-stale");
        staleModel.setProvider("Stale");
        settings.addModelInProviderBlock(staleModel);
        settings.setDefaultModel("M-stale");

        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork")
                .modelAdd(staleModel)
                .defaultModel("M-stale")
                .build();
        WebSettingsController controller = new WebSettingsController(engine, settings);

        Result result = controller.settingsOverlayImport(MIRROR_JSON);

        assertEquals(200, result.getCode());
        // settings：镜像内容 + 替换语义
        assertEquals("sk-home-secret", settings.getProviders().get("Home").getApiKey());
        assertFalse(settings.getModels().containsKey("M-stale"));
        assertEquals("M-home", settings.getDefaultModel());
        assertTrue(settings.isMirrored());
        // 引擎：新模型注册、旧模型摘除、默认模型切换
        assertTrue(engine.hasModel("M-home"), "镜像模型必须注册进运行时引擎（否则会话无模型可用）");
        assertFalse(engine.hasModel("M-stale"), "被镜像淘汰的旧模型必须从引擎摘除（否则成为孤儿可调用）");
        assertEquals("M-home", engine.getDefaultModel());
    }

    @Test
    void overlayEndpointRejectsEmptyPayload(@TempDir Path workspace) throws Exception {
        System.setProperty(AgentFlags.PROP_REMOTE, "true");
        HarnessEngine engine = HarnessEngine.of(workspace.toString(), ".gwork").build();
        WebSettingsController controller = new WebSettingsController(engine, new AgentSettings());

        Result empty = controller.settingsOverlayImport("   ");
        Assertions.assertNotEquals(200, empty.getCode(), "空载荷必须拒绝（防止误清空远端配置，含纯空白串）");

        Result nullPayload = controller.settingsOverlayImport(null);
        Assertions.assertNotEquals(200, nullPayload.getCode(), "null 载荷同理拒绝");
    }
}
