package com.gourdai.harness.hitl;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * bash 写路径边界判定的行为契约。
 *
 * <p>本类锁定的核心安全承诺：<b>默认档下，bash 不得静默写到工作区之外</b>。
 * 此前该承诺在全仓零覆盖——bash 只有「杀宿主进程 / exit / 根目录删除」三条红线，
 * 路径概念完全不存在，{@code Set-Content D:\其他项目\x.txt} 这类命令可以直接执行成功。</p>
 *
 * <p>断言分两组，两组都必须成立，否则护栏没有意义：</p>
 * <ul>
 *   <li>{@code mustBlock}：越界<b>写</b>必须被识别（安全底线，漏一个就是一个洞）；</li>
 *   <li>{@code mustRelease}：界内写、构建缓存、无害形态必须放行
 *       （误拦会让审批退化成连点，而连点的审批等于没有审批）。</li>
 * </ul>
 *
 * <p><b>「读也拦」口径生效后</b>，越界<b>读</b>同样必须被识别（{@code mustBlockRead}），
 * 且两者都命中时报写（{@code mustBlockWrite}）。上面这段旧描述曾把「越界读」列进
 * mustRelease 组——那是口径变更前的契约，留着会与新用例自相矛盾。</p>
 *
 * <p>另有一组<b>结构护栏</b>（{@code verbTablesHaveNoDuplicateKeys}）：动词表是手写的大表，
 * 同键重复 {@code m.put} 会被 {@code HashMap} 静默覆盖，编译不报、行为用例也可能全绿，
 * 只有扫源码才能发现。本仓已实证过一例（select-string / sls 的 SKIP_FIRST_ALL
 * 被后写的 Mode.ALL 覆盖，导致 pattern 被当成检索目标）。</p>
 *
 * <ul>
 * </ul>
 *
 * <h3>为什么工作区不用 {@code @TempDir}</h3>
 *
 * <p>{@code java.io.tmpdir} 本身在内置豁免清单里（编译器与构建工具必须能写临时目录）。
 * 若把工作区建在临时目录下，则「工作区外」的目标往往仍落在临时目录<b>内</b>，
 * 会被豁免规则放行——测试将恒绿而护栏实际无效。故工作区建在模块 {@code target/} 下，
 * 该位置既不是临时目录也不在任何豁免项中。</p>
 */
class BashPathGuardTest {

    /** 工作区根（测试专用，真实创建于 target/ 下）。 */
    private static Path workspace;

    /** 工作区之外的目录（与 workspace 同级但不同目录）。 */
    private static Path outside;

    /** 承载上述两者的临时基准目录，测试结束后清理。 */
    private static Path holder;

    @BeforeAll
    static void createDirs() throws IOException {
        Path base = Paths.get("").toAbsolutePath();
        holder = base.resolve("target").resolve("bpg-test-" + System.nanoTime());
        workspace = holder.resolve("ws");
        outside = holder.resolve("outside");
        Files.createDirectories(workspace.resolve("src"));
        Files.createDirectories(outside);
    }

    @AfterAll
    static void removeDirs() {
        deleteQuietly(holder);
    }

    private static void deleteQuietly(Path p) {
        if (p == null) {
            return;
        }
        try {
            if (Files.isDirectory(p)) {
                try (var stream = Files.list(p)) {
                    for (Path child : stream.toList()) {
                        deleteQuietly(child);
                    }
                }
            }
            Files.deleteIfExists(p);
        } catch (IOException ignored) {
            // 清理失败不影响判定
        }
    }

    // ==========================================================================
    // 断言辅助
    // ==========================================================================

    private BashPathGuard.Violation inspect(String command) {
        return BashPathGuard.inspect(command, workspace, null);
    }

    private void mustBlock(String command) {
        BashPathGuard.Violation v = inspect(command);
        Assertions.assertNotNull(v,
                "越界写必须被识别，否则默认档的空间边界承诺落空： " + command);
    }

    /** 断言被拦<b>且报为写</b>（写优先：两者都命中时必须报写）。 */
    private void mustBlockWrite(String command) {
        BashPathGuard.Violation v = inspect(command);
        Assertions.assertNotNull(v, "越界写必须被识别： " + command);
        Assertions.assertTrue(v.isWrite(),
                "该命中应报为写（isWrite=true），否则用户会低估风险： " + command + "  => " + v);
    }

    /** 断言被拦<b>且报为读</b>（读拦截口径，用户拍板）。 */
    private void mustBlockRead(String command) {
        BashPathGuard.Violation v = inspect(command);
        Assertions.assertNotNull(v, "越界读必须被识别： " + command);
        Assertions.assertFalse(v.isWrite(),
                "该命中应报为读（isWrite=false），不得把可撤销的读误报成不可逆的写： " + command + "  => " + v);
    }

    private void mustRelease(String command) {
        BashPathGuard.Violation v = inspect(command);
        Assertions.assertNull(v,
                "该命令不应触发越界判定（误拦会让审批退化成连点）： " + command
                        + (v == null ? "" : "  => " + v));
    }

    /** 工作区外的绝对路径（按平台用反斜杠或正斜杠书写）。 */
    private String out(String rel) {
        return outside.resolve(rel).toString();
    }

    /**
     * 工作区外路径的<b>纯字符串</b>拼接（不经 {@link Path#resolve}）。
     *
     * <p>专供含通配符的目标使用：{@code *} / {@code ?} 是 Windows 的非法路径字符，
     * {@code outside.resolve("*")} 会抛 {@code InvalidPathException}。本方法只做字符串拼接，
     * 因为护栏吃的是命令文本、并不需要路径真的存在。</p>
     */
    private String outStr(String rel) {
        return outside + java.io.File.separator + rel;
    }

    // ==========================================================================
    // A. 越界写必拦
    // ==========================================================================

    @Test
    void blocksPowerShellWritesOutsideWorkspace() {
        mustBlock("Set-Content -Path " + out("x.txt") + " -Value hello");
        mustBlock("Set-Content " + out("y.txt") + " hello");
        mustBlock("Add-Content -Path " + out("log.txt") + " -Value line");
        mustBlock("Out-File -FilePath " + out("o.txt"));
        mustBlock("New-Item -Path " + out("newdir") + " -ItemType Directory");
        mustBlock("Remove-Item -Path " + out("f.txt") + " -Force");
        mustBlock("Remove-Item -Recurse -Force " + out("tree"));
        mustBlock("Copy-Item src\\a.txt -Destination " + out("a.txt"));
        mustBlock("Move-Item a.txt " + out("b.txt"));
        mustBlock("Rename-Item -Path " + out("a.txt") + " -NewName b.txt");
    }

    @Test
    void blocksUnixStyleWritesOutsideWorkspace() {
        mustBlock("rm -rf " + out("tree"));
        mustBlock("cp src/a.txt " + out("a.txt"));
        mustBlock("mv a.txt " + out("b.txt"));
        mustBlock("mkdir " + out("d"));
        mustBlock("touch " + out("t"));
        mustBlock("tee " + out("t.txt"));
        mustBlock("dd if=/dev/zero of=" + out("img.bin"));
        mustBlock("sed -i s/a/b/ " + out("f.txt"));
        mustBlock("truncate -s 0 " + out("f.txt"));
    }

    @Test
    void blocksEscapingViaParentDirectory() {
        // 相对路径向上跳出工作区：这是最容易被忽略的形态（不含盘符、看着像界内操作）
        mustBlock("rm -rf ../" + workspace.getFileName() + "-sibling");
        mustBlock("cp a.txt ../../escape.txt");
        mustBlock("echo x > ../outside.txt");
        mustBlock("Set-Content ..\\..\\f.txt x");
    }

    @Test
    void blocksRedirectionRegardlessOfVerb() {
        // 重定向是最强的写信号，与动词无关：动词表里没有的程序也能借它越界写
        mustBlock("echo hacked > " + out("x.txt"));
        mustBlock("echo hacked >> " + out("x.txt"));
        mustBlock("node build.js > " + out("log.txt"));
        mustBlock("mvn test 2> " + out("err.txt"));
        mustBlock("Get-Process | Out-File " + out("p.txt"));
    }

