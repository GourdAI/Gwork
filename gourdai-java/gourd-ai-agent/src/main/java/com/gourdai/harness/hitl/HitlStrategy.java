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
import com.gourdai.harness.HarnessEngine;
import org.noear.solon.core.util.Assert;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
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
 * <h3>第二条判定轴：读到 / 写到了哪里（{@link BashPathGuard}）</h3>
 *
 * <p>上面八类正则判定的是「命令<b>形态</b>危不危险」，与路径无关。但它们对
 * {@code Set-Content D:\其他项目\x.txt}、{@code cp a.txt /etc/b}、{@code cat D:\其他项目\secret}
 * 这类<b>形态无害但目标在工作区外</b>的命令全部放行——而这正是「默认权限」
 * 对用户承诺的边界。故在链末尾追加一道路径边界判定：<b>越界读与越界写都拦</b>
 * （用户拍板口径），两者都命中时报写（口径与理由见 {@link BashPathGuard} 类注释）。</p>
 *
 * <p>两道轴的分工是刻意的：形态轴拦「不可逆」，路径轴拦「越界」，互不依赖。
 * {@code rm -rf D:\out} 两边都命中（重叠是好事：任一条被绕过时另一条仍在），
 * 而 {@code Set-Content D:\out\f.txt x} 只有路径轴能拦。</p>
 *
 * <p><b>路径轴需要工作区基准</b>（toolContext 的 {@code __cwd}）：取不到时只解除路径轴、
 * 形态轴照常生效。故直调本策略而传 {@code null} trace 的单元测试，测到的<b>只有形态轴</b>
 * ——不能据那类用例推出「读工作区外文件会放行」（那是假绿，
 * 见 {@code HitlSensitiveFileWriteTest} 类注释）。</p>
 *
 * <p>完全访问档下本策略整体不生效（{@code HITLInterceptor.onAction} 在调用前已按
 * {@code AccessPolicy.isCommandApprovalRequired} 早退），路径轴随之解除——
 * 用户要的正是「能碰工作区外的东西」。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class HitlStrategy implements HITLInterceptor.InterventionStrategy {

    /**
     * 用户配置的 bash <b>读写</b>豁免目录（settings.json 的 {@code permission.bashExemptDirs}）。
     *
     * <p>存<b>字面量</b>而非已解析的 Path：环境变量在进程生命周期内可能变化
     * （用户改完环境变量不重启应用），每次判定时重新展开才能跟得上。
     * 展开成本极低（一次正则扫描），而 bash 调用频次远低于其开销阈值。</p>
     *
     * <p>用 {@code volatile} + 整体替换（而不是就地 clear/addAll）发布：
     * 本策略实例被多个会话线程共用，就地修改会让并发读到「已清空但尚未填充」的中间态，
     * 那一瞬所有豁免都失效——表现为保存配置时恰好跑的命令突然弹审批。</p>
     */
    private volatile List<String> bashExemptDirs = Collections.emptyList();

    /**
     * 无豁免配置的默认构造器。
     *
     * <p>保留它是必需的：{@code HarnessEngine} 在未显式配置时用它装配默认拦截器，
     * 且既有测试（{@code HitlStrategyTest}、{@code BashPathBoundaryWiringTest}）直接 new。
     * 若只留带参构造器，这些调用点全部被迫传 null，反而更容易出错。</p>
     */
    public HitlStrategy() {
    }

    /**
     * 带用户豁免目录的构造器。
     *
     * @param bashExemptDirs 豁免目录字面量，可为 null（等价于无配置）
     */
    public HitlStrategy(List<String> bashExemptDirs) {
        setBashExemptDirs(bashExemptDirs);
    }

    /**
     * 热更新豁免目录（设置页保存后调用，无需重启）。
     *
     * <p>入参做<b>防御性拷贝</b>：settings 里的 List 是可变对象且会被保存流程 clear/addAll，
     * 直接持有引用会让本策略看到半更新状态。</p>
     */
    public void setBashExemptDirs(List<String> bashExemptDirs) {
        if (bashExemptDirs == null || bashExemptDirs.isEmpty()) {
            this.bashExemptDirs = Collections.emptyList();
            return;
        }

        List<String> copy = new ArrayList<>(bashExemptDirs.size());
        for (String item : bashExemptDirs) {
            if (item != null && !item.trim().isEmpty() && !copy.contains(item.trim())) {
                copy.add(item.trim());
            }
        }
        this.bashExemptDirs = Collections.unmodifiableList(copy);
    }

    /**
     * 当前生效的豁免目录字面量（只读视图，供设置页回显与测试断言）。
     */
    public List<String> getBashExemptDirs() {
        return bashExemptDirs;
    }

    /**
     * 已知会「原样执行其后命令」的前缀词：调度修饰器、提权器、shell / 脚本启动器。
     *
     * <p><b>为什么必须是白名单而不是「任意词 + 空格」</b>：后者会让
     * {@code git commit -m "add sudo docs"} 这类引号内文本被当成命令位置而误拦。
     * 只有白名单里的词才具备「把控制权交给后续命令」的语义。</p>
     *
     * <p>{@code su} 用 {@code \b} 收尾故不会误吃 {@code sudo}（后跟 {@code d}，词边界不成立）。</p>
     */
    private static final String PREFIX_WRAPPER_WORD =
            "(?:nohup|time|nice|ionice|stdbuf|setsid|eval|exec|sudo|doas|gsudo|runas|su"
                    + "|sh|bash|zsh|ksh|dash|fish|ash|csh|tcsh|source"
                    + "|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|cmd(?:\\.exe)?|wsl(?:\\.exe)?)\\b";

    /**
     * 命令位置锚点：行首、{@code ; & |}、{@code $(} 命令替换开头、换行之后，
     * <b>或紧跟在上述位置之后的包装器前缀序列之后</b>。
     *
     * <p>不认普通空格前导（否则 {@code git commit -m "add sudo docs"} 这类带引号文本的
     * 普通命令会被误拦——词汇出现在参数里不代表它会被执行）；
     * 但必须认 {@code $(}、反引号与换行：{@code echo $(sudo rm -rf /)}、
     * {@code echo `sudo rm -rf /`} 与多行脚本里的 {@code sudo ...} 都是真会执行的命令位置，
     * 漏掉它们等于把提权/删除放过去。</p>
     *
     * <p><b>包装器前缀序列是本仓实证补上的</b>：旧锚点只认 {@code ^|[;&|]|$(|`|\n}，
     * 于是 {@code nohup rm -rf D:\其他项目} 里的 {@code rm} 前面是「字母 + 空格」、
     * 不含任何锚点字符 → 形态轴不命中；而路径轴当时也因包装器未展开而不命中，
     * <b>两轴同时失守</b>，默认档下不可逆递归删除零审批静默执行。
     * {@code sudo rm -rf} 看似被拦，其实只因 {@code sudo} 自身命中提权正则，与 {@code rm -rf} 无关。</p>
     *
     * <p>前缀序列<b>必须紧跟在原锚点之后</b>（而不是出现在命令任意位置）：
     * 这样 {@code git commit -m "nohup rm -rf /"} 里的 {@code nohup} 前面是 {@code -m "}、
     * 不在原锚点后 → 不匹配，引号内文本仍不会被误拦。</p>
     *
     * <h4>刻意<b>不</b>收录「命令载荷标记」（{@code -c} / {@code /c} / {@code -Command} …）</h4>
     *
     * <p>曾有一版在锚点里多加了一条 {@code PAYLOAD_FLAG}，直觉是「标记后面也是新命令位置」。
     * 变异验证把它删掉后<b>所有用例仍全绿</b>，于是用正则差异集探针实测（24 条候选）：
     * 它只对 6 条<b>真实 shell 里不存在的形态</b>产生影响——全部是「裸标记开头、
     * 前面没有 shell 名」（如 {@code -c rm -rf ...}、{@code ;/c rd /s ...}）；
     * 而所有真实形态（{@code sh -c}、{@code bash -c}、{@code cmd /c}、{@code cmd.exe /k}、
     * {@code powershell -Command}、{@code pwsh -c}、{@code wsl -e}、{@code sudo -c}）
     * <b>只靠 {@link #PREFIX_WRAPPER_WORD} 就已全部命中</b>：前缀词之后的
     * {@code (?:\s+\S+){0,4}?} 会把标记与引号一起吃掉。</p>
     *
     * <p>故删除而非保留：<b>为死代码补一个只能靠「不存在的命令形态」才能杀死的用例，
     * 等于把回归锁在死代码上</b>（本仓已有先例：契约测试把缺陷形状锁成了正确形状）。
     * 若将来发现某个真实形态确实需要标记才能命中，请先用差异集探针证明再加回来。</p>
     *
     * <p>两层重复次数都限制为 4：既覆盖 {@code nohup sudo -u root stdbuf -oL rm -rf} 这类
     * 多层嵌套，又避免惰性量词在长命令上回溯爆炸。</p>
     */
    private static final String CMD_ANCHOR =
            "(?:^|[;&|]|\\$\\(|`|\\n)\\s*"
                    + "(?:(?:" + PREFIX_WRAPPER_WORD + ")"
                    + "(?:\\s+\\S+){0,4}?\\s*[\"']?\\s*){0,4}";

    /**
     * 提权与身份篡改：拿到的权限本身就越过了所有其它边界，必须批。
     *
     * <p>{@code chmod/chown} 在列是因为它们能给自己开后门（如给脚本加执行位、夺取文件归属）；
     * 原名单里的 {@code alias/unalias} 已移除——它只影响当前子 shell，进程一退就没了。</p>
     *
     * <p>所有「命令位置」匹配一律只认行首、{@code ; & |} 之后、或<b>包装器前缀序列</b>之后，
     * <b>不认任意普通空格前导</b>。否则 {@code git commit -m "add sudo docs"} 这类带引号文本的
     * 普通命令会被误拦——词汇出现在参数里不代表它会被执行。前缀序列的白名单与理由见
     * {@link #CMD_ANCHOR}。</p>
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
     * <p><b>本名单只管写形态</b>：读 {@code cat ~/.bashrc} 不在本名单内——但自「读也拦」
     * 口径生效后，它会被<b>路径轴</b>拦住（家目录在工作区外）。两轴职责：
     * 本名单拦「写向后门面」这一危险形态，{@link #CREDENTIAL_ACCESS} 拦凭据访问，
     * 路径轴拦「目标在工作区外」。故不要据本名单的「不拦读」推出「读启动文件会放行」。</p>
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

        // 最后一道：工作区外的读 / 写目标。放在末尾是刻意的——形态轴（不可逆）比路径轴（越界）
        // 更紧急，两条都命中时应优先告诉用户「这操作删了就没了」，而不是「这操作写到了外面」。
        String outOfWorkspace = evaluatePathBoundary(trace, cmd);
        if (outOfWorkspace != null) {
            return outOfWorkspace;
        }

        // 其余一律放行：git 常规操作、本地依赖安装、构建、mv/cp、管道、`;` 串联、
        // 网络探测与普通下载、进程查看与清理自己启动的子进程。
        return null;
    }

    /**
     * 越界访问判定：命令里有落到工作区之外的读 / 写目标时要求审批。
     *
     * <p><b>读写都拦</b>（用户拍板口径）。{@link BashPathGuard#inspect} 内部两趟扫描、写优先，
     * 所以两者都命中时 {@code violation.isWrite()} 为 true，文案报「写入」——写不可逆、
     * 读可撤销，优先让用户看到更严重的那个。文案必须区分读写：把读报成写会让用户
     * 高估风险（以为要覆盖文件，其实只是看一眼），反之则会低估。</p>
     *
     * <p><b>工作区从哪来</b>：本轮 toolContext 里的 {@code __cwd}，与
     * {@code ActionTask#toolContextText} 及终端工具 {@code getWorkPath} 同源同口径。
     * 不能从 args 取——args 在 {@code onAction} 阶段只含模型参数，框架私有键（{@code __} 前缀）
     * 是后续 {@code ToolRequest} 构造时才由 toolsContext 合并进去的。</p>
     *
     * <p><b>取不到工作区时跳过判定</b>：没有边界就无从谈「越界」，而猜一个基准
     * （比如进程 {@code user.dir}）会把用户无关目录判成越界，制造无法解释、
     * 批准了也不知道会发生什么的审批卡。生产路径上 cwd 恒存在
     * （{@code AgentFactory} 用 {@code engine.getWorkspace()} 做了默认注入，
     * Web/Ws/CLI 三端各自再按会话 cwd 覆盖），取不到只可能出现在单元测试直调时。</p>
     */
    private String evaluatePathBoundary(ReActTrace trace, String cmd) {
        Path workspaceRoot = resolveWorkspaceRoot(trace);
        if (workspaceRoot == null) {
            return null;
        }

        BashPathGuard.Violation violation =
                BashPathGuard.inspect(cmd, workspaceRoot, workspaceExemptions());
        if (violation == null) {
            return null;
        }

        String action = violation.isWrite() ? "写入" : "读取";
        return "检测到" + action + "工作区之外的路径：" + violation.target()
                + "（触发形态：" + violation.verb() + "）。"
                + "当前为默认权限，工作区边界为 " + workspaceRoot + "，读写工作区外路径均需批准。"
                + "若确需" + action + "该位置请批准，或在设置→工具权限里把该目录加入豁免清单，"
                + "或切换到「完全访问」权限。";
    }

    /**
     * 解析本轮的工作区根目录。取不到或非法返回 null（跳过路径判定，见调用方说明）。
     */
    private static Path resolveWorkspaceRoot(ReActTrace trace) {
        if (trace == null || trace.getOptions() == null || trace.getOptions().getToolContext() == null) {
            return null;
        }

        Object value = trace.getOptions().getToolContext().get(HarnessEngine.ATTR_CWD);
        if (value == null) {
            return null;
        }

        String text = String.valueOf(value).trim();
        if (text.isEmpty() || ".".equals(text)) {
            return null;
        }

        try {
            return Paths.get(text).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            // InvalidPathException（脏 cwd）与 toAbsolutePath 的 SecurityException 等一律当作
            // 「拿不到可靠边界」，交由调用方跳过判定而不是把命令判成越界。
            return null;
        }
    }

    /**
     * 用户配置的额外豁免目录（与 {@link BashPathGuard#defaultExemptRoots()} 内置清单叠加）。
     *
     * <p>每次判定都重新解析字面量，让 {@code ~} 与环境变量跟随运行期变化；
     * 展开逻辑只在 {@link BashPathGuard#resolveExemptDirs} 里有一份实现，
     * 本方法不自己拼路径——两处展开口径迟早漂移，而漂移的后果是「配了豁免但没生效」。</p>
     */
    private List<Path> workspaceExemptions() {
        return BashPathGuard.resolveExemptDirs(bashExemptDirs);
    }
}
