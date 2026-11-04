package com.gourdai.harness.hitl;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 写向持久化后门面的操作必须审批（P1-4）。
 *
 * <p>shell 启动文件与 SSH 授权键在每次新开 shell / 登录时自动加载，写进去的内容
 * 长期静默生效，是经典持久化后门手法。修复前 CREDENTIAL_ACCESS 只覆盖「读凭据」，
 * {@code echo 'alias x' >> ~/.bashrc} 在默认档无审批直接落盘。</p>
 *
 * <h3>本类只测<b>形态轴</b>：trace 传 null，路径轴整体不参与</h3>
 *
 * <p>{@code evaluate(null, args)} 拿不到 toolContext 里的 {@code __cwd}，
 * 而 {@code HitlStrategy.evaluatePathBoundary} 在无工作区基准时<b>刻意跳过</b>判定
 * （不凭空造边界）。因此本类的所有断言都只在描述「敏感文件名单」这一条形态轴。</p>
 *
 * <p><b>不要</b>据本类推出「读 {@code ~/.bashrc} 会被放行」——那是「读也拦」口径生效前的
 * 旧契约，本类曾这样写过并造成假绿：路径轴短路后 {@code cat ~/.bashrc} 确实返回 null，
 * 而生产环境（cwd 恒存在）会被路径轴拦下。真实契约见
 * {@code BashPathBoundaryWiringTest#homeStartupFileReadsAreBlockedByPathAxis}。</p>
 */
class HitlSensitiveFileWriteTest {
    private final HitlStrategy strategy = new HitlStrategy();

    private String evaluate(String command) {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", command);
        return strategy.evaluate(null, args);
    }

    private void assertBlocked(String command) {
        Assertions.assertNotNull(evaluate(command),
                "写向持久化后门面必须触发审批: " + command);
    }

    /**
     * 断言<b>形态轴</b>不拦（trace=null 故路径轴不参与，见类注释）。
     */
    private void assertReleased(String command) {
        Assertions.assertNull(evaluate(command),
                "该形态不得被敏感文件名单误拦（审批疲劳会让真拦截失效）: " + command);
    }

    @Test
    void blocksShellStartupFileWrites() {
        // 重定向追加（最经典的后门注入形态）
        assertBlocked("echo 'alias x=evil' >> ~/.bashrc");
        assertBlocked("echo 'alias x=evil' >> ~/.zshrc");
        assertBlocked("echo 'export EVIL=1' >> ~/.profile");
        assertBlocked("echo 'x' >> ~/.bash_profile");
        assertBlocked("echo 'x' >> ~/.zprofile");
        assertBlocked("echo 'x' >> ~/.zshenv");
        // 覆盖写（>）
        assertBlocked("echo evil > ~/.bashrc");
        assertBlocked("echo evil > ~/.zshrc");
        // stderr 重定向与裸相对名
        assertBlocked("echo x 2> ~/.bashrc");
        assertBlocked("echo x > .bashrc");
        // $HOME 形态
        assertBlocked("echo 'alias x' >> $HOME/.bashrc");
        // 串接命令中的写（重定向自带命令边界，不依赖 CMD_ANCHOR）
        assertBlocked("echo a > a.txt; echo evil >> ~/.bashrc");
        assertBlocked("ls -la && echo evil >> ~/.zshrc");
        // 同形但不同文件：.ssh/authorized_keys
        assertBlocked("echo 'ssh-rsa AAAA' >> ~/.ssh/authorized_keys");
        assertBlocked("echo 'ssh-rsa AAAA' >> ~/.ssh/authorized_keys2");
        // gitconfig（写入可改全局 git 行为，如 url.insteadOf 劫持）
        assertBlocked("echo '[url \"https://evil\"]' >> ~/.gitconfig");
    }

    @Test
    void blocksPowerShellAndTeeWriteForms() {
        assertBlocked("Add-Content ~/.bashrc 'alias x=evil'");
        assertBlocked("Set-Content ~/.zshrc 'evil'");
        assertBlocked("Out-File -FilePath ~/.profile -InputObject evil");
        assertBlocked("echo evil | tee -a ~/.bashrc");
        assertBlocked("echo 'ssh-rsa AAAA' | Out-File ~/.ssh/authorized_keys");
        assertBlocked("Add-Content ~/.ssh/authorized_keys 'ssh-rsa AAAA'");
        // /home/ 与 /Users/ 显式前缀
        assertBlocked("Add-Content /home/u/.bashrc 'evil'");
        assertBlocked("Set-Content /Users/u/.zshrc 'evil'");
    }

    /**
     * 形态轴的<b>反向边界</b>：读敏感启动文件不属于「写向后门面」这一形态，故本轴不拦。
     *
     * <p>注意这<b>不等于</b>生产环境会放行：trace 为 null 时路径轴被跳过（见类注释），
     * 而带 cwd 的真实链路里这些命令会被路径轴拦下（家目录在工作区外）。
     * 本用例锁的只是「敏感文件名单不该把读也算成后门面写入」这一形态轴语义。</p>
     */
    @Test
    void shapeAxisDoesNotTreatReadsAsBackdoorWrites() {
        // 形态轴不拦读（路径轴会拦，但那需要 cwd，本类没有）
        assertReleased("cat ~/.bashrc");
        assertReleased("Get-Content ~/.zshrc");
        assertReleased("cat ~/.ssh/authorized_keys");
        assertReleased("diff ~/.bashrc /etc/skel/.bashrc");
        // 普通重定向写（非敏感家文件）
        assertReleased("echo hello > out.txt");
        assertReleased("echo hello >> build.log");
        assertReleased("npm run build > out.txt 2>&1");
        // 同形词不得误伤
        assertReleased("echo x > app.bashrc.js");
        assertReleased("echo x > .bashrc-old");
        assertReleased("echo x > bashrc-notes.md");
        assertReleased("echo x > ~/.bashrc-backup");
        // .env 类已由 CREDENTIAL_ACCESS 管（读拦截），写向 .env 由其覆盖检查路径形态
        assertReleased("echo x > config.json");
        // 非家目录的普通 gitconfig（项目内）
        assertReleased("git config user.name x");
    }
}
