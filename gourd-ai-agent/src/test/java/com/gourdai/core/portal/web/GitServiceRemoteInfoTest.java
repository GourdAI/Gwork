package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * {@link GitService#remoteInfo()} 及其解析 seam 的聚焦测试。
 *
 * <p><b>WHY 分两层</b>：{@code remoteInfo()} 会 spawn 真 git，无法在 CI 上稳定复现「多远端 /
 * 畸形 rev-list 输出」等分支；故把纯字符串逻辑抽成包可见静态方法
 * （{@link GitService#parseRemoteUrl}、{@link GitService#parseAheadBehind}）单独覆盖，
 * 再用一个真 git 用例锁定「有远端但无上游」这条最常见的降级路径。
 * git 不可用时该用例 {@code assumeTrue} 跳过，不让环境缺依赖变成红。</p>
 */
class GitServiceRemoteInfoTest {

    @TempDir
    Path temp;

    // ==================== 1. parseRemoteUrl：纯解析，不 spawn git ====================

    @Test
    void parsesFirstFetchUrlAndIgnoresPushLine() {
        // git remote -v 对每个远端输出 fetch 与 push 两行；面板关心「代码从哪来」，只认 fetch
        List<String> lines = Arrays.asList(
                "origin\thttps://github.com/noear/gourdai.git (fetch)",
                "origin\thttps://github.com/noear/gourdai.git (push)");

        Assertions.assertEquals("https://github.com/noear/gourdai.git", GitService.parseRemoteUrl(lines));
    }

    @Test
    void multipleRemotesTakeTheFirstFetchLine() {
        // 输出按远端名字典序，第一行 fetch 即「第一个远端」
        List<String> lines = Arrays.asList(
                "backup\tgit@backup.local:team/app.git (fetch)",
                "backup\tgit@backup.local:team/app.git (push)",
                "origin\tgit@github.com:team/app.git (fetch)",
                "origin\tgit@github.com:team/app.git (push)");

        Assertions.assertEquals("git@backup.local:team/app.git", GitService.parseRemoteUrl(lines));
    }

    @Test
    void pushOnlyRemoteStillYieldsAUrl() {
        // push-only 配置（只读镜像常见）没有 fetch 行：退回第一行地址，不能显示为空
        List<String> lines = Collections.singletonList(
                "origin\tssh://git@internal/app.git (push)");

        Assertions.assertEquals("ssh://git@internal/app.git", GitService.parseRemoteUrl(lines));
    }

    @Test
    void emptyOrBlankOutputMeansNoRemote() {
        Assertions.assertNull(GitService.parseRemoteUrl(null));
        Assertions.assertNull(GitService.parseRemoteUrl(Collections.emptyList()));
        Assertions.assertNull(GitService.parseRemoteUrl(Arrays.asList("", "   ", "\t")));
    }

    @Test
    void malformedLineWithoutUrlYieldsNull() {
        // 只有远端名、没有地址：不能把远端名当成 URL 回给前端
        Assertions.assertNull(GitService.parseRemoteUrl(Collections.singletonList("origin")));
        Assertions.assertNull(GitService.parseRemoteUrl(Collections.singletonList("origin\t (fetch)")));
    }

    @Test
    void spaceSeparatedRemoteLineIsTolerated() {
        // 少数 git 版本/终端用空格而非 TAB 分隔
        Assertions.assertEquals("https://example.com/a.git",
                GitService.parseRemoteUrl(Collections.singletonList("origin https://example.com/a.git (fetch)")));
    }

    // ==================== 2. parseAheadBehind：behind/ahead 顺序不可写反 ====================

    @Test
    void parsesBehindThenAhead() {
        // rev-list --left-right --count @{u}...HEAD 输出「左=仅上游有(behind) 右=仅本地有(ahead)」
        int[] behindAhead = GitService.parseAheadBehind("2\t3\n");

        Assertions.assertNotNull(behindAhead);
        Assertions.assertEquals(2, behindAhead[0], "左值必须是 behind");
        Assertions.assertEquals(3, behindAhead[1], "右值必须是 ahead");
    }

    @Test
    void parsesZeroZeroAsInSync() {
        int[] behindAhead = GitService.parseAheadBehind("0\t0");

        Assertions.assertNotNull(behindAhead);
        Assertions.assertEquals(0, behindAhead[0]);
        Assertions.assertEquals(0, behindAhead[1]);
    }

    @Test
    void unparsableOutputReturnsNullSoCallerMarksDegraded() {
        Assertions.assertNull(GitService.parseAheadBehind(null));
        Assertions.assertNull(GitService.parseAheadBehind(""));
        Assertions.assertNull(GitService.parseAheadBehind("   \n"));
        Assertions.assertNull(GitService.parseAheadBehind("abc\tdef"));
        Assertions.assertNull(GitService.parseAheadBehind("7"));
        // 计数不可能为负：负值说明拿到的不是本命令的输出
        Assertions.assertNull(GitService.parseAheadBehind("-1\t2"));
    }

    // ==================== 3. 真 git：有远端但无上游的降级路径 ====================

    /** git 是否可用；不可用时相关用例跳过而不是失败。 */
    private static boolean gitAvailable(Path dir) {
        try {
            Process proc = new ProcessBuilder("git", "--version")
                    .directory(dir.toFile())
                    .redirectErrorStream(true)
                    .start();
            proc.getInputStream().readAllBytes();
            return proc.waitFor(10, TimeUnit.SECONDS) && proc.exitValue() == 0;
        } catch (Throwable e) {
            return false;
        }
    }

    private static int git(Path dir, String... args) throws Exception {
        String[] command = new String[args.length + 1];
        command[0] = "git";
        System.arraycopy(args, 0, command, 1, args.length);
        Process proc = new ProcessBuilder(command)
                .directory(dir.toFile())
                .redirectErrorStream(true)
                .start();
        proc.getInputStream().readAllBytes();
        proc.waitFor(20, TimeUnit.SECONDS);
        return proc.exitValue();
    }

    @Test
    void remoteWithoutUpstreamReportsHasRemoteAndDegrades() throws Exception {
        Assumptions.assumeTrue(gitAvailable(temp.toAbsolutePath()), "git 不可用，跳过真仓库用例");

        Path repo = Files.createTempDirectory(temp, "repo");
        Assertions.assertEquals(0, git(repo, "init"), "git init 应成功");
        Assertions.assertEquals(0, git(repo, "remote", "add", "origin", "https://example.com/x.git"));

        // engine 传 null：remoteInfo() 只走进程调用，不触碰 AI 引擎
        GitService service = new GitService(repo.toString(), null);
        Map<String, Object> info = service.remoteInfo();

        Assertions.assertEquals(Boolean.TRUE, info.get("gitAvailable"));
        Assertions.assertEquals(Boolean.TRUE, info.get("hasRemote"), "刚 add 的 origin 必须被识别");
        Assertions.assertEquals("https://example.com/x.git", info.get("remoteUrl"));
        // 从未 fetch/branch --set-upstream：上游不存在，ahead/behind 只能是哨兵值
        Assertions.assertNull(info.get("upstream"));
        Assertions.assertEquals(-1, info.get("ahead"));
        Assertions.assertEquals(-1, info.get("behind"));
        Assertions.assertEquals(Boolean.TRUE, info.get("degraded"), "无上游属于不完整结果，必须标 degraded");
    }

    @Test
    void directoryWithoutRepoDegradesInsteadOfThrowing() throws Exception {
        Assumptions.assumeTrue(gitAvailable(temp.toAbsolutePath()), "git 不可用，跳过真仓库用例");

        Path plain = Files.createTempDirectory(temp, "plain");
        GitService service = new GitService(plain.toString(), null);

        // 非 git 仓库：不得抛异常，回结构化降级空态
        Map<String, Object> info = Assertions.assertDoesNotThrow(service::remoteInfo);
        Assertions.assertEquals(Boolean.FALSE, info.get("hasRemote"));
        Assertions.assertEquals(Boolean.TRUE, info.get("degraded"));
        // 字段必须齐备：前端不该对每个字段做 undefined 判定
        for (String key : Arrays.asList("gitAvailable", "hasRemote", "remoteUrl",
                "upstream", "ahead", "behind", "degraded")) {
            Assertions.assertTrue(info.containsKey(key), "响应缺少字段: " + key);
        }
    }

    @Test
    void inRootRedirectsTheGitDirectory() throws Exception {
        Assumptions.assumeTrue(gitAvailable(temp.toAbsolutePath()), "git 不可用，跳过真仓库用例");

        // 启动工作区不是仓库，root 覆盖后指向真仓库：验证 ThreadLocal 目录覆盖对新方法同样生效
        Path notRepo = Files.createTempDirectory(temp, "not-repo");
        Path repo = Files.createTempDirectory(temp, "repo2");
        git(repo, "init");
        git(repo, "remote", "add", "origin", "https://example.com/y.git");

        GitService service = new GitService(notRepo.toString(), null);
        Map<String, Object> viaRoot = service.inRoot(repo.toString(), service::remoteInfo);
        Assertions.assertEquals(Boolean.TRUE, viaRoot.get("hasRemote"), "inRoot 必须把执行目录切到 root");

        Map<String, Object> viaWorkspace = service.remoteInfo();
        Assertions.assertEquals(Boolean.FALSE, viaWorkspace.get("hasRemote"),
                "不带 root 时仍应落在启动工作区（非仓库）");
        // ThreadLocal 必须已清理，否则同一线程后续请求会串到上一个 root
        Assertions.assertEquals(Boolean.TRUE, viaWorkspace.get("degraded"),
                "非仓库工作区应降级，说明目录覆盖已被 clearDir 清理");
    }

    /** 兜底：临时目录里的 .git 不该被测试遗留在工作区（@TempDir 会自动清理，这里只断言路径隔离）。 */
    @Test
    void tempRepoStaysInsideTempDir() throws Exception {
        Assumptions.assumeTrue(gitAvailable(temp.toAbsolutePath()), "git 不可用，跳过真仓库用例");

        Path repo = Files.createTempDirectory(temp, "isolated");
        git(repo, "init");

        Assertions.assertTrue(new File(repo.toFile(), ".git").exists());
        Assertions.assertTrue(repo.startsWith(temp), "仓库必须建在 @TempDir 内");
        // 不留下任何写入工作区的痕迹
        Assertions.assertTrue(Files.readString(repo.resolve(".git/HEAD"), StandardCharsets.UTF_8).contains("ref:"));
    }
}