    @Test
    void blocksWritesHiddenInsideShellWrappers() {
        // 不展开包装器就是一个绕过口子：命令文本被藏进字符串参数
        mustBlock("sh -c \"rm -rf " + out("tree").replace("\\", "/") + "\"");
        mustBlock("bash -c 'echo x > " + out("f.txt").replace("\\", "/") + "'");
        mustBlock("powershell -Command \"Set-Content " + out("y.txt").replace("\\", "/") + " x\"");
        mustBlock("cmd /c echo x > " + out("c.txt"));
        mustBlock("sudo tee " + out("hosts"));
        mustBlock("wsl -d Ubuntu rm -rf " + out("tree").replace("\\", "/"));
        mustBlock("nohup sh -c \"rm -rf " + out("t").replace("\\", "/") + "\" &");
    }

    @Test
    void blocksBase64EncodedPowerShellCommand() {
        // -EncodedCommand 是 Base64(UTF-16LE)，肉眼审不出内容，是最隐蔽的绕过形态
        String inner = "Set-Content -Path " + out("enc.txt") + " -Value pwned";
        String b64 = Base64.getEncoder().encodeToString(inner.getBytes(StandardCharsets.UTF_16LE));

        mustBlock("powershell -EncodedCommand " + b64);
        mustBlock("powershell -enc " + b64);
        mustBlock("pwsh -EncodedCommand " + b64);
    }

    @Test
    void blocksDotNetStaticWriteCalls() {
        // .NET 静态方法直调不含任何 cmdlet 名，动词表完全看不到它，但它是真实的写操作
        mustBlock("[System.IO.File]::WriteAllText(\"" + out("z.txt").replace("\\", "/") + "\", \"x\")");
        mustBlock("[System.IO.File]::WriteAllBytes('" + out("z.bin").replace("\\", "/") + "', $b)");
        mustBlock("[System.IO.File]::Delete(\"" + out("z.txt").replace("\\", "/") + "\")");
        mustBlock("[System.IO.Directory]::CreateDirectory(\"" + out("d").replace("\\", "/") + "\")");
        mustBlock("[IO.File]::AppendAllText(\"" + out("a.txt").replace("\\", "/") + "\", $s)");
    }

    @Test
    void blocksArchiveAndDownloadTargetsOutside() {
        mustBlock("tar -czf " + out("x.tgz") + " src");
        mustBlock("tar --create --file " + out("x.tgz") + " src");
        mustBlock("tar -xzf src.tgz -C " + out("dest"));
        mustBlock("curl -o " + out("dl.bin") + " http://x/y");
        mustBlock("wget -O " + out("dl.bin") + " http://x/y");
        mustBlock("zip " + out("a.zip") + " src");
        mustBlock("unzip -d " + out("dest") + " pkg.zip");
        mustBlock("7z a " + out("a.7z") + " src");
        mustBlock("robocopy src " + out("backup") + " /E");
        mustBlock("Compress-Archive -Path src -DestinationPath " + out("a.zip"));
    }

    @Test
    void blocksWritesIntoUserDataUnderHome() {
        // 家目录下的用户数据区不是缓存，写它必须审批（缓存豁免不覆盖这些）
        mustBlock("Set-Content ~/Documents/notes.txt x");
        mustBlock("echo x > ~/.ssh/authorized_keys");
        mustBlock("rm -rf ~/.aws");
        mustBlock("mkdir ~/Desktop/d");
        mustBlock("echo x > $HOME/f.txt");
    }

    @Test
    void blocksAfterCdChangesRelativeBase() {
        // 基准必须跨段维护：cd 之后的相对路径要按新基准判定，否则整类命令漏判
        mustBlock("cd " + out("") + "; Set-Content f.txt x");
        mustBlock("Set-Location " + out("") + "; echo x > f.txt");
        mustBlock("pushd " + out("") + "; New-Item f.txt -ItemType File");
        mustBlock("cd " + out("") + " && rm -rf .");
    }

    // ==========================================================================
    // B. 必须放行
    // ==========================================================================

    @Test
    void releasesWritesInsideWorkspace() {
        mustRelease("Set-Content -Path ./x.txt -Value hello");
        mustRelease("Set-Content src/a.txt hello");
        mustRelease("echo ok > build/out.txt");
        mustRelease("rm -rf target");
        mustRelease("Remove-Item -Recurse -Force target");
        mustRelease("mkdir -p build/out");
        mustRelease("mv a.txt b.txt");
        mustRelease("cp -r src dst");
        mustRelease("tee .tmp/out.txt");
        mustRelease("[System.IO.File]::WriteAllText(\"./x.txt\", \"v\")");
        mustRelease("tar -czf dist/app.tgz src");
        mustRelease("curl -o .tmp/dl.bin http://x/y");
    }

    /**
     * 越界<b>读</b>现在也拦——用户拍板的口径（原为「只拦写」）。
     *
     * <p>读虽然可撤销，但会把工作区外的文件内容带进模型上下文（可能含敏感信息），
     * 用户明确要求默认档下读写工作区外都需审批。故本组从「放行」反转为「拦截」，
     * 且必须报为<b>读</b>（isWrite=false），以便审批文案区分读/写的严重程度。</p>
     *
     * <p><b>远程 URL 仍放行</b>：{@code curl https://...}、{@code wget http://...} 的目标是网络地址
     * 而非本地路径，不属于「工作区外目录」的范畴；且下载器不带 {@code -o} 时落盘在当前目录（界内）。</p>
     */
    @Test
    void blocksReadsOutsideWorkspace() {
        mustBlockRead("cat /etc/os-release");
        mustBlockRead("Get-Content " + out("secret.txt"));
        mustBlockRead("type " + out("f.txt"));
        mustBlockRead("grep -r foo /usr/share");
        mustBlockRead("Select-String -Path " + out("f.txt") + " -Pattern x");
        mustBlockRead("ls " + out(""));
        mustBlockRead("dir " + out(""));
        mustBlockRead("Get-ChildItem " + out(""));
        mustBlockRead("find /usr -name foo");
        mustBlockRead("head -20 " + out("f.txt"));
        mustBlockRead("powershell -Command \"Get-Content " + out("y.txt").replace("\\", "/") + "\"");
        mustBlockRead("[System.IO.File]::ReadAllText(\"" + out("z.txt").replace("\\", "/") + "\")");
        mustBlockRead("tar -tzf " + out("a.tgz"));
        mustBlockRead("unzip -l " + out("pkg.zip"));

        // 远程 URL 不是本地路径，仍放行
        mustRelease("curl -s https://example.com/api");
        mustRelease("wget http://x/y.tar.gz");
    }

    /**
     * 构建 / 包管理缓存必须豁免：写它们是工具链的正常行为，不豁免会让默认档下
     * 几乎每次构建都弹审批。
     */
    @Test
    void releasesBuildCacheDirectories() {
        mustRelease("rm -rf ~/.m2/repository/org/x");
        mustRelease("mkdir ~/.gradle/caches/tmp");
        mustRelease("Set-Content ~/.npm/_logs/x.txt hi");
        mustRelease("echo x > ~/.cache/probe.txt");
        mustRelease("rm -rf ~/.cargo/registry/cache");
        mustRelease("mkdir ~/.nuget/packages/x");
        mustRelease("mvn install");
        mustRelease("npm install -g typescript");
        mustRelease("cargo install ripgrep");
        mustRelease("pip install --user requests");
        mustRelease("rm -rf " + System.getProperty("java.io.tmpdir").replace("\\", "/") + "/probe-dir");
        mustRelease("echo x > " + System.getProperty("java.io.tmpdir").replace("\\", "/") + "/probe.txt");
    }

