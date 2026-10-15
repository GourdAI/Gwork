package com.gourdai.harness.change;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * {@link FileChangeService#listSession(String, String)} 的聚焦测试。
 *
 * <p><b>WHY 直接写 manifest 而不跑 before/after</b>：会话级清单的语义全在「跨 run 归并」上，
 * 而 before/after 链路会顺带落 blob、算 LCS，既慢又把断言焦点从归并逻辑挪到快照逻辑。
 * 这里按 {@code FileChangeServiceTest} 已有的 manifestJson 结构直接落盘真实账本文件，
 * 并在 entry 里显式写 {@code additions/deletions}，使 {@code ensureLineStats} 短路
 * （不回读 blob）——测试因此完全 hermetic，不依赖工作区里的真实文件内容。</p>
 *
 * <p><b>时间戳必须用近期值</b>：{@code maintain()} 会回收 {@code updatedAt} 早于保留期
 * （30 天）的账本，写死小常数会让 manifest 在 listSession 之前就被 GC 掉。</p>
 */
class FileChangeServiceListSessionTest {

    private final FileChangeService service = FileChangeService.getInstance();

    @TempDir
    Path root;

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> listOf(Map<String, Object> summary, String key) {
        return (List<Map<String, Object>>) summary.get(key);
    }

    private static Map<String, Object> rowOf(Map<String, Object> summary, String path) {
        for (Map<String, Object> row : listOf(summary, "files")) {
            if (path.equals(row.get("path"))) return row;
        }
        return Assertions.fail("file row not found: " + path);
    }

    private static int number(Object value) {
        return ((Number) value).intValue();
    }

    private static long longOf(Object value) {
        return ((Number) value).longValue();
    }

    /** 新布局 manifest 路径：{@code <root>/.gwork/sessions/<sid>/file-changes/manifests/<runId>.json}。 */
    private void writeManifest(String sessionId, String runId, long updatedAt,
                               boolean possiblyIncomplete, String... entries) throws Exception {
        Path file = root.resolve(".gwork/sessions/" + sessionId
                + "/file-changes/manifests/" + runId + ".json");
        Files.createDirectories(file.getParent());
        StringBuilder json = new StringBuilder();
        json.append("{\"version\":\"1\",\"sessionId\":\"").append(sessionId)
                .append("\",\"runId\":\"").append(runId)
                .append("\",\"revision\":1,\"ready\":true,\"possiblyIncomplete\":").append(possiblyIncomplete)
                .append(",\"incompleteReasons\":[],\"lastStatus\":\"READY\",\"conflicts\":[],\"updatedAt\":")
                .append(updatedAt).append(",\"entries\":[");
        for (int i = 0; i < entries.length; i++) {
            if (i > 0) json.append(',');
            json.append(entries[i]);
        }
        json.append("]}");
        Files.writeString(file, json.toString(), StandardCharsets.UTF_8);
    }

    /**
     * 文件条目：显式带 additions/deletions，避免 ensureLineStats 回读 blob。
     *
     * @param existsBefore before 侧是否存在（false → ADDED）
     * @param existsAfter  after 侧是否存在（false → DELETED）
     */
    private static String entry(String path, boolean existsBefore, boolean existsAfter,
                                int additions, int deletions, boolean undone) {
        return "{\"path\":\"" + path + "\","
                + "\"before\":{\"exists\":" + existsBefore + ",\"hash\":\"h-before\",\"binary\":false,\"contentSkipped\":false},"
                + "\"after\":{\"exists\":" + existsAfter + ",\"hash\":\"h-after\",\"binary\":false,\"contentSkipped\":false},"
                + "\"undone\":" + undone + ",\"additions\":" + additions + ",\"deletions\":" + deletions + "}";
    }

    // ==================== 1. 跨 run 归并 ====================

    @Test
    void mergesFilesAcrossRunsKeepingLatestStateAndAccumulatingRunIds() throws Exception {
        long older = System.currentTimeMillis() - 60_000L;
        long newer = System.currentTimeMillis();

        // run-1（较旧）：改 a.txt
        writeManifest("work-ls1", "run-1", older, false, entry("a.txt", true, true, 2, 1, false));
        // run-2（较新）：再改 a.txt 并已撤销，同时新增 b.txt
        writeManifest("work-ls1", "run-2", newer, false,
                entry("a.txt", true, true, 5, 3, true),
                entry("b.txt", false, true, 4, 0, false));

        Map<String, Object> result = service.listSession("work-ls1", root.toString());

        Assertions.assertEquals("OK", result.get("status"));
        Assertions.assertEquals("work-ls1", result.get("sessionId"));
        Assertions.assertEquals(2, number(result.get("fileCount")));

        // a.txt：状态类字段取 updatedAt 最大的那一轮（run-2），归属类字段累加两轮
        Map<String, Object> aRow = rowOf(result, "a.txt");
        Assertions.assertEquals("MODIFIED", aRow.get("changeType"));
        Assertions.assertEquals("UNDONE", aRow.get("state"), "必须取最新一轮的撤销状态");
        Assertions.assertEquals(5, number(aRow.get("additions")), "增删行取最新一轮，不得跨轮相加");
        Assertions.assertEquals(3, number(aRow.get("deletions")));
        Assertions.assertEquals(List.of("run-1", "run-2"), aRow.get("runIds"));
        Assertions.assertEquals(newer, longOf(aRow.get("lastUpdatedAt")));

        Map<String, Object> bRow = rowOf(result, "b.txt");
        Assertions.assertEquals("ADDED", bRow.get("changeType"));
        Assertions.assertEquals(List.of("run-2"), bRow.get("runIds"));

        // 会话级增删是「各文件最新一轮」之和：a(5+3) + b(4+0)
        Assertions.assertEquals(9, number(result.get("additions")));
        Assertions.assertEquals(3, number(result.get("deletions")));

        // runs 按时间倒序，updatedAt 取最新
        List<Map<String, Object>> runs = listOf(result, "runs");
        Assertions.assertEquals(2, runs.size());
        Assertions.assertEquals("run-2", runs.get(0).get("runId"));
        Assertions.assertEquals("run-1", runs.get(1).get("runId"));
        Assertions.assertEquals(2, number(runs.get(0).get("fileCount")));
        Assertions.assertEquals(1, number(runs.get(1).get("fileCount")));
        Assertions.assertEquals(newer, longOf(result.get("updatedAt")));
    }

    @Test
    void mergeResultIsIndependentOfDirectoryListingOrder() throws Exception {
        // 归并按 updatedAt 升序进行，故 Files.list 的遍历顺序（文件系统决定）不得影响结果。
        // 这里刻意让「较新的 run」文件名字典序在前，验证排序发生在合并之前。
        long older = System.currentTimeMillis() - 60_000L;
        long newer = System.currentTimeMillis();
        writeManifest("work-ls2", "aaa-newer", newer, false, entry("f.txt", true, true, 7, 0, false));
        writeManifest("work-ls2", "zzz-older", older, false, entry("f.txt", true, true, 1, 1, false));

        Map<String, Object> result = service.listSession("work-ls2", root.toString());
        Map<String, Object> row = rowOf(result, "f.txt");

        Assertions.assertEquals(7, number(row.get("additions")), "必须取 updatedAt 最大那一轮");
        Assertions.assertEquals(0, number(row.get("deletions")));
        Assertions.assertEquals(newer, longOf(row.get("lastUpdatedAt")));
        Assertions.assertEquals(List.of("zzz-older", "aaa-newer"), row.get("runIds"),
                "runIds 应按时间升序累加");
    }

    // ==================== 2. possiblyIncomplete 透传 ====================

    @Test
    void possiblyIncompletePropagatesFromAnyRun() throws Exception {
        long now = System.currentTimeMillis();
        // bash 产出不被追踪：run-2 标记不完整，会话级必须透传（既有语义，见 summary 的同名字段）
        writeManifest("work-ls3", "run-1", now - 1000L, false, entry("a.txt", true, true, 1, 0, false));
        writeManifest("work-ls3", "run-2", now, true, entry("b.txt", true, true, 1, 0, false));

        Map<String, Object> result = service.listSession("work-ls3", root.toString());

        Assertions.assertEquals(Boolean.TRUE, result.get("possiblyIncomplete"),
                "任一轮不完整即会话级不完整");
        List<Map<String, Object>> runs = listOf(result, "runs");
        Assertions.assertEquals(Boolean.TRUE, runs.get(0).get("possiblyIncomplete"));
        Assertions.assertEquals(Boolean.FALSE, runs.get(1).get("possiblyIncomplete"));
    }

    // ==================== 3. 空态 ====================

    @Test
    void missingLedgerDirectoryReturnsStructuredEmptyState() throws Exception {
        // 目录完全不存在：空态而非 NOT_FOUND——「这个会话还没改过文件」是常态，不是错误
        Map<String, Object> result = service.listSession("work-nothing", root.toString());

        Assertions.assertEquals("OK", result.get("status"));
        Assertions.assertEquals(0, number(result.get("fileCount")));
        Assertions.assertTrue(listOf(result, "files").isEmpty());
        Assertions.assertTrue(listOf(result, "runs").isEmpty());
        Assertions.assertEquals(0, number(result.get("additions")));
        Assertions.assertEquals(0, number(result.get("deletions")));
        Assertions.assertEquals(0, longOf(result.get("updatedAt")));
        Assertions.assertEquals(Boolean.FALSE, result.get("possiblyIncomplete"));
    }

    @Test
    void emptyManifestsDirectoryReturnsEmptyState() throws Exception {
        // manifests 目录存在但为空（run 刚建目录还没落盘）
        Files.createDirectories(root.resolve(".gwork/sessions/work-empty/file-changes/manifests"));

        Map<String, Object> result = service.listSession("work-empty", root.toString());

        Assertions.assertEquals("OK", result.get("status"));
        Assertions.assertEquals(0, number(result.get("fileCount")));
        Assertions.assertEquals(0, number(result.get("runCount")));
    }

    @Test
    void runWithNoEntriesContributesZeroFiles() throws Exception {
        writeManifest("work-ls4", "run-empty", System.currentTimeMillis(), false);

        Map<String, Object> result = service.listSession("work-ls4", root.toString());

        Assertions.assertEquals(1, number(result.get("runCount")), "空 run 仍应出现在 runs 清单里");
        Assertions.assertEquals(0, number(result.get("fileCount")));
        Assertions.assertEquals(0, number(listOf(result, "runs").get(0).get("fileCount")));
    }

    // ==================== 4. 入参与脏数据 ====================

    @Test
    void illegalSessionIdIsRejected() throws Exception {
        // sessionDir() 拒收 ..、分隔符与空字节；listSession 必须把它归为 INVALID_REQUEST 而不是抛异常
        for (String bad : new String[]{"../escape", "a/b", "a\\b", "..", ""}) {
            Map<String, Object> result = service.listSession(bad, root.toString());
            Assertions.assertEquals("INVALID_REQUEST", result.get("status"),
                    "非法 sessionId 应被拒收: " + bad);
        }
        Assertions.assertEquals("INVALID_REQUEST", service.listSession(null, root.toString()).get("status"));
    }

    @Test
    void missingRootIsRejected() {
        // validateRoot 口径：root 为空或不存在都归 INVALID_REQUEST（与 getRun 一致）
        Assertions.assertEquals("INVALID_REQUEST",
                service.listSession("work-ls5", null).get("status"));
        Assertions.assertEquals("INVALID_REQUEST",
                service.listSession("work-ls5", root.resolve("no-such-dir").toString()).get("status"));
    }

    @Test
    void unreadableAndForeignManifestsAreSkippedNotFatal() throws Exception {
        long now = System.currentTimeMillis();
        writeManifest("work-ls6", "run-good", now, false, entry("a.txt", true, true, 1, 0, false));

        Path manifests = root.resolve(".gwork/sessions/work-ls6/file-changes/manifests");
        // 畸形 JSON：跳过并计入 unreadableRuns，绝不能让整份清单 500
        Files.writeString(manifests.resolve("run-broken.json"), "not-json", StandardCharsets.UTF_8);
        // 被搬错位置的账本（sessionId 属于别的会话）：不得把别人的变更归到本会话名下
        Files.writeString(manifests.resolve("run-foreign.json"),
                "{\"version\":\"1\",\"sessionId\":\"work-other\",\"runId\":\"run-foreign\",\"revision\":1,"
                        + "\"ready\":true,\"possiblyIncomplete\":false,\"incompleteReasons\":[],"
                        + "\"lastStatus\":\"READY\",\"conflicts\":[],\"updatedAt\":" + now + ",\"entries\":["
                        + entry("secret.txt", true, true, 9, 9, false) + "]}",
                StandardCharsets.UTF_8);

        Map<String, Object> result = service.listSession("work-ls6", root.toString());

        Assertions.assertEquals("OK", result.get("status"));
        Assertions.assertEquals(1, number(result.get("fileCount")), "只应统计可读且归属正确的账本");
        Assertions.assertEquals("a.txt", rowOf(result, "a.txt").get("path"));
        Assertions.assertEquals(2, listOf(result, "unreadableRuns").size(),
                "畸形与外来账本都应被记录为不可读");
        Assertions.assertFalse(String.valueOf(result).contains(root.toString()),
                "响应不得泄露服务端绝对路径");
    }

    @Test
    void responseDoesNotLeakBlobHashesOrAbsolutePaths() throws Exception {
        // summary() 的既有约束：轻量摘要不含绝对路径、内容或 blob hash。会话级清单沿用同一约束。
        writeManifest("work-ls7", "run-1", System.currentTimeMillis(), false,
                entry("a.txt", true, true, 1, 0, false));

        Map<String, Object> result = service.listSession("work-ls7", root.toString());
        String text = String.valueOf(result);

        Assertions.assertFalse(text.contains("h-before"), "不得回传 blob hash");
        Assertions.assertFalse(text.contains("h-after"), "不得回传 blob hash");
        Assertions.assertFalse(text.contains(root.toString()), "不得回传服务端绝对路径");
    }
}
