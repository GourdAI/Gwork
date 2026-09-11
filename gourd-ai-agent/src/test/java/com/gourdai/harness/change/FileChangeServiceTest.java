package com.gourdai.harness.change;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

class FileChangeServiceTest {
    private final FileChangeService service = FileChangeService.getInstance();

    /** 单例服务的 listener 会跨用例泄漏，逐个用例前清空以隔离。 */
    @BeforeEach
    void resetListener() {
        service.setListener(null);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> files(Map<String, Object> summary) {
        return (List<Map<String, Object>>) summary.get("files");
    }

    private static Map<String, Object> fileRow(Map<String, Object> summary, String path) {
        for (Map<String, Object> row : files(summary)) {
            if (path.equals(row.get("path"))) return row;
        }
        return Assertions.fail("file row not found: " + path);
    }

    private static int number(Object value) {
        return ((Number) value).intValue();
    }

    @Test
    void aggregatesFirstBeforeLastAfterAndRemovesNetZero() throws Exception {
        Path root = Files.createTempDirectory("file-changes-aggregate");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A");
            FileChangeService.Capture first = service.before("work-s1", "run-1", root.toString(), "a.txt");
            Files.writeString(file, "B");
            service.after(first);
            FileChangeService.Capture second = service.before("work-s1", "run-1", root.toString(), "a.txt");
            Files.writeString(file, "C");
            service.after(second);

            Map<String, Object> diff = service.diff("work-s1", "run-1", root.toString(), "a.txt");
            Assertions.assertEquals("A", diff.get("before"));
            Assertions.assertEquals("C", diff.get("after"));
            Assertions.assertFalse((Boolean) diff.get("binary"));

            FileChangeService.Capture third = service.before("work-s1", "run-1", root.toString(), "a.txt");
            Files.writeString(file, "A");
            service.after(third);
            Assertions.assertEquals(0, ((Number) service.getRun("work-s1", "run-1", root.toString()).get("fileCount")).intValue());
        } finally {
            delete(root);
        }
    }

    @Test
    void undoAndReapplyAddedFile() throws Exception {
        Path root = Files.createTempDirectory("file-changes-added");
        try {
            Path file = root.resolve("new.txt");
            FileChangeService.Capture capture = service.before("work-s2", "run-2", root.toString(), "new.txt");
            Files.writeString(file, "new");
            service.after(capture);
            service.finish("work-s2", "run-2", root.toString());

            Assertions.assertEquals("OK", service.undoFile("work-s2", "run-2", root.toString(), "new.txt").get("status"));
            Assertions.assertFalse(Files.exists(file));
            Assertions.assertEquals("OK", service.reapplyRun("work-s2", "run-2", root.toString()).get("status"));
            Assertions.assertEquals("new", Files.readString(file));
        } finally {
            delete(root);
        }
    }

    @Test
    void runUndoConflictsBeforeAnyWrite() throws Exception {
        Path root = Files.createTempDirectory("file-changes-conflict");
        try {
            Path a = root.resolve("a.txt");
            Path b = root.resolve("b.txt");
            Files.writeString(a, "A0");
            Files.writeString(b, "B0");
            FileChangeService.Capture ca = service.before("work-s3", "run-3", root.toString(), "a.txt");
            Files.writeString(a, "A1");
            service.after(ca);
            FileChangeService.Capture cb = service.before("work-s3", "run-3", root.toString(), "b.txt");
            Files.writeString(b, "B1");
            service.after(cb);
            service.finish("work-s3", "run-3", root.toString());

            Files.writeString(b, "external");
            Map<String, Object> result = service.undoRun("work-s3", "run-3", root.toString());
            Assertions.assertEquals("CONFLICT", result.get("status"));
            Assertions.assertEquals("A1", Files.readString(a));
            Assertions.assertEquals("external", Files.readString(b));
            Assertions.assertEquals(1, ((List<?>) result.get("conflicts")).size());
        } finally {
            delete(root);
        }
    }

