package com.gourdai.harness.change;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link EphemeralPaths} 的判定测试。
 *
 * <p>这些断言全部落在<b>真实路径解析</b>上，不做字符串猜测：临时目录用
 * {@code java.io.tmpdir} 的真实值配合 {@code createTempFile}，工作区用 {@code @TempDir}。
 * 这样一旦 Windows/Unix 的路径形态差异（盘符、符号链接、8.3 短名）让判定失效，
 * 测试会红，而不是像纯字符串断言那样恒绿。</p>
 */
class EphemeralPathsTest {

    /** 用户实测的三类噪音，必须全部被认定为临时产物。 */
    @Test
    void recognizesTheNoiseUserActuallyReported() {
        assertTrue(EphemeralPaths.isEphemeralRelative(".tmp/check-endings.js"), ".tmp 下的验证脚本");
        assertTrue(EphemeralPaths.isEphemeralRelative(".tmp/mutation_verify.js"), "变异验证脚本");
        assertTrue(EphemeralPaths.isEphemeralRelative("gourd-ai-agent/.tmp/mvn_full.log"), "嵌套 .tmp 下的日志");
        assertTrue(EphemeralPaths.isEphemeralRelative("target/classes/static/js/app.css"), "构建产物");
        assertTrue(EphemeralPaths.isEphemeralRelative("node_modules/playwright-core/index.js"), "依赖目录");
        assertTrue(EphemeralPaths.isEphemeralRelative(".gwork/tmp/solon-src/x.java"), "GWork 自己的临时区");
        assertTrue(EphemeralPaths.isEphemeralRelative("src/.tmp-1749000000/probe.js"), ".tmp-* 前缀变体");
    }

    /** 反向断言：真实产物与源码绝不能被误杀，否则这个过滤就是灾难。 */
    @Test
    void neverSwallowsRealSourceFiles() {
        assertFalse(EphemeralPaths.isEphemeralRelative("src/main/java/com/gourdai/App.java"), "主源码");
        assertFalse(EphemeralPaths.isEphemeralRelative("gourd-ai-agent/src/main/resources/static/js/app.css"), "前端资源");
        assertFalse(EphemeralPaths.isEphemeralRelative("README.md"), "根文件");
        // 「名字里带 verify」不等于文件是临时的：项目里可以真有 verify.js 作为测试辅助。
        // 这正是本类刻意只认路径段、不猜文件名的原因。
        assertFalse(EphemeralPaths.isEphemeralRelative("test/js/verify.js"), "放在正常目录里的 verify 脚本");
        // 裸名 tmp 只在工作区根一级生效：src/tmp/ 很可能是真实目录，不得抹掉
        assertTrue(EphemeralPaths.isEphemeralRelative("tmp/probe.js"), "根一级 tmp/ 视为临时");
        assertFalse(EphemeralPaths.isEphemeralRelative("src/tmp/tmpdir.js"), "深层 src/tmp/ 不得误杀");
        assertFalse(EphemeralPaths.isEphemeralRelative("src/tmp/probe.js"), "深层 tmp/ 不得误杀");
        assertFalse(EphemeralPaths.isEphemeralRelative("docs/templates/build-guide.md"), "build 只是路径前缀");
        assertFalse(EphemeralPaths.isEphemeralRelative("src/targeted/Foo.java"), "targeted 不是 target 段");
    }

    @Test
    void handlesSeparatorAndCaseVariants() {
        assertTrue(EphemeralPaths.isEphemeralRelative(".tmp\\probe.js"), "Windows 反斜杠");
        assertTrue(EphemeralPaths.isEphemeralRelative(".TMP/probe.js"), "大写目录名");
        assertTrue(EphemeralPaths.isEphemeralRelative(".DS_Store"), "Windows 上是文件形态");
        assertFalse(EphemeralPaths.isEphemeralRelative(null));
        assertFalse(EphemeralPaths.isEphemeralRelative(""));
    }

    /** 工作区内的相对路径与绝对路径必须得到同一结论。 */
    @Test
    void resolvesWorkspaceRelativeAndAbsoluteAlike(@TempDir Path root) throws Exception {
        Path script = root.resolve(".tmp").resolve("probe.js");
        Files.createDirectories(script.getParent());
        Files.writeString(script, "// probe");

        assertTrue(EphemeralPaths.isEphemeralTarget(root, ".tmp/probe.js"), "相对路径");
        assertTrue(EphemeralPaths.isEphemeralTarget(root, script.toString()), "工作区内绝对路径");

        Path real = root.resolve("src").resolve("Main.java");
        Files.createDirectories(real.getParent());
        Files.writeString(real, "class Main {}");
        assertFalse(EphemeralPaths.isEphemeralTarget(root, "src/Main.java"));
        assertFalse(EphemeralPaths.isEphemeralTarget(root, real.toString()));
    }