    /**
     * 无害形态不得误报。
     *
     * <p>{@code /s}、{@code /q} 这类 CMD 短选项尤其关键：Windows 上 {@code Paths.get("/s")}
     * 不是绝对路径（缺盘符），会被解析成当前盘符根的 {@code \s}，
     * 于是 {@code rd /s /q build} 会误报「越界写 D:\s」。</p>
     */
    @Test
    void releasesHarmlessFormsThatLookLikePaths() {
        mustRelease("rd /s /q build\\out");
        mustRelease("del /f /q target\\*");
        mustRelease("copy /y a.txt b.txt");
        mustRelease("robocopy src dst /E /NFL /NDL /NJH /NJS");
        mustRelease("echo x > /dev/null");
        mustRelease("cmd 2>&1");
        mustRelease("grep foo bar 2>/dev/null");
        mustRelease("Set-Item HKLM:\\SOFTWARE\\X -Value 1");
        mustRelease("Set-Item Env:FOO -Value bar");
        mustRelease("New-Item -Path Cert:\\CurrentUser\\My -ItemType x");
        mustRelease("Remove-Item -Path *.tmp -Force");
        mustRelease("Get-ChildItem src | Where-Object { $_.Name -eq 'x' }");
        mustRelease("git status");
        mustRelease("git add -A ; git commit -m \"fix: bug\"");
        mustRelease("git push origin main");
        mustRelease("tasklist | findstr node");
    }

    /**
     * 值不是路径的命名参数不得被当写目标判定。
     *
     * <p>{@code -Value "D:\other\notapath.txt"} 里的内容是<b>要写进文件的文本</b>，
     * 不是目标路径。若把 -Value 的值送进边界判定，命令内容就会决定审批结果——
     * 这既误拦又泄漏语义。</p>
     */
    @Test
    void releasesNonPathParameterValues() {
        mustRelease("Set-Content -Path x.txt -Value \"" + out("notapath.txt") + "\"");
        mustRelease("Set-Content -Path x.txt -Encoding UTF8");
        mustRelease("Out-File -FilePath out.txt -Encoding utf8 -Width 200");
        mustRelease("New-Item -Path x.txt -ItemType File -Value " + out("v"));
        mustRelease("Write-Host " + out("justtext"));
        mustRelease("echo " + out("justtext"));
    }

    /**
     * 不可判定的目标必须放行而非拦截。
     *
     * <p>路径依赖运行期变量值或含通配时，本层看不到真实目标；此时拦住会产生
     * 用户无法解释、批准了也不知道会写到哪的审批卡。这是已声明的能力边界。</p>
     */
    @Test
    void releasesUnjudgeableTargets() {
        mustRelease("d=\"" + out("") + "\"; Set-Content \"$d/f.txt\" x");
        mustRelease("Set-Content $target x");
        mustRelease("Remove-Item $env:SOMEDIR_UNSET_PROBE\\f.txt");
        mustRelease("Remove-Item %SOMEDIR_UNSET_PROBE%\\f.txt");
        mustRelease("Get-ChildItem -Recurse | Remove-Item");
    }

    /**
     * 环境变量<b>能</b>解析时必须展开并正常判定。
     *
     * <p>这是上一条的反向护栏，两者必须同时成立：若把「查不到就放行」过度实现成
     * 「所有 {@code $env:} / {@code %VAR%} 都放行」，那么 {@code $env:USERPROFILE\Documents\x.txt}
     * 就是一个彻底的绕过口——而它是 PowerShell 下最常见的绝对路径写法之一。</p>
     *
     * <p>环境变量名跨平台不同（Windows {@code USERPROFILE} / Unix {@code HOME}），
     * 故按可用性选取；两者都缺失时用 assumeTrue 跳过而不是失败（不是护栏缺陷，是环境不具备）。
     * 同理，若工作区本身就建在家目录下，则该目标并不越界，同样跳过。</p>
     */
    @Test
    void expandsResolvableEnvironmentVariables() {
        String varName = System.getenv("USERPROFILE") != null ? "USERPROFILE"
                : (System.getenv("HOME") != null ? "HOME" : null);
        Assertions.assertNotNull(varName, "测试环境需至少有 USERPROFILE 或 HOME 环境变量");

        Path homePath = Paths.get(System.getenv(varName)).toAbsolutePath().normalize();
        String target = homePath.resolve("bpg-probe-outside.txt").toString();
        org.junit.jupiter.api.Assumptions.assumeFalse(target.startsWith(workspace.toString()),
                "工作区建在家目录下，该目标并不越界，无法用于本断言");
        org.junit.jupiter.api.Assumptions.assumeFalse(isExempt(homePath),
                "家目录本身落在豁免清单内，无法用于本断言");

        // PowerShell 形态
        BashPathGuard.Violation ps = inspect("Set-Content $env:" + varName + "\\bpg-probe-outside.txt x");
        Assertions.assertNotNull(ps, "$env:" + varName + " 可解析，必须展开并判定为越界写");
        Assertions.assertTrue(ps.target().contains("bpg-probe-outside.txt"),
                "展开后的目标必须保留文件名段： " + ps.target());

        // CMD 形态
        BashPathGuard.Violation cmd = inspect("copy a.txt %" + varName + "%\\bpg-probe-outside.txt");
        Assertions.assertNotNull(cmd, "%" + varName + "% 可解析，必须展开并判定为越界写");

        // 同一变量下的构建缓存仍必须豁免（展开正确 + 豁免生效，两者同时成立）
        mustRelease("Set-Content $env:" + varName + "\\.m2\\repository\\x.txt x");
    }

    /**
     * 判定路径本身是否落在豁免清单内。
     *
     * <p>只看「路径在豁免目录下」（{@code p.startsWith(ex)}），不能反过来：
     * 家目录 {@code C:\Users\x} 下确实含有 {@code AppData\Local\Temp} 这类豁免项，
     * 但那是<b>子目录</b>被豁免，不代表家目录本身被豁免。若用 {@code ex.startsWith(p)}
     * 则家目录会被误判为豁免，使本测试被 assume 跳过——而跳过的恰恰是
     * 「环境变量可解析时必须展开并判定」这条最关键的反向护栏，形成假绿。</p>
     */
    private boolean isExempt(Path p) {
        for (Path ex : BashPathGuard.defaultExemptRoots()) {
            if (p.startsWith(ex)) {
                return true;
            }
        }
        return false;
    }

    /**
     * sed/find 的写旗标门控：不带写旗标时是纯读，带旗标时才写。
     *
     * <p>本用例验证的是 gateFlag / gateAbsent 这对相反语义：同一个动词在两趟扫描里
     * 归属不同。<b>在工作区内</b>的文件上，不带旗标时读写两趟都不命中（放行）；
     * <b>在工作区外</b>的文件上，不带旗标归读趟（报读），带旗标归写趟（报写）。</p>
     */
    @Test
    void sedAndFindGateOnWriteFlag() {
        // 界内：不带写旗标 → 读写两趟都不命中
        mustRelease("sed s/a/b/ src/x.txt");
        mustRelease("find . -name foo");
        // 界内：带写旗标会写文件，但目标在界内→ 仍放行
        mustRelease("sed -i s/a/b/ src/x.txt");

        // 界外：不带写旗标 → 归读趟，报为读
        mustBlockRead("sed -n 1,10p " + out("f.txt"));
        mustBlockRead("find " + out("") + " -name foo");
        // 界外：带写旗标 → 归写趟，报为写（写优先）
        mustBlockWrite("sed -i s/a/b/ " + out("f.txt"));
        mustBlockWrite("find " + out("") + " -name foo -delete");
    }

    // ==========================================================================
    // A2. 越界读必拦（用户拍板口径）
    // ==========================================================================