    @Test
    void marksBinaryAndRejectsEscapingPath() throws Exception {
        Path root = Files.createTempDirectory("file-changes-binary");
        try {
            Path file = root.resolve("data.bin");
            FileChangeService.Capture capture = service.before("work-s4", "run-4", root.toString(), "data.bin");
            Files.write(file, new byte[]{0, 1, 2});
            service.after(capture);
            Map<String, Object> diff = service.diff("work-s4", "run-4", root.toString(), "data.bin");
            Assertions.assertEquals(Boolean.TRUE, diff.get("binary"));
            Assertions.assertFalse(diff.containsKey("before"));
            Assertions.assertFalse(diff.containsKey("after"));

            Map<String, Object> escaped = service.diff("work-s4", "run-4", root.toString(), "../outside.txt");
            Assertions.assertEquals("INVALID_REQUEST", escaped.get("status"));
        } finally {
            delete(root);
        }
    }

    @Test
    void manifestStoresHashesButSummaryHidesThemAndBashMarksIncomplete() throws Exception {
        Path root = Files.createTempDirectory("file-changes-manifest");
        try {
            Path file = root.resolve("x.txt");
            FileChangeService.Capture capture = service.before("work-s5", "run-5", root.toString(), "x.txt");
            Files.writeString(file, "x", StandardCharsets.UTF_8);
            service.after(capture);
            service.markBash("work-s5", "run-5", root.toString());
            service.finish("work-s5", "run-5", root.toString());

            Map<String, Object> summary = service.getRun("work-s5", "run-5", root.toString());
            Assertions.assertEquals(Boolean.TRUE, summary.get("possiblyIncomplete"));
            Assertions.assertEquals(Boolean.TRUE, summary.get("ready"));
            Assertions.assertEquals("READY", summary.get("status"));
            String summaryText = String.valueOf(summary);
            Assertions.assertFalse(summaryText.contains(root.toString()));
            Assertions.assertFalse(summaryText.contains("hash="));

            Path manifest = root.resolve(".gwork/file-changes/manifests/work-s5/run-5.json");
            String json = Files.readString(manifest);
            Assertions.assertTrue(json.contains("\"hash\""));
            Assertions.assertFalse(json.contains(root.toString()));
        } finally {
            delete(root);
        }
    }

    @Test
    void secondUndoIsIdempotentAndDoesNotConflict() throws Exception {
        Path root = Files.createTempDirectory("file-changes-idempotent");
        try {
            Path a = root.resolve("a.txt");
            Path b = root.resolve("b.txt");
            Files.writeString(a, "A0");
            Files.writeString(b, "B0");
            FileChangeService.Capture ca = service.before("work-s6", "run-6", root.toString(), "a.txt");
            Files.writeString(a, "A1");
            service.after(ca);
            FileChangeService.Capture cb = service.before("work-s6", "run-6", root.toString(), "b.txt");
            Files.writeString(b, "B1");
            service.after(cb);
            service.finish("work-s6", "run-6", root.toString());

            Assertions.assertEquals("OK", service.undoFile("work-s6", "run-6", root.toString(), "a.txt").get("status"));
            Map<String, Object> mixed = service.getRun("work-s6", "run-6", root.toString());
            Assertions.assertEquals("PARTIALLY_UNDONE", mixed.get("runApplyState"));

            // 单文件撕销后再整轮撕销：已达目标态的条目幂等跳过，不得报假冲突。
            Map<String, Object> result = service.undoRun("work-s6", "run-6", root.toString());
            Assertions.assertEquals("OK", result.get("status"));
            Assertions.assertEquals("A0", Files.readString(a));
            Assertions.assertEquals("B0", Files.readString(b));
            Assertions.assertEquals("FULLY_UNDONE", ((Map<?, ?>) result.get("summary")).get("runApplyState"));

            Map<String, Object> again = service.undoRun("work-s6", "run-6", root.toString());
            Assertions.assertEquals("OK", again.get("status"));
            Assertions.assertEquals("A0", Files.readString(a));

            Map<String, Object> reapplied = service.reapplyRun("work-s6", "run-6", root.toString());
            Assertions.assertEquals("OK", reapplied.get("status"));
            Assertions.assertEquals("FULLY_APPLIED", ((Map<?, ?>) reapplied.get("summary")).get("runApplyState"));
        } finally {
            delete(root);
        }
    }

