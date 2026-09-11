package com.gourdai.core.config;

import com.gourdai.core.config.entity.ModelDo;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 模型顺序不变量测试：同一 provider 的模型在 AgentSettings.models 中必须连续，
 * 组间顺序 = 首次出现顺序，组内顺序 = 原相对顺序（或同步时指定的供应商列表顺序）。
 */
class AgentSettingsModelOrderTest {
    private String originalGwork;
    private String originalUserDir;
    private Path tempDir;

    @BeforeEach
    void setUp() throws Exception {
        originalGwork = System.getProperty("gwork.home");
        originalUserDir = System.getProperty("user.dir");
        tempDir = Files.createTempDirectory("gwork-model-order-test");
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

    private AgentSettings settingsOf(String... nameAndProviderPairs) {
        AgentSettings settings = new AgentSettings();
        for (int i = 0; i < nameAndProviderPairs.length; i += 2) {
            String name = nameAndProviderPairs[i];
            String provider = nameAndProviderPairs[i + 1];
            settings.getModels().put(name, model(name, provider));
        }
        return settings;
    }

    private List<String> keys(AgentSettings settings) {
        return new ArrayList<>(settings.getModels().keySet());
    }

    @Test
    void normalizeRegroupsSplitProviderBlocks() {
        AgentSettings settings = settingsOf(
                "A-1", "A", "A-2", "A", "B-1", "B", "A-3", "A");

        Assertions.assertTrue(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "A-3", "B-1"), keys(settings));
        // 已连续时再次调用不应变化
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
    }

