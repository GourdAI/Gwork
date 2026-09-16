package com.gourdai.core.portal.web;

import com.gourdai.core.config.entity.ModelDo;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 模型稳定 uid 全链路测试 —— 归档写入 → 存量回填 → 账本持久化。
 *
 * <p>背景：使用统计原按「服务商名-模型ID」名称 key 归组，服务商改名后历史条目分裂。
 * 修复方案给每个模型派生稳定 uid（{@code ModelDo#uidOf}），trace 事件携带 modelId，
 * 账本条目持久化 uid，统计按 uid 归组；存量账本由一次性回填补齐 uid（带标记防重跑）。</p>
 *
 * @author oisin
 */
public class UsageUidBackfillTest {

    private static final String SESSIONS = ".gwork/sessions";

    private SessionLocator newLocator(Path ws) {
        return new SessionLocator(ws.toString(), ws.toString(), SESSIONS);
    }

    /** 造一个当前配置的模型（provider + model → 稳定 uid）。 */
    private ModelDo model(String provider, String model) {
        ModelDo m = new ModelDo();
        m.setProvider(provider);
        m.setModel(model);
        return m;
    }

    private void writeSession(Path root, String sid, String stream) throws Exception {
        Path dir = root.resolve(SESSIONS).resolve(sid);
        Files.createDirectories(dir);
        if (stream != null) {
            Files.write(dir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    stream.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** 手写月度账本（形状与 UsageArchiveService.writeLedger 一致）。 */
    private Path writeLedgerFile(Path globalBase, String month, String daysJson) throws Exception {
        Path dir = globalBase.resolve(".gwork/usage");
        Files.createDirectories(dir);
        String json = "{\"month\":\"" + month + "\",\"days\":{" + daysJson + "},\"watermarks\":{}}";
        Files.write(dir.resolve("usage-" + month + ".json"), json.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    private String dayJson(String date, String modelsJson) {
        return "\"" + date + "\":{\"messages\":1,\"sessions\":[\"s1\"],\"models\":{" + modelsJson + "}}";
    }

    private String ms(long tokens, long rounds) {
        return "{\"tokens\":" + tokens + ",\"input\":1,\"output\":1,\"cacheRead\":0,\"cacheCreation\":0,\"rounds\":" + rounds + "}";
    }

    // ─────────────────────── 归档：trace 携带 modelId ───────────────────────

    /** trace 事件的 modelId 必须落进账本条目并持久化；无 modelId 的旧事件 uid 为 null。 */
    @Test
    public void testArchiveCarriesModelIdIntoPersistentLedger() throws Exception {
        Path ws = Files.createTempDirectory("usage-uid-archive");
        try {
            long now = System.currentTimeMillis();
            String sid = "work-uid001";
            String line1 = "{\"type\":\"trace\",\"createdAt\":" + now + ",\"model\":\"MAD-gpt-5.6-sol\","
                    + "\"modelId\":\"abc123\",\"inputTokens\":5,\"outputTokens\":5,\"totalTokens\":10}";
            String line2 = "{\"type\":\"trace\",\"createdAt\":" + (now + 1) + ",\"model\":\"old-model\","
                    + "\"inputTokens\":1,\"outputTokens\":1,\"totalTokens\":2}";
            writeSession(ws, sid, line1 + "\n" + line2 + "\n");

            SessionLocator locator = newLocator(ws);
            UsageArchiveService svc = new UsageArchiveService(locator, ws.toString());
            svc.archiveIncremental();

            LocalDate today = LocalDate.now();
            UsageArchiveService.DayStat day = svc.load(today, today).get(today);
            Assertions.assertNotNull(day, "应先完成一次归档");
            Assertions.assertEquals("abc123", day.models.get("MAD-gpt-5.6-sol").uid, "模型ID必须落进条目");
            Assertions.assertEquals(10L, day.models.get("MAD-gpt-5.6-sol").tokens);
            Assertions.assertNull(day.models.get("old-model").uid, "无 modelId 的旧事件 uid 应为 null");

            // 重新实例化读回：uid 必须随账本持久化（不是内存态）
            UsageArchiveService reload = new UsageArchiveService(locator, ws.toString());
            UsageArchiveService.DayStat day2 = reload.load(today, today).get(today);
            Assertions.assertEquals("abc123", day2.models.get("MAD-gpt-5.6-sol").uid, "uid 必须持久化");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    // ─────────────────────── 存量回填 ───────────────────────

    /** 回填核心场景：大小写差异、别名改名归并，无法解析的保持原样；且带标记防重跑。 */
    @Test
    public void testBackfillMergesCaseAliasAndKeepsUnresolved() throws Exception {
        Path ws = Files.createTempDirectory("usage-uid-backfill");
        try {
            String month = "2026-09";
            String d1 = "2026-09-11";
            Path usageDir = writeLedgerFile(ws, month,
                    dayJson(d1,
                            "\"Mad-gpt-5.6-sol\":" + ms(100, 1) + ","
                                    + "\"MAD-gpt-5.6-sol\":" + ms(200, 2) + ","
                                    + "\"黑驴AI-gpt-5.6-sol\":" + ms(300, 3) + ","
                                    + "\"螃蟹-gpt-5.6-sol\":" + ms(50, 1)));
            Files.write(usageDir.resolve("merge-aliases.json"),
                    "{\"黑驴AI-gpt-5.6-sol\":\"黑驴-gpt-5.6-sol\"}".getBytes(StandardCharsets.UTF_8));

            Map<String, ModelDo> models = new LinkedHashMap<>();
            models.put("MAD-gpt-5.6-sol", model("MAD", "gpt-5.6-sol"));
            models.put("黑驴-gpt-5.6-sol", model("黑驴", "gpt-5.6-sol"));

            UsageArchiveService svc = new UsageArchiveService(newLocator(ws), ws.toString());
            Assertions.assertTrue(svc.backfillModelUids(models), "应发生归并改写");

            UsageArchiveService.DayStat day = svc.load(LocalDate.parse(d1), LocalDate.parse(d1)).get(LocalDate.parse(d1));
            UsageArchiveService.ModelStat mad = day.models.get("MAD-gpt-5.6-sol");
            Assertions.assertNotNull(mad, "大小写差异条目应并入当前规范名");
            Assertions.assertEquals(300L, mad.tokens, "Mad+MAD token 必须相加");
            Assertions.assertEquals(ModelDo.uidOf("MAD", "gpt-5.6-sol"), mad.uid);
            Assertions.assertNull(day.models.get("Mad-gpt-5.6-sol"), "旧 key 应被移除并合并");

            UsageArchiveService.ModelStat hei = day.models.get("黑驴-gpt-5.6-sol");
            Assertions.assertNotNull(hei, "别名条目应并入目标");
            Assertions.assertEquals(300L, hei.tokens);
            Assertions.assertEquals(ModelDo.uidOf("黑驴", "gpt-5.6-sol"), hei.uid);
            Assertions.assertNull(day.models.get("黑驴AI-gpt-5.6-sol"));

            UsageArchiveService.ModelStat crab = day.models.get("螃蟹-gpt-5.6-sol");
            Assertions.assertNotNull(crab, "无法解析的条目必须保持原样");
            Assertions.assertNull(crab.uid, "保持原样的条目无 uid");

            Assertions.assertTrue(Files.isRegularFile(usageDir.resolve(".uid-backfilled")), "回填后应写标记文件");
            Assertions.assertFalse(svc.backfillModelUids(models), "标记存在时再次调用应直接跳过");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    /** 空账本 + 有模型表：首次扫描后写标记（避免每次启动重复全量扫描）。 */
    @Test
    public void testBackfillWritesMarkerEvenWhenNothingToDo() throws Exception {
        Path ws = Files.createTempDirectory("usage-uid-noop");
        try {
            Map<String, ModelDo> models = new LinkedHashMap<>();
            models.put("MAD-gpt-5.6-sol", model("MAD", "gpt-5.6-sol"));
            UsageArchiveService svc = new UsageArchiveService(newLocator(ws), ws.toString());
            Assertions.assertFalse(svc.backfillModelUids(models), "无账本时不应有改写");

            Path marker = ws.resolve(".gwork/usage/.uid-backfilled");
            Assertions.assertTrue(Files.isRegularFile(marker), "空扫描也应写标记");
            Assertions.assertFalse(svc.backfillModelUids(models), "已标记则不重跑");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    /** 模型表不可用（null/空表，如配置加载失败兜底）：不写标记，避免永久错过回填，待配置可用后重试。 */
    @Test
    public void testBackfillSkipsMarkerWhenModelsUnavailable() throws Exception {
        Path ws = Files.createTempDirectory("usage-uid-nomodels");
        try {
            UsageArchiveService svc = new UsageArchiveService(newLocator(ws), ws.toString());
            Path marker = ws.resolve(".gwork/usage/.uid-backfilled");

            Assertions.assertFalse(svc.backfillModelUids(null), "null 模型表不应有改写");
            Assertions.assertFalse(Files.exists(marker), "null 模型表不得写标记（留待重试）");

            Assertions.assertFalse(svc.backfillModelUids(new LinkedHashMap<>()), "空模型表不应有改写");
            Assertions.assertFalse(Files.exists(marker), "空模型表不得写标记（留待重试）");
        } finally {
            deleteRecursively(ws.toFile());
        }
    }

    private void deleteRecursively(File f) {
        if (f == null || !f.exists()) {
            return;
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        f.delete();
    }
}
