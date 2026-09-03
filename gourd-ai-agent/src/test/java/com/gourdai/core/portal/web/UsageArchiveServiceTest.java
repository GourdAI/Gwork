package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.TreeMap;

/**
 * 用量归档回归测试 —— 重点覆盖「全局区空壳会话目录吞掉项目会话」的历史缺陷。
 *
 * <p>背景：新会话在绑定所属根之前，{@code AgentSessionProvider} 已用无根提示的
 * {@link SessionLocator#resolveDir(String)} 在全局区建好了空目录，真身随后才写入
 * {@code <项目根>/.gwork/sessions/}。若归档收集阶段按「目录名」占坑去重，先扫到的
 * 全局空壳会把项目根下的真身整个跳过，导致项目会话的 token 用量永远不入账。</p>
 *
 * @author oisin
 */
public class UsageArchiveServiceTest {

    private static final String SESSIONS = ".gwork/sessions";

    private SessionLocator newLocator(Path workspace) {
        return new SessionLocator(workspace.toString(), SESSIONS);
    }

    private SessionLocator newLocator(Path workspace, Path globalBase) {
        return new SessionLocator(workspace.toString(), globalBase.toString(), SESSIONS);
    }

    /** 建一个会话目录；stream 为 null 表示只建空壳目录（模拟未绑根时的预创建）。 */
    private void writeSession(Path root, String sid, String stream) throws Exception {
        Path dir = root.resolve(SESSIONS).resolve(sid);
        Files.createDirectories(dir);
        if (stream != null) {
            Files.write(dir.resolve(sid + SessionStreamStore.STREAM_SUFFIX),
                    stream.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String traceLine(String model, long tokens, long ts) {
        return "{\"type\":\"trace\",\"createdAt\":" + ts + ",\"model\":\"" + model
                + "\",\"inputTokens\":" + (tokens / 2) + ",\"outputTokens\":" + (tokens / 2)
                + ",\"totalTokens\":" + tokens + "}";
    }

    private String userLine(long ts) {
        return "{\"type\":\"user\",\"createdAt\":" + ts + ",\"content\":\"hi\"}";
    }

    private UsageArchiveService.DayStat archiveToday(SessionLocator locator, Path globalBase) {
        UsageArchiveService svc = new UsageArchiveService(locator, globalBase.toString());
        svc.archiveIncremental();
        LocalDate today = LocalDate.now();
        TreeMap<LocalDate, UsageArchiveService.DayStat> days = svc.load(today, today);
        return days.get(today);
    }

    /**
     * workspace 与 globalBase 不同时，账本必须写入 globalBase，而项目会话仍从项目根扫描。
     */
    @Test
    public void testDistinctGlobalBaseKeepsUsageOutOfWorkspace() throws Exception {
        Path workspace = Files.createTempDirectory("usage-workspace-distinct");
        Path globalBase = Files.createTempDirectory("usage-global-distinct");
        Path project = Files.createTempDirectory("usage-project-distinct");
        try {
            long now = System.currentTimeMillis();
            String sid = "work-distinct001";
            writeSession(project, sid, traceLine("distinct-model", 700, now) + "\n" + userLine(now) + "\n");

            SessionLocator locator = newLocator(workspace, globalBase);
            locator.bindSessionRoot(sid, project.toString());
            UsageArchiveService.DayStat day = archiveToday(locator, globalBase);

            Assertions.assertNotNull(day, "项目会话应被归档");
            Assertions.assertEquals(700L, day.tokens());
            Path ledger = globalBase.resolve(".gwork/usage/usage-" + LocalDate.now().toString().substring(0, 7) + ".json");
            Assertions.assertTrue(Files.isRegularFile(ledger), "账本必须写入 globalBase");
            Assertions.assertFalse(Files.exists(workspace.resolve(".gwork/usage")), "workspace 不应承载全局账本");
            Assertions.assertTrue(Files.isRegularFile(globalBase.resolve(".gwork/session-roots.json")), "登记表必须写入 globalBase");
            Assertions.assertTrue(Files.isRegularFile(project.resolve(SESSIONS).resolve(sid)
                    .resolve(sid + SessionStreamStore.STREAM_SUFFIX)), "项目会话仍应在项目根");
        } finally {
            deleteRecursively(workspace.toFile());
            deleteRecursively(globalBase.toFile());
            deleteRecursively(project.toFile());
        }
    }


    @Test
    public void testGlobalEmptyShellMustNotSwallowProjectSession() throws Exception {
        Path ws = Files.createTempDirectory("usage-ws");
        Path project = Files.createTempDirectory("usage-project");
        try {
            long now = System.currentTimeMillis();
            String sid = "work-prj001";

            // 全局区：绑根前预创建的空壳目录（无流文件）
            writeSession(ws, sid, null);
            // 项目根：真身（1 条 trace + 1 条 user）
            writeSession(project, sid, traceLine("m1", 1000, now) + "\n" + userLine(now) + "\n");

            SessionLocator locator = newLocator(ws);
            locator.bindSessionRoot(sid, project.toString());

            UsageArchiveService.DayStat day = archiveToday(locator, ws);

            Assertions.assertNotNull(day, "项目会话应产生当日账本数据");
            Assertions.assertEquals(1000L, day.tokens(), "项目会话的 token 必须计入，不能被全局空壳吞掉");
            Assertions.assertEquals(1, day.messages, "项目会话的用户消息数必须计入");
            Assertions.assertTrue(day.sessions.contains(sid), "活跃会话集合应包含项目会话");
        } finally {
            deleteRecursively(ws.toFile());
            deleteRecursively(project.toFile());
        }
    }

    /**
     * 同一 sid 在多个根都有流文件时，取内容更多（字节更大）的那个，避免统计到残留的旧碎片。
     */
    @Test
    public void testSameSidPicksLargerStream() throws Exception {
        Path ws = Files.createTempDirectory("usage-ws2");
        Path project = Files.createTempDirectory("usage-project2");
        try {
            long now = System.currentTimeMillis();
            String sid = "work-prj002";

            // 全局区：残留的一条小碎片
            writeSession(ws, sid, traceLine("m1", 10, now) + "\n");
            // 项目根：真身，内容更多
            writeSession(project, sid,
                    traceLine("m1", 500, now) + "\n" + traceLine("m1", 500, now + 1) + "\n");

            SessionLocator locator = newLocator(ws);
            locator.bindSessionRoot(sid, project.toString());

            UsageArchiveService.DayStat day = archiveToday(locator, ws);

            Assertions.assertNotNull(day, "应产生当日账本数据");
            Assertions.assertEquals(1000L, day.tokens(), "同 sid 多处命中时应取内容更完整的流文件");
            Assertions.assertEquals(2, day.rounds(), "轮次应来自更完整的流文件");
        } finally {
            deleteRecursively(ws.toFile());
            deleteRecursively(project.toFile());
        }
    }

    /**
     * 全局会话（无所属根）本身照常入账，不因去重口径调整而回归。
     */
    @Test
    public void testGlobalSessionStillArchived() throws Exception {
        Path ws = Files.createTempDirectory("usage-ws3");
        try {
            long now = System.currentTimeMillis();
            writeSession(ws, "work-g001", traceLine("m2", 300, now) + "\n");
            // 同时存在一个纯空壳，不应影响结果、也不应报错
            writeSession(ws, "work-g002", null);

            SessionLocator locator = newLocator(ws);
            UsageArchiveService.DayStat day = archiveToday(locator, ws);

            Assertions.assertNotNull(day, "全局会话应产生当日账本数据");
            Assertions.assertEquals(300L, day.tokens(), "全局会话 token 应照常统计");
            Assertions.assertTrue(day.sessions.contains("work-g001"), "活跃会话应含全局会话");
            Assertions.assertFalse(day.sessions.contains("work-g002"), "空壳目录不应产生活跃会话");
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
