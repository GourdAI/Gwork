package com.gourdai.core.config;

import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.ProviderDo;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.lang.reflect.Modifier;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

/**
 * 配置安全性测试：损坏配置备份与加载失败保护（H11）、原子落盘（H11）、
 * replaceModelInPlace 的 provider 变更顺序不变量（H13d）、供应商级联删除（H13b）。
 *
 * <p>与 {@link AgentSettingsModelOrderTest} 同构：用 {@code gwork.home} / {@code user.dir}
 * 两个系统属性把配置目录指到临时目录，用例结束后还原并清理。</p>
 */
class AgentSettingsSafetyTest {
    private String originalGwork;
    private String originalUserDir;
    private Path tempDir;
    private Path settingsDir;
    private Path settingsFile;

    @BeforeEach
    void setUp() throws Exception {
        originalGwork = System.getProperty("gwork.home");
        originalUserDir = System.getProperty("user.dir");
        tempDir = Files.createTempDirectory("gwork-settings-safety-test");
        // gwork.home 与 user.dir 指向同一目录 => isLocalAsGlobal，只读写一份 settings.json
        System.setProperty("gwork.home", tempDir.toString());
        System.setProperty("user.dir", tempDir.toString());
        settingsDir = Paths.get(tempDir.toString(), ".gwork");
        Files.createDirectories(settingsDir);
        settingsFile = settingsDir.resolve("settings.json");
    }

