package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * {@link SessionStreamStore#recordToolUsage} 的写盘契约测试。
 *
 * <p>锁定三件事：① 账本落在会话目录的 {@code <sid>.usage.ndjson}；② 行格式为
 * {tool,ok,at[,actionId][,agent][,skill]} 且可被 {@link SessionToolUsageService} 直接读回
 * （写读闭环，防两侧格式漂移）；③ 空参数 no-op、失败不抛（统计是旁路，不得影响主链路）。</p>
 */
class SessionStreamStoreUsageLedgerTest {

    @Test
    void writesUsageLedgerReadableByUsageService() throws Exception {
        Path workspace = Files.createTempDirectory("usage-ledger-store");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-ledger-write";

            store.recordToolUsage(sid, null, "skillread", true, "call_1", "main", "ppt-craft-master");
            store.recordToolUsage(sid, null, "memory_extract", true, "call_2", "main", null);
            store.recordToolUsage(sid, null, "bash", false, "call_3", "main", null);

            Path ledger = workspace.resolve(".gwork/sessions/" + sid + "/" + sid + ".usage.ndjson");
            Assertions.assertTrue(Files.exists(ledger), "账本必须落在会话目录");
            List<String> lines = Files.readAllLines(ledger, StandardCharsets.UTF_8);
            Assertions.assertEquals(3, lines.size(), "一次调用一行，行级可见（写完即 flush）");
            Assertions.assertTrue(lines.get(0).contains("\"tool\":\"skillread\""));
            Assertions.assertTrue(lines.get(0).contains("\"ok\":true"));
            Assertions.assertTrue(lines.get(0).contains("\"skill\":\"ppt-craft-master\""));
            Assertions.assertFalse(lines.get(1).contains("\"skill\""), "非技能工具不写 skill 字段");
            Assertions.assertTrue(lines.get(2).contains("\"ok\":false"), "失败调用如实记录");

            // 写读闭环：统计服务直接读回账本
            var usage = SessionToolUsageService.usage(
                    workspace.resolve(".gwork/sessions/" + sid).toFile(), sid);
            Assertions.assertEquals(Boolean.TRUE, usage.get("exists"));
            Assertions.assertEquals(3, ((Number) usage.get("toolCallCount")).intValue());
            Assertions.assertEquals(1, ((Number) usage.get("skillCount")).intValue());
            @SuppressWarnings("unchecked")
            var mem = (java.util.Map<String, Object>) usage.get("memory");
            Assertions.assertEquals(Boolean.TRUE, mem.get("updated"));
        } finally {
            delete(workspace);
        }
    }

    @Test
    void escapesSpecialCharsSoLedgerStaysReadable() throws Exception {
        // 转义写读闭环：技能名/代理名含引号、反斜杠、控制符时，账本行仍必须是合法 JSON
        // 且能被统计服务原样读回（jsonStr 漏转义任一种都会让该行变 degraded、统计丢事实）
        Path workspace = Files.createTempDirectory("usage-ledger-escape");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-ledger-esc";
            String nasty = "a\"b\\c\nd";

            store.recordToolUsage(sid, null, "skillread", true, "c\"1", "ag\\ent", nasty);

            var usage = SessionToolUsageService.usage(
                    workspace.resolve(".gwork/sessions/" + sid).toFile(), sid);
            Assertions.assertEquals(0, ((Number) usage.get("degradedLines")).intValue(),
                    "转义后的账本行必须零 degraded");
            @SuppressWarnings("unchecked")
            var skills = (java.util.List<java.util.Map<String, Object>>) usage.get("skills");
            Assertions.assertEquals(1, skills.size());
            Assertions.assertEquals(nasty, skills.get(0).get("name"), "技能名必须原样读回");
        } finally {
            delete(workspace);
        }
    }

    @Test
    void deleteSessionClearsLedgerAndReleasesWriterHandle() throws Exception {
        // 回归护栏（2026-10 自审）：账本与 stream 共用长驻 Writer，Windows 下 delete 不关句柄
        // 则 deleteIfExists 抛 AccessDenied → 会话目录删不掉。此处锁定「delete 后账本不存在
        // 且可再次写入（句柄已释放/可重建）」。
        Path workspace = Files.createTempDirectory("usage-ledger-delete");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);
            String sid = "work-ledger-del";

            store.recordToolUsage(sid, null, "skillread", true, "c1", "main", "s1");
            Path ledger = workspace.resolve(".gwork/sessions/" + sid + "/" + sid + ".usage.ndjson");
            Assertions.assertTrue(Files.exists(ledger), "前置：账本已落盘");

            store.delete(sid, null);

            Assertions.assertFalse(Files.exists(ledger), "delete 必须连同账本一起删除，不得残留");

            // 句柄已释放：删除后再次写入能重建句柄并成功落盘（若旧句柄未关，Windows 下
            // 重建 FileOutputStream 会因目录/文件状态异常而失败或写进已删句柄）
            store.recordToolUsage(sid, null, "bash", true, "c2", "main", null);
            Assertions.assertTrue(Files.exists(ledger), "delete 后账本可重建");
            Assertions.assertEquals(1, Files.readAllLines(ledger, StandardCharsets.UTF_8).size());
        } finally {
            delete(workspace);
        }
    }

    @Test
    void blankInputsAreNoOpAndNeverThrow() throws Exception {
        Path workspace = Files.createTempDirectory("usage-ledger-noop");
        try {
            SessionLocator locator = new SessionLocator(workspace.toString(), ".gwork/sessions");
            SessionStreamStore store = new SessionStreamStore(locator);

            store.recordToolUsage(null, null, "bash", true, null, null, null);
            store.recordToolUsage("", null, "bash", true, null, null, null);
            store.recordToolUsage("work-x", null, "", true, null, null, null);
            store.recordToolUsage("work-x", null, null, true, null, null, null);

            Path ledger = workspace.resolve(".gwork/sessions/work-x/work-x.usage.ndjson");
            Assertions.assertFalse(Files.exists(ledger), "空参数不得产生账本文件");
        } finally {
            delete(workspace);
        }
    }

    /**
     * 写侧接线形状契约（2026-10 自审补）：账本的全部价值挂在
     * {@code WebStreamBuilder.mapEvent} 的 ToolCallEndEvent 分支那一行接线上，而 mapEvent 是
     * private 且无测试直接构造 WebStreamBuilder——行为测试够不到它，删掉接线全部测试照绿。
     * 故双侧锁定：① 调用点（分支内、且在 onToolCallEndEvent/可见性过滤之前）；
     * ② 被调方法体的参数映射（ok 取 error==null、skill 取 skillNameOrNull、root 取 streamRoot）。
     * 另锁 delete 对账本句柄的关闭（Linux 上行为测试抓不到句柄泄漏，形状锁跨平台有牙）。
     */
    @Test
    void wiring_shape_guards() throws Exception {
        String builder = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebStreamBuilder.java");
        String store = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/SessionStreamStore.java");

        int callSite = builder.indexOf("recordToolUsageLedger(session, endEvent);");
        int endMap = builder.indexOf("onToolCallEndEvent(endEvent)");
        Assertions.assertTrue(callSite > 0, "mapEvent 的 ToolCallEndEvent 分支必须调用账本接线");
        Assertions.assertTrue(endMap > callSite, "账本追写必须先于 onToolCallEndEvent（可见性过滤之前）");

        int body = builder.indexOf("private void recordToolUsageLedger(");
        Assertions.assertTrue(body > 0, "接线方法必须存在");
        String method = builder.substring(body);
        Assertions.assertTrue(method.contains("store.recordToolUsage(sessionId, webGate.streamRoot(sessionId), toolName,"),
                "落点必须与 stream 同根（streamRoot），不得另解一套目录");
        Assertions.assertTrue(method.contains("event.getError() == null"),
                "ok 必须取 error==null，不得恒真只报喜");
        Assertions.assertTrue(method.contains("SessionToolUsageService.skillNameOrNull(event.getArgs(), toolName)"),
                "skill 标识必须与读侧同口径（同一函数），不得两处各算一套");

        int del = store.indexOf("public void delete(String sessionId, String projectRoot)");
        Assertions.assertTrue(del > 0, "delete 方法必须存在");
        String delBody = store.substring(del, store.indexOf("// ═", del) > 0 ? store.indexOf("// ═", del) : store.length());
        Assertions.assertTrue(delBody.contains("closeWriter(ledger)"),
                "delete 必须关闭账本长驻句柄（Windows 不关则删不掉会话目录）");
        Assertions.assertTrue(delBody.contains("Files.deleteIfExists(ledger.toPath())"),
                "delete 必须删除账本文件，不得残留");
    }

    private static String readSource(String relativePath) throws Exception {
        Path path = Path.of(relativePath);
        if (!Files.exists(path)) {
            path = Path.of("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(path), "源码文件必须存在: " + relativePath);
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    private static void delete(Path dir) throws Exception {
        if (!Files.exists(dir)) return;
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignore) {
                }
            });
        }
    }
}