    @Test
    void normalizeKeepsFirstOccurrenceAndRelativeOrder() {
        AgentSettings settings = settingsOf(
                "A-1", "A", "B-1", "B", "C-1", "C", "A-2", "A", "B-2", "B");

        Assertions.assertTrue(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(
                Arrays.asList("A-1", "A-2", "B-1", "B-2", "C-1"), keys(settings));
    }

    @Test
    void normalizeKeepsManualModelsInPlace() {
        // 手工模型（provider 为空/null）不隶属任何供应商区块，不参与归组，位置必须保持不变
        AgentSettings settings = settingsOf(
                "M-1", null, "A-1", "A", "M-2", "");

        // 无真实 provider 分裂，不应视为需要归组
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(Arrays.asList("M-1", "A-1", "M-2"), keys(settings));
    }

    @Test
    void normalizeRegroupsProvidersWithoutMovingManualModels() {
        // A 真实分裂（被 M-1/B 隔开）：仅 A 区块合并到首次出现处，手工模型 M-1 原索引不动
        AgentSettings settings = settingsOf(
                "A-1", "A", "M-1", null, "B-1", "B", "A-2", "A");

        List<String> split = new ArrayList<>();
        Assertions.assertTrue(settings.normalizeModelProviderOrder(split));
        Assertions.assertEquals(Arrays.asList("A"), split);
        // 槽位：[A区块][手工][B区块] —— M-1 仍在第二个槽位
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "M-1", "B-1"), keys(settings));
        Assertions.assertFalse(settings.normalizeModelProviderOrder());
    }

    @Test
    void normalizeNoopWhenAlreadyContiguous() {
        AgentSettings settings = settingsOf(
                "A-1", "A", "A-2", "A", "B-1", "B");

        Assertions.assertFalse(settings.normalizeModelProviderOrder());
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "B-1"), keys(settings));
    }

    @Test
    void addModelAppendsToProviderBlockTail() {
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B");

        settings.addModelInProviderBlock(model("A-2", "A"));
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "B-1"), keys(settings));

        // 新 provider 追加到总表末尾
        settings.addModelInProviderBlock(model("C-1", "C"));
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "B-1", "C-1"), keys(settings));
    }

    @Test
    void addModelWithExistingKeyOverwritesAndMovesIntoTargetBlock() {
        // 回归：新增模型 key 与既有模型同名、但 provider 不同且旧位置在目标区块之后时，
        // 旧条目曾在重建时把刚插入的新配置覆盖回去 → 提示添加成功但配置未变
        AgentSettings settings = settingsOf("X-1", "A", "Y", "B");

        ModelDo moved = model("Y", "A");
        moved.setApiKey("NEW-KEY");
        settings.addModelInProviderBlock(moved);

        Assertions.assertEquals(Arrays.asList("X-1", "Y"), keys(settings));
        ModelDo stored = settings.getModels().get("Y");
        Assertions.assertEquals("A", stored.getProvider());
        Assertions.assertEquals("NEW-KEY", stored.getApiKey());
        Assertions.assertEquals(2, settings.getModels().size());
    }

    @Test
    void replaceModelInPlaceKeepsSlotAndSupportsRename() {
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B", "A-2", "A");

        settings.replaceModelInPlace("B-1", model("B-1x", "B"));
        Assertions.assertEquals(Arrays.asList("A-1", "B-1x", "A-2"), keys(settings));

        // oldKey 不存在时退化为区块追加
        settings.replaceModelInPlace("ZZZ", model("A-3", "A"));
        Assertions.assertEquals(Arrays.asList("A-1", "B-1x", "A-2", "A-3"), keys(settings));
    }

    @Test
    void replaceModelInPlaceRejectsRenameOntoExistingKey() {
        // 回归：把 A-1 改名为已存在的 B-1，早前会静默覆盖掉 B-1（模型总数 -1）
        AgentSettings settings = settingsOf("A-1", "A", "B-1", "B");

        Assertions.assertFalse(settings.replaceModelInPlace("A-1", model("B-1", "A")));
        // 集合保持原样，不丢模型
        Assertions.assertEquals(Arrays.asList("A-1", "B-1"), keys(settings));
        Assertions.assertEquals("B", settings.getModels().get("B-1").getProvider());

        // 同名自身（仅改其他字段）应正常放行
        Assertions.assertTrue(settings.replaceModelInPlace("A-1", model("A-1", "A")));
        Assertions.assertEquals(Arrays.asList("A-1", "B-1"), keys(settings));
    }

    @Test
    void applyModelKeyRenamesKeepsPositions() {
        AgentSettings settings = settingsOf("A-1", "A", "A-2", "A", "B-1", "B");

        Map<String, String> renames = new LinkedHashMap<>();
        renames.put("A-1", "A-1x");
        renames.put("A-2", "A-2x");
        settings.applyModelKeyRenames(renames);

        Assertions.assertEquals(Arrays.asList("A-1x", "A-2x", "B-1"), keys(settings));
    }

    @Test
    void applyModelKeyRenamesSkipsOccupiedTargets() {
        // 回归：改名目标被「不参与本次改名」的模型占用时，早前会静默覆盖导致模型丢失
        AgentSettings settings = settingsOf("old-1", "A", "new-1", "B");

        Map<String, String> renames = new LinkedHashMap<>();
        renames.put("old-1", "new-1");

        Assertions.assertEquals(0, settings.applyModelKeyRenames(renames));
        Assertions.assertEquals(Arrays.asList("old-1", "new-1"), keys(settings));
        Assertions.assertEquals(2, settings.getModels().size());
    }

    @Test
    void applyModelKeyRenamesAllowsSwapWithinRenameSet() {
        // 旧 key 即将释放的情况不算被占：整体前缀迁移（A-1→A-2、A-2→A-3）应尽可能生效
        AgentSettings settings = settingsOf("A-1", "A", "A-2", "A");

        Map<String, String> renames = new LinkedHashMap<>();
        renames.put("A-1", "A-1x");
        renames.put("A-2", "A-2x");

        Assertions.assertEquals(2, settings.applyModelKeyRenames(renames));
        Assertions.assertEquals(Arrays.asList("A-1x", "A-2x"), keys(settings));
    }

    @Test
    void reorderProviderModelsMovesBlockToFirstOccurrence() {
        AgentSettings settings = settingsOf(
                "A-1", "A", "B-1", "B", "B-2", "B", "A-2", "A");

        boolean changed = settings.reorderProviderModels("A", Arrays.asList("A-2", "A-1"));
        Assertions.assertTrue(changed);
        Assertions.assertEquals(Arrays.asList("A-2", "A-1", "B-1", "B-2"), keys(settings));

        // 目标顺序已满足时不再变化
        Assertions.assertFalse(settings.reorderProviderModels("A", Arrays.asList("A-2", "A-1")));
    }

    @Test
    void reorderProviderModelsIgnoresUnknownKeysAndKeepsExtras() {
        AgentSettings settings = settingsOf(
                "B-1", "B", "A-1", "A", "A-2", "A");

        boolean changed = settings.reorderProviderModels("A", Arrays.asList("A-9", "A-2"));
        Assertions.assertTrue(changed);
        // A-9 不存在被忽略；A-1 不在 orderedKeys 中按原相对顺序补在区块之后
        Assertions.assertEquals(Arrays.asList("B-1", "A-2", "A-1"), keys(settings));
    }

    @Test
    void loadFromFileMigratesSplitHistoryInMemoryWithoutRewritingFile() throws Exception {
        System.setProperty("gwork.home", tempDir.toString());
        System.setProperty("user.dir", tempDir.toString());

        Path settingsDir = Paths.get(tempDir.toString(), ".gwork");
        Files.createDirectories(settingsDir);
        Path settingsFile = settingsDir.resolve("settings.json");
        Files.write(settingsFile, ("{"
                + "\"models\":{"
                + "\"A-1\":{\"name\":\"A-1\",\"model\":\"a1\",\"provider\":\"A\"},"
                + "\"B-1\":{\"name\":\"B-1\",\"model\":\"b1\",\"provider\":\"B\"},"
                + "\"A-2\":{\"name\":\"A-2\",\"model\":\"a2\",\"provider\":\"A\"}"
                + "}}").getBytes("UTF-8"));

        byte[] before = Files.readAllBytes(settingsFile);

        AgentSettings loaded = AgentSettings.loadFromFile();

        // 内存顺序已归组（接口与前端展示的就是这个顺序）
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "B-1"), keys(loaded));

        // 加载阶段不得写盘：saveToFile 按 scope 拆文件，迁移回写会与合并顺序互相抵消，
        // 造成每次加载（ACP 每轮 prompt）都重写配置文件
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsFile));

        // 重复加载幂等：内存顺序稳定、文件仍未被改动
        AgentSettings reloaded = AgentSettings.loadFromFile();
        Assertions.assertEquals(Arrays.asList("A-1", "A-2", "B-1"), keys(reloaded));
        Assertions.assertArrayEquals(before, Files.readAllBytes(settingsFile));
    }

    @Test
    void loadFromFileKeepsOrderStableAcrossScopes() throws Exception {
        // P0 回归：同一 provider 同时含 workspace 与 user 模型时，早前的「归组后立即回写」
        // 会被 saveToFile 的 scope 拆分抵消，形成每次加载都重排+写盘的死循环
        Path globalHome = Files.createDirectory(tempDir.resolve("global"));
        Path workspace = Files.createDirectory(tempDir.resolve("workspace"));
        System.setProperty("gwork.home", globalHome.toString());
        System.setProperty("user.dir", workspace.toString());

        Path globalDir = Paths.get(globalHome.toString(), ".gwork");
        Files.createDirectories(globalDir);
        Files.write(globalDir.resolve("settings.json"), ("{"
                + "\"models\":{"
                + "\"P-1\":{\"name\":\"P-1\",\"model\":\"p1\",\"provider\":\"P\",\"scope\":\"user\"},"
                + "\"Q-1\":{\"name\":\"Q-1\",\"model\":\"q1\",\"provider\":\"Q\",\"scope\":\"user\"}"
                + "}}").getBytes("UTF-8"));

        Path localDir = Paths.get(workspace.toString(), ".gwork");
        Files.createDirectories(localDir);
        Path localFile = localDir.resolve("settings.json");
        Files.write(localFile, ("{"
                + "\"models\":{"
                + "\"P-2\":{\"name\":\"P-2\",\"model\":\"p2\",\"provider\":\"P\",\"scope\":\"workspace\"},"
                + "\"Q-2\":{\"name\":\"Q-2\",\"model\":\"q2\",\"provider\":\"Q\",\"scope\":\"workspace\"}"
                + "}}").getBytes("UTF-8"));

        byte[] globalBefore = Files.readAllBytes(globalDir.resolve("settings.json"));
        byte[] localBefore = Files.readAllBytes(localFile);

        AgentSettings first = AgentSettings.loadFromFile();
        List<String> firstKeys = keys(first);

        // 合并后的原始顺序是 [P-1, Q-1, P-2, Q-2]（bindTo 对 map 字段是追加语义：全局在前、工作区在后），
        // P/Q 各自被劈成两段 → 归组后同 provider 连续，且组间保持首次出现顺序
        Assertions.assertEquals(Arrays.asList("P-1", "P-2", "Q-1", "Q-2"), firstKeys);

        // 两个配置文件均未被动
        Assertions.assertArrayEquals(globalBefore, Files.readAllBytes(globalDir.resolve("settings.json")));
        Assertions.assertArrayEquals(localBefore, Files.readAllBytes(localFile));

        // 反复加载结果幂等
        Assertions.assertEquals(firstKeys, keys(AgentSettings.loadFromFile()));
        Assertions.assertEquals(firstKeys, keys(AgentSettings.loadFromFile()));
    }
}