    @AfterEach
    void tearDown() throws Exception {
        restore("gwork.home", originalGwork);
        restore("user.dir", originalUserDir);
        if (tempDir != null && Files.exists(tempDir)) {
            try (Stream<Path> paths = Files.walk(tempDir)) {
                paths.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }

    private void restore(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    private ModelDo model(String name, String provider) {
        ModelDo modelDo = new ModelDo();
        modelDo.setName(name);
        modelDo.setModel(name);
        modelDo.setProvider(provider);
        return modelDo;
    }

    private ProviderDo provider(String name) {
        ProviderDo providerDo = new ProviderDo();
        providerDo.setName(name);
        providerDo.setStandard("openai");
        providerDo.setApiUrl("https://example.com/" + name);
        providerDo.setApiKey("sk-secret-" + name);
        return providerDo;
    }

    private AgentSettings settingsOf(String... nameAndProviderPairs) {
        AgentSettings settings = new AgentSettings();
        for (int i = 0; i < nameAndProviderPairs.length; i += 2) {
            String name = nameAndProviderPairs[i];
            settings.getModels().put(name, model(name, nameAndProviderPairs[i + 1]));
        }
        return settings;
    }

    private List<String> keys(AgentSettings settings) {
        return new ArrayList<>(settings.getModels().keySet());
    }

    /** 列出配置目录下所有匹配 {@code settings.json.<suffix>-*} 的文件名。 */
    private List<String> filesNamedLike(String infix) throws Exception {
        List<String> names = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(settingsDir)) {
            for (Path p : stream) {
                String fileName = p.getFileName().toString();
                if (fileName.startsWith("settings.json." + infix)) {
                    names.add(fileName);
                }
            }
        }
        names.sort(Comparator.naturalOrder());
        return names;
    }

    private void writeSettings(String json) throws Exception {
        Files.write(settingsFile, json.getBytes("UTF-8"));
    }

    // ==================== H11：损坏配置备份 + 加载失败保护 ====================

    @Test
    void loadFromFileBacksUpTruncatedJsonAndKeepsOriginalFile() throws Exception {
        // 模拟写入中途崩溃/断电留下的截断 JSON：括号未闭合
        String truncated = "{\"defaultModel\":\"A-1\",\"models\":{\"A-1\":{\"name\":\"A-1\",\"model\":\"a1\",\"provider\":\"A\"";
        writeSettings(truncated);
        byte[] before = Files.readAllBytes(settingsFile);

        AgentSettings loaded = AgentSettings.loadFromFile();

        // 1) 损坏文件已被备份为同目录 settings.json.corrupt-<yyyyMMddHHmmss>
        List<String> backups = filesNamedLike("corrupt-");
        Assertions.assertEquals(1, backups.size(), "应产生且仅产生一个 .corrupt 备份: " + backups);
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsDir.resolve(backups.get(0))),
                "备份内容必须与原损坏文件逐字节一致");

        // 2) 原文件不被加载流程改动（加载阶段一律不写盘）
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsFile));

        // 3) 内存降级为空配置，但内置连接仍常驻
        Assertions.assertTrue(keys(loaded).isEmpty(), "损坏文件的模型不得进入内存");
        Assertions.assertTrue(loaded.getProviders().containsKey(AgentSettings.BUILTIN_PROVIDER_NAME));

        // 4) 打上加载失败标志，供 saveToFile 拒绝回写
        Assertions.assertTrue(loaded.isLoadFailed());
    }

    @Test
    void loadFromFileBacksUpIllegalJsonToo() throws Exception {
        writeSettings("this is not json at all }{][");
        byte[] before = Files.readAllBytes(settingsFile);

        AgentSettings loaded = AgentSettings.loadFromFile();

        Assertions.assertEquals(1, filesNamedLike("corrupt-").size());
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsFile));
        Assertions.assertTrue(loaded.isLoadFailed());
    }

    @Test
    void saveToFileRefusesToOverwriteConfigAfterLoadFailure() throws Exception {
        // 核心回归：损坏配置被读成空配置后，任意一次 saveSettings() 曾把空配置写盘覆盖原文件，
        // 用户全部模型配置与 apiKey 永久丢失
        String truncated = "{\"defaultModel\":\"A-1\",\"models\":{\"A-1\":{\"name\":\"A-1\",\"model\":\"a1\",\"provider\":\"A\"";
        writeSettings(truncated);
        byte[] before = Files.readAllBytes(settingsFile);

        AgentSettings loaded = AgentSettings.loadFromFile();
        Assertions.assertTrue(loaded.isLoadFailed());

        // 用户在 UI 里改了点什么并触发保存（当前没有「强制回写」入口，故显式保存同样受保护）
        loaded.setDefaultModel("whatever");
        loaded.addModelInProviderBlock(model("New-1", "NewProvider"));
        loaded.saveToFile();

        // 磁盘上那份（可能只是暂时读不出的）配置必须原封不动
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsFile),
                "loadFailed 时 saveToFile 不得覆盖磁盘配置");
        // 也不得留下写了一半的临时文件
        Assertions.assertTrue(filesNamedLike("tmp-").isEmpty(), "拒绝回写时不应产生临时文件");
    }

    @Test
    void loadFromFileSucceedsOnValidJsonAndAllowsSave() throws Exception {
        writeSettings("{\"defaultModel\":\"A-1\",\"models\":{"
                + "\"A-1\":{\"name\":\"A-1\",\"model\":\"a1\",\"provider\":\"A\"}}}");

        AgentSettings loaded = AgentSettings.loadFromFile();

        Assertions.assertFalse(loaded.isLoadFailed(), "合法配置不得被打上加载失败标志");
        Assertions.assertEquals(Arrays.asList("A-1"), keys(loaded));
        Assertions.assertTrue(filesNamedLike("corrupt-").isEmpty(), "合法配置不得产生 .corrupt 备份");
    }

    // ==================== H11：原子写 ====================

    @Test
    void saveToFileWritesCompleteJsonAndLeavesNoTempFile() throws Exception {
        AgentSettings settings = new AgentSettings();
        settings.getProviders().put("P", provider("P"));
        settings.addModelInProviderBlock(model("P-1", "P"));
        settings.addModelInProviderBlock(model("P-2", "P"));
        settings.setDefaultModel("P-1");

        settings.saveToFile();

        // 1) 文件存在且内容完整（能被重新解析回同样的模型集合，说明没有截断）
        Assertions.assertTrue(Files.exists(settingsFile));
        AgentSettings reloaded = AgentSettings.loadFromFile();
        Assertions.assertFalse(reloaded.isLoadFailed(), "写出的文件必须可被正常解析");
        Assertions.assertEquals(Arrays.asList("P-1", "P-2"), keys(reloaded));
        Assertions.assertEquals("P-1", reloaded.getDefaultModel());
        Assertions.assertEquals("sk-secret-P", reloaded.getProviders().get("P").getApiKey());

        // 2) 临时文件不残留（move 成功后 finally 里的兜底删除不应再有东西可删）
        Assertions.assertTrue(filesNamedLike("tmp-").isEmpty(), "落盘后不得残留 .tmp 临时文件");
        // 3) 正常保存路径不产生损坏备份
        Assertions.assertTrue(filesNamedLike("corrupt-").isEmpty());
    }

    @Test
    void saveToFileOverwritesExistingFileAtomicallyWithoutLeftovers() throws Exception {
        writeSettings("{\"defaultModel\":\"OLD\",\"models\":{"
                + "\"OLD\":{\"name\":\"OLD\",\"model\":\"old\",\"provider\":\"O\"}}}");

        AgentSettings settings = new AgentSettings();
        settings.addModelInProviderBlock(model("NEW", "N"));
        settings.setDefaultModel("NEW");
        settings.saveToFile();

        // 覆盖写生效：旧内容被完整替换，而不是追加或截断
        AgentSettings reloaded = AgentSettings.loadFromFile();
        Assertions.assertEquals(Arrays.asList("NEW"), keys(reloaded));
        Assertions.assertEquals("NEW", reloaded.getDefaultModel());
        Assertions.assertTrue(filesNamedLike("tmp-").isEmpty());

        // 反复保存同样不留残留
        for (int i = 0; i < 5; i++) {
            settings.saveToFile();
        }
        Assertions.assertTrue(filesNamedLike("tmp-").isEmpty(), "多次保存后仍不得残留临时文件");
        Assertions.assertEquals(Arrays.asList("NEW"), keys(AgentSettings.loadFromFile()));
    }

    // ==================== H13d：replaceModelInPlace 变更 provider 仍保持区块连续 ====================

    @Test
    void replaceModelInPlaceKeepsProviderContiguousWhenProviderChanges() {
        // A-2 从 provider A 改到 B：原位替换会让 B 被劈成 [B-1] 与 [A-2] 两段（中间夹着 A-1），
        // 方法内部必须自行归位，不能依赖调用方补一次 normalize
        AgentSettings settings = settingsOf("B-1", "B", "A-1", "A", "A-2", "A");

        Assertions.assertTrue(settings.replaceModelInPlace("A-2", model("A-2", "B")));

        // B 区块合并到其首次出现处，A 区块保持原相对顺序
        Assertions.assertEquals(Arrays.asList("B-1", "A-2", "A-1"), keys(settings));
        Assertions.assertEquals("B", settings.getModels().get("A-2").getProvider());
        Assertions.assertEquals(3, settings.getModels().size());

        // 不变量已成立：再调 normalize 应是 no-op
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
    }

    @Test
    void replaceModelInPlaceKeepsProviderContiguousOnRenamePlusProviderChange() {
        // 同时改名 + 改 provider：newKey 落到目标区块内，且目标区块不被劈开
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B", "A-2", "A");

        Assertions.assertTrue(settings.replaceModelInPlace("A-1", model("B-9", "B")));

        Assertions.assertEquals(3, settings.getModels().size());
        Assertions.assertEquals("B", settings.getModels().get("B-9").getProvider());
        // 同 provider 必须连续
        Assertions.assertFalse(settings.normalizeModelProviderOrder(),
                "replaceModelInPlace 返回后「同 provider 连续」不变量必须已成立，实际=" + keys(settings));
        List<String> result = keys(settings);
        Assertions.assertTrue(result.indexOf("B-9") >= 0 && result.indexOf("B-1") >= 0);
        Assertions.assertEquals(1, Math.abs(result.indexOf("B-9") - result.indexOf("B-1")),
                "B 组两个模型必须相邻，实际=" + result);
    }

    @Test
    void replaceModelInPlaceKeepsSlotWhenProviderUnchanged() {
        // provider 未变时严格保持「接管原槽位、位置不变」的契约，不做多余归组
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B", "A-2", "A");

        Assertions.assertTrue(settings.replaceModelInPlace("B-1", model("B-1x", "B")));

        Assertions.assertEquals(Arrays.asList("A-1", "B-1x", "A-2"), keys(settings));
    }

    @Test
    void replaceModelInPlaceRepairsDefaultAndAcpReferencesOnRename() {
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B");
        settings.setDefaultModel("A-1");
        settings.getGeneral().setAcpModel("A-1");

        Assertions.assertTrue(settings.replaceModelInPlace("A-1", model("A-2", "A")));

        Assertions.assertEquals("A-2", settings.getDefaultModel());
        Assertions.assertEquals("A-2", settings.getGeneral().getAcpModel());
        Assertions.assertFalse(settings.getModels().containsKey("A-1"));
    }

    // ==================== H13b：供应商级联删除 ====================

    @Test
    void removeProviderCascadeDeletesProviderAndItsModels() {
        AgentSettings settings = settingsOf("P-1", "P", "Q-1", "Q", "P-2", "P", "M-1", null);
        settings.getProviders().put("P", provider("P"));
        settings.getProviders().put("Q", provider("Q"));

        List<String> engineRemoved = new ArrayList<>();
        List<String> removed = settings.removeProviderCascade("P", engineRemoved::add);

        // provider 条目被删，其余保留（含内置之外的 Q）
        Assertions.assertFalse(settings.getProviders().containsKey("P"));
        Assertions.assertTrue(settings.getProviders().containsKey("Q"));

        // 名下模型全部级联删除，其它 provider 与手工模型不受影响、相对顺序不变
        Assertions.assertEquals(Arrays.asList("P-1", "P-2"), removed);
        Assertions.assertEquals(Arrays.asList("Q-1", "M-1"), keys(settings));

        // 运行时引擎摘除回调按原顺序收到每个被删模型（孤儿模型不能再被调用）
        Assertions.assertEquals(Arrays.asList("P-1", "P-2"), engineRemoved);
    }

    @Test
    void removeProviderCascadeToleratesNullCallbackAndUnknownProvider() {
        AgentSettings settings = settingsOf("P-1", "P");
        settings.getProviders().put("P", provider("P"));

        // 回调为 null：只清配置，不抛异常
        Assertions.assertEquals(Arrays.asList("P-1"), settings.removeProviderCascade("P", null));
        Assertions.assertTrue(keys(settings).isEmpty());
        Assertions.assertFalse(settings.getProviders().containsKey("P"));

        // 不存在的 provider / 空名称：no-op，不误删任何模型
        settings.addModelInProviderBlock(model("Z-1", "Z"));
        Assertions.assertTrue(settings.removeProviderCascade("NOPE", key -> Assertions.fail("不应回调")).isEmpty());
        Assertions.assertTrue(settings.removeProviderCascade("", key -> Assertions.fail("不应回调")).isEmpty());
        Assertions.assertTrue(settings.removeProviderCascade(null, key -> Assertions.fail("不应回调")).isEmpty());
        Assertions.assertEquals(Arrays.asList("Z-1"), keys(settings));
    }

    @Test
    void removeModelsKeepsRelativeOrderOfSurvivors() {
        // 供应商同步清理路径改用的封装方法：批量摘除后剩余模型相对顺序不变、不变量不被破坏
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B", "A-2", "A", "C-1", "C");

        List<String> removed = settings.removeModels(Arrays.asList("A-1", "C-1", "NOT-EXIST"));

        Assertions.assertEquals(Arrays.asList("A-1", "C-1"), removed, "只返回真实存在的 key，按原顺序");
        Assertions.assertEquals(Arrays.asList("B-1", "A-2"), keys(settings));
        Assertions.assertEquals(2, settings.getModels().size());

        // 单个删除走同一口径
        Assertions.assertTrue(settings.removeModel("B-1"));
        Assertions.assertEquals(Arrays.asList("A-2"), keys(settings));
        Assertions.assertFalse(settings.removeModel("B-1"), "重复删除应返回 false");
        Assertions.assertTrue(settings.removeModels(null).isEmpty());
    }

    @Test
    void removingReferencedModelsRepairsDefaultAndAcp() {
        AgentSettings settings = settingsOf("A", "P", "B", "Q", "C", "P");
        settings.setDefaultModel("A");
        settings.getGeneral().setAcpModel("A");
        settings.setModelEnabled("B", false);

        settings.removeModel("A");
        Assertions.assertEquals("C", settings.getDefaultModel(), "默认模型应跳过排在前面的禁用模型");
        Assertions.assertNull(settings.getGeneral().getAcpModel());

        settings.getGeneral().setAcpModel("C");
        settings.putProvider("P", provider("P"));
        settings.removeProviderCascade("P", null);
        Assertions.assertNull(settings.getDefaultModel(), "没有启用模型时默认值应清空");
        Assertions.assertNull(settings.getGeneral().getAcpModel());
    }

    @Test
    void providerAndModelUpdatesPublishNewValuesWithoutMutatingOldSnapshot() {
        AgentSettings settings = new AgentSettings();
        settings.putProvider("P", provider("P"));
        ModelDo richModel = model("P-1", "P");
        richModel.setDescription("description");
        richModel.setApiUrl("https://model.example");
        richModel.setApiKey("secret");
        richModel.setStandard("anthropic");
        richModel.setContextLength(123456);
        richModel.setHeader("x-test", "value");
        richModel.setUserAgent("test-agent");
        richModel.setTimeout(Duration.ofSeconds(77));
        richModel.setScope("workspace");
        settings.addModelInProviderBlock(richModel);
        Map<String, ProviderDo> oldProviders = settings.getProviders();
        Map<String, ModelDo> oldModels = settings.getModels();
        ProviderDo oldProvider = oldProviders.get("P");
        ModelDo oldModel = oldModels.get("P-1");

        settings.setProviderEnabled("P", false);
        settings.setModelEnabled("P-1", false);

        Assertions.assertNotSame(oldProviders, settings.getProviders());
        Assertions.assertNotSame(oldProvider, settings.getProviders().get("P"));
        Assertions.assertTrue(oldProvider.isEnabled());
        Assertions.assertNotSame(oldModels, settings.getModels());
        ModelDo changedModel = settings.getModels().get("P-1");
        Assertions.assertNotSame(oldModel, changedModel);
        Assertions.assertTrue(oldModel.isEnabled());
        Assertions.assertEquals(oldModel.getDescription(), changedModel.getDescription());
        Assertions.assertEquals(oldModel.getApiUrl(), changedModel.getApiUrl());
        Assertions.assertEquals(oldModel.getApiKey(), changedModel.getApiKey());
        Assertions.assertEquals(oldModel.getStandard(), changedModel.getStandard());
        Assertions.assertEquals(oldModel.getContextLength(), changedModel.getContextLength());
        Assertions.assertEquals(oldModel.getHeaders(), changedModel.getHeaders());
        Assertions.assertEquals(oldModel.getUserAgent(), changedModel.getUserAgent());
        Assertions.assertEquals(oldModel.getTimeout(), changedModel.getTimeout());
        Assertions.assertEquals(oldModel.getScope(), changedModel.getScope());
    }

    @Test
    void concurrentCowUpdatesAndSavesDoNotThrowConcurrentModification() throws Exception {
        AgentSettings settings = new AgentSettings();
        settings.putProvider("P", provider("P"));
        for (int i = 0; i < 20; i++) {
            settings.addModelInProviderBlock(model("P-" + i, "P"));
        }
        CountDownLatch start = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread writer = new Thread(() -> {
            try {
                start.await();
                for (int i = 0; i < 200; i++) {
                    settings.setModelEnabled("P-" + (i % 20), (i & 1) == 0);
                    settings.setProviderEnabled("P", (i & 1) == 0);
                }
            } catch (Throwable e) {
                failure.compareAndSet(null, e);
            }
        });
        Thread saver = new Thread(() -> {
            try {
                start.await();
                for (int i = 0; i < 100; i++) settings.saveToFile();
            } catch (Throwable e) {
                failure.compareAndSet(null, e);
            }
        });
        writer.start();
        saver.start();
        start.countDown();
        writer.join(TimeUnit.SECONDS.toMillis(20));
        saver.join(TimeUnit.SECONDS.toMillis(20));
        Assertions.assertFalse(writer.isAlive() || saver.isAlive(), "并发测试超时");
        Assertions.assertNull(failure.get(), () -> "并发保存异常: " + failure.get());
        Assertions.assertFalse(AgentSettings.loadFromFile().isLoadFailed());
    }

    @Test
    void concurrentSavesLeaveLatestStateOnDisk() throws Exception {
        Assertions.assertTrue(Modifier.isSynchronized(
                AgentSettings.class.getMethod("saveToFile").getModifiers()),
                "saveToFile 必须串行覆盖快照生成与完整文件落盘");

        AgentSettings settings = new AgentSettings();
        settings.addModelInProviderBlock(model("BASE", "P"));
        CountDownLatch start = new CountDownLatch(1);
        List<Thread> savers = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        for (int i = 0; i < 12; i++) {
            final int index = i;
            Thread saver = new Thread(() -> {
                try {
                    start.await();
                    settings.setDefaultModel("snapshot-" + index);
                    settings.saveToFile();
                } catch (Throwable e) {
                    failure.compareAndSet(null, e);
                }
            });
            savers.add(saver);
            saver.start();
        }
        start.countDown();
        for (Thread saver : savers) saver.join(TimeUnit.SECONDS.toMillis(20));
        Assertions.assertNull(failure.get(), () -> "并发保存异常: " + failure.get());

        settings.setDefaultModel("LATEST");
        settings.saveToFile();
        Assertions.assertEquals("LATEST", AgentSettings.loadFromFile().getDefaultModel(),
                "最后完成的保存必须成为最终落盘状态");
        Assertions.assertTrue(filesNamedLike("tmp-").isEmpty());
    }
}