    /**
     * 系统临时目录是本次治理的<b>首选落点</b>，必须被识别为临时产物。
     *
     * <p>这条是整条链里最容易「看起来对、实际没生效」的一环：脚本在工作区<b>之外</b>，
     * 若没被前面拦住，就会走到 {@code validateRelativePath} 抛「不可追踪」，
     * 进而把整轮标成 possiblyIncomplete。所以这里用真实的 createTempFile 验证。</p>
     */
    @Test
    void recognizesRealSystemTempDirectory(@TempDir Path root) throws Exception {
        Path temp = Files.createTempFile("gwork-ephemeral-probe-", ".js");
        try {
            assertTrue(EphemeralPaths.isSystemTemp(temp), "系统临时目录里的文件");
            assertTrue(EphemeralPaths.isEphemeralTarget(root, temp.toString()),
                    "工作区之外的系统临时文件应被判定为临时产物");
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    /**
     * 边界：工作区<b>外</b>、且不在系统临时目录的绝对路径<b>不应</b>被本类放行。
     *
     * <p>语义要保持：写到另一个项目去仍然算「不可追踪」，该降完整性就降——本类只负责
     * 折叠掉「临时产物」这一类，不能顺手把真正的越界写入也静音了。</p>
     *
     * <p><b>陷阱（已踩）：</b>不能用第二个 {@code @TempDir} 当「工作区外」——JUnit 把
     * TempDir 建在 {@code java.io.tmpdir} 下，那事实上就是系统临时目录，判定为 true 才是对的。
     * 所以这里必须在临时目录之外造一个真实目录。用系统盘盘符根构造即可（不写入）。</p>
     */
    @Test
    void doesNotSilenceWritesOutsideWorkspaceButNotTemp(@TempDir Path root) {
        Path outside = Path.of(System.getProperty("java.io.tmpdir"))
                .toAbsolutePath().normalize().getParent().resolve("gwork-other-project-NOTTEMP")
                .resolve("Service.java");
        // 前置自检：这个样本必须真的不在临时目录下，否则下面的断言测的就是空气
        assertFalse(EphemeralPaths.isSystemTemp(outside), "夹具本身必须不在系统临时目录内");
        assertFalse(EphemeralPaths.isEphemeralTarget(root, outside.toString()),
                "工作区外且非临时目录的路径不得被静音");
    }

    /** 逻辑挂载路径交给原有的严格校验去处理，本类不得替它下结论。 */
    @Test
    void leavesLogicalPathsToExistingValidation(@TempDir Path root) {
        assertFalse(EphemeralPaths.isEphemeralTarget(root, "@alias/some/file.java"));
        assertFalse(EphemeralPaths.isEphemeralTarget(root, "~/notes.md"));
        assertFalse(EphemeralPaths.isEphemeralTarget(root, null));
    }

    // ================== 以下四组均为复审探针抓出的真实缺陷回归 ==================

    /**
     * 【缺陷 1】裸前缀 {@code tmp-} / {@code temp-} 在任意层级都会误杀真实源码目录。
     *
     * <p>旧实现把 {@code tmp-}、{@code temp-} 与 {@code .tmp-} 混在同一个数组里全层级生效，
     * 于是 {@code src/tmp-utils/Helper.java}、{@code src/tmp-guide.md}、
     * {@code docs/temp-notes.md} 全部被当成临时产物——用户会看不到也撤销不了自己的真实文件。
     * 带点的 {@code .tmp-*} 不受影响（它语义上必然是工具鬼次区）。</p>
     */
    @Test
    void bareTempPrefixesOnlyApplyAtWorkspaceRoot() {
        // 误杀样本：必须全部为 false
        assertFalse(EphemeralPaths.isEphemeralRelative("src/tmp-utils/Helper.java"), "深层 tmp-utils 目录");
        assertFalse(EphemeralPaths.isEphemeralRelative("src/tmp-guide.md"), "名为 tmp-guide.md 的文件");
        assertFalse(EphemeralPaths.isEphemeralRelative("docs/temp-notes.md"), "深层 temp-notes.md");
        assertFalse(EphemeralPaths.isEphemeralRelative("src/main/java/com/demo/tmp-cache/Foo.java"), "深层 tmp-cache 目录");

        // 根一级仍必须生效（不能把功能一起删了）
        assertTrue(EphemeralPaths.isEphemeralRelative("tmp-1749000000/probe.js"), "根一级 tmp-<时间戳>");
        assertTrue(EphemeralPaths.isEphemeralRelative("temp-build/x.log"), "根一级 temp-build");
        // 带点前缀仍然全层级生效
        assertTrue(EphemeralPaths.isEphemeralRelative("src/.tmp-1749/x.js"), ".tmp-* 不受层级限制");
    }

    /**
     * 【缺陷 2】末段是文件名，不得按目录名单判。
     *
     * <p>入参是文件路径，所以 {@code scripts/build} 只是「有个文件叫 build」。
     * 旧实现一刀切段匹配，把 {@code scripts/build}、{@code bin/vendor} 误杀。
     * 末尾带 {@code /} 时末段才是目录名，此时仍应生效。</p>
     */
    @Test
    void lastSegmentIsTreatedAsFileNameNotDirectory() {
        assertFalse(EphemeralPaths.isEphemeralRelative("scripts/build"), "名为 build 的无扩展名文件");
        assertFalse(EphemeralPaths.isEphemeralRelative("bin/vendor"), "名为 vendor 的无扩展名文件");
        assertFalse(EphemeralPaths.isEphemeralRelative("tools/target"), "名为 target 的无扩展名文件");

        // 作为目录（非末段，或显式带尾斜杠）仍必须生效
        assertTrue(EphemeralPaths.isEphemeralRelative("build/out.js"), "build 作为目录段");
        assertTrue(EphemeralPaths.isEphemeralRelative("build/"), "显式目录尾斜杠");
        assertTrue(EphemeralPaths.isEphemeralRelative("vendor/lib/x.js"), "vendor 作为目录段");
    }

    /**
     * 【缺陷 3】含 {@code ..} 的路径必须先规范化再判段。
     *
     * <p>旧实现直接跳过 {@code .}/{@code ..} 段，导致两个相反的错误：<br>
     * ① {@code ../tmp/evil.js}（工作区<b>之外</b>）被当成「根一级 tmp」而静音——
     *    真正的越界写入反而比普通越界更安静，把安全提示也抹了；<br>
     * ② {@code src/../tmp/probe.js} 规范化后就是根级 tmp，旧实现却因先看到 {@code src} 而漏过滤。</p>
     */
    @Test
    void dotDotIsNormalizedBeforeSegmentMatching() {
        // 越出工作区根：交给 validateRelativePath 报越界，本类不得静音
        assertFalse(EphemeralPaths.isEphemeralRelative("../tmp/evil.js"), "越界到同级 tmp/ 不得静音");
        assertFalse(EphemeralPaths.isEphemeralRelative("../../tmp/evil.js"), "越界两级不得静音");
        assertFalse(EphemeralPaths.isEphemeralRelative("../src/A.java"), "普通越界仍走原逻辑");

        // 越界后又回到工作区内：规范化后正确命中
        assertTrue(EphemeralPaths.isEphemeralRelative("src/../tmp/probe.js"), "规范化后是根级 tmp");
        assertTrue(EphemeralPaths.isEphemeralRelative("src/a/../../.tmp/x.js"), "规范化后是根级 .tmp");
    }

    /**
     * 【缺陷 4】Windows 上 {@code Path.of("/tmp")} 不是绝对路径。
     *
     * <p>{@code toAbsolutePath()} 会把它拼成<b>当前盘符</b>下的 {@code D:\tmp}。
     * 本机 {@code D:\tmp} 确实存在（且很可能就是用户放真实文件的地方），
     * 于是「系统临时目录」判定会把该目录下的一切静音，且结果随进程当前目录漂移。</p>
     *
     * <p>断言方式：只要当前平台是 Windows（{@code /tmp} 非绝对），
     * 则 {@code <当前盘>/tmp/x} 必须<b>不</b>被当成系统临时目录。</p>
     */
    @Test
    void relativePosixTempCandidatesAreIgnoredOnWindows() {
        Path posixTmp = Path.of("/tmp");
        if (posixTmp.isAbsolute()) {
            // POSIX 平台：/tmp 本来就是绝对路径，本用例不适用
            return;
        }
        Path driveTmp = posixTmp.toAbsolutePath().normalize();
        assertFalse(EphemeralPaths.isSystemTemp(driveTmp),
                "Windows 上以 '/' 开头的相对候选会被解析成 " + driveTmp + "，那是当前盘符下的普通目录，不是系统临时目录");
    }
}