    /**
     * 读动词表：各类读命令的越界读都要拦，且报为读。
     *
     * <p>覆盖三方言（Unix / CMD / PowerShell）与别名，任一方言的读动词漏登记
     * 就是一个静默的越界读口子。</p>
     */
    @Test
    void blocksReadVerbsAcrossDialects() {
        mustBlockRead("cat " + out("a.txt"));
        mustBlockRead("head -20 " + out("a.txt"));
        mustBlockRead("tail -5 " + out("a.log"));
        mustBlockRead("less " + out("a.txt"));
        mustBlockRead("wc -l " + out("a.txt"));
        mustBlockRead("diff " + out("a.txt") + " b.txt");
        mustBlockRead("type " + out("a.txt"));            // CMD
        mustBlockRead("Get-Content " + out("a.txt"));     // PowerShell
        mustBlockRead("gc " + out("a.txt"));              // PS 别名
        mustBlockRead("Get-ChildItem " + out(""));
        mustBlockRead("ls " + out(""));
        mustBlockRead("dir " + out(""));
    }

    /**
     * SKIP_FIRST_ALL：grep/sed/awk 的<b>首个位置参数是 pattern / 脚本正文</b>，不是路径。
     *
     * <p>这是读改造里最容易出错的一处：若用 Mode.ALL，pattern 会被当路径送进判定。
     * 危险形态是 {@code grep "D:\out\x" 界内文件} ——pattern 长得像绝对路径，
     * 会被误报「读了 D:\out\x」，而真实读的是界内文件。本用例锁两头：
     * pattern 像路径但文件在界内 → 放行；文件在界外 → 拦。</p>
     */
    @Test
    void skipFirstPositionalForPatternCommands() {
        // pattern 像绝对路径，但被检索的文件在界内 → 不得误报
        mustRelease("grep \"" + out("x.txt") + "\" src/a.txt");
        mustRelease("grep -rn \"" + out("") + "\" ./src");
        mustRelease("sed \"s|" + out("a") + "|b|\" src/a.txt");
        mustRelease("awk '{print \"" + out("") + "\"}' data.csv");

        // 被检索的文件在界外 → 拦（pattern 本身不参与判定）
        mustBlockRead("grep foo " + out("a.txt"));
        mustBlockRead("grep -rn TODO " + out(""));
        mustBlockRead("findstr foo " + out("a.txt"));
        mustBlockRead("Select-String -Path " + out("a.txt") + " -Pattern foo");
    }

    /**
     * .NET 静态读方法直调：不含任何 cmdlet 名，动词表看不到，但确实是读。
     *
     * <p>与写侧对称。注意 {@code File.Open}/{@code OpenRead} 这类模棱两可的方法
     * 被归入写侧（宁可把可能的读当写拦，不可把可能的写当读放），
     * 故此处只断言明确是读的方法。</p>
     */
    @Test
    void blocksDotNetReadCalls() {
        String p = out("z.txt").replace("\\", "/");
        mustBlockRead("[System.IO.File]::ReadAllText(\"" + p + "\")");
        mustBlockRead("[System.IO.File]::ReadAllBytes(\"" + p + "\")");
        mustBlockRead("[System.IO.File]::ReadAllLines('" + p + "')");
        mustBlockRead("[IO.File]::Exists(\"" + p + "\")");
        mustBlockRead("[System.IO.Directory]::GetFiles(\"" + out("").replace("\\", "/") + "\")");
        // 界内读必须放行
        mustRelease("[System.IO.File]::ReadAllText(\"./x.txt\")");
    }

    /**
     * dd if=（读源）、tar -f（解压/查看时读归档）、REDIR_IN(&lt;) 三条专属读形态。
     *
     * <p>这三条都不是「动词 + 位置参数」的常规形态，各有专属提取逻辑，
     * 任何一条漏了都是一个越界读口子。</p>
     */
    @Test
    void blocksSpecialReadForms() {
        // dd：if= 是读源，of= 是写目标；同一命令两者都越界时写优先
        mustBlockRead("dd if=" + out("disk.img") + " of=./local.img");
        mustBlockWrite("dd if=./local.img of=" + out("disk.img"));

        // tar：解压/查看模式下 -f 指向的归档是被读的源
        mustBlockRead("tar -tf " + out("a.tgz"));
        mustBlockRead("tar -xzf " + out("a.tgz") + " -C ./extracted");

        // 输入重定向 <
        mustBlockRead("sort < " + out("input.txt"));
        mustBlockRead("wc -l < " + out("input.txt"));
        // 界内输入重定向放行
        mustRelease("sort < ./input.txt");
    }

    /**
     * REDIR_IN（{@code <}）必须<b>独立于动词表</b>生效。
     *
     * <p>为什么要单独锁这一条：{@code sort}、{@code wc} 这类命令<b>本身就在读动词表里</b>，
     * 所以 {@code sort < 外部文件} 即使用重定向检查完全失效，也会被动词表的位置参数判定拦住——
     * 实测证据：变异把 {@code wantKind} 钉死为 REDIR_OUT（读趟不再查 {@code <}），
     * 上面那些断言<b>全部照旧绿</b>。那是典型的「测试通过但原因是错的」假绿。</p>
     *
     * <p>故本用例只用<b>不在任何动词表里</b>的命令，并在断言前自证该动词确实不在表中——
     * 这样命中就只可能来自 REDIR_IN 检查本身。将来有人往读表里加了这些动词，
     * 自证断言会先红，提醒把本用例换成另一个未登记的动词，而不是静默退化成假绿。</p>
     */
    @Test
    void blocksInputRedirectionIndependentlyOfVerbTable() {
        // psql/sqlite3/jq 都是真实会用到 `cmd < file` 形态、但未登记进读写动词表的命令
        for (String verb : List.of("psql", "sqlite3", "jq")) {
            Assertions.assertFalse(BashPathGuard.knownReadVerbsForTest().contains(verb),
                    verb + " 已被登记进读动词表，本用例失去意义：请换成一个未登记的动词，"
                            + "否则命中的是动词表而不是 REDIR_IN 检查（会退化成假绿）");
            Assertions.assertFalse(BashPathGuard.knownWriteVerbsForTest().contains(verb),
                    verb + " 已被登记进写动词表，同上");
        }

        mustBlockRead("psql -U u db < " + out("dump.sql"));
        mustBlockRead("sqlite3 db.sqlite < " + out("schema.sql"));
        mustBlockRead("jq . " + "< " + out("data.json"));

        // 界内重定向仍放行
        mustRelease("psql -U u db < ./dump.sql");
        mustRelease("jq . < ./data.json");
    }

    /**
     * 读优先级的反向护栏：读写都命中时必须报写，绝不能报读。
     *
     * <p>这是 inspect 两趟扫描的核心契约。若退化成单趟「谁先出现报谁」，
     * {@code cat 外部 > 外部} 会报成读，用户以为只是看一眼、随手批准，
     * 实际却覆盖了外部文件——把可撤销的读报成不可逆的写是低估，反之是高估，
     * 这里错的方向是「低估写风险」，更危险。</p>
     */
    @Test
    void writeTakesPriorityWhenBothHit() {
        mustBlockWrite("cat /etc/hosts > " + out("dump.txt"));
        mustBlockWrite("grep x " + out("a.txt") + " > " + out("b.txt"));
        // 读源在界外、写在界内：只有读命中 → 报读
        mustBlockRead("cat " + out("a.txt") + " > ./local.txt");
    }