    @Test
    void logicalMountPathIsRejectedAndMarksIncomplete() throws Exception {
        Path root = Files.createTempDirectory("file-changes-logical");
        try {
            FileChangeService.Capture capture = service.before("work-s7", "run-7", root.toString(), "@pool1/bin/tool.txt");
            service.after(capture);
            Map<String, Object> summary = service.getRun("work-s7", "run-7", root.toString());
            Assertions.assertEquals(Boolean.TRUE, summary.get("possiblyIncomplete"));
            Assertions.assertEquals(0, number(summary.get("fileCount")));

            FileChangeService.Capture home = service.before("work-s7", "run-7", root.toString(), "~/secret.txt");
            service.after(home);
            Assertions.assertEquals(Boolean.TRUE,
                    service.getRun("work-s7", "run-7", root.toString()).get("possiblyIncomplete"));
            Assertions.assertEquals("INVALID_REQUEST",
                    service.diff("work-s7", "run-7", root.toString(), "@pool1/bin/tool.txt").get("status"));
        } finally {
            delete(root);
        }
    }

    @Test
    void countsAdditionsAndDeletionsPerFileAndPerRun() throws Exception {
        Path root = Files.createTempDirectory("file-changes-lines");
        try {
            Path modified = root.resolve("m.txt");
            Path added = root.resolve("n.txt");
            Path removed = root.resolve("d.txt");
            Files.writeString(modified, "l1\nl2\nl3\n");
            Files.writeString(removed, "x1\nx2\n");

            FileChangeService.Capture cm = service.before("work-s8", "run-8", root.toString(), "m.txt");
            Files.writeString(modified, "l1\nl2b\nl3\nl4\n");
            service.after(cm);
            FileChangeService.Capture cn = service.before("work-s8", "run-8", root.toString(), "n.txt");
            Files.writeString(added, "a1\na2\n");
            service.after(cn);
            FileChangeService.Capture cd = service.before("work-s8", "run-8", root.toString(), "d.txt");
            Files.delete(removed);
            service.after(cd);

            Map<String, Object> summary = service.getRun("work-s8", "run-8", root.toString());
            Map<String, Object> mRow = fileRow(summary, "m.txt");
            Assertions.assertEquals("MODIFIED", mRow.get("changeType"));
            Assertions.assertEquals(2, number(mRow.get("additions")));
            Assertions.assertEquals(1, number(mRow.get("deletions")));

            Map<String, Object> nRow = fileRow(summary, "n.txt");
            Assertions.assertEquals("ADDED", nRow.get("changeType"));
            Assertions.assertEquals(2, number(nRow.get("additions")));
            Assertions.assertEquals(0, number(nRow.get("deletions")));

            Map<String, Object> dRow = fileRow(summary, "d.txt");
            Assertions.assertEquals("DELETED", dRow.get("changeType"));
            Assertions.assertEquals(0, number(dRow.get("additions")));
            Assertions.assertEquals(2, number(dRow.get("deletions")));

            Assertions.assertEquals(4, number(summary.get("additions")));
            Assertions.assertEquals(3, number(summary.get("deletions")));
            Assertions.assertEquals("FULLY_APPLIED", summary.get("runApplyState"));
        } finally {
            delete(root);
        }
    }

