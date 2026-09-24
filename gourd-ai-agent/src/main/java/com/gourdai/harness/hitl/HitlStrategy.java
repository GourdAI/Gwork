/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.hitl;

import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.intercept.HITLInterceptor;
import org.noear.solon.core.util.Assert;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * 危险命令审批策略：判定一条 bash 命令是否需要人工批准。
 *
 * <p>返回 {@code null} 表示放行，返回文案表示拦截并挂起等待用户决策。</p>
 *
 * <h3>判定口径：只拦不可逆与高危，不拦「看着吓人但能撤销」的操作</h3>
 *
 * <p>本策略原先是一份宽口径黑名单：含 {@code ;} 或 {@code &} 即拦、任意 {@code mv} 即拦、
 * 任意 {@code git commit/push/checkout} 即拦、任意 {@code npm install} 即拦、
 * 任意 {@code curl/ping} 即拦。它从未在默认路径上跑过（审批开关此前默认关闭），
 * 一旦成为默认档的常驻闸门，PowerShell 下几乎每条命令都会因为 {@code ;} 被拦，
 * 审批会退化成无脑连点——而无脑连点的审批等于没有审批，真正危险的那条也会被一起放过。</p>
 *
 * <p>因此判定标准收敛为一条：<b>执行后能否靠再敲一条命令撤销</b>。
 * 不能撤销的（删除、提权、关机、下载即执行、全局改环境）必须批；
 * 能撤销的（git 常规操作、本地依赖安装、移动、管道、分号串联）一律放行。
 * 代价是接受一部分「可恢复的破坏」无需确认，换取审批提示在出现时是可信的。</p>
 *
 * <p>注意本策略只覆盖 bash。read/write/edit 等结构化文件工具的边界由
 * {@code TerminalSupport.resolveSafePath} 独立保障，不走这里。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class HitlStrategy implements HITLInterceptor.InterventionStrategy {

    /**
     * 命令位置锚点：行首、或 {@code ; & |}、或 {@code $(} 命令替换开头、或换行之后。
     *
     * <p>不认普通空格前导（否则 {@code git commit -m "add sudo docs"} 这类带引号文本的
     * 普通命令会被误拦——词汇出现在参数里不代表它会被执行）；
     * 但必须认 {@code $(}、反引号与换行：{@code echo $(sudo rm -rf /)}、
     * {@code echo `sudo rm -rf /`} 与多行脚本里的 {@code sudo ...} 都是真会执行的命令位置，
     * 漏掉它们等于把提权/删除放过去。</p>
     */
    private static final String CMD_ANCHOR = "(?:^|[;&|]|\\$\\(|`|\\n)\\s*";

    /**
     * 提权与身份篡改：拿到的权限本身就越过了所有其它边界，必须批。
     *
     * <p>{@code chmod/chown} 在列是因为它们能给自己开后门（如给脚本加执行位、夺取文件归属）；
     * 原名单里的 {@code alias/unalias} 已移除——它只影响当前子 shell，进程一退就没了。</p>
     *
     * <p>所有「命令位置」匹配一律只认行首或 {@code ; & |} 之后，<b>不认普通空格前导</b>。
     * 否则 {@code git commit -m "add sudo docs"} 这类带引号文本的普通命令会被误拦——
     * 词汇出现在参数里不代表它会被执行。</p>
     */
    private static final Pattern PRIVILEGE_ESCALATION = Pattern.compile(
            "(?i)" + CMD_ANCHOR + "(sudo|doas|su|runas|chown|chgrp|chmod|passwd|visudo|usermod|useradd|Start-Process\\s+.*-Verb\\s+RunAs)\\b");

    /**
     * 系统生命周期：关机重启会直接终止宿主进程与全部未保存工作，不可撤销。
     *
     * <p>原名单里的 {@code kill/pkill/systemctl/service} 已从「一律拦」降级：
     * 杀宿主进程本就由 {@code TerminalSupport.validateCommandNoKill} 硬拦（不可关闭、
     * 且完全访问档也拦），而杀自己刚起的子进程是清理后台任务的正常操作。</p>
     */
    private static final Pattern SYSTEM_LIFECYCLE = Pattern.compile(
            "(?i)" + CMD_ANCHOR + "(reboot|shutdown|halt|poweroff|Restart-Computer|Stop-Computer|init\\s+[06])\\b");

    /**
     * 下载即执行：管道尽头是解释器，等于把任意远程内容当脚本跑，内容不可预审。
     *
     * <p>这是网络类命令中唯一保留拦截的形态。单纯的 {@code curl}/{@code wget} 下载、
     * {@code ping}/{@code dig} 探测已全部放行——把它们一律当危险会让联网排查寸步难行，
     * 而下载一个文件到工作区是可删除的、可撤销的。</p>
     */
    private static final Pattern REMOTE_EXEC = Pattern.compile(
            "(?i)\\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\\b[^|]*\\|\\s*(sudo\\s+)?\\b(sh|bash|zsh|ksh|dash|python[0-9.]*|perl|ruby|node|iex|Invoke-Expression)\\b");

    /**
     * 全局环境变更：装到系统级的东西不在工作区内，删不掉也不随项目走。
     *
     * <p>与之相对，本地依赖安装（{@code npm install}、{@code pip install -r}、{@code mvn install}）
     * 全部放行——它们只写 node_modules/venv/本地仓库，是日常开发的必经步骤。</p>
     */
    private static final Pattern GLOBAL_INSTALL = Pattern.compile(
            "(?i)" + CMD_ANCHOR + "("
                    + "(apt|apt-get|yum|dnf|zypper|pacman|apk)\\s+(install|remove|purge|upgrade|autoremove)"
                    + "|(npm|pnpm|yarn)\\s+(install|add|uninstall|remove)\\b[^;&|]*\\s(-g|--global)\\b(?![\\w-])"
                    + "|(npm|pnpm|yarn)\\s+publish"
                    + "|pip[0-9.]*\\s+install\\b[^;&|]*\\s--user\\b"
                    + "|brew\\s+(install|uninstall|upgrade)"
                    + "|choco\\s+(install|uninstall|upgrade)"
                    + "|winget\\s+(install|uninstall|upgrade)"
                    + "|scoop\\s+(install|uninstall)"
                    + "|cargo\\s+(install|publish)"
                    + "|go\\s+install"
                    + "|npm\\s+(login|adduser|token)"
                    + ")\\b");

    /**
     * 递归删除：本策略要拦的头号目标，删掉就没了。
     *
     * <p>覆盖 Unix {@code rm -r*}、Windows {@code rd /s}、PowerShell
     * {@code Remove-Item -Recurse}，以及 {@code find ... -delete} 这种隐蔽形态。</p>
     *
     * <p><b>刻意不拦单文件删除</b>（{@code rm a.txt}、{@code rm -f dist/app.js}、{@code del x.txt}）：
     * 它们只影响个别文件、可用版本控制或重新生成恢复，拦下来会让清理临时文件的日常操作
     * 每次都弹窗。真正不可恢复的是递归形态，也就是本正则匹配的那些。</p>
     *
     * <p>rm 的旗标用<b>段内前瞻</b>而非「紧跟 rm 的单横杠串」匹配：旗标顺序任意且存在
     * GNU 长选项形态（{@code rm --recursive dir}、{@code rm --force -r dir}），
     * 旧的单横杠写法会漏掉它们；前瞻限定在同一条简单命令内（不跨 {@code ; & |} 与换行），
     * 且 {@code --preserve-root} 这类含 r 的安全长选项不会自匹配（双横杠进不了短旗标分支）。</p>
     *
     * <p>xargs 管道变体（P1-2）：{@code find . -type f | xargs rm -rf} 里 rm 位于
     * xargs 的参数位，CMD_ANCHOR 锚不到它；但 xargs 会把上游清单逐一喂给 rm，
     * 实际破坏力等同于直接递归删除，必须拦。只匹配「命令位置上的 xargs 段内接带递归
     * 旗标的 rm」形态——管道符已由 CMD_ANCHOR 消耗，此处不再重复写 {@code \|}；
     * {@code grep foo | xargs cat} 这类无害 xargs 不受影响（无 rm 或不带递归旗标不命中）。</p>
     */
    private static final Pattern RECURSIVE_DELETE = Pattern.compile(
            "(?i)" + CMD_ANCHOR + "("
                    + "rm\\b(?=[^;&|\\n]*(?:\\s--recursive\\b|\\s-[a-z]*[rR][a-z]*\\b))"
                    + "|(rd|rmdir)\\s+/s"
                    + "|Remove-Item\\b[^;&|]*\\s-(Recurse|Force)\\b"
                    + "|del\\s+/s"
                    + "|find\\b[^;&|]*\\s-delete\\b"
                    + "|git\\s+clean\\b[^;&|]*\\s-[a-z]*f"
                    + "|xargs\\b[^;&|\\n]*\\brm\\b(?=[^;&|\\n]*(?:\\s--recursive\\b|\\s-[a-z]*[rR][a-z]*\\b))"
                    + ")");

    /**
     * 不可恢复的历史重写：与普通 git 操作的区别是本地 reflog 之外无处可寻，
     * 且 force push 会覆盖远端他人提交。
     *
     * <p>{@code commit}/{@code checkout}/{@code push}（非 force）/{@code merge} 一律放行。</p>
     *
     * <p><b>大小写敏感是必需的</b>：{@code git branch -d} 删除<b>已合并</b>分支（可恢复），
     * {@code git branch -D} 强制删除（不可恢复），两者只差一个字母的大小写。
     * 因此这里不用全局 {@code (?i)}，只对 {@code git} 关键词局部兼底。</p>
     */
    private static final Pattern DESTRUCTIVE_VCS = Pattern.compile(
            CMD_ANCHOR + "(?i:git)\\s+(?:"
                    + "(?i:push)\\b[^;&|]*(?:\\s-f\\b|\\s--force\\b(?!-with-lease))"
                    + "|(?i:reset)\\b[^;&|]*\\s--hard\\b"
                    + "|(?i:branch)\\b[^;&|]*\\s-D\\b"
                    + "|(?i:filter-branch)\\b"
                    + "|(?i:update-ref)\\b[^;&|]*\\s-d\\b"
                    + ")");

    /**
     * 磁盘级与凭据级操作：格式化、裸写块设备、读私钥。
     */
    private static final Pattern DISK_AND_SECRETS = Pattern.compile(
            "(?i)" + CMD_ANCHOR + "("
                    + "mkfs(\\.[a-z0-9]+)?\\b"
                    + "|fdisk\\b|diskpart\\b|Format-Volume\\b|format\\s+[a-z]:"
                    + "|dd\\b[^;&|]*\\sof=/dev/"
                    + "|>\\s*/dev/(sd|hd|nvme|disk)"
                    + ")");

    /**
     * 私钥与凭据文件：读出来就可能被带进模型上下文，外泄不可逆。
     *
     * <p>{@code ~/.ssh} 与 {@code id_rsa} 类私钥、云厂商凭据、{@code .env} 里的密钥。
     * 原名单把整个 {@code /etc}、{@code /var}、{@code ~/} 都算敏感，
     * 导致 {@code cat /etc/os-release} 这类纯环境探测也要审批，已收窄到凭据本身。</p>
     */
    private static final Pattern CREDENTIAL_ACCESS = Pattern.compile(
            "(?i)(\\.ssh[/\\\\](id_[a-z0-9]+|identity|.*\\.pem)\\b"
                    + "|\\bid_rsa\\b|\\bid_ed25519\\b"
                    + "|\\.aws[/\\\\]credentials\\b"
                    + "|\\.kube[/\\\\]config\\b"
                    + "|\\.npmrc\\b|\\.pypirc\\b"
                    + "|(?<![\\w.-])\\.env\\b"
                    + "|/etc/(shadow|sudoers)\\b"
                    + "|\\.docker[/\\\\]config\\.json\\b)");

    /** 家目录前缀（均可选，裸相对文件名也命中）：~/、$HOME/、/home/<user>/、/Users/<user>/ */
    private static final String HOME_PREFIX =
            "(?:~[/\\\\]?|\\$HOME[/\\\\]?|/home/[^/\\s\"']+/?|/Users/[^/\\s\"']+/?)?";

    /** 敏感家文件族：SSH 授权键与 shell 启动/配置文件（写入即持久化生效）。
     *  尾部 (?![\w.-]) 排除同形词：app.bashrc.js / .bashrc-old / bashrc-notes.md 不在名单内。 */
    private static final String SENSITIVE_FAMILY =
            "(?:\\.ssh[/\\\\]authorized_keys2?(?![\\w.-])"
                    + "|\\.(?:bashrc|zshrc|profile|bash_profile|zprofile|zlogin|zshenv|inputrc|tmux\\.conf|gitconfig)(?![\\w.-]))";

    /**
     * 写向持久化后门面的操作：shell 启动文件与 SSH 授权键。
     *
     * <p>这些文件在每次新开 shell / SSH 登录时被自动加载——写进去的内容会在用户
     * 毫无感知的情况下长期生效（alias 里藏命令、authorized_keys 里塞公钥都是经典
     * 持久化后门手法），事后难以发现与撤销，必须审批。</p>
     *
     * <p><b>只拦写，不拦读</b>：读 {@code cat ~/.bashrc} 是日常排错行为，拦下来只会
     * 制造审批疲劳；本名单与 {@link #CREDENTIAL_ACCESS}（读拦截）职责互补。</p>
     *
     * <p>匹配口径：写形态 = 重定向（{@code >}、{@code >>}、{@code 2>}）或 PowerShell
     * 的 {@code Add-Content}/{@code Set-Content}/{@code Out-File} 或 {@code tee}；
     * 目标 = 家目录前缀（{@code ~}、{@code $HOME}、{@code /home/u}、{@code /Users/u}，
     * 均可选——裸相对名 {@code > .bashrc} 也算）+ 敏感家文件。重定向符与 PowerShell
     * 动词自带命令边界，不依赖 CMD_ANCHOR，串接命令同样命中。</p>
     */
    private static final Pattern SENSITIVE_FILE_WRITE = Pattern.compile(
            "(?i)((?:\\d?>>?)\\s*[^;&|\\n]*?" + HOME_PREFIX + SENSITIVE_FAMILY
                    + "|Add-Content\\b[^;&|\\n]*?" + HOME_PREFIX + SENSITIVE_FAMILY
                    + "|Set-Content\\b[^;&|\\n]*?" + HOME_PREFIX + SENSITIVE_FAMILY
                    + "|Out-File\\b[^;&|\\n]*?" + HOME_PREFIX + SENSITIVE_FAMILY
                    + "|tee\\b[^;&|\\n]*?" + HOME_PREFIX + SENSITIVE_FAMILY + ")");

    @Override
    public String evaluate(ReActTrace trace, Map<String, Object> args) {
        String cmd = (String) args.get("command");
        if (Assert.isEmpty(cmd)) {
            return null;
        }

        cmd = cmd.trim();
        // 多行命令里的换行也是命令位置锚点（见 CMD_ANCHOR）；\r\n 归一为 \n 以免锚点漏配
        cmd = cmd.replace("\r\n", "\n");

        if (RECURSIVE_DELETE.matcher(cmd).find()) {
            return "检测到递归/强制删除操作，删除后无法恢复。";
        }

        if (PRIVILEGE_ESCALATION.matcher(cmd).find()) {
            return "检测到提权或文件权限/归属变更操作。";
        }

        if (SYSTEM_LIFECYCLE.matcher(cmd).find()) {
            return "检测到关机/重启指令，会终止当前全部未保存的工作。";
        }

        if (REMOTE_EXEC.matcher(cmd).find()) {
            return "检测到「下载即执行」形态：远程内容将被直接当作脚本运行。";
        }

        if (DISK_AND_SECRETS.matcher(cmd).find()) {
            return "检测到磁盘级写入或格式化操作。";
        }

        if (GLOBAL_INSTALL.matcher(cmd).find()) {
            return "检测到全局环境变更（系统级安装/发布），影响范围超出当前项目。";
        }

        if (DESTRUCTIVE_VCS.matcher(cmd).find()) {
            return "检测到不可恢复的版本历史重写操作。";
        }

        if (CREDENTIAL_ACCESS.matcher(cmd).find()) {
            return "检测到访问私钥或凭据文件。";
        }

        if (SENSITIVE_FILE_WRITE.matcher(cmd).find()) {
            return "检测到写向 shell 启动文件或 SSH 授权键的操作，会在后续会话中长期生效。";
        }

        // 其余一律放行：git 常规操作、本地依赖安装、构建、mv/cp、管道、`;` 串联、
        // 网络探测与普通下载、进程查看与清理自己启动的子进程。
        return null;
    }
}