    /**
     * 读改造最大的风险：正常工作流绝不能被误拦。
     *
     * <p>读的动词表远大于写，一旦把 {@code mvn}、{@code npm}、{@code git} 这类
     * 高频命令也拖进来，默认档就没法干活了，审批退化成连点——而连点的审批等于没有审批。
     * 这些命令读取工作区外文件（依赖仓库、全局 git 配置）发生在<b>被调进程内部</b>，
     * 路径不在命令行上，本层看不到也不该拦。</p>
     */
    @Test
    void doesNotOverBlockNormalWorkflows() {
        // 自证：下面这些高频命令确实没被登记进读动词表。
        // 它们读取工作区外文件（依赖仓库、全局 git 配置）发生在被调进程内部，
        // 路径不在命令行上，本层看不到也不该拦。一旦有人把它们加进表里，
        // 本断言会立刻红，而不是等到用户抱怨「默认档没法干活」才发现。
        for (String verb : List.of("mvn", "npm", "git", "cargo", "python", "node", "pip", "yarn", "pnpm")) {
            Assertions.assertFalse(BashPathGuard.knownReadVerbsForTest().contains(verb),
                    verb + " 不得进读动词表：它的外部读取发生在被调进程内部，"
                            + "登记它会让默认档下几乎每条构建/版本控制命令都弹审批，审批退化成连点");
            Assertions.assertFalse(BashPathGuard.knownWriteVerbsForTest().contains(verb),
                    verb + " 不得进写动词表（同上）");
        }

        mustRelease("mvn -o test");
        mustRelease("mvn clean install -DskipTests");
        mustRelease("npm install");
        mustRelease("npm run build");
        mustRelease("node src/index.js");
        mustRelease("python script.py");
        mustRelease("pip install -r requirements.txt");
        mustRelease("cargo build --release");
        mustRelease("git status");
        mustRelease("git add -A ; git commit -m \"fix\"");
        mustRelease("git log --oneline -20");
        mustRelease("git diff HEAD~1");
        // 界内读
        mustRelease("cat package.json");
        mustRelease("grep -rn TODO src/");
        mustRelease("grep foo ./a.txt ./b.txt");
        mustRelease("ls -la");
        mustRelease("ls src/main/java");
        mustRelease("head -5 pom.xml");
        mustRelease("tail -f logs/app.log");
        mustRelease("find . -name '*.java'");
        mustRelease("awk '{print $1}' data.csv");
        mustRelease("wc -l src/*.js");
        mustRelease("Get-Content ./config.json");
        mustRelease("Get-ChildItem -Recurse src");
        mustRelease("cat /dev/null");
        mustRelease("curl -s https://example.com/api");

        // ---- 高频命令带<b>工作区外绝对路径参数</b>时也不得拦 ----
        // 这一段是「过度拦截」护栏的真正牙齿所在。上面那些命令的参数全是相对路径
        //（如 `mvn -o test`），解析后落在界内，所以即使把 mvn/npm/git 误登记进读动词表
        // 也照样放行——实测变异 R8 正是这样存活的：护栏形同虚设。
        // 只有当参数是工作区外的绝对路径时，「该动词在不在读表里」才会真正影响结果。
        mustRelease("mvn -f " + out("pom.xml") + " test");
        mustRelease("npm --prefix " + out("pkg") + " install");
        mustRelease("git --git-dir=" + out("repo.git") + " status");
        mustRelease("cargo build --manifest-path " + out("Cargo.toml"));
        mustRelease("python " + out("helper.py"));
        mustRelease("node " + out("tool.js"));
        // 构建缓存读取豁免
        mustRelease("cat ~/.m2/settings.xml");
        mustRelease("ls ~/.gradle/caches");
        mustRelease("grep foo ~/.npm/_logs/x.txt");
    }

    /**
     * 读侧同样受豁免清单保护：豁免目录里的读不弹审批。
     *
     * <p>这条锁住「豁免对读写同时生效」——正是这个语义让我把配置项从
     * {@code bashWriteExemptDirs} 改名为 {@code bashExemptDirs}（旧名会是虚假承诺）。
     * 若将来有人把豁免改成只对写生效，本用例会红。</p>
     */
    @Test
    void exemptionAlsoAppliesToReads() {
        Path exemptDir = outside.resolve("exempt-read");
        String cmd = "Get-Content " + exemptDir.resolve("f.txt");

        Assertions.assertNotNull(inspect(cmd), "前置：未豁免时越界读应被拦");

        BashPathGuard.Violation exempted =
                BashPathGuard.inspect(cmd, workspace, List.of(exemptDir));
        Assertions.assertNull(exempted,
                "豁免目录内的读必须放行（豁免对读写同时生效，否则配置项名不副实）");
    }

    // ==========================================================================
    // C. 边界与契约细节
    // ==========================================================================

    @Test
    void distinguishesSiblingWithSameStringPrefix() {
        // D:\...\ws 与 D:\...\ws2：字符串前缀相同但不是父子关系。
        // 必须用 Path.startsWith 而非字符串前缀比较，否则 ws2 会被误判为界内。
        Path sibling = workspace.getParent().resolve(workspace.getFileName() + "2");
        mustBlock("echo x > " + sibling.resolve("f.txt"));
    }

    @Test
    void noVerdictWithoutWorkspaceRoot() {
        // 没有边界就无从谈「越界」。猜一个基准（如进程 user.dir）会把用户无关目录
        // 判成越界，制造无法解释的审批。故 workspaceRoot=null 时本类不做任何判定，
        // 由调用方决定 fail-safe 策略。
        Assertions.assertNull(BashPathGuard.inspect("Set-Content " + out("x.txt") + " y", null, null),
                "workspaceRoot 缺失时不得凭空造出边界");
    }

    @Test
    void noVerdictForEmptyCommand() {
        Assertions.assertNull(BashPathGuard.inspect(null, workspace, null));
        Assertions.assertNull(BashPathGuard.inspect("", workspace, null));
        Assertions.assertNull(BashPathGuard.inspect("   ", workspace, null));
    }

    @Test
    void userConfiguredExemptionIsHonoured() {
        String cmd = "Set-Content " + out("x.txt") + " y";

        Assertions.assertNotNull(inspect(cmd), "未配置豁免时该命令应被判定为越界写");
        Assertions.assertNull(BashPathGuard.inspect(cmd, workspace, Collections.singletonList(outside)),
                "用户显式豁免的目录不得再判越界（否则用户只能整档切到完全访问）");
    }

    @Test
    void reportsFirstViolationWithReadableDetail() {
        BashPathGuard.Violation v = inspect("Set-Content -Path " + out("x.txt") + " -Value hello");
        Assertions.assertNotNull(v);
        Assertions.assertTrue(v.target().length() > 0, "必须给出具体目标路径，否则用户无从判断");
        Assertions.assertTrue(v.verb().length() > 0, "必须给出触发形态，否则用户不知道哪个动作越界");
        Assertions.assertTrue(v.toString().contains(v.target()));
    }

    @Test
    void verbTableCoversBothDialectsAndAliases() {
        // 动词表意外收缩（如重构时漏掉某方言）会让护栏静默失效，故锁住关键项的存在
        var verbs = BashPathGuard.knownWriteVerbsForTest();
        for (String expected : List.of("rm", "del", "remove-item", "ri", "cp", "copy-item",
                "mv", "move-item", "mkdir", "md", "new-item", "set-content", "add-content",
                "out-file", "tee", "robocopy", "unzip", "sed", "touch", "rd", "rmdir")) {
            Assertions.assertTrue(verbs.contains(expected), "写动词表缺少关键项： " + expected);
        }
        // 歧义命令刻意排除：sc 既是 Set-Content 别名又是 Windows 服务控制程序
        Assertions.assertFalse(verbs.contains("sc"),
                "sc 有歧义（PS Set-Content 别名 / Windows 服务控制），收录会把 sc \\\\server 的 UNC 主机名误判为写目标");
    }