    @Test
    void binaryFileReportsZeroLineStats() throws Exception {
        Path root = Files.createTempDirectory("file-changes-binary-lines");
        try {
            FileChangeService.Capture capture = service.before("work-s9", "run-9", root.toString(), "blob.bin");
            Files.write(root.resolve("blob.bin"), new byte[]{0, 10, 0, 10});
            service.after(capture);
            Map<String, Object> summary = service.getRun("work-s9", "run-9", root.toString());
            Map<String, Object> row = fileRow(summary, "blob.bin");
            Assertions.assertEquals(Boolean.TRUE, row.get("binary"));
            Assertions.assertEquals(0, number(row.get("additions")));
            Assertions.assertEquals(0, number(row.get("deletions")));
            Assertions.assertEquals(0, number(summary.get("additions")));
        } finally {
            delete(root);
        }
    }

    @Test
    void largeUtf8TextIsNotMisdetectedAsBinary() throws Exception {
        Path root = Files.createTempDirectory("file-changes-utf8");
        try {
            StringBuilder text = new StringBuilder();
            while (text.length() < 12000) text.append("中文测试行内容\n");
            Path file = root.resolve("big.txt");
            Files.writeString(file, "首行\n", StandardCharsets.UTF_8);
            FileChangeService.Capture capture = service.before("work-s10", "run-10", root.toString(), "big.txt");
            Files.writeString(file, text.toString(), StandardCharsets.UTF_8);
            service.after(capture);

            Map<String, Object> diff = service.diff("work-s10", "run-10", root.toString(), "big.txt");
            Assertions.assertEquals(Boolean.FALSE, diff.get("binary"));
            Assertions.assertEquals(text.toString(), diff.get("after"));
            Assertions.assertTrue(number(fileRow(service.getRun("work-s10", "run-10", root.toString()), "big.txt")
                    .get("additions")) > 100);
        } finally {
            delete(root);
        }
    }