    /**
     * Windows 反斜杠路径必须被完整保留（回归护栏）。
     *
     * <p>反斜杠曾被无条件当作 Unix 转义符吃掉，使 {@code D:\other\x.txt} 变成
     * {@code D:otherx.txt} —— 它会被解析成<b>工作区内的相对路径</b>，于是越界写在 Windows 上
     * 100% 漏判。PowerShell / CMD 是本框架的主方言之一，这不是边缘情况。</p>
     *
     * <p>断言走公开 API 而非内部 token：如果反斜杠被吃，目标会落到界内而<b>不</b>被拦，
     * {@code mustBlock} 直接失败；再断言 {@code target()} 保留了原始路径结构
     * （含空格的路径未被破坏），以区分「恰好因别的原因拦下」的假绿。
     * 好处是内部词法实现可以自由重构，只要行为契约不变。</p>
     */
    @Test
    void windowsBackslashPathsAreNotMangled() {
        String plain = out("back\\x.txt");
        BashPathGuard.Violation v1 = inspect("Set-Content -Path " + plain + " -Value hello");
        Assertions.assertNotNull(v1, "裸写反斜杠路径的越界写必须被拦： " + plain);
        Assertions.assertTrue(v1.target().endsWith("x.txt"),
                "目标文件名必须原样保留（被吃掉反斜杠会变成 x.txt 粘在前一段后面）： " + v1.target());

        // 引号包裹 + 路径含空格：PowerShell 处理 Program Files 这类目录的常规写法。
        // PS 双引号内的转义符是反引号而不是反斜杠，故引号内同样不得吃反斜杠。
        String withSpaces = out("Program Files\\app\\x.txt");
        BashPathGuard.Violation v2 = inspect("Set-Content -Path \"" + withSpaces + "\" -Value hello");
        Assertions.assertNotNull(v2, "引号包裹且含空格的 Windows 路径必须被拦： " + withSpaces);
        Assertions.assertTrue(v2.target().contains("Program Files"),
                "含空格的路径必须保持完整，不得在空格处断开： " + v2.target());
        Assertions.assertTrue(v2.target().endsWith("x.txt"), "文件名段必须保留： " + v2.target());

        // 正斜杠与反斜杠在 Windows 上等价，两种写法都必须拦住（只认一种就是漏拦）
        mustBlock("Set-Content -Path " + out("fwd/x.txt").replace("\\", "/") + " -Value hello");
    }

    // ==========================================================================
    // D. 结构护栏：动词表自身的完整性（行为用例照不到的失效模式）
    // ==========================================================================

    /**
     * 动词表内<b>不得有重复键</b>。
     *
     * <p>{@code HashMap.put} 同键后写覆盖前写：编译器不报、运行不抛，
     * 而语义可能完全相反（本仓实证：{@code select-string} / {@code sls} 先按
     * {@code SKIP_FIRST_ALL} 登记、后被 PowerShell 块里的 {@code Mode.ALL} 覆盖，
     * 于是 pattern 被当成检索目标，界内检索误报越界读）。
     * 这类缺陷行为用例很容易全绿——除非恰好用例覆盖了两种模式的差异形态。</p>
     *
     * <p>按 {@code static} 块分组统计：{@code WRITE_RULES} 与 {@code READ_RULES}
     * 是两个独立的表，同名键（如 {@code sed}、{@code more}）在两表里都出现是<b>合法</b>的，
     * 只有同一张表内重复才是缺陷。</p>
     *
     * <p>同时断言「确实扫到了足够多的登记项」：若源码排版变化导致正则不再匹配，
     * dups 会恒为空而本用例变成假绿——这条自证断言就是防它。</p>
     */
    @Test
    void verbTablesHaveNoDuplicateKeys() throws IOException {
        List<String> lines = Files.readAllLines(sourceOf("BashPathGuard.java"), StandardCharsets.UTF_8);

        Pattern putPattern = Pattern.compile("^\\s*m\\.put\\(\"([^\"]+)\"");
        Set<String> blockKeys = new HashSet<>();
        List<String> dups = new ArrayList<>();
        int blocks = 0;
        int puts = 0;
        boolean inBlock = false;
        int blockStart = -1;

        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.matches("^ {4}static \\{$")) {
                inBlock = true;
                blockStart = i + 1;
                blocks++;
                blockKeys.clear();
                continue;
            }
            if (!inBlock) {
                continue;
            }
            if (line.matches("^ {4}\\}$")) {
                inBlock = false;
                continue;
            }
            Matcher m = putPattern.matcher(line);
            if (m.find()) {
                puts++;
                String key = m.group(1);
                if (!blockKeys.add(key)) {
                    dups.add(key + "@L" + (i + 1) + " (block@L" + blockStart + ")");
                }
            }
        }

        Assertions.assertTrue(dups.isEmpty(),
                "动词表存在重复键，后写会静默覆盖前写并改变判定语义： " + dups);
        Assertions.assertEquals(2, blocks, "应扫到 WRITE_RULES 与 READ_RULES 两个 static 块");
        Assertions.assertTrue(puts >= 100,
                "扫到的登记项过少（" + puts + "），说明源码排版变了、正则已失配 —— 本用例会退化成假绿");
    }

    /**
     * 读取被测源文件（双 cwd 兼容）。
     *
     * <p>surefire 的工作目录可能是仓库根，也可能是模块目录，两种都要能跑；
     * 找不到时直接 fail 而不是返回 null —— 静默跳过会让本护栏形同不存在。</p>
     */
    private static Path sourceOf(String fileName) {
        String rel = "src/main/java/com/gourdai/harness/hitl/" + fileName;
        Path direct = Paths.get(rel);
        if (Files.exists(direct)) {
            return direct;
        }
        Path fromRepoRoot = Paths.get("..").resolve(rel).normalize();
        Assertions.assertTrue(Files.exists(fromRepoRoot),
                "找不到被测源文件 " + fileName + "（模块目录与仓库根两种 cwd 都试过）");
        return fromRepoRoot;
    }

    /**
     * pattern / 脚本正文<b>不得</b>被当成读取目标（{@code SKIP_FIRST_ALL} 的行为护栏）。
     *
     * <p>{@code skipFirstPositionalForPatternCommands} 只覆盖了 grep / sed / awk 与
     * {@code Select-String -Path} 命名参数形态，恰好漏掉了「PowerShell 位置参数形态」——
     * 而 {@code select-string} / {@code sls} 的重复登记正是从这个缺口漏过去的：
     * 覆盖后它们按 {@code Mode.ALL} 判定，pattern 被当成检索目标。</p>
     *
     * <p>触发形态是真实存在的：在界内代码里检索一个界外路径字符串
     * （{@code Select-String "D:\logs\app.log" src/a.txt}）。命令完全无害，
     * 却会弹「读取工作区之外的路径」审批。</p>
     *
     * <p>末尾两条<b>反向断言</b>是必需的：只断言「放行」无法区分「pattern 没被当路径」
     * 与「Select-String 整个动词失效」。反向断言证明该动词仍在读表里且仍能拦界外目标。</p>
     */
    @Test
    void patternIsNotTreatedAsReadTarget() {
        String outsideAsPattern = out("log.txt").replace("\\", "/");

        // 检索目标全在界内，pattern 文本里含一个工作区外的绝对路径 -> 不得误拦
        mustRelease("Select-String \"" + outsideAsPattern + "\" src/a.txt");
        mustRelease("sls \"" + outsideAsPattern + "\" src/a.txt");
        mustRelease("Select-String -Pattern \"" + outsideAsPattern + "\" -Path src/a.txt");
        // 对照组：同一形态的 grep / findstr 一直是对的（证明差异来自 Select-String 自身）
        mustRelease("grep \"" + outsideAsPattern + "\" src/a.txt");
        mustRelease("findstr \"" + out("log.txt") + "\" src\\a.txt");

        // 反向：Select-String 仍必须能拦住真正的界外读取（否则上面的放行毫无意义）
        mustBlockRead("Select-String foo " + out("a.txt"));
        mustBlockRead("Select-String -Pattern foo -Path " + out("a.txt"));
        mustBlockRead("sls foo " + out("a.txt"));
        Assertions.assertTrue(BashPathGuard.knownReadVerbsForTest().contains("select-string"),
                "select-string 必须仍在读动词表里");
        Assertions.assertTrue(BashPathGuard.knownReadVerbsForTest().contains("sls"),
                "sls 必须仍在读动词表里");
    }

    // ==========================================================================
    // E. 包装器三类语义（本轮 P0 绕过修复）
    // ==========================================================================

    /**
     * ② 前缀修饰器：必须<b>跳过后面的真实命令</b>，而不是整段不检查。
     *
     * <p><b>本仓实证的绕过</b>：旧版 {@code WRAPPERS} 集合收了 nohup/time/nice/ionice/
     * stdbuf/setsid/eval/exec，但 {@code wrapperPayload} 的「无标记包装器」兜底分支
     * 只白名单了 6 个提权器（sudo/doas/runas/gsudo/su/wsl），其余成员一律
     * {@code return null} → {@code handleSegment} 直接 return → <b>整段完全不检查</b>。
     * 于是 {@code nohup Set-Content D:\out\f.txt x} 在默认档下静默执行。</p>
     *
     * <p>更严重的是形态轴也不兜底（{@code CMD_ANCHOR} 不认前缀词），
     * 所以 {@code nohup rm -rf <工作区外>} 两轴同时失守——不可逆递归删除零审批。
     * 该形态由 {@code HitlStrategyTest#prefixWrappersDoNotHideDangerousShape} 从形态轴侧锁住。</p>
     */
    @Test
    void prefixModifiersAreUnwrappedNotSkipped() {
        // 写侧
        mustBlockWrite("nohup Set-Content " + out("f.txt") + " x");
        mustBlockWrite("time cp a.txt " + out("a.txt"));
        mustBlockWrite("nice mv a.txt " + out("a.txt"));
        mustBlockWrite("setsid mv a.txt " + out("a.txt"));
        mustBlockWrite("ionice dd if=/dev/zero of=" + out("f.bin"));
        mustBlockWrite("eval \"Set-Content " + out("f.txt") + " x\"");
        mustBlockWrite("nohup Remove-Item " + out("tree") + " -Recurse -Force");

        // 读侧
        mustBlockRead("nohup cat " + out("secret.txt"));
        mustBlockRead("time head -n 5 " + out("secret.txt"));
        mustBlockRead("stdbuf -oL cat " + out("secret.txt"));
        mustBlockRead("eval \"cat " + out("secret.txt") + "\"");
        mustBlockRead("exec cat " + out("secret.txt"));

        // 修饰器自带选项（-n 5 / -oL）不得干扰 payload 定位
        mustBlockWrite("nice -n 5 mv a.txt " + out("a.txt"));
        mustBlockWrite("stdbuf -oL tee " + out("f.txt"));

        // 多层前缀
        mustBlockWrite("nohup sudo mv a.txt " + out("a.txt"));
        mustBlockRead("stdbuf -oL nohup cat " + out("secret.txt"));
    }

    /**
     * ③ 脚本文件型：被执行的工作区外<b>脚本文件</b>是读目标，必须拦住。
     *
     * <p>脚本内容本层看不到，但「读了一个工作区外的脚本」风险不低于读数据文件——
     * 脚本里可以写任何东西。旧版对这类形态同样静默放行。</p>
     *
     * <p>末尾的界内反向断言是必需的：只断言「界外脚本被拦」无法区分
     * 「脚本判定生效」与「该动词整个失效后恰好因别的原因拦住了前者」。</p>
     */
    @Test
    void outOfWorkspaceScriptFilesAreBlockedAsReads() {
        mustBlockRead("bash " + out("x.sh"));
        mustBlockRead("sh " + out("x.sh"));
        mustBlockRead("zsh " + out("x.sh"));
        mustBlockRead("source " + out("x.sh"));
        mustBlockRead(". " + out("x.sh"));
        mustBlockRead("powershell -File " + out("x.ps1"));
        mustBlockRead("pwsh -File " + out("x.ps1"));
        mustBlockRead("cmd /c " + out("x.bat"));
        mustBlockRead("wsl bash " + out("x.sh"));

        // 前缀修饰器 + 脚本文件：nohup / setsid 属于 PREFIX_MODIFIERS 而非命令展开型，
        // 但语义同样是「执行了这个脚本文件」。本仓实测：只给 shell 启动器开
        // 脚本判定分支时，下面两条均被静默放行——而 nohup ./x.sh 是 nohup 最常见的用法之一。
        mustBlockRead("nohup " + out("x.sh"));
        mustBlockRead("setsid " + out("x.sh"));
        mustBlockRead("time " + out("x.sh"));
        // 带参数的脚本（报首个词而不是整串，否则含空格的怪路径解析失败 → 静默放行）
        mustBlockRead("cmd /c " + out("x.bat") + " arg1 arg2");

        // 【关键杀手用例】带<b>盘符参数</b>的脚本：{@code cmd /c D:\out\x.bat C:\logs\a.txt}。
        // 若报「整串」而非「首词」，整串里会出现<b>第二个冒号</b>，
        // {@code Paths.get} 抛 InvalidPathException → {@code check} 直接 return → 静默放行。
        // 而带参数的空格形态（上面 arg1 arg2）两种实现都能拦住，故对本缺陷<b>无牙</b>：
        // 变异验证 M13 实测 SURVIVED，直到加了这一条才被杀死。
        // 传绝对路径给批处理是 Windows 下的常规用法，不是边缘形态。
        mustBlockRead("cmd /c " + out("x.bat") + " " + out("logs/a.txt"));
        mustBlockRead("cmd /c " + out("x.bat").replace('/', '\\') + " " + out("logs/a.txt").replace('/', '\\'));

        // 反向：界内脚本不得误拦（高频正常操作，误拦会让默认档不可用）
        mustRelease("bash scripts/build.sh");
        mustRelease("sh scripts/deploy.sh");
        mustRelease("source scripts/env.sh");
        mustRelease("powershell -File scripts/build.ps1");
        mustRelease("cmd /c build.bat");
        mustRelease("python scripts/gen.py");
        mustRelease("node scripts/setup.js");
        mustRelease("nohup ./build.sh");
        mustRelease("time scripts/t.sh");
        mustRelease("setsid ./run.sh");

        // 反向：动词仍在表里（证明上面的放行不是因为整个判定失效）
        Assertions.assertTrue(BashPathGuard.knownReadVerbsForTest().contains("cat"),
                "cat 必须仍在读动词表里");
    }

    /**
     * Windows 风格的 {@code /} 前缀选项不得被当成被包装的命令。
     *
     * <p>{@code runas /user:Administrator "Set-Content D:\out\f.txt x"} 里，
     * {@code /user:Administrator} 是 runas 自己的选项；旧版跳过选项的循环只认 {@code -} 前缀，
     * 于是 {@code /user:Administrator} 成了「被包装命令」的动词 → 查不到规则 → 真实 payload 静默放行。</p>
     *
     * <p>反向必须同时钉住：{@code /} 前缀的识别<b>不能</b>宽到把 Unix 绝对路径
     * （{@code sudo /usr/bin/rm ...}）当成选项跳过，否则真实命令反而被跳过 → 另一种绕过。</p>
     */
    @Test
    void windowsStyleOptionsAreNotTreatedAsWrappedCommand() {
        mustBlockWrite("runas /user:Administrator \"Set-Content " + out("f.txt") + " x\"");
        mustBlockWrite("runas /user:Administrator \"cmd /c del " + out("f.txt") + "\"");
        mustBlockRead("runas /user:Administrator \"type " + out("secret.txt") + "\"");

        // Unix 绝对路径形式的命令：必须识别为命令（而不是选项）
        mustBlockWrite("sudo /usr/bin/rm " + out("f.txt"));
        mustBlockRead("sudo /usr/bin/cat " + out("secret.txt"));

        // 反向：界内目标不得误拦
        mustRelease("runas /user:Administrator \"cmd /c build.bat\"");
        mustRelease("sudo /usr/bin/rm build/tmp.txt");
    }

    // ==========================================================================
    // E2. 通配符：退判归属目录（本轮 P1 修复）
    // ==========================================================================

    /**
     * 含通配符的目标必须按<b>归属目录</b>判定，不得一律放行。
     *
     * <p>通配符只在最后几段展开，前面的目录部分是字面量，所以
     * {@code D:\out\*.*} 的每一个可能匹配项都在 {@code D:\out} 之内——
     * 判这个前缀就等于判了整个目标集合。</p>
     *
     * <p>旧实现一律放行，后果是 {@code del D:\out\*.*}、
     * {@code Remove-Item D:\out\* -Recurse -Force} 这类<b>越界批量删除</b>两轴皆不命中
     * （形态轴的 {@code del /s} / {@code rd /s} 正则要求带 {@code /s}，此处没有）。</p>
     */
    @Test
    void wildcardTargetsAreJudgedByTheirOwningDirectory() {
        mustBlockWrite("Remove-Item " + outStr("*") + " -Recurse -Force");
        mustBlockWrite("del " + outStr("*.*"));
        mustBlockRead("cat " + outStr("*.txt"));
        mustBlockRead("Get-Content " + outStr("?.log"));
        mustBlockWrite("rm -rf " + outStr("sub/*"));
        mustBlockWrite("Set-Content " + outStr("*.txt") + " x");
        // 多级通配：归属退到第一个确定的目录层
        mustBlockWrite("Remove-Item " + outStr("*/inner.txt"));
        // 与前缀修饰器叠加
        mustBlockWrite("nohup Remove-Item " + outStr("*") + " -Force");

        // 盘符根通配：最危险形态。归属前缀必须是真正的绝对路径 {@code D:\}，
        // 不能是 drive-relative 的 {@code D:}（那会被 resolve 成「当前盘符的当前目录」）。
        // 本仓实测：旧写法下目标被解析成工作区自身（{@code D:\work\...\}），
        // 拦截<b>侥幸</b>成立、而审批文案报的路径完全是错的。
        String drive = workspace.getRoot().toString().replace("\\", "");
        BashPathGuard.Violation rootWildcard = inspect("Remove-Item " + drive + "\\*");
        Assertions.assertNotNull(rootWildcard, "盘符根通配（删整个盘）必须被拦住");
        Assertions.assertEquals(workspace.getRoot().toString(), rootWildcard.target(),
                "归属前缀必须是盘符根本身，而不是被 resolve 成当前目录的 drive-relative 路径："
                        + " 审批文案报 '" + rootWildcard.target() + "' 会让用户无法判断该不该批准");

        // 反向：界内通配一律不得误拦（最高频的正常操作）
        mustRelease("cat src/*.java");
        mustRelease("rm -rf build/*");
        mustRelease("Remove-Item target/* -Recurse -Force");
        mustRelease("ls *.md");
        mustRelease("del *.tmp");
        mustRelease("Get-ChildItem src/**/*.java");
        mustRelease("tar -czf build/out.tgz src/*");

        // 反向：变量引用仍属能力边界（值只在运行期存在），不得误拦
        mustRelease("cat $d/f.txt");
        mustRelease("Set-Content \"$out\\f.txt\" x");
    }

    // ==========================================================================
    // F. 一致性结构护栏：声明表 ↔ 实际处理逻辑（防复发）
    // ==========================================================================

    /**
     * <b>每一个已声明的包装器都必须真的被处理</b>。
     *
     * <p>这是本轮 P0 的直接防复发护栏。缺陷形态是：{@code WRAPPERS} 声明表收了 30 个成员，
     * 而 {@code wrapperPayload} 的兜底分支只白名单了 6 个 → 其余成员静默 return null。
     * <b>声明与实现分属两处、靠人肉保持同步，就是下一个静默绕过口。</b></p>
     *
     * <p>护栏手法：给每个已声明成员构造一条「包装器 + 界外目标」的命令，
     * 断言必须被拦住。任何一个成员落到「什么都不做」的分支都会使本用例红。</p>
     *
     * <p>与 {@code verbTablesHaveNoDuplicateKeys} 同类：都是「行为用例照不到的失效模式」，
     * 靠枚举声明表逐项验证才能发现。</p>
     */
    @Test
    void everyDeclaredWrapperIsActuallyHandled() throws IOException {
        Set<String> declared = declaredWrapperMembers();
        Assertions.assertTrue(declared.size() >= 20,
                "从源码提取到的包装器成员过少（" + declared.size() + "），说明正则已失配、本用例会退化成假绿");

        String secret = out("secret.txt");
        List<String> unhandled = new ArrayList<>();
        for (String w : declared) {
            // 两种载荷形态都试：带路径的命令、带路径的脚本文件。
            // 只要有一种被拦住，就说明该成员真的被处理了。
            boolean handled = inspect(w + " cat " + secret) != null
                    || inspect(w + " " + out("x.sh")) != null
                    || inspect(w + " -c \"cat " + secret + "\"") != null
                    || inspect(w + " /c \"type " + secret + "\"") != null
                    || inspect(w + " -File " + out("x.ps1")) != null;
            if (!handled) {
                unhandled.add(w);
            }
        }
        Assertions.assertTrue(unhandled.isEmpty(),
                "以下包装器已声明但<b>没有任何一种形态被处理</b>，等于给越界访问开了静默绕过口： "
                        + unhandled + "。修法：让 handleWrapper 对该成员真的递归展开或判定目标，"
                        + "而不是把它从声明表里删了事（删表会让已拦住的形态退化）。");
    }

    /**
     * 从源码提取<b>两个</b>包装器声明表的成员并集。
     *
     * <p>直接读源码而不是调 {@code BashPathGuard} 的内部集合：护栏必须验证
     * 「<b>声明了什么</b>」而不是「代码里现在能拿到什么」——后者会把缺陷本身当真相来源。</p>
     *
     * <p>注意：<b>只提取真正驱动行为的表</b>。曾有一张 {@code SCRIPT_LAUNCHERS}，
     * 当脚本判定提升为所有包装器通用后它已不再驱动任何分支（变异验证实测：删成员全绿），
     * 故从源码删除。本提取器<b>不得</b>再去找它：否则一旦有人重新引入一张
     * 「名字像、但无人消费」的表，护栏会把它当真相来源，反而掩盖死分类。</p>
     */
    private static Set<String> declaredWrapperMembers() throws IOException {
        List<String> lines = Files.readAllLines(sourceOf("BashPathGuard.java"), StandardCharsets.UTF_8);
        Set<String> members = new LinkedHashSet<>();
        boolean inTarget = false;

        for (String line : lines) {
            if (line.contains("COMMAND_WRAPPERS = Collections")
                    || line.contains("PREFIX_MODIFIERS = Collections")) {
                inTarget = true;
            }
            if (!inTarget) {
                continue;
            }
            Matcher m = Pattern.compile("\"([^\"]+)\"").matcher(line);
            while (m.find()) {
                members.add(m.group(1));
            }
            if (line.contains(")));") || line.trim().endsWith(");")) {
                inTarget = false;
            }
        }
        return members;
    }

    /**
     * 字面量数组不得有重复项。
     *
     * <p>本仓已两次踩到「同一张表里写了两遍」：动词表里 {@code select-string} 被
     * {@code HashMap.put} 两次（后写静默覆盖前写，语义完全相反），以及
     * {@code PS_DRIVE_PREFIXES} 里 {@code "registry::"} 字面重复。
     * 数组重复虽不改变行为，但它是「抄贴时漏改」的信号，且会让后人误以为两项有意不同。</p>
     */
    @Test
    void literalArraysHaveNoDuplicates() throws IOException {
        List<String> lines = Files.readAllLines(sourceOf("BashPathGuard.java"), StandardCharsets.UTF_8);
        List<String> dups = new ArrayList<>();
        int scanned = 0;

        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (!line.contains("String[] ") || !line.contains("= {")) {
                continue;
            }
            // 收集该数组字面量的全部行（直到闭合的 };）
            StringBuilder body = new StringBuilder();
            for (int j = i; j < lines.size(); j++) {
                body.append(lines.get(j)).append('\n');
                if (lines.get(j).contains("};")) {
                    break;
                }
            }
            Set<String> seen = new HashSet<>();
            Matcher m = Pattern.compile("\"([^\"]*)\"").matcher(body);
            while (m.find()) {
                scanned++;
                if (!seen.add(m.group(1))) {
                    dups.add(m.group(1) + " @L" + (i + 1));
                }
            }
        }

        Assertions.assertTrue(dups.isEmpty(), "字面量数组存在重复项（抄贴漏改的信号）： " + dups);
        Assertions.assertTrue(scanned >= 60,
                "扫到的字面量过少（" + scanned + "），说明数组排版变了、本用例会退化成假绿");
    }
}