    @Test
    void rejectsUndoWhileRunIsNotReadyAndHonoursOperationId() throws Exception {
        Path root = Files.createTempDirectory("file-changes-busy");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A0");
            FileChangeService.Capture capture = service.before("work-s11", "run-11", root.toString(), "a.txt");
            Files.writeString(file, "A1");
            service.after(capture);

            Map<String, Object> busy = service.undoRun("work-s11", "run-11", root.toString());
            Assertions.assertEquals("BUSY", busy.get("status"));
            Assertions.assertEquals("A1", Files.readString(file));

            service.finish("work-s11", "run-11", root.toString());
            Map<String, Object> first = service.undoRun("work-s11", "run-11", root.toString(), "op-1");
            Assertions.assertEquals("OK", first.get("status"));
            Assertions.assertEquals("A0", Files.readString(file));

            // 同一 operationId 重复提交：直接返回首次结果，不重跑。
            Files.writeString(file, "A1");
            Map<String, Object> replay = service.undoRun("work-s11", "run-11", root.toString(), "op-1");
            // 用 assertEquals 而不是 assertSame：幂等契约是「返回同一份结果内容」，不是「返回同一个
            // Map 实例」。实现刻意回副本——调用方（WebController.changeWriteResult）会在返回的 Map 上
            // 就地 put("operationId", ...)，把缓存里的同一个实例交出去会让并发下的一读一写 CME，
            // 并让第二次请求读到上一次写进去的 operationId。见下方
            // replayedResultIsADefensiveCopySoCallersCannotCorruptTheCache。
            Assertions.assertEquals(first, replay);
            Assertions.assertNotSame(first, replay);
            Assertions.assertEquals("A1", Files.readString(file));

            // 换新 operationId 后不再命中幂等缓存，会真实跑一遍预检：
            // 此时账本已标 undone，预期当前内容为 before(A0)，但上方已手工写回 A1，
            // 属于「文件在撤销后又被外部改动」——必须判 CONFLICT 并拒绝覆盖，
            // 这正是本功能的安全语义（不静默干掉用户后来的修改）。
            Map<String, Object> fresh = service.undoRun("work-s11", "run-11", root.toString(), "op-2");
            Assertions.assertEquals("CONFLICT", fresh.get("status"));
            Assertions.assertEquals("A1", Files.readString(file));
        } finally {
            delete(root);
        }
    }

    /**
     * B2 回归：异常/取消收口必须解锁撤销能力。
     *
     * <p>旧实现只在「正常完成」路径调 finish，而 finish 里的 {@code ready=true} 是撤销的第一道门禁。
     * 于是 run 一旦流异常或被用户 Stop，账本永远停在 {@code ready=false}，撤销按钮永久返回 BUSY，
     * 且重启也不自愈——而「agent 跑挂了、工作区被改乱」恰恰是最需要回滚的时刻。</p>
     */
    @Test
    void abnormalFinishUnlocksUndoAndMarksLedgerIncomplete() throws Exception {
        Path root = Files.createTempDirectory("file-changes-interrupted");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A0");
            FileChangeService.Capture capture = service.before("work-s12", "run-12", root.toString(), "a.txt");
            Files.writeString(file, "A1");
            service.after(capture);

            // 未收口时挡住是对的：run 可能还有 write/edit 在写盘
            Assertions.assertEquals("BUSY", service.undoRun("work-s12", "run-12", root.toString()).get("status"));

            // 异常收口：clean=false 同样要置 ready，否则撤销永久锁死
            service.finish("work-s12", "run-12", root.toString(), false);

            Map<String, Object> summary = service.getRun("work-s12", "run-12", root.toString());
            Assertions.assertEquals(Boolean.TRUE, summary.get("ready"), "异常收口后必须解锁撤销");
            Assertions.assertEquals(Boolean.TRUE, summary.get("possiblyIncomplete"), "异常收口必须告知账本可能不完整");
            Assertions.assertEquals("INCOMPLETE", summary.get("status"));

            // 解锁后撤销真的能跑通，把文件恢复到改动前
            Map<String, Object> undo = service.undoRun("work-s12", "run-12", root.toString());
            Assertions.assertEquals("OK", undo.get("status"));
            Assertions.assertEquals("A0", Files.readString(file));
        } finally {
            delete(root);
        }
    }

    /**
     * BUSY 是瞬态结果，不得进幂等缓存。
     *
     * <p>旧实现无条件缓存 operationId 的结果且无过期时间，于是同一个 operationId 一旦撞上 BUSY
     * 就永久返回 BUSY（重启也不清），此前只靠前端每次生成新随机 id 掩盖了这个缺陷。</p>
     */
    @Test
    void busyResultIsNotCachedSoRetrySucceedsAfterFinish() throws Exception {
        Path root = Files.createTempDirectory("file-changes-busy-cache");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A0");
            FileChangeService.Capture capture = service.before("work-s13", "run-13", root.toString(), "a.txt");
            Files.writeString(file, "A1");
            service.after(capture);

            Assertions.assertEquals("BUSY",
                    service.undoRun("work-s13", "run-13", root.toString(), "op-busy").get("status"));

            service.finish("work-s13", "run-13", root.toString());

            // 同一个 operationId 重试：必须真的跑一遍，而不是回放上一次的 BUSY
            Map<String, Object> retry = service.undoRun("work-s13", "run-13", root.toString(), "op-busy");
            Assertions.assertEquals("OK", retry.get("status"), "BUSY 被缓存会导致撤销永久失效");
            Assertions.assertEquals("A0", Files.readString(file));
        } finally {
            delete(root);
        }
    }

    /**
     * 幂等缓存必须回副本：调用方对返回值的就地修改不得污染缓存。
     *
     * <p>WebController.changeWriteResult 会在返回的 Map 上 {@code put("operationId", ...)}。
     * 旧实现把缓存里的同一个 LinkedHashMap 实例直接交出去，于是：① 并发下一读一写会 CME /
     * 产出损坏 JSON；② 第二次请求会看到上一次写入的 operationId。</p>
     */
    @Test
    void replayedResultIsADefensiveCopySoCallersCannotCorruptTheCache() throws Exception {
        Path root = Files.createTempDirectory("file-changes-cache-copy");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A0");
            FileChangeService.Capture capture = service.before("work-s14", "run-14", root.toString(), "a.txt");
            Files.writeString(file, "A1");
            service.after(capture);
            service.finish("work-s14", "run-14", root.toString());

            Map<String, Object> first = service.undoRun("work-s14", "run-14", root.toString(), "op-copy");
            Assertions.assertEquals("OK", first.get("status"));

            // 模拟 WebController 的就地写入
            first.put("operationId", "op-copy");

            Map<String, Object> replay = service.undoRun("work-s14", "run-14", root.toString(), "op-copy");
            Assertions.assertNotSame(first, replay);
            Assertions.assertFalse(replay.containsKey("operationId"),
                    "调用方对返回值的就地修改不得污染幂等缓存");
        } finally {
            delete(root);
        }
    }

    @Test
    void gbkDiffAndLineStatsUseTheSameRecordedCharset() throws Exception {
        Path root = Files.createTempDirectory("file-changes-gbk-lines");
        try {
            Charset gbk = Charset.forName("GBK");
            Path file = root.resolve("legacy.txt");
            Files.write(file, "第一行\n第二行\n".getBytes(gbk));
            FileChangeService.Capture capture = service.before("work-s15", "run-15", root.toString(), "legacy.txt");
            Files.write(file, "第一行\n第二行修改\n第三行\n".getBytes(gbk));
            service.after(capture);

            Map<String, Object> diff = service.diff("work-s15", "run-15", root.toString(), "legacy.txt");
            Assertions.assertEquals("第一行\n第二行\n", diff.get("before"));
            Assertions.assertEquals("第一行\n第二行修改\n第三行\n", diff.get("after"));
            Map<String, Object> row = fileRow(service.getRun("work-s15", "run-15", root.toString()), "legacy.txt");
            Assertions.assertEquals(2, number(row.get("additions")));
            Assertions.assertEquals(1, number(row.get("deletions")));

            String manifest = Files.readString(root.resolve(".gwork/file-changes/manifests/work-s15/run-15.json"));
            Assertions.assertTrue(manifest.contains("\"charset\":\"GBK\""));
        } finally {
            delete(root);
        }
    }

    @Test
    void finishReportsFailureWithoutCreatingAReadyManifestAndCanBeRetried() throws Exception {
        Path root = Files.createTempDirectory("file-changes-finish-retry");
        try {
            Path file = root.resolve("a.txt");
            Files.writeString(file, "A0");
            FileChangeService.Capture capture = service.before("work-s16", "run-16", root.toString(), "a.txt");
            Files.writeString(file, "A1");
            service.after(capture);

            // 稳定 seam：暂时写入不可读 manifest 触发失败，不依赖操作系统权限语义；修复后原调用可重试。
            Path manifest = root.resolve(".gwork/file-changes/manifests/work-s16/run-16.json");
            String validManifest = Files.readString(manifest);
            Files.writeString(manifest, "not-json");
            Assertions.assertFalse(service.finish("work-s16", "run-16", root.toString()));

            Files.writeString(manifest, validManifest);
            Assertions.assertTrue(service.finish("work-s16", "run-16", root.toString()));
            Assertions.assertEquals(Boolean.TRUE,
                    service.getRun("work-s16", "run-16", root.toString()).get("ready"));
        } finally {
            delete(root);
        }
    }

    @Test
    void maintenanceFailureIsNotTreatedAsSuccessful() throws Exception {
        Path root = Files.createTempDirectory("file-changes-maintain-retry");
        try {
            Path manifests = root.resolve(".gwork/file-changes/manifests");
            Files.createDirectories(manifests.getParent());
            Files.writeString(manifests, "blocked");
            Assertions.assertFalse(service.maintainLocked(root));

            Files.delete(manifests);
            Assertions.assertTrue(service.maintainLocked(root));
        } finally {
            delete(root);
        }
    }

    private static void delete(Path path) throws Exception {
        if (!Files.exists(path)) return;
        try (java.util.stream.Stream<Path> stream = Files.walk(path)) {
            stream.sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (Exception ignored) { }
            });
        }
    }
}
