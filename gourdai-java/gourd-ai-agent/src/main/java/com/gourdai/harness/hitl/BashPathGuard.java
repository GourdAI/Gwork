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

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * bash 命令的<b>路径边界</b>判定器：找出「会落到工作区之外的读取 / 写入 / 删除 / 创建目标」。
 *
 * <h3>为什么需要这个类</h3>
 *
 * <p>结构化文件工具（read/write/edit/ls/glob/grep）的边界由
 * {@code TerminalSupport.resolveSafePath} 逐次硬校验，模型无法绕过。而 bash 是<b>自由文本</b>，
 * Java 层此前只有 {@code validateCommandNoKill} 三条红线（杀宿主进程、{@code exit}、根目录删除），
 * 完全没有路径概念；默认档下 OS 内核沙盒又是关闭的
 * （{@code AccessPolicy.isKernelSandboxEnabled} 需要嵌入方显式打开 {@code sandboxSystemRestrict}）。
 * 于是「默认权限」对 bash 实际只剩提示词软约束——{@code Set-Content D:\其他项目\x.txt}、
 * {@code rm -rf ../sibling}、{@code cat D:\其他项目\secret} 都能静默执行成功。</p>
 *
 * <p>本类把 bash 拉回到与文件工具同等的边界强度：解析命令 → 提取访问目标 → 判定是否越界。</p>
 *
 * <h3>口径：读写都拦，写优先报</h3>
 *
 * <p>越界<b>写</b>与越界<b>读</b>都要求审批（用户拍板口径）。{@link #inspect} 内部
 * <b>两趟扫描</b>：先找越界写，没有再找越界读。分开两趟而非一趟里「谁先出现报谁」，
 * 是因为<b>写不可逆而读可撤销</b>：{@code cat 外部文件 > 外部文件} 读写都命中，
 * 必须报「写入」——若报成「读取」，用户以为只是看一眼就随手批准，实际却覆盖了外部文件。
 * {@link Violation#isWrite()} 供审批文案区分两者，避免把读误报成写（高估风险）或反之（低估）。</p>
 *
 * <p><b>为何拦读也要小心过度拦截</b>：读命令的动词表远大于写，一旦把 {@code mvn}、{@code npm}、
 * {@code git} 这类高频命令也拖进来，默认档就没法干活了。它们读工作区外文件
 * （依赖仓库、全局 git 配置）发生在<b>被调进程内部</b>，路径不在命令行上，本层看不到也不该拦。
 * 因此只拦「命令行上显式写了工作区外路径」的读，{@code doesNotOverBlockNormalWorkflows} 用例专门锁这一点。</p>
 *
 * <h3>能力边界（诚实声明：这是纵深防御，不是不可绕过的安全边界）</h3>
 *
 * <ul>
 *   <li>路径藏在自定义 shell 变量里（{@code $d="D:\out"; Set-Content "$d\f.txt" x}）——
 *       变量值不在本层可见，只展开少数已知形态（{@code ~}、{@code $HOME}、{@code $env:X}、{@code %X%}）；</li>
 *   <li>由被调程序自身拼接路径的读写（{@code node -e "fs.readFileSync(...)"}、
 *       {@code python -c "open(...,'w')"}）——那是脚本内部行为，本层只看命令行文本；</li>
 *   <li>经管道 / 脚本块间接产生的访问（{@code Get-ChildItem D:\out | ForEach-Object { ... }}）。</li>
 * </ul>
 *
 * <p>要覆盖这些需要 OS 内核级沙盒（Seatbelt / bwrap / Windows 作业对象），
 * 即 {@code sandboxSystemRestrict=true} 那条路径。本类解决的是「默认档下最常见的直接越界读写」，
 * 不是全部——把它当成完整边界是误用。</p>
 *
 * <h3>与 {@link HitlStrategy} 的分工</h3>
 *
 * <p>那边管「不可逆的危险<b>形态</b>」（递归删除、提权、关机、下载即执行、凭据访问、
 * 写启动文件），这边管「读到 / 写到了<b>哪里</b>」。两者互补且有重叠
 * （{@code rm -rf D:\out} 两边都命中）——重叠是好事，任一条被绕过时另一条仍在。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public final class BashPathGuard {

    private BashPathGuard() {
    }

    /** 包装器命令（{@code sh -c} / {@code powershell -Command} 等）的最大递归展开层数。 */
    private static final int MAX_UNWRAP_DEPTH = 4;

    // ==========================================================================
    // 结果类型
    // ==========================================================================

    /**
     * 越界访问命中。
     *
     * <p>只报告<b>第一个</b>命中：审批卡要给用户看的是「这条命令想动工作区外的什么」，
     * 一条足够定性，列全部只会把卡片撑成噪音。</p>
     *
     * <p>区分读/写是因为两者的<b>严重程度不同</b>：写不可逆（删了就没了、覆盖了就回不来），
     * 读可撤销但会泄露内容。两者同时命中时必须报写——告诉用户「这操作删了就没了」
     * 比「这操作读到了外面」重要得多。故 {@link #inspect} 采用两趟扫描、写优先。</p>
     */
    public static final class Violation {

        private final String target;
        private final String verb;
        private final boolean write;

        Violation(String target, String verb, boolean write) {
            this.target = target;
            this.verb = verb;
            this.write = write;
        }

        /** 越界目标的绝对路径（已归一化）。 */
        public String target() {
            return target;
        }

        /** 触发的动词或形态（如 {@code Set-Content}、{@code >}、{@code rm}、{@code cat}）。 */
        public String verb() {
            return verb;
        }

        /**
         * 是写命中还是读命中。
         *
         * <p>审批文案据此分叉：写说「写入」、读说「读取」。写错成读会让用户低估风险
         * （以为只是看一眼，实际是覆写），反之则会高估。</p>
         */
        public boolean isWrite() {
            return write;
        }

        @Override
        public String toString() {
            return (write ? "W " : "R ") + verb + " → " + target;
        }
    }

    // ==========================================================================
    // 对外入口
    // ==========================================================================

    /**
     * 检查一条命令是否含有工作区外的访问目标（读或写）。
     *
     * <p><b>两趟扫描、写优先</b>：先找越界写，没找到再找越界读。这不只是文案优先级——
     * 写不可逆而读可撤销，两者同时命中时报写才能让用户看到真正的风险。
     * 单趟扫描「谁先出现报谁」会让 {@code cat D:\out\f > D:\out\g} 报成读。</p>
     *
     * @param command       原始命令文本（{@code ~} 未展开）；null / 空白直接放行
     * @param workspaceRoot 工作区根目录。<b>为 null 时不做任何判定</b>（返回 null）：
     *                      边界必须由调用方给出，本类无法凭空造出一个「界内」的定义，
     *                      猜一个（比如取 user.dir）反而会把无关目录判成越界
     * @param extraExempts  额外豁免目录（来自用户配置，<b>读写同时豁免</b>），可为 null
     * @return 首个命中（写优先）；未发现越界访问返回 null
     */
    public static Violation inspect(String command, Path workspaceRoot, Collection<Path> extraExempts) {
        if (command == null || command.trim().isEmpty() || workspaceRoot == null) {
            return null;
        }

        // \r\n 归一：换行是段分隔符，残留的 \r 会粘在 token 尾部污染路径判定
        String text = command.replace("\r\n", "\n");

        Scan writeScan = new Scan(workspaceRoot, extraExempts, true);
        writeScan.run(text, 0);
        if (writeScan.hit != null) {
            return writeScan.hit;
        }

        Scan readScan = new Scan(workspaceRoot, extraExempts, false);
        readScan.run(text, 0);
        return readScan.hit;
    }

    /**
     * 内置豁免目录：构建 / 包管理缓存与系统临时目录（<b>读写同时豁免</b>）。
     *
     * <p>这些目录必然在工作区外，但访问它们是<b>工具链的正常行为</b>而非越权：
     * {@code mvn} 读写 {@code ~/.m2}、{@code npm} 读写 {@code ~/.npm}、{@code cargo} 读写
     * {@code ~/.cargo}、编译器读写临时目录。不豁免会让默认档下几乎每次构建都弹审批，
     * 而审批疲劳的终点是用户无脑点「批准」。</p>
     *
     * <p><b>读写都豁免</b>：既然「读也拦」，若只豁免写，那么 {@code cat ~/.m2/settings.xml}
     * 这类完全正当的构建链读取会天天弹审批，豁免清单就形同虚设。
     * 该语义由 {@code exemptionAlsoAppliesToReads} 用例锁住（变异 R9 把它改成只豁免写，测试会红）。</p>
     *
     * <p>只覆盖「缓存 / 可重建产物」语义的目录，不含 {@code ~/.ssh}、{@code ~/.aws}、
     * {@code ~/Documents} 等凭据与用户数据区——读写它们都该弹审批。</p>
     */
    public static List<Path> defaultExemptRoots() {
        List<Path> roots = new ArrayList<>();

        // --- 系统临时目录 ---
        addAbsolute(roots, System.getProperty("java.io.tmpdir"));
        addAbsolute(roots, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp",
                "/var/folders", "/private/var/folders", "/dev/shm",
                "C:/Windows/Temp", "C:/Windows/SoftwareDistribution/Download");

        // --- 家目录下的构建 / 包管理缓存 ---
        String home = System.getProperty("user.home");
        if (home != null && !home.isEmpty()) {
            for (String rel : HOME_CACHE_DIRS) {
                addAbsolute(roots, home + "/" + rel);
            }
        }

        // --- Windows 侧的缓存目录（与 user.home 同盘但路径形态不同）---
        addAbsolute(roots, System.getenv("LOCALAPPDATA"), System.getenv("APPDATA"),
                System.getenv("TEMP"), System.getenv("TMP"), System.getenv("USERPROFILE") + "/AppData/Local/Temp");

        return Collections.unmodifiableList(roots);
    }

    /**
     * 家目录下的缓存类子目录（相对 {@code user.home}）。
     *
     * <p>刻意只收<b>缓存与可重建产物</b>：删了会重新下载 / 重新生成的东西。
     * {@code ~/.ssh}、{@code ~/.aws}、{@code ~/.config}、{@code ~/.kube} 等承载凭据或
     * 用户配置的目录不在列——写它们该走审批。</p>
     *
     * <p>Windows 的 {@code AppData} 项在其它平台上是死条目（路径不存在），
     * 收录它们零成本：{@link #addAbsolute} 只登记字面量，不存在的目录永远不会命中，
     * 也就永远不会误放行。</p>
     */
    private static final String[] HOME_CACHE_DIRS = {
            // JVM 生态
            ".m2", ".m2/repository", ".m2/wrapper", ".gradle", ".gradle/caches",
            ".ivy2", ".sbt", ".javafx", ".jdk",
            // Node 生态
            ".npm", ".yarn", ".yarn-cache", ".pnpm-store", ".pnpm-state", ".bun", ".deno",
            ".nvm", ".volta", ".node-gyp", ".electron", ".electron-gyp", ".cache",
            // 其它语言 / 包管理器
            ".cargo", ".rustup", ".gem", ".bundle", ".composer", ".pub-cache", ".nuget",
            ".dotnet", ".pyenv", ".local/share/pip", ".local/share/uv", ".local/share/virtualenvs",
            ".local/share/pypoetry", ".local/share/coursier", ".pip", ".conda", ".pkgs",
            ".mono", ".cocoapods", ".android", ".android/cache", ".android/avd",
            ".oracle_jre_usage", ".openjfx", ".swt", ".tooling",
            "go/pkg", "go/build", "sdk",
            // macOS / Windows 平台缓存
            "Library/Caches", "Library/Developer/Xcode/DerivedData",
            "Library/Developer/CoreSimulator/Caches", "Library/Developer/Xcode/iOS DeviceSupport",
            "Library/Android/sdk",
            "AppData/Local/Temp", "AppData/Local/pip", "AppData/Local/pip/cache",
            "AppData/Local/npm-cache", "AppData/Local/Yarn", "AppData/Local/Yarn/Cache",
            "AppData/Local/NuGet", "AppData/Local/NuGet/v3-cache", "AppData/Local/NuGet/plugins",
            "AppData/Local/Microsoft/Windows/INetCache", "AppData/Local/CrashDumps",
            "AppData/Local/uv", "AppData/Local/uv/cache", "AppData/Local/pnpm",
            "AppData/Local/pnpm-cache", "AppData/Local/pnpm-store", "AppData/Local/Go",
            "AppData/Local/JetBrains", "AppData/Local/Microsoft/WindowsApps",
            "AppData/Roaming/npm-cache", "AppData/Roaming/npm",
    };

    /**
     * 把用户配置的豁免目录字面量解析成可比较的绝对路径。
     *
     * <p>存在的理由：{@code ~} 与环境变量（{@code $env:X}、{@code %X%}）的展开逻辑
     * 必须只有一份实现。若让调用方（settings 读取处）自己展开，两处口径迟早漂移——
     * 而漂移的后果是「配了豁免但没生效」，用户只能整档切到完全访问，正好是配置项
     * 想避免的那个坏结果。故本方法对外暴露，内部复用 {@link #expandVars}。</p>
     *
     * <p><b>非法条目静默跳过而不抛错</b>：豁免清单少一项只会让判定<b>更严</b>
     * （多弹一次审批），不会造成越权；反之，因为一个拼错的目录就让保存失败或
     * 让整个护栏失效，代价完全不成比例。</p>
     *
     * <p>展开后仍含 {@code $} / {@code %}（环境变量在本机不存在）的条目会被丢弃：
     * 这样的路径无法与真实目标比对，留着也只是永不会命中的死条目。</p>
     *
     * @param literals 用户配置的目录字面量，可为 null
     * @return 解析成功的绝对路径（不可变，可能为空列表，绝不为 null）
     */
    public static List<Path> resolveExemptDirs(Collection<String> literals) {
        if (literals == null || literals.isEmpty()) {
            return Collections.emptyList();
        }

        List<Path> out = new ArrayList<>(literals.size());
        for (String raw : literals) {
            if (raw == null) {
                continue;
            }
            String text = raw.trim();
            if (text.isEmpty()) {
                continue;
            }

            String expanded = expandVars(text);
            if (expanded == null) {
                continue;
            }
            expanded = expanded.trim();
            if (expanded.isEmpty() || isUnjudgeable(expanded)) {
                continue;
            }

            try {
                out.add(Paths.get(expanded).toAbsolutePath().normalize());
            } catch (RuntimeException ignored) {
                // 非法路径字面量（如 Windows 下的非法字符）直接丢弃
            }
        }
        return Collections.unmodifiableList(out);
    }

    /**
     * 把候选路径字面量登记为豁免根。
     *
     * <p>{@code null} / 空白 / 非法字面量一律跳过：豁免清单少一项只会让判定<b>更严</b>
     * （多弹一次审批），不会造成越权，因此这里不需要抛错。</p>
     */
    private static void addAbsolute(List<Path> roots, String... candidates) {
        for (String c : candidates) {
            if (c == null || c.trim().isEmpty() || c.trim().equals("null")) {
                continue;
            }
            try {
                roots.add(Paths.get(c.trim()).toAbsolutePath().normalize());
            } catch (RuntimeException ignored) {
                // 非法路径字面量直接丢弃
            }
        }
    }

    // ==========================================================================
    // 动词表
    // ==========================================================================

    /**
     * 位置参数中「哪些是写目标」的取法。
     *
     * <p>三方言在这一点上惊人地一致：{@code rm} 与 {@code Remove-Item} 都是「全部位置参数即目标」，
     * {@code cp} 与 {@code Copy-Item} 都是「最后一个即目标」。因此 Unix 命令、CMD 命令、
     * PowerShell cmdlet 与其别名可以共用一张表。</p>
     */
    private enum Mode {
        /** 所有位置参数都是写目标（rm / del / Remove-Item / mkdir / touch / tee）。 */
        ALL,
        /** 只有最后一个位置参数是写目标（cp / mv / rsync / Copy-Item / Move-Item）。 */
        LAST,
        /** 只有第一个位置参数是写目标（zip / patch / Export-Csv / Rename-Item）。 */
        FIRST,
        /** 只有第二个位置参数是写目标（robocopy SRC DST、7z a ARCHIVE FILES）。 */
        SECOND,
        /**
         * 位置参数里<b>没有</b>写目标，只有命名参数才是（unzip：位置参数是被读的归档，
         * 写目标是 {@code -d DIR}）。
         */
        NONE,
        /**
         * 跳过第一个位置参数，其余全部是目标。
         *
         * <p>专用于「首个位置参数不是路径」的读命令：
         * {@code grep PATTERN FILE...}、{@code findstr PATTERN FILE...}、
         * {@code sed SCRIPT FILE...}、{@code awk SCRIPT FILE...}。
         * 用 ALL 会把 pattern / 脚本正文当路径送进判定：
         * {@code grep "D:\\out\\x" a.txt} 里的 pattern 长得像绝对路径，会被误报越界。</p>
         */
        SKIP_FIRST_ALL
    }

    /**
     * 一个动词的目标提取规则（读写共用同一结构）。
     *
     * @param mode        位置参数取法
     * @param pathParams  命名参数（小写、不含前导 {@code -}）其值为目标路径：覆盖 PowerShell 的
     *                    {@code -Path} / {@code -Destination}、{@code unzip -d} 等
     * @param skipParams  命名参数其值<b>不是</b>路径，必须连同值一起跳过
     *                    （{@code -Value}、{@code -Encoding}…）。不跳过就会把
     *                    {@code -Value "hello"} 里的 hello 当路径判定
     * @param gateFlag    配合 {@code gateAbsent} 使用的旗标；null 表示无条件检查
     * @param gateAbsent  gateFlag 的判定方向：
     *                    <ul>
     *                      <li>{@code false} = 仅当段内<b>出现</b>该旗标时才检查
     *                          （写表里的 {@code sed -i}、{@code find -delete}）；</li>
     *                      <li>{@code true} = 仅当段内<b>没有</b>该旗标时才检查
     *                          （读表里的 {@code sed}、{@code find}）。</li>
     *                    </ul>
     *                    <b>这个反向语义是必需的</b>：{@code sed s/a/b/ D:\out\f} 不带 {@code -i}
     *                    时是纯读，带了才是写。若读表也写成「有 -i 才检查」，
     *                    那么不带 -i 的越界读会全部漏判；若写成无条件检查，
     *                    那么 {@code sed -i} 会被读写两表重复报（虽然写优先会掩盖，但语义不清）。
     */
    private static final class Rule {
        final Mode mode;
        final Set<String> pathParams;
        final Set<String> skipParams;
        final String gateFlag;
        final boolean gateAbsent;

        Rule(Mode mode) {
            this(mode, null, null, null, false);
        }

        Rule(Mode mode, String[] pathParams, String[] skipParams, String gateFlag) {
            this(mode, pathParams, skipParams, gateFlag, false);
        }

        Rule(Mode mode, String[] pathParams, String[] skipParams, String gateFlag, boolean gateAbsent) {
            this.mode = mode;
            this.pathParams = lowerSet(pathParams);
            this.skipParams = skipParams == null ? PS_NON_PATH_PARAMS : lowerSet(skipParams);
            this.gateFlag = gateFlag;
            this.gateAbsent = gateAbsent;
        }

        private static Set<String> lowerSet(String[] in) {
            if (in == null) {
                return Collections.emptySet();
            }
            Set<String> set = new HashSet<>(in.length * 2);
            for (String s : in) {
                set.add(s.toLowerCase(Locale.ROOT));
            }
            return set;
        }
    }

    /**
     * PowerShell 通用的「带值但非路径」参数名。
     *
     * <p>作为所有 PS cmdlet 规则的默认跳过集：{@code -Value}、{@code -Encoding} 之类的值
     * 若被当路径判定，轻则误报越界（值恰为绝对路径形态时），重则把命令内容当文件名。
     * 宁可多跳过一个参数名，也不要把非路径值送进边界判定。</p>
     */
    private static final Set<String> PS_NON_PATH_PARAMS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "value", "encoding", "type", "itemtype", "property", "propertytype", "name",
            "newname", "delimiter", "width", "depth", "stream", "inputobject", "totalcount",
            "tail", "head", "first", "last", "skip", "replace", "filter", "include", "exclude",
            "confirm", "whatif", "erroraction", "errorvariable", "warningaction", "verbose",
            "debug", "outvariable", "outbuffer", "pipelinevariable", "informationaction",
            "force", "recurse", "nonewline", "passthru", "quiet", "credential", "usessl",
            "command", "argumentlist", "workingdirectory", "windowstyle", "verb", "reason",
            "activity", "status", "currentoperation", "parentid", "sourceidentifier",
            "valueonly", "asstring", "asbyte", "nooverwrite", "container", "attributes",
            "culture", "throttlelimit", "timeoutsec", "sessionoption", "authentication",
            "body", "headers", "method", "contenttype", "useragent", "proxy", "proxycredential",
            "infile", "outfile", "responseheadersvariable", "skiphttperrorcheck", "statuscode",
            "statusdescription", "maximumredirection", "allowunencrypted", "port", "computername",
            "pattern", "casesensitive", "simplematch", "context", "allmatches", "raw",
            "readcount", "wait", "noversioncheck", "module", "list", "class", "namespace"
    )));

    /** PowerShell 里代表「写目标」的命名参数名（小写、不含 {@code -}）。 */
    private static final String[] PS_PATH_PARAMS = {
            "path", "literalpath", "destination", "destinationpath", "filepath", "target",
            "fullpath", "filename", "d"
    };

    /**
     * <b>写</b>动词表：key 一律小写。读动词在 {@link #READ_RULES}。
     *
     * <p>收录标准只有一条——<b>该动词会在文件系统上产生写效果</b>。</p>
     *
     * <p><b>为何读写分两张表而不是一张表加标志位</b>：同一动词在读写两侧的位置参数语义
     * 往往不同——{@code cp SRC DST} 写侧取 LAST（DST），读侧取 FIRST（SRC）；
     * {@code unzip ARCHIVE -d DIR} 写侧 ARCHIVE 不算目标（Mode.NONE），读侧它恰恰是目标。
     * 强行合并会变成一堆条件分支，每改一处都要同时想读和写，漂移只是时间问题。
     * 两表共用 {@link Rule} 结构与 {@code Scan.check} 判定，重复的只有登记行。</p>
     *
     * <p><b>刻意排除的歧义命令</b>：{@code sc}（PS 的 Set-Content 别名，但同时是 Windows 的
     * 服务控制程序 {@code sc.exe}，且 Unix 下是电子表格）。{@code sc \\server config svc}
     * 里的 UNC 主机名会被当成写目标而误报越界，故只保留无歧义的 {@code set-content}。</p>
     */
    private static final Map<String, Rule> WRITE_RULES;

    static {
        Map<String, Rule> m = new HashMap<>(128);

        Rule all = new Rule(Mode.ALL);
        Rule last = new Rule(Mode.LAST);
        Rule first = new Rule(Mode.FIRST);
        Rule second = new Rule(Mode.SECOND);
        Rule psPathAll = new Rule(Mode.ALL, PS_PATH_PARAMS, null, null);
        Rule psPathFirst = new Rule(Mode.FIRST, PS_PATH_PARAMS, null, null);

        // ---- 删除类（Unix / CMD / PS 共用：全部位置参数都是目标）----
        for (String v : new String[]{"rm", "del", "erase", "unlink", "shred", "rmdir", "rd", "srm"}) {
            m.put(v, all);
        }
        m.put("remove-item", psPathAll);
        m.put("ri", psPathAll);

        // ---- 创建类 ----
        for (String v : new String[]{"mkdir", "md", "touch", "mkfifo", "mknod"}) {
            m.put(v, all);
        }
        m.put("new-item", new Rule(Mode.ALL, new String[]{"path", "literalpath"}, null, null));
        m.put("ni", new Rule(Mode.ALL, new String[]{"path", "literalpath"}, null, null));

        // ---- 复制 / 移动 / 安装 / 链接（目标 = 最后一个位置参数）----
        for (String v : new String[]{"cp", "copy", "mv", "move", "install", "rsync", "scp", "ln"}) {
            m.put(v, last);
        }
        m.put("copy-item", new Rule(Mode.LAST, new String[]{"destination"}, null, null));
        m.put("cpi", new Rule(Mode.LAST, new String[]{"destination"}, null, null));
        m.put("move-item", new Rule(Mode.LAST, new String[]{"destination"}, null, null));
        m.put("mi", new Rule(Mode.LAST, new String[]{"destination"}, null, null));
        m.put("xcopy", last);
        m.put("robocopy", second);
        m.put("mklink", first);
        m.put("ren", first);
        m.put("rename", first);
        m.put("rename-item", psPathFirst);
        m.put("rni", psPathFirst);

        // ---- 写入内容类 ----
        m.put("tee", all);
        m.put("truncate", last);
        m.put("set-content", psPathAll);
        m.put("add-content", psPathAll);
        m.put("ac", psPathAll);
        m.put("out-file", new Rule(Mode.ALL, new String[]{"filepath", "literalpath"}, null, null));
        m.put("set-item", psPathAll);
        m.put("si", psPathAll);
        m.put("clear-item", psPathAll);
        m.put("cli", psPathAll);
        m.put("clear-content", psPathAll);
        m.put("export-csv", psPathFirst);
        m.put("export-clixml", psPathFirst);
        m.put("set-acl", psPathFirst);
        m.put("new-itemproperty", psPathFirst);
        m.put("set-itemproperty", psPathFirst);
        m.put("remove-itemproperty", psPathFirst);
        m.put("clear-itemproperty", psPathFirst);
        m.put("move-itemproperty", new Rule(Mode.FIRST, new String[]{"destination"}, null, null));
        m.put("copy-itemproperty", new Rule(Mode.FIRST, new String[]{"destination"}, null, null));

        // ---- 归档 / 压缩（写目标形态各异，用位置参数近似）----
        m.put("zip", first);
        m.put("7z", second);
        m.put("7za", second);
        m.put("7zr", second);
        m.put("gzip", all);
        m.put("bzip2", all);
        m.put("xz", all);
        m.put("zstd", all);
        m.put("compress-archive", new Rule(Mode.FIRST, new String[]{"destinationpath"}, null, null));
        m.put("expand-archive", new Rule(Mode.FIRST, new String[]{"destinationpath"}, null, null));
        // unzip 的位置参数是被<b>读</b>的归档，写目标是 -d 指定的目录
        m.put("unzip", new Rule(Mode.NONE, new String[]{"d"}, null, null));

        // ---- 就地改写（仅带对应旗标时才写；不带时归读表）----
        m.put("sed", new Rule(Mode.ALL, null, null, "-i"));
        m.put("gsed", new Rule(Mode.ALL, null, null, "-i"));
        m.put("perl", new Rule(Mode.ALL, null, null, "-i"));
        m.put("find", new Rule(Mode.FIRST, null, null, "-delete"));
        m.put("gfind", new Rule(Mode.FIRST, null, null, "-delete"));

        // ---- 打补丁（目标 = 被改写的文件）----
        m.put("patch", first);

        // ---- 下载落盘（目标路径显式写在命令行上）----
        m.put("certutil", last);
        m.put("bitsadmin", last);

        WRITE_RULES = Collections.unmodifiableMap(m);
    }

    /**
     * 读动词表：key 一律小写。
     *
     * <p><b>为何要单独一张表而不是一张表加标志位</b>：读写的位置参数语义完全不同。
     * {@code cp SRC DST} 在写表里取 LAST（DST 是写目标），但在读表里 SRC 才是读目标；
     * {@code unzip ARCHIVE -d DIR} 在写表里 ARCHIVE 不算目标（Mode.NONE），在读表里它恰恰是目标。
     * 强行合并会把两种语义搞成一堆条件分支，每改一处都要同时想读和写，漂移只是时间问题。</p>
     *
     * <p><b>刻意不收录的动词</b>：{@code mvn}、{@code npm}、{@code git}、{@code cargo}、{@code javac} 等
     * 构建与版本控制工具。它们确实会读工作区外的文件（依赖仓库、全局 git 配置），
     * 但路径不在命令行上，本层看不到；而它们的日常使用频率极高，
     * 一旦拦下来默认档就没法干活了。构建缓存目录已在豁免清单内，
     * 且写表已覆盖它们带路径参数的写入形态。</p>
     *
     * <p>另：{@code ls} 类命令的递归遍历由 {@code flatListLogic} 负责（结构化文件工具），
     * bash 侧只拦命令行上显式写出的路径。</p>
     */
    private static final Map<String, Rule> READ_RULES;

    static {
        Map<String, Rule> m = new HashMap<>(96);

        // 全部位置参数都是读目标（cat a b c 会依次读三个文件）
        Rule all = new Rule(Mode.ALL);
        Rule psPathAll = new Rule(Mode.ALL, PS_PATH_PARAMS, null, null);
        // 本块的 first 与 WRITE_RULES 块里的同名局部变量无关（各自 static 块作用域独立），
        // 语义也相反：写表里 FIRST 取的是「被改写的文件」，读表里取的是「被读的源」。
        Rule first = new Rule(Mode.FIRST);

        // ---- 类 Unix 读命令 ----
        // 注意：awk/gawk/sed/perl 不在这里——它们的首个位置参数是<b>脚本正文</b>而非路径，
        // 必须用 SKIP_FIRST_ALL，否则会拿 `{print $1}` 这类脚本文本去做边界判定。
        for (String v : new String[]{"cat", "tac", "bat", "less", "more", "head", "tail",
                "nl", "od", "xxd", "hexdump", "strings", "file", "stat", "wc", "md5sum",
                "sha1sum", "sha256sum", "cksum", "du", "tree", "cut", "sort",
                "uniq", "diff", "cmp", "comm", "paste", "join", "column", "expand", "unexpand"}) {
            m.put(v, all);
        }
        // grep 族：首个位置参数是 pattern（不是路径），其余才是被读的文件
        Rule skipFirst = new Rule(Mode.SKIP_FIRST_ALL);
        m.put("grep", skipFirst);
        m.put("egrep", skipFirst);
        m.put("fgrep", skipFirst);
        m.put("zgrep", skipFirst);
        m.put("rg", skipFirst);
        m.put("ag", skipFirst);
        m.put("findstr", skipFirst);
        // Select-String / sls：-Path 是命名参数（PS 常规写法），位置参数形态与 grep 相同
        // （首参是 pattern）。这两条<b>只能登记一次</b>：曾被后面的 PowerShell 块再 put 一次
        // Mode.ALL 版本并覆盖本条，使 pattern 被当成检索目标——界内检索
        // Select-String "<界外绝对路径>" src/a.txt 会误报越界读，而同形态的 grep / findstr 放行。
        // 护栏：verbTablesHaveNoDuplicateKeys 用例锁「表内无重复键」，patternIsNotTreatedAsReadTarget 锁行为。
        Rule psSkipFirst = new Rule(Mode.SKIP_FIRST_ALL, new String[]{"path", "literalpath"}, null, null);
        m.put("select-string", psSkipFirst);
        m.put("sls", psSkipFirst);
        // ls 族：列目录
        for (String v : new String[]{"ls", "dir", "eza", "exa"}) {
            m.put(v, all);
        }

        // ---- CMD 读命令 ----
        m.put("type", all);
        m.put("more", all);

        // ---- 复制 / 移动的<b>源</b>：跨盘复制会把外部内容读进来，源也算越界读 ----
        // 写表已覆盖它们的目标侧（Mode.LAST / SECOND），这里补源侧（Mode.FIRST）。
        // 同盘 mv 是 rename、不读内容，但按源路径判定同样合理：它确实在动工作区外的对象。
        m.put("cp", first);
        m.put("copy", first);
        m.put("copy-item", new Rule(Mode.FIRST, new String[]{"path", "literalpath"}, null, null));
        m.put("cpi", new Rule(Mode.FIRST, new String[]{"path", "literalpath"}, null, null));
        m.put("mv", first);
        m.put("move", first);
        m.put("move-item", new Rule(Mode.FIRST, new String[]{"path", "literalpath"}, null, null));
        m.put("mi", new Rule(Mode.FIRST, new String[]{"path", "literalpath"}, null, null));
        m.put("xcopy", first);
        m.put("robocopy", first);
        m.put("rsync", first);
        m.put("scp", first);
        m.put("install", first);

        // ---- PowerShell 读 cmdlet 与别名 ----
        m.put("get-content", psPathAll);
        m.put("gc", psPathAll);
        m.put("cat", psPathAll);          // PS 里 cat 是 Get-Content 别名（与 Unix 同名，语义一致）
        m.put("get-item", psPathAll);
        m.put("gi", psPathAll);
        m.put("get-childitem", psPathAll);
        m.put("gci", psPathAll);
        m.put("dir", psPathAll);          // PS 里 dir 是 Get-ChildItem 别名（与 CMD dir 同名，都是读）
        m.put("ls", psPathAll);           // PS 里 ls 是 Get-ChildItem 别名
        m.put("get-itemproperty", psPathAll);
        m.put("gp", psPathAll);
        m.put("import-csv", psPathAll);
        m.put("import-clixml", psPathAll);
        m.put("convertfrom-json", psPathAll);
        m.put("get-acl", psPathAll);
        m.put("get-filehash", psPathAll);
        m.put("gfh", psPathAll);
        m.put("test-path", psPathAll);
        m.put("resolve-path", psPathAll);
        m.put("get-contentraw", psPathAll);

        // ---- 归档：位置参数是被读的归档（与写表的 Mode.NONE 相反）----
        m.put("unzip", new Rule(Mode.FIRST));
        m.put("zipinfo", new Rule(Mode.FIRST));
        m.put("gzip", new Rule(Mode.ALL));   // gzip -l / -t 是读；写形态由写表按旗标覆盖
        m.put("bzip2", new Rule(Mode.ALL));
        m.put("xz", new Rule(Mode.ALL));
        m.put("zstd", new Rule(Mode.ALL));
        m.put("expand-archive", new Rule(Mode.FIRST, new String[]{"path", "literalpath"}, null, null));

        // ---- 反向 gate：不带写旗标时才算读 ----
        // sed/gsed 的首个位置参数是脚本正文（不是路径），故用 SKIP_FIRST_ALL
        m.put("sed", new Rule(Mode.SKIP_FIRST_ALL, null, null, "-i", true));
        m.put("gsed", new Rule(Mode.SKIP_FIRST_ALL, null, null, "-i", true));
        m.put("perl", new Rule(Mode.SKIP_FIRST_ALL, null, null, "-i", true));
        m.put("awk", skipFirst);
        m.put("gawk", skipFirst);
        m.put("mawk", skipFirst);
        // find 的起点目录是首个位置参数（与写表同口径：写表也用 FIRST 取起点）
        m.put("find", new Rule(Mode.FIRST, null, null, "-delete", true));
        m.put("gfind", new Rule(Mode.FIRST, null, null, "-delete", true));

        // ---- 补丁：读源补丁文件 ----
        m.put("patch", all);

        READ_RULES = Collections.unmodifiableMap(m);
    }

    /**
     * 需要专属提取逻辑的动词：写目标挂在旗标上，通用位置参数规则表达不了。
     *
     * <p>且同一旗标在不同动词 / 不同模式下含义不同（{@code tar -f} 在创建时是写归档、
     * 在解压时是读归档），因此只能各写各的。</p>
     */
    private static final Set<String> SPECIAL_VERBS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "dd", "tar", "gtar", "bsdtar", "curl", "curl.exe", "wget", "aria2c", "axel", "fetch"
    )));

    /**
     * 包装器分两类。分法的唯一依据是<b>「会不会带命令载荷标记」</b>，
     * 而不是「后面跟命令还是脚本」。
     *
     * <p><b>本仓实证的教训</b>：早期版本只有一个 {@code WRAPPERS} 集合，而
     * {@code wrapperPayload} 的「无标记包装器」兜底分支只白名单了 6 个提权器
     * （sudo/doas/runas/gsudo/su/wsl）。于是集合里另外 8 个成员
     * （nohup/time/nice/ionice/stdbuf/setsid/eval 及 shell 启动器的无标记形态）
     * 走到兜底时 {@code return null} → 整段<b>完全不检查</b>：
     * {@code nohup Set-Content D:\out\f.txt x}、{@code bash D:\out\x.sh}、
     * {@code powershell -File D:\out\x.ps1} 在默认档下全部静默放行。
     * 更糟的是形态轴的 {@code CMD_ANCHOR} 也不认前缀词，于是
     * {@code nohup rm -rf <工作区外>} 两轴同时失守——不可逆递归删除零审批。
     * <b>声明表与实际消费逻辑必须有一致性护栏</b>，见
     * {@code BashPathGuardTest#everyDeclaredWrapperIsActuallyHandled}。</p>
     *
     * <p><b>刻意不再区分「命令展开型」与「脚本文件型」</b>：曾有一张独立的
     * {@code SCRIPT_LAUNCHERS} 表，但当脚本文件判定被提升到<b>所有</b>包装器通用
     * （{@code nohup D:\out\x.sh} 与 {@code bash D:\out\x.sh} 语义相同）后，
     * 那张表就不再驱动任何行为分支了。变异验证实测：删掉它的成员，所有用例仍全绿
     * （等价变异）——因为它剩下的成员几乎全是 {@code COMMAND_WRAPPERS} 的子集。
     * <b>保留一个「名字叫 X 型、却不决定任何 X 行为」的分类表，就是下一个误导源</b>：
     * 后人会以为往里面加成员能改变行为，实际上加了没用。
     * 「后面跟的是脚本文件」现在是一个横切所有包装器的<b>通用判定</b>
     * （见 {@code expandUnmarkedPayload}），不是一类包装器。</p>
     */

    /**
     * ① 命令展开型：可能带载荷标记（{@code -c} / {@code /c} / {@code -Command} / {@code -File}），
     * 也可能不带（{@code sudo X}、{@code bash x.sh}、{@code source x.sh}）。
     *
     * <p>不展开就是绕过口子：{@code sh -c "rm -rf /opt/x"}、
     * {@code powershell -Command "Set-Content D:\out\f.txt x"}、
     * {@code powershell -EncodedCommand <base64>} 都能把越界写藏进字符串参数里。
     * {@code -EncodedCommand} 尤其关键——它是 Base64(UTF-16LE)，肉眼审不出来。</p>
     */
    private static final Set<String> COMMAND_WRAPPERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "sh", "bash", "zsh", "ksh", "dash", "fish", "ash", "csh", "tcsh",
            "source", ".",
            "powershell", "powershell.exe", "pwsh", "pwsh.exe",
            "cmd", "cmd.exe",
            "wsl", "wsl.exe",
            "sudo", "doas", "su", "runas", "runas.exe", "gsudo"
    )));

    /**
     * ② 前缀修饰器型：<b>永远不带命令载荷标记</b>，自身选项之后紧跟被修饰的命令。
     *
     * <p>它们只是给命令加调度属性（后台 / 计时 / 优先级 / 缓冲 / 会话），语义上等价于
     * 「命令原样执行」。故处理逻辑与提权器相同：跳过自身选项后，余下全部字就是 payload。</p>
     *
     * <p>{@code eval} / {@code exec} 归本类而非命令展开型：它们的参数是<b>字符串形式的命令</b>
     * 而非脚本文件，且从不带 {@code -c} 这类标记，展开后按命令解析才正确。</p>
     *
     * <p><b>这张表驱动真实行为</b>（{@code handleWrapper} 的分支 ①），所以它不是死分类：
     * 往里加一个词，那个词就不再走「扫载荷标记」的循环了。
     * 与形态轴的锚点白名单必须同步，由
     * {@code HitlStrategyTest#prefixModifierVocabularyIsConsistentAcrossBothAxes} 锁住。</p>
     */
    private static final Set<String> PREFIX_MODIFIERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "nohup", "time", "nice", "ionice", "stdbuf", "setsid", "eval", "exec"
    )));

    /** 两类之并：{@code handleSegment} 用它判定「这一段要不要走包装器逻辑」。 */
    private static final Set<String> WRAPPERS = unionOf(COMMAND_WRAPPERS, PREFIX_MODIFIERS);

    /** 并集工具：用静态方法而非 {@code static {}} 块，避免打破结构护栏对 static 块数量的断言。 */
    @SafeVarargs
    private static Set<String> unionOf(Set<String>... sets) {
        Set<String> out = new HashSet<>();
        for (Set<String> s : sets) {
            out.addAll(s);
        }
        return Collections.unmodifiableSet(out);
    }

    /** 改变「相对路径基准」的动词：其后的相对路径要按新基准解析。 */
    private static final Set<String> CD_VERBS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "cd", "chdir", "pushd", "popd", "set-location", "sl"
    )));

    /**
     * {@code .NET} 静态方法直调：PowerShell 里绕过所有 cmdlet 的写文件方式。
     *
     * <p>{@code [System.IO.File]::WriteAllText("D:\out\f.txt", $c)} 不含任何 cmdlet 名，
     * 动词表完全看不到它；但它是真实的写操作，而且模型确实会用——在 PowerShell 5.1 下
     * 写 UTF-8 无 BOM 文件这是唯一可靠手段。因此单独按方法名提取首个路径参数。</p>
     */
    private static final Pattern DOTNET_WRITE_CALL = Pattern.compile(
            "(?i)\\[?\\s*(?:System\\.IO\\.)?(File|Directory|FileInfo|DirectoryInfo)\\s*\\]?\\s*::\\s*"
                    + "(WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines|"
                    + "OpenWrite|Create|CreateText|Copy|Move|Delete|Replace|Encrypt|Decrypt|"
                    + "SetAttributes|SetCreationTime|SetLastWriteTime|SetLastAccessTime|"
                    + "CreateDirectory|WriteAllTextAsync|WriteAllBytesAsync)\\s*\\(\\s*"
                    + "(?:\"([^\"]*)\"|'([^']*)'|([^,)\\s]+))");

    /**
     * {@code .NET} 静态<b>读</b>方法直调。
     *
     * <p>与写侧分开而非合并成一个模式：两者的<b>命中后果不同</b>（读/写要分开报），
     * 且 {@code File.Open} 这类既可读也可写的方法无法从名字判定意图，
     * 故读侧只收「语义上明确是读」的方法，模棱两可的（Open/OpenRead/OpenWrite）
     * 归入写侧——宁可把可能的读当成写拦（更安全），也不能把可能的写当成读放。</p>
     */
    private static final Pattern DOTNET_READ_CALL = Pattern.compile(
            "(?i)\\[?\\s*(?:System\\.IO\\.)?(File|Directory|FileInfo|DirectoryInfo)\\s*\\]?\\s*::\\s*"
                    + "(ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenText|OpenRead|"
                    + "ReadAllTextAsync|ReadAllBytesAsync|ReadAllLinesAsync|Exists|GetFiles|"
                    + "GetDirectories|GetFileSystemEntries|EnumerateFiles|EnumerateDirectories|"
                    + "GetLastWriteTime|GetLastAccessTime|GetCreationTime|GetAttributes)\\s*\\(\\s*"
                    + "(?:\"([^\"]*)\"|'([^']*)'|([^,)\\s]+))");

    /** {@code dd ... of=PATH} 的写目标。 */
    private static final Pattern DD_OF = Pattern.compile("(?i)(?:^|[\\s;|&])of=([^\\s;|&]+)");

    /** {@code dd ... if=PATH} 的读源。 */
    private static final Pattern DD_IF = Pattern.compile("(?i)(?:^|[\\s;|&])if=([^\\s;|&]+)");

    /** 下载器的落盘目标：{@code curl -o PATH}、{@code wget -O PATH}、{@code aria2c -o PATH}。 */
    private static final Pattern DOWNLOAD_OUT = Pattern.compile(
            "(?i)(?:^|[\\s;|&])(?:-o|-O|--output|--output-document)\\s*=?\\s*([^\\s;|&]+)");

    /** {@code tar} 的归档文件（{@code -f} / {@code --file}，含组合短选项 {@code -czf}）。 */
    private static final Pattern TAR_FILE_FLAG = Pattern.compile(
            "(?i)(?:^|[\\s;|&])--file[=\\s]([^\\s;|&]+)|(?:^|[\\s;|&])-[a-z]*f\\s*([^\\s;|&]+)");

    /** {@code tar} 的解压目录（{@code -C DIR} / {@code --directory DIR}）。 */
    private static final Pattern TAR_DIR_FLAG = Pattern.compile(
            "(?i)(?:^|[\\s;|&])--directory[=\\s]([^\\s;|&]+)|(?:^|[\\s;|&])-C\\s*([^\\s;|&]+)");

    /**
     * {@code tar} 创建模式：组合短选项内任意位置含小写 {@code c}（{@code -c}、{@code -czf}、{@code -cf}），
     * 或长选项 {@code --create}。
     *
     * <p><b>刻意大小写敏感</b>：{@code -C} 是 {@code --directory}（解压目标目录），
     * {@code -c} 才是创建；加了 {@code (?i)} 两者就会混淆，把「读归档解压」判成「写归档」。</p>
     *
     * <p><b>不能要求 c 在组合末尾</b>：真实用法 {@code tar -czf x.tgz src} 里 {@code c} 后面还有
     * {@code zf}，旧写法 {@code -[a-z]*c\b} 匹配不到，创建模式的写目标会全部漏判。</p>
     */
    private static final Pattern TAR_CREATE = Pattern.compile(
            "(?:^|[\\s;|&])(?:-(?=[a-z]*c)[a-z]+(?![A-Za-z0-9])|--create(?![A-Za-z0-9-]))");

    /** {@code tar} 解压模式：组合短选项内任意位置含小写 {@code x}，或长选项 {@code --extract}。 */
    private static final Pattern TAR_EXTRACT = Pattern.compile(
            "(?:^|[\\s;|&])(?:-(?=[a-z]*x)[a-z]+(?![A-Za-z0-9])|--extract(?![A-Za-z0-9-]))");

    /** 非文件系统驱动器前缀：写它们不是文件越界，本类不管（注册表项由别处约束）。 */
    private static final String[] PS_DRIVE_PREFIXES = {
            "hklm:", "hkcu:", "hkcr:", "hku:", "hkcc:", "env:", "cert:", "wsman:",
            "variable:", "function:", "alias:", "registry::", "microsoft.powershell"
    };

    /** 重定向到空设备 / 文件描述符复制：不是真实的文件写入。 */
    private static final Set<String> NULL_TARGETS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero",
            "/dev/random", "/dev/urandom", "nul", "null", "$null", "-", "con", "conout$", "conin$"
    )));

    /**
     * CMD 短选项形态：{@code /s}、{@code /q}、{@code /S /Q}。
     *
     * <p><b>必须排除，否则 Windows 上大面积误报</b>：{@code Paths.get("/s")} 在 Windows 上
     * <b>不是</b>绝对路径（缺盘符），会被 {@code base.resolve} 解析成 {@code D:\s}，
     * 于是 {@code rd /s /q build} 会误报「越界写 D:\s」。</p>
     *
     * <p>限定 1-2 个字母正是为了不与 {@code /tmp}、{@code /var}（Unix 真实目录）混淆。</p>
     */
    private static final Pattern CMD_SHORT_OPTION = Pattern.compile("^/[A-Za-z]{1,2}$");

    // ==========================================================================
    // 词法分析
    // ==========================================================================

    private enum TokKind {
        /** 普通字：命令名、参数、路径。 */
        WORD,
        /** 段分隔符：{@code ; | & && ||} 与换行。 */
        SEP,
        /** 输出重定向符：{@code > >> 2> 1>>}（写信号）。 */
        REDIR_OUT,
        /** 输入重定向符：{@code < <<}（读，本类不关心，仅为正确切词）。 */
        REDIR_IN,
        /** 括号：子 shell / PS 分组，作为硬边界切段。 */
        PAREN
    }

    private static final class Tok {
        final TokKind kind;
        final String text;

        Tok(TokKind kind, String text) {
            this.kind = kind;
            this.text = text;
        }
    }

    /**
     * 反斜杠在其后出现时才充当转义符的字符集（Unix shell 语义）。
     *
     * <p><b>刻意不含</b>字母数字与 {@code : . _ - * ? # = ~ ! ( )}：前四类是 Windows 路径的
     * 常规组成（{@code D:\other\x.txt} 里的 {@code \o} 是路径分隔符而非转义）；后几类在 NTFS 里是
     * <b>合法文件名字符</b>（{@code C:\proj#1\a.txt}、{@code D:\a=b}、{@code C:\Program Files (x86)}），
     * 把它们当转义符会吃掉反斜杠、破坏路径完整性。</p>
     *
     * <p>代价：Unix 下 {@code rm \*}（删除字面名为 {@code *} 的文件）这类极端写法不再被识别为转义。
     * 但该 token 仍含通配符，会走<b>归属目录</b>判定（见 {@link #wildcardPrefix}），
     * 与「识别为转义后同样含 {@code *}」的结果一致，故无实际损失。</p>
     */
    private static final String SHELL_ESCAPABLE = " \t\n\r'\"$`;|&<>";

    /**
     * 把命令文本切成 token 流。
     *
     * <p>为什么必须自己写而不能用正则切分：引号语义在三方言下都不平凡——
     * {@code "a;b"} 里的分号不是分隔符；{@code 'it's'} 在 Unix 下第二个单引号会闭合；
     * PowerShell 双引号内 {@code `} 是转义符而 Unix 下是命令替换。用正则切分必然在这些
     * 地方出错，而错一次就是漏拦或多拦。</p>
     *
     * <p>刻意<b>不</b>实现 {@code $(...)} / 反引号命令替换的嵌套优先级：括号被当作切段符，
     * 内部命令因此会作为独立段被检查。对「提取访问目标」这个目的而言这等价于展开，
     * 且实现简单、不会算错嵌套。</p>
     */

    static List<Tok> tokenize(String s) {
        List<Tok> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean hasCur = false;
        char quote = 0;
        int i = 0;
        int n = s.length();

        while (i < n) {
            char c = s.charAt(i);

            if (quote != 0) {
                // 引号内：只认闭合符与转义。两个方言在双引号内的转义符不同，必须分开处理：
                //   PowerShell 用反引号 `，反斜杠是路径分隔符（"D:\other\x.txt" 必须原样保留）；
                //   bash 用反斜杠，但仅当后跟 $ ` " \ 或换行时才是转义，其它位置是字面量。
                // 旧写法无条件吃掉反斜杠后的字符，使 "D:\other\x.txt" 变成 D:otherx.txt，
                // 于是 PowerShell 的常规写法——引号包裹的 Windows 绝对路径——100% 漏判越界写。
                // 单引号在两个方言下都是完全字面量，由外层 quote == '"' 判定保证不参与转义。
                if (quote == '"' && i + 1 < n) {
                    char nq = s.charAt(i + 1);
                    if (c == '`'
                            || (c == '\\' && (nq == '$' || nq == '`' || nq == '"'
                            || nq == '\\' || nq == '\n'))) {
                        cur.append(nq);
                        i += 2;
                        continue;
                    }
                }
                if (c == quote) {
                    quote = 0;
                    i++;
                    continue;
                }
                cur.append(c);
                i++;
                continue;
            }

            if (c == '\'' || c == '"') {
                // 空引号 "" 也算一个字（例如 -Value ""），故置 hasCur
                quote = c;
                hasCur = true;
                i++;
                continue;
            }

            if (c == '\\' && i + 1 < n) {
                // 只有后跟 shell 元字符时才是转义（Unix 语义：foo\ bar、\$HOME）；
                // 后跟普通字符时反斜杠是 Windows 路径分隔符，必须原样保留——
                // 否则 D:\other\x.txt 会被吃成 D:otherx.txt，越界写在 Windows 上全部漏判。
                char next = s.charAt(i + 1);
                if (SHELL_ESCAPABLE.indexOf(next) >= 0) {
                    cur.append(next);
                    i += 2;
                    continue;
                }
                cur.append('\\');
                hasCur = true;
                i++;
                continue;
            }

            if (c == '\n' || c == ';') {
                if (hasCur) {
                    out.add(new Tok(TokKind.WORD, cur.toString()));
                    cur.setLength(0);
                    hasCur = false;
                }
                out.add(new Tok(TokKind.SEP, String.valueOf(c)));
                i++;
                continue;
            }

            if (c == '|' || c == '&') {
                if (hasCur) {
                    out.add(new Tok(TokKind.WORD, cur.toString()));
                    cur.setLength(0);
                    hasCur = false;
                }
                int j = i;
                StringBuilder op = new StringBuilder();
                while (j < n && (s.charAt(j) == '|' || s.charAt(j) == '&')) {
                    op.append(s.charAt(j));
                    j++;
                }
                out.add(new Tok(TokKind.SEP, op.toString()));
                i = j;
                continue;
            }

            if (c == '(' || c == ')') {
                if (hasCur) {
                    out.add(new Tok(TokKind.WORD, cur.toString()));
                    cur.setLength(0);
                    hasCur = false;
                }
                out.add(new Tok(TokKind.PAREN, String.valueOf(c)));
                i++;
                continue;
            }

            if (c == '>' || c == '<') {
                if (hasCur) {
                    out.add(new Tok(TokKind.WORD, cur.toString()));
                    cur.setLength(0);
                    hasCur = false;
                }
                int j = i;
                StringBuilder op = new StringBuilder();
                while (j < n && (s.charAt(j) == '>' || s.charAt(j) == '<')) {
                    op.append(s.charAt(j));
                    j++;
                }
                out.add(new Tok(op.indexOf(">") >= 0 ? TokKind.REDIR_OUT : TokKind.REDIR_IN, op.toString()));
                i = j;
                continue;
            }

            if (Character.isWhitespace(c)) {
                if (hasCur) {
                    out.add(new Tok(TokKind.WORD, cur.toString()));
                    cur.setLength(0);
                    hasCur = false;
                }
                i++;
                continue;
            }

            cur.append(c);
            hasCur = true;
            i++;
        }

        if (hasCur) {
            out.add(new Tok(TokKind.WORD, cur.toString()));
        }

        return out;
    }

    /** 按段分隔符与括号切分 token 流。 */
    private static List<List<Tok>> splitSegments(List<Tok> toks) {
        List<List<Tok>> segs = new ArrayList<>();
        List<Tok> cur = new ArrayList<>();
        for (Tok t : toks) {
            if (t.kind == TokKind.SEP || t.kind == TokKind.PAREN) {
                if (!cur.isEmpty()) {
                    segs.add(cur);
                    cur = new ArrayList<>();
                }
            } else {
                cur.add(t);
            }
        }
        if (!cur.isEmpty()) {
            segs.add(cur);
        }
        return segs;
    }

    private static Tok firstWord(List<Tok> seg) {
        for (Tok t : seg) {
            if (t.kind == TokKind.WORD) {
                return t;
            }
        }
        return null;
    }

    /**
     * 从 {@code from} 起找下一个普通字。
     *
     * <p>越过重定向符继续找：{@code cmd > a.txt} 的 {@code a.txt} 在 REDIR_OUT 之后，
     * 若在此中断就拿不到目标。</p>
     */
    private static Tok nextWord(List<Tok> seg, int from) {
        for (int i = from; i < seg.size(); i++) {
            Tok t = seg.get(i);
            if (t.kind == TokKind.WORD) {
                return t;
            }
            if (t.kind == TokKind.REDIR_OUT || t.kind == TokKind.REDIR_IN) {
                continue;
            }
            break;
        }
        return null;
    }

    /**
     * 取命令名本身：剥掉路径前缀（{@code C:\Windows\System32\cmd.exe} → {@code cmd.exe}）
     * 与 PowerShell 的调用运算符 / splatting（{@code & Set-Content} → {@code Set-Content}）。
     */
    private static String baseName(String raw) {
        if (raw == null) {
            return "";
        }
        String t = raw.trim();
        while (t.startsWith("&") || t.startsWith("@") || t.startsWith("%")) {
            t = t.substring(1).trim();
        }
        int slash = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
        if (slash >= 0 && slash < t.length() - 1) {
            t = t.substring(slash + 1);
        }
        return t;
    }

    /**
     * 段内是否出现某个旗标。
     *
     * <p>同时认三种形态：独立长选项（{@code --in-place}）、独立短选项（{@code -i}）、
     * 以及组合短选项里的字母（{@code sed -i.bak}、{@code perl -pi}）。</p>
     */
    private static boolean hasFlag(List<Tok> seg, String flag) {
        String f = flag.toLowerCase(Locale.ROOT);
        boolean shortFlag = f.startsWith("-") && !f.startsWith("--") && f.length() == 2;

        for (Tok t : seg) {
            if (t.kind != TokKind.WORD) {
                continue;
            }
            String v = t.text.toLowerCase(Locale.ROOT);
            if (v.equals(f)) {
                return true;
            }
            if (f.startsWith("--")) {
                if (v.startsWith(f + "=")) {
                    return true;
                }
                continue;
            }
            if (shortFlag && v.startsWith("-") && !v.startsWith("--")) {
                // 组合短选项：只要含该字母即视为出现（sed -i.bak / perl -pi）
                char want = f.charAt(1);
                for (int i = 1; i < v.length(); i++) {
                    if (v.charAt(i) == want) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * 把段内 token 还原成近似原文，供只吃字符串的正则使用
     * （.NET 直调、dd、tar、下载器）。
     *
     * <p>还原是<b>有意的近似</b>：tokenize 已剥掉引号，此处用空格重拼。
     * 这些正则只关心「旗标后面那个路径字面量」，引号有无不影响提取结果。</p>
     */
    private static String segmentText(List<Tok> seg) {
        StringBuilder sb = new StringBuilder();
        for (Tok t : seg) {
            if (t.kind == TokKind.WORD || t.kind == TokKind.REDIR_OUT || t.kind == TokKind.REDIR_IN) {
                if (sb.length() > 0) {
                    sb.append(' ');
                }
                sb.append(t.text);
            }
        }
        return sb.toString();
    }

    // ==========================================================================
    // 包装器展开
    // ==========================================================================

    private static final Set<String> WRAPPER_PAYLOAD_FLAGS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "-c", "-command", "/c", "/k", "-cmd", "-e", "-execute"
    )));

    /**
     * 「后面跟的是<b>脚本文件</b>」的载荷标记。
     *
     * <p>与 {@link #WRAPPER_PAYLOAD_FLAGS} 分开是必需的：{@code powershell -File D:\out\x.ps1}
     * 里的路径不是命令文本，把它当 payload 递归展开只会得到 {@code baseName = "x.ps1"}
     * 这个查不到任何规则的动词 → 静默放行。正确语义是「读了一个工作区外的脚本」。</p>
     */
    private static final Set<String> SCRIPT_PAYLOAD_FLAGS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "-file", "/f"
    )));

    private static final Set<String> ENCODED_FLAGS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "-encodedcommand", "-enc", "-ec", "/encodedcommand"
    )));

    /**
     * 跳过包装器<b>自身的</b>选项，返回第一个「非选项」字的下标。
     *
     * <p>同时认两种选项前缀：Unix 的 {@code -}（{@code sudo -u root}、{@code stdbuf -oL}）
     * 与 Windows 的 {@code /}（{@code runas /user:Administrator}）。</p>
     *
     * <p><b>{@code /} 前缀必须限定形态</b>：无条件把 {@code /} 开头当选项，会让
     * {@code sudo /usr/bin/rm -rf D:\out} 里的 {@code /usr/bin/rm}（真实命令）被当成选项跳过，
     * payload 只剩 {@code -rf D:\out} → 动词丢失 → 静默放行。故只认
     * {@code /字母数字[:值]} 且<b>不含第二个斜杠</b>的形态，路径自然被排除。</p>
     *
     * <p>带值选项的值要一并跳过（{@code -u root} 的 {@code root} 不是命令）；
     * {@code /user:Administrator} 是内联形态，无独立值可跳。</p>
     */
    private static int skipOwnOptions(List<Tok> seg, int from) {
        int i = from;
        while (i < seg.size()) {
            Tok t = seg.get(i);
            if (t.kind != TokKind.WORD) {
                i++;
                continue;
            }
            String lt = t.text.toLowerCase(Locale.ROOT);
            boolean isOption = lt.startsWith("-") || WINDOWS_OPTION.matcher(t.text).matches();
            if (!isOption) {
                break;
            }

            i++;
            if (VALUE_FLAGS.contains(lt)) {
                while (i < seg.size() && seg.get(i).kind != TokKind.WORD) {
                    i++;
                }
                if (i < seg.size()) {
                    i++;
                }
            }
        }
        return i;
    }

    /** Windows 风格选项：{@code /c}、{@code /user:Administrator}（不含第二个斜杠，故不会误吞路径）。 */
    private static final Pattern WINDOWS_OPTION = Pattern.compile("^/[A-Za-z][A-Za-z0-9]*(?::\\S*)?$");

    /**
     * 从前缀修饰器的参数区里找出<b>真正的命令起始下标</b>。
     *
     * <p><b>为什么不能只靠「跳过选项」</b>：{@code nice -n 5 mv a.txt D:\out\a.txt} 里的
     * {@code -n} 带一个值 {@code 5}，而 {@code 5} 不带 {@code -} 前缀、不是选项，
     * 于是它被当成「被修饰的命令」→ {@code baseName("5") = "5"} 查不到任何规则 → 静默放行。
     * 本仓实测过这个形态。靠枚举 {@code VALUE_FLAGS} 永远补不完（每个修饰器都有自己的带值选项），
     * 而漏一个就是一个绕过口。</p>
     *
     * <p>通用判据：<b>前缀修饰器之后第一个「已知动词」才是被修饰的命令</b>。
     * 已知动词 = 在任一张表里登记过的词（写表 / 读表 / 专属形态 / cd / 包装器）。
     * 这样 {@code -n 5} 的两个 token 都查不到 → 继续往后扫 → 扫到 {@code mv} 才停。</p>
     *
     * <p><b>扫不到已知动词时必须退回原位</b>（而不是返回末尾）：
     * {@code sudo mvn test} 里 {@code mvn} 不在任何表里，退回原位后 payload 仍是
     * {@code mvn test}，递归展开后同样查不到规则 → 放行，不误拦。
     * 若返回末尾会得到空 payload，反而丢了「脚本文件」判定（{@code bash scripts/build.sh}）。</p>
     */
    private static int findCommandStart(List<Tok> seg, int from) {
        for (int i = from; i < seg.size(); i++) {
            Tok t = seg.get(i);
            if (t.kind != TokKind.WORD) {
                continue;
            }
            if (isKnownVerb(baseName(t.text))) {
                return i;
            }
        }
        return from;
    }

    /** 该词是否在<b>任一张</b>动词表里登记过（即「它可能是一个真命令」）。 */
    private static boolean isKnownVerb(String word) {
        if (word == null || word.isEmpty()) {
            return false;
        }
        String key = word.toLowerCase(Locale.ROOT);
        return WRITE_RULES.containsKey(key)
                || READ_RULES.containsKey(key)
                || SPECIAL_VERBS.contains(key)
                || CD_VERBS.contains(key)
                || WRAPPERS.contains(key);
    }

    /** 自身带值、值需一并跳过的选项（小写）。 */
    private static final Set<String> VALUE_FLAGS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "-u", "-user", "--user", "-d", "--distribution", "-g", "--group"
    )));

    /** 脚本文件扩展名：其后跟随的不是命令名，而是<b>会被读取执行的文件</b>。 */
    private static final Set<String> SCRIPT_EXTENSIONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            ".sh", ".bash", ".zsh", ".ksh", ".fish", ".csh", ".tcsh",
            ".ps1", ".psm1", ".psd1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse",
            ".wsf", ".wsh", ".msc", ".py", ".rb", ".pl", ".php", ".lua"
    )));

    /** 该字是否为脚本文件路径（按扩展名判定；含通配符时不算，交由通配符逻辑处理）。 */
    private static boolean isScriptFile(String text) {
        if (text == null) {
            return false;
        }
        String lt = text.toLowerCase(Locale.ROOT);
        if (lt.indexOf('*') >= 0 || lt.indexOf('?') >= 0) {
            return false;
        }
        for (String ext : SCRIPT_EXTENSIONS) {
            if (lt.endsWith(ext)) {
                return true;
            }
        }
        return false;
    }

    /** 取载荷文本的首个字（用于区分「命令」与「脚本文件路径」）。 */
    private static String firstPayloadWord(String payload) {
        if (payload == null) {
            return null;
        }
        List<Tok> toks = tokenize(payload);
        Tok head = firstWord(toks);
        return head == null ? null : head.text;
    }

    private static String joinFrom(List<Tok> seg, int from) {
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < seg.size(); i++) {
            Tok t = seg.get(i);
            if (t.kind != TokKind.WORD) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(t.text);
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    /**
     * 解码 PowerShell 的 {@code -EncodedCommand} 载荷（Base64 of UTF-16LE）。
     *
     * <p>解码失败返回 null（放行）而非报错：无法解码意味着它也不是本层能判定的命令，
     * 而 {@code -EncodedCommand} 在合法运维脚本里常见（本项目自己就在用，见
     * {@code ShellCommandFactory}），硬拦会误伤。这条路径的真正兜底是 OS 内核沙盒。</p>
     */
    private static String decodeEncodedCommand(String b64) {
        if (b64 == null || b64.trim().isEmpty()) {
            return null;
        }
        try {
            byte[] raw = Base64.getMimeDecoder().decode(b64.trim());
            if (raw.length == 0) {
                return null;
            }
            return new String(raw, StandardCharsets.UTF_16LE);
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ==========================================================================
    // 路径解析辅助（纯函数）
    // ==========================================================================

    /**
     * 变量与 {@code ~} 展开。
     *
     * <p>只展开<b>能确定值</b>的形态：{@code ~}（user.home）、{@code $HOME} / {@code ${HOME}} /
     * {@code $USERPROFILE}、{@code $env:NAME}、{@code %NAME%}（环境变量存在时）。
     * 展开不出来时保留原样，由调用方决定是否放弃判定。</p>
     *
     * <p>{@code %NAME%} 在环境变量缺失时<b>保留原样</b>而非放弃：CMD 下未定义变量会展开成空串，
     * 保留原样会让路径解析成一个含 {@code %} 的怪路径（必然界内 → 放行），
     * 与 CMD 的真实行为方向一致，不会造成误拦。</p>
     */
    private static String expandVars(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw;

        if (s.equals("~")) {
            return System.getProperty("user.home");
        }
        if (s.startsWith("~/") || s.startsWith("~\\")) {
            String home = System.getProperty("user.home");
            return home == null ? null : home + s.substring(1);
        }

        // $env:NAME 与 ${env:NAME}
        s = replaceByPattern(s, Pattern.compile("(?i)\\$\\{?env:([A-Za-z_][A-Za-z0-9_]*)\\}?"),
                name -> {
                    String v = System.getenv(name);
                    // 查不到时<b>保留原样</b>而不是展开成空串：PowerShell 的真实语义确实是展开成
                    // 空串（`$env:UNSET\f.txt` 会写到当前盘符根），但那样会把目标解析成
                    // `D:\f.txt` 并报给用户——用户写的是 `$env:UNSET\f.txt`，这个审批文案无法解释，
                    // 批准了也不知道会写到哪。保留原样后由 isUnjudgeable 放行，
                    // 与下面 %NAME% 缺失时的处理保持一致（同类形态不得两种口径，否则就是漂移点）。
                    return v == null ? null : v;
                });

        // $HOME / ${HOME} / $USERPROFILE / ${USERPROFILE}
        s = replaceByPattern(s, Pattern.compile("\\$\\{?(HOME|USERPROFILE)\\}?"),
                name -> {
                    if ("USERPROFILE".equals(name)) {
                        return System.getenv("USERPROFILE");
                    }
                    String v = System.getProperty("user.home");
                    return v != null ? v : System.getenv("HOME");
                });

        // %NAME%
        s = replaceByPattern(s, Pattern.compile("%([A-Za-z_][A-Za-z0-9_]*)%"),
                name -> {
                    String v = System.getenv(name);
                    // 缺失时保留原样（见方法 javadoc）
                    return v == null ? "%" + name + "%" : v;
                });

        return s;
    }

    /** 按正则逐处替换；{@code lookup} 返回 null 表示「查不到值」，此时保留原匹配文本。 */
    private static String replaceByPattern(String s, Pattern p, java.util.function.Function<String, String> lookup) {
        Matcher m = p.matcher(s);
        if (!m.find()) {
            return s;
        }
        StringBuffer sb = new StringBuffer();
        m.reset();
        while (m.find()) {
            String v = lookup.apply(m.group(1));
            m.appendReplacement(sb, Matcher.quoteReplacement(v == null ? m.group(0) : v));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    /**
     * 是否为「不像路径」的 token，必须先于路径解析排除。
     *
     * <ul>
     *   <li>{@code -xxx} 旗标：{@code cp -r SRC DST} 的 {@code -r} 若被当写目标就会误判；</li>
     *   <li>{@code /s}、{@code /q} 这类 CMD 短选项：见 {@link #CMD_SHORT_OPTION} 的说明。</li>
     * </ul>
     */
    private static boolean isOptionLike(String t) {
        if (t.startsWith("-") && t.length() > 1) {
            return true;
        }
        return CMD_SHORT_OPTION.matcher(t).matches();
    }

    private static boolean isNullTarget(String t) {
        String lt = t.toLowerCase(Locale.ROOT);
        if (NULL_TARGETS.contains(lt)) {
            return true;
        }
        // 文件描述符复制：>&1、2>&1（tokenize 会把 & 切成段，这里兜住紧贴形态）
        return lt.matches("^&?\\d*>&\\d+$");
    }

    /**
     * 是否为非文件系统驱动器（注册表项、环境变量项、证书项等）。
     *
     * <p>单字母盘符（{@code C:\}、{@code D:/}）是文件系统，必须交给后续边界判定，
     * 因此这条检查要在盘符判定<b>之后</b>做。</p>
     */
    private static boolean isNonFileSystemDrive(String t) {
        String lt = t.toLowerCase(Locale.ROOT);
        if (lt.length() >= 2 && lt.charAt(1) == ':' && Character.isLetter(lt.charAt(0))) {
            return false;
        }
        for (String pre : PS_DRIVE_PREFIXES) {
            if (lt.startsWith(pre)) {
                return true;
            }
        }
        // 形如 provider:path 的其它 PowerShell 驱动器
        return lt.matches("^[a-z][a-z0-9_.]*:[\\\\/].*");
    }

    /**
     * 目标不可解析成确定路径时放弃判定（用于<b>配置项与 cd 目标</b>）。
     *
     * <p>展开后仍含 {@code $} 或 {@code %} 说明路径依赖运行期变量值，本层看不到；
     * 含 {@code *} / {@code ?} 说明是通配（真实目标集合未知）。</p>
     *
     * <p>这里选择<b>放行</b>而非拦截：无法判定归属时拦住会产生用户无法解释、
     * 也无法通过批准来「修正」的审批（批准了也不知道会写到哪）。</p>
     *
     * <p><b>访问目标的判定不用本方法</b>：通配符的「归属目录」其实是确定的
     * （{@code D:\out\*.*} 一定属于 {@code D:\out}），一律放行会把越界批量删除也放过去。
     * 见 {@link #hasUnresolvedVar} 与 {@link #wildcardPrefix}。本方法保留给
     * 「通配符在这里根本无意义」的两个调用点：豁免目录配置项与 {@code cd} 目标。</p>
     */
    private static boolean isUnjudgeable(String expanded) {
        return hasUnresolvedVar(expanded) || wildcardPrefix(expanded) != null;
    }

    /**
     * 是否含<b>本层看不到值</b>的变量引用（{@code $} / {@code %}）。
     *
     * <p>这才是真正「无法判定归属」的形态：{@code $d="D:\out"; Set-Content "$d\f.txt" x}
     * 里的 {@code $d} 值只在运行期存在。此时只能放行（能力边界已写入类注释）。</p>
     */
    private static boolean hasUnresolvedVar(String expanded) {
        return expanded.indexOf('$') >= 0 || expanded.indexOf('%') >= 0;
    }

    /**
     * 取通配符路径的<b>归属目录前缀</b>；不含通配符时返回 null。
     *
     * <p>为什么能判：{@code *} / {@code ?} 只在<b>最后几段</b>展开，前面的目录部分是字面量。
     * 于是 {@code D:\out\*.*} 的每一个可能匹配项都在 {@code D:\out} 之内——
     * 判这个前缀就等于判了整个目标集合，且结论是<b>保守正确</b>的：
     * 前缀在工作区外 → 全部匹配项都在外（该拦）；前缀在工作区内 → 匹配项不一定全在内
     * （{@code src/*\.txt} 不会跑出工作区，因为通配符不跨分隔符），故放行也是对的。</p>
     *
     * <p>旧实现对含通配符的目标一律放行，后果是 {@code del D:\out\*.*}、
     * {@code Remove-Item D:\out\* -Recurse -Force} 这类<b>越界批量删除</b>两轴皆不命中
     * （形态轴的 {@code del /s} / {@code rd /s} 正则要求带 {@code /s}，此处没有）。</p>
     *
     * <p>截断位置是「首个通配符之前的最后一个分隔符」，故多级通配
     * （{@code D:/out/*}{@code /*.txt}）也只退到第一个确定的目录层。</p>
     *
     * @return 归属目录前缀；通配符前没有分隔符（如 {@code *.txt}）时返回<b>空串</b>
     *         表示「归属就是当前基准目录」；不含通配符时返回 null
     */
    private static String wildcardPrefix(String expanded) {
        int w = -1;
        for (int i = 0; i < expanded.length(); i++) {
            char c = expanded.charAt(i);
            if (c == '*' || c == '?') {
                w = i;
                break;
            }
        }
        if (w < 0) {
            return null;
        }

        int cut = -1;
        for (int i = w - 1; i >= 0; i--) {
            char c = expanded.charAt(i);
            if (c == '/' || c == '\\') {
                cut = i;
                break;
            }
        }
        if (cut < 0) {
            // `*.txt`：通配符前没有任何目录部分，归属就是当前基准
            return "";
        }
        if (cut == 0) {
            // `/*.txt`：归属是根目录本身。必须保留那个分隔符，
            // 否则截成空串会被当成相对路径、退到基准目录而漏判根目录通配
            return expanded.substring(0, 1);
        }

        String prefix = expanded.substring(0, cut);

        // Windows 盘符根：`D:\*` 截出来是 `D:`，而 {@code Paths.get("D:")} 是
        // <b>drive-relative</b>（{@code isAbsolute() == false}），会被 {@code base.resolve()}
        // 解析成「D 盘的当前目录」而不是盘符根。本仓实测：它解析成
        // {@code D:\work\gourd\gourdai\}（带尾分隔符的怪路径，即工作区自己），
        // 而判定结果<b>侥幸</b>仍是「越界」——只因那个怪路径的最后一段字面是
        // {@code "gourdai\\"}、与工作区的 {@code "gourdai"} 不相等。
        // 换个 JDK / 平台行为就可能翻成「界内」，于是 {@code Remove-Item D:\*}
        //（删整个盘）被静默放行。<b>靠侥幸成立的正确结果等于缺陷</b>，故补回分隔符，
        // 让它成为真正的绝对路径（{@code D:\} 的 {@code isAbsolute() == true}），
        // 判定不再依赖任何字面巧合。
        if (prefix.length() == 2 && prefix.charAt(1) == ':'
                && Character.isLetter(prefix.charAt(0))) {
            return prefix + expanded.charAt(cut);
        }
        return prefix;
    }

    private static Path realOrLexical(Path target) {
        try {
            if (Files.exists(target)) {
                return target.toRealPath();
            }
            Path ancestor = target;
            List<String> tail = new ArrayList<>();
            while (ancestor != null && ancestor.getParent() != null && !Files.exists(ancestor)) {
                Path name = ancestor.getFileName();
                tail.add(0, name == null ? "" : name.toString());
                ancestor = ancestor.getParent();
            }
            if (ancestor == null) {
                return target.normalize();
            }
            Path real = ancestor.toRealPath();
            for (String seg : tail) {
                if (!seg.isEmpty()) {
                    real = real.resolve(seg);
                }
            }
            return real.normalize();
        } catch (Exception e) {
            // 目标及其祖先都不可达（如不存在的盘符）：回退词法路径，仍能判定越界
            return target.normalize();
        }
    }

    private static Path toReal(Path p) {
        try {
            return Files.exists(p) ? p.toRealPath() : p.normalize();
        } catch (Exception e) {
            return p.normalize();
        }
    }

    /**
     * 边界判定：{@code target} 是否落在 {@code root} 之内。
     *
     * <p>用 {@code startsWith} 而非字符串前缀比较：{@code D:\work\gourdai2} 以
     * {@code D:\work\gourdai} 为字符串前缀但<b>不在</b>其内，字符串比较会把它误判为界内。</p>
     */
    private static boolean isInside(Path root, Path target) {
        if (root == null || target == null) {
            return false;
        }
        try {
            return target.startsWith(root);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** 取选项名（小写、不含前导 {@code -}）；非选项返回 null。 */
    private static String optionName(String token) {
        if (token == null) {
            return null;
        }
        String t = token.trim();
        if (!t.startsWith("-")) {
            return null;
        }
        int eq = t.indexOf('=');
        String name = eq > 0 ? t.substring(0, eq) : t;
        while (name.startsWith("-")) {
            name = name.substring(1);
        }
        if (name.isEmpty() || name.length() > 40) {
            return null;
        }
        return name.toLowerCase(Locale.ROOT);
    }

    // ==========================================================================
    // 扫描状态机
    // ==========================================================================

    /**
     * 单次 {@link #inspect} 的可变状态。
     *
     * <p>{@code base} 必须<b>跨段维护</b>：{@code Set-Location D:\out; Set-Content f.txt x}
     * 里第二段是相对路径，只有跟着 {@code cd} 改基准才能看出它其实写在工作区外。
     * 忽略 {@code cd} 会让这类命令全部漏判。</p>
     *
     * <p>所有需要状态的逻辑（规则应用、专属形态、cd 跟踪、边界判定）都是本类的方法，
     * 纯函数留在外层 {@code BashPathGuard}。<b>不使用 ThreadLocal 传递状态</b>：
     * 那样会随 surefire 的线程复用泄漏给后续用例，且绑定/解绑一旦漏配就是静默 NPE。</p>
     */
    private static final class Scan {
        final Path root;
        final List<Path> exempts;
        final List<Path> dirStack = new ArrayList<>();
        /**
         * 本趟扫描的目标类型：true = 只找越界<b>写</b>，false = 只找越界<b>读</b>。
         *
         * <p>一个 Scan 实例只跑一趟。读写分成两个实例而不是在一个实例里同时找，
         * 是因为 {@code hit} 只能存一个结果，而写必须优先于读（见 {@link #inspect}）。
         * 共用同一个类而非两个类，是因为两趟的<b>路径解析与豁免判定完全相同</b>，
         * 只有「查哪张动词表」与「认哪种重定向符」不同——拆成两个类会把
         * 边界判定逻辑复制一份，那就是下一个漂移点。</p>
         */
        final boolean writeMode;
        Path base;
        Violation hit;

        Scan(Path workspaceRoot, Collection<Path> extraExempts, boolean writeMode) {
            this.root = toReal(workspaceRoot.toAbsolutePath().normalize());
            this.base = this.root;

            List<Path> ex = new ArrayList<>(defaultExemptRoots());

            // Windows 下 `/tmp` 这类「有根无盘符」的路径会按基准盘符解析成 `D:\tmp`，
            // 而豁免清单里的 `/tmp` 解析成 `C:\tmp`（JVM 当前盘符），两者对不上会误报。
            // 故按工作区盘符补一份同名变体。
            Path rootDir = this.root.getRoot();
            if (rootDir != null) {
                for (String rel : new String[]{"tmp", "var/tmp", "private/tmp", "var/folders"}) {
                    try {
                        ex.add(toReal(rootDir.resolve(rel).normalize()));
                    } catch (RuntimeException ignored) {
                        // 补不上就算了：只会更严，不会越权
                    }
                }
            }

            if (extraExempts != null) {
                for (Path p : extraExempts) {
                    if (p != null) {
                        try {
                            ex.add(toReal(p.toAbsolutePath().normalize()));
                        } catch (RuntimeException ignored) {
                            // 用户配置里的非法路径直接忽略
                        }
                    }
                }
            }

            this.exempts = Collections.unmodifiableList(ex);
            this.writeMode = writeMode;
        }

        void run(String text, int depth) {
            if (depth > MAX_UNWRAP_DEPTH || hit != null || text == null) {
                return;
            }

            // .NET 静态方法直调必须在<b>整条文本</b>上扫：方法名的左括号会被 tokenize 当作切段符，
            // 把 WriteAllText( 与它的路径参数分到不同段，段级扫描永远匹配不到。
            scanDotNetCalls(text);
            if (hit != null) {
                return;
            }

            for (List<Tok> seg : splitSegments(tokenize(text))) {
                if (hit != null) {
                    return;
                }
                handleSegment(seg, depth);
            }
        }

        private void handleSegment(List<Tok> seg, int depth) {
            // 1. 重定向：最强的访问信号，与动词无关。
            //    写趟认 `>`（`cat x > D:\out\f`），读趟认 `<`（`sort < D:\out\f`）。
            //    两趟各认一种，避免同一条重定向被读写两边重复报。
            TokKind wantKind = writeMode ? TokKind.REDIR_OUT : TokKind.REDIR_IN;
            for (int i = 0; i < seg.size(); i++) {
                if (seg.get(i).kind == wantKind) {
                    Tok target = nextWord(seg, i + 1);
                    if (target != null) {
                        check(target.text, seg.get(i).text);
                        if (hit != null) {
                            return;
                        }
                    }
                }
            }

            // 2. 取段首动词（剥路径前缀与 PS 调用运算符）
            Tok head = firstWord(seg);
            if (head == null) {
                return;
            }

            String verb = baseName(head.text);
            String key = verb.toLowerCase(Locale.ROOT);

            // 3. cd 类：更新相对路径基准，本身不写文件
            if (CD_VERBS.contains(key)) {
                applyCd(key, seg);
                return;
            }

            // 4. 专属形态动词（dd / tar / 下载器）
            if (SPECIAL_VERBS.contains(key)) {
                scanSpecial(key, seg);
                return;
            }

            // 5. 包装器：按「后面跟的是命令还是脚本文件」分派。
            //    三类都必须有真实处理逻辑——任何一类落到「什么都不做」就是绕过口子
            //    （本仓实证：早期只有 COMMAND_WRAPPERS 一类，8 个成员静默放行）。
            if (WRAPPERS.contains(key)) {
                handleWrapper(key, seg, depth);
                return;
            }

            // 6. 通用动词表（按本趟类型选表）
            Rule rule = (writeMode ? WRITE_RULES : READ_RULES).get(key);
            if (rule == null) {
                return;
            }
            if (rule.gateFlag != null) {
                boolean present = hasFlag(seg, rule.gateFlag);
                // gateAbsent=false：旗标出现才检查（写表：sed -i / find -delete）
                // gateAbsent=true ：旗标缺席才检查（读表：sed 不带 -i 时是纯读）
                if (rule.gateAbsent == present) {
                    return;
                }
            }
            applyRule(verb, seg, rule);
        }

        private void applyRule(String verb, List<Tok> seg, Rule rule) {
            List<String> positional = new ArrayList<>();
            boolean skipNext = false;
            String pendingPathParam = null;

            for (int i = 1; i < seg.size(); i++) {
                Tok t = seg.get(i);
                if (t.kind != TokKind.WORD) {
                    continue;
                }
                String v = t.text;

                if (skipNext) {
                    skipNext = false;
                    continue;
                }
                if (pendingPathParam != null) {
                    String label = verb + " -" + pendingPathParam;
                    pendingPathParam = null;
                    check(v, label);
                    if (hit != null) {
                        return;
                    }
                    continue;
                }

                String opt = optionName(v);
                if (opt != null) {
                    if (rule.pathParams.contains(opt)) {
                        // 带值形态 -Path=X 当场就能取到值，不必等下一个 token
                        int eq = v.indexOf('=');
                        if (eq > 0) {
                            check(v.substring(eq + 1), verb + " -" + opt);
                            if (hit != null) {
                                return;
                            }
                        } else {
                            pendingPathParam = opt;
                        }
                    } else if (rule.skipParams.contains(opt)) {
                        if (v.indexOf('=') < 0) {
                            skipNext = true;
                        }
                    }
                    continue;
                }

                if (isOptionLike(v)) {
                    continue;
                }

                positional.add(v);
            }

            switch (rule.mode) {
                case ALL:
                    for (String p : positional) {
                        check(p, verb);
                        if (hit != null) {
                            return;
                        }
                    }
                    break;
                case SKIP_FIRST_ALL:
                    // 首个位置参数是 pattern / 脚本正文，从第二个开始才是路径
                    for (int i = 1; i < positional.size(); i++) {
                        check(positional.get(i), verb);
                        if (hit != null) {
                            return;
                        }
                    }
                    break;
                case LAST:
                    if (!positional.isEmpty()) {
                        check(positional.get(positional.size() - 1), verb);
                    }
                    break;
                case FIRST:
                    if (!positional.isEmpty()) {
                        check(positional.get(0), verb);
                    }
                    break;
                case SECOND:
                    if (positional.size() >= 2) {
                        check(positional.get(1), verb);
                    }
                    break;
                case NONE:
                default:
                    break;
            }
        }

        /**
         * 扫描 .NET 静态方法直调。
         *
         * <p>入参是<b>整条命令文本</b>而非段：{@code WriteAllText(} 的左括号会被 tokenize
         * 当作切段符，把方法名与路径参数分到不同段，段级扫描必然漏判。
         * 直接吃原文还有个好处——引号未被剥离，路径字面量的边界更清晰。</p>
         */
        private void scanDotNetCalls(String text) {
            // 两趟共用同一方法：按 writeMode 选用读表或写表。同一文本不会既报读又报写
            //（一个 Scan 实例只跑一趟），故不会重复命中。
            Pattern pattern = writeMode ? DOTNET_WRITE_CALL : DOTNET_READ_CALL;
            Matcher m = pattern.matcher(text);
            while (m.find()) {
                String path = m.group(3) != null ? m.group(3)
                        : (m.group(4) != null ? m.group(4) : m.group(5));
                if (path != null && !path.trim().isEmpty()) {
                    check(path.trim(), "[System.IO." + m.group(1) + "]::" + m.group(2));
                    if (hit != null) {
                        return;
                    }
                }
            }
        }

        private void scanSpecial(String key, List<Tok> seg) {
            String text = segmentText(seg);

            if (key.equals("dd")) {
                // 写趟看 of=，读趟看 if=
                Matcher m = (writeMode ? DD_OF : DD_IF).matcher(text);
                while (m.find()) {
                    check(m.group(1), writeMode ? "dd of=" : "dd if=");
                    if (hit != null) {
                        return;
                    }
                }
                return;
            }

            // curl / wget / aria2c / axel / fetch：下载器的 -o 是写侧；读侧不关心（远程 URL 不是本地路径）
            if (!isTarVerb(key)) {
                if (writeMode) {
                    Matcher mOut = DOWNLOAD_OUT.matcher(text);
                    while (mOut.find()) {
                        check(mOut.group(1), key + " -o");
                        if (hit != null) {
                            return;
                        }
                    }
                }
                return;
            }

            // tar：
            //   写趟 —— 创建模式下 -f 指定的归档是写；解压模式下 -C 指定的目录是写
            //   读趟 —— 解压/查看模式下 -f 指定的归档是被读的源（如 tar -xf D:\out\a.tgz -C 界内）
            boolean creating = TAR_CREATE.matcher(text).find();
            boolean extracting = TAR_EXTRACT.matcher(text).find();

            if (writeMode) {
                Pattern p = creating && !extracting ? TAR_FILE_FLAG : (extracting ? TAR_DIR_FLAG : null);
                if (p == null) {
                    return;
                }
                Matcher m = p.matcher(text);
                while (m.find()) {
                    String v = m.group(1) != null ? m.group(1) : m.group(2);
                    if (v != null) {
                        check(v, key + (creating && !extracting ? " -f" : " -C"));
                        if (hit != null) {
                            return;
                        }
                    }
                }
            } else {
                // 读趟：解压 / 查看模式下，-f 指向的归档是<b>被读的源</b>，故检查它是否越界。
                // 纯创建模式（creating && !extracting）刻意排除：那时 -f 是写目标，已由写趟报；
                // 若这里也报，同一条命令会在读写两趟里对 -f 重复判定（写优先已覆盖，读趟多余）。
                if (!creating || extracting) {
                    Matcher m = TAR_FILE_FLAG.matcher(text);
                    while (m.find()) {
                        String v = m.group(1) != null ? m.group(1) : m.group(2);
                        if (v != null) {
                            check(v, key + " -f (read)");
                            if (hit != null) {
                                return;
                            }
                        }
                    }
                }
            }
        }

        private static boolean isTarVerb(String key) {
            return key.startsWith("tar") || key.equals("gtar") || key.equals("bsdtar");
        }

        /**
         * 应用 cd / pushd / popd，更新相对路径基准。
         *
         * <p>{@code popd} 回到上一个目录，故维护一个栈；栈空时回到工作区根。
         * {@code cd -}（回上一个目录）与 {@code cd}（回家目录）无法确定基准时
         * 退回工作区根——这样后续相对路径会被判为界内（放行）。
         * 宁可漏判也不制造无法解释的误拦。</p>
         */
        private void applyCd(String key, List<Tok> seg) {
            if (key.equals("popd")) {
                base = dirStack.isEmpty() ? root : dirStack.remove(dirStack.size() - 1);
                return;
            }

            if (key.equals("pushd")) {
                dirStack.add(base);
            }

            Tok target = nextWord(seg, 1);
            if (target == null || target.text.startsWith("-")) {
                base = root;
                return;
            }

            Path p = resolve(target.text);
            if (p != null) {
                base = p;
            }
        }

        /**
         * 包装器分派：三类语义各走各路，<b>任何一条分支都不得静默什么都不做</b>。
         *
         * <p>判定顺序是刻意的：</p>
         * <ol>
         *   <li>前缀修饰器（nohup / time / eval …）：无载荷标记，跳过自身选项后余下就是命令；</li>
         *   <li>{@code -EncodedCommand <base64>}：解码后递归展开；</li>
         *   <li>脚本标记（{@code -File} / {@code /f}）：其后是<b>脚本文件</b>，按读目标判定
         *       （当命令文本递归展开只会得到 {@code x.ps1} 这个查不到规则的动词 → 静默放行）；</li>
         *   <li>命令标记（{@code -c} / {@code -Command} / {@code /c} / {@code /k}）：递归展开，
         *       <b>并额外检查首个字是否为脚本文件</b>——{@code cmd /c D:\out\x.bat} 走的是这条，
         *       只递归展开会漏；</li>
         *   <li>无标记：提权器 / WSL 按命令展开；shell 启动器与 {@code source} / {@code .}
         *       的首个位置参数是脚本文件；其余一律按命令展开兜底。</li>
         * </ol>
         *
         * <p><b>本方法不得有「什么都不做就返回」的路径</b>：早期版本把无标记包装器
         * 白名单写死为 6 个提权器，其余成员一律 {@code return null} → 整段不检查，
         * 于是 {@code nohup Set-Content D:\out\f.txt x} 在默认档下静默放行。
         * 现在最后的兜底分支无条件按命令展开。</p>
         */
        private void handleWrapper(String key, List<Tok> seg, int depth) {
            // ① 前缀修饰器：永远没有命令载荷标记。跳过自身选项后，定位到第一个
            //    「已知动词」或「脚本文件」（见 expandUnmarkedPayload 的 nice -n 5 / nohup ./x.sh 实证）。
            if (PREFIX_MODIFIERS.contains(key)) {
                expandUnmarkedPayload(key, seg, skipOwnOptions(seg, 1), depth);
                return;
            }

            for (int i = 1; i < seg.size(); i++) {
                Tok t = seg.get(i);
                if (t.kind != TokKind.WORD) {
                    continue;
                }
                String lt = t.text.toLowerCase(Locale.ROOT);

                // ② Base64 编码命令
                if (ENCODED_FLAGS.contains(lt)) {
                    Tok b64 = nextWord(seg, i + 1);
                    runPayload(b64 == null ? null : decodeEncodedCommand(b64.text), depth);
                    return;
                }

                // ③ 脚本文件标记：powershell -File X.ps1
                if (SCRIPT_PAYLOAD_FLAGS.contains(lt)) {
                    Tok script = nextWord(seg, i + 1);
                    if (script != null) {
                        checkScriptRead(script.text, key + " " + t.text);
                    }
                    return;
                }

                // ④ 命令标记：sh -c "..." / cmd /c ... / powershell -Command "..."
                if (WRAPPER_PAYLOAD_FLAGS.contains(lt)) {
                    String payload = joinFrom(seg, i + 1);
                    String firstWord = firstPayloadWord(payload);
                    if (isScriptFile(firstWord)) {
                        // cmd /c D:\out\x.bat —— 载荷是脚本文件而不是命令。
                        // 报<b>首个词</b>而不是整串：整串可能带参数（"D:\out\x.bat arg1"），
                        // 当成单一路径去解析会得到一个含空格的怪路径 → 解析失败 → 静默放行。
                        checkScriptRead(firstWord, key + " " + t.text);
                        return;
                    }
                    runPayload(payload, depth);
                    return;
                }
            }

            // ⑤ 无标记：提权器、WSL、前缀修饰器、脚本启动器全走这一条
            expandUnmarkedPayload(key, seg, skipOwnOptions(seg, 1), depth);
        }

        /**
         * 展开「无标记」的载荷：先判它是不是<b>脚本文件路径</b>，是则按读目标判定，
         * 否则递归展开成命令。
         *
         * <p><b>必须对所有包装器统一处理</b>，不能只给某一类包装器开这个分支：
         * {@code nohup D:\out\x.sh} 里 nohup 是<b>前缀修饰器</b>而非 shell 启动器，
         * 但语义同样是「执行了这个脚本文件」。本仓实测：只给 shell 启动器开分支时，
         * {@code nohup D:\out\x.sh}、{@code setsid D:\out\x.sh} 均被静默放行——
         * 而 {@code nohup ./build.sh} 是 nohup 最常见的用法之一，不是边缘形态。</p>
         *
         * <p>先跑 {@link #findCommandStart} 再判脚本：两层定位缺一不可。
         * {@code nice -n 5 mv ...} 需要前者跳过选项值，{@code nohup ./x.sh} 需要后者识别脚本。</p>
         */
        private void expandUnmarkedPayload(String key, List<Tok> seg, int start, int depth) {
            int cmdStart = findCommandStart(seg, start);
            Tok first = nextWord(seg, cmdStart);
            if (first != null && isScriptFile(first.text)) {
                // bash D:\out\x.sh / source x.sh / . x.sh / nohup ./x.sh —— 脚本文件是读目标
                checkScriptRead(first.text, key);
                return;
            }
            runPayload(joinFrom(seg, cmdStart), depth);
        }

        /** 递归展开载荷命令；载荷为空时确实没有可判定的内容，故什么都不做。 */
        private void runPayload(String payload, int depth) {
            if (payload != null && !payload.trim().isEmpty()) {
                run(payload, depth + 1);
            }
        }

        /**
         * 把「被执行的工作区外脚本」当作<b>读</b>目标判定。
         *
         * <p>脚本内容本层看不到（要读文件才知道），但读一个工作区外的脚本风险不低于
         * 读数据文件——脚本里可以写任何东西。故只在读趟报：写趟报它会把「读了外部脚本」
         * 误报成「写入」，与两趟扫描的语义分工矛盾。</p>
         */
        private void checkScriptRead(String scriptPath, String verb) {
            if (writeMode) {
                return;
            }
            check(scriptPath, verb + " (script)");
        }

        /**
         * 判定一个目标是否越界，命中即记录到 {@link #hit}（读写共用）。
         *
         * <p>读写共用同一判定是刻意的：「什么算界内」「哪些目录豁免」「怎么防符号链接逃逸」
         * 这三件事与访问类型无关。若为读另写一份，两份的豁免清单迟早对不上——
         * 而那种漂移的表现是「配了豁免但只对写生效」，极难归因。</p>
         *
         * <p>判定链顺序是刻意的：先排除「根本不是路径」的东西（选项、空设备、注册表键、
         * 无法判定的变量 / 通配），再做路径解析，最后比边界。把排除项放在前面可以避免
         * 把 {@code /s}、{@code &1} 解析成 {@code D:\s} 而误报越界。</p>
         */
        void check(String rawTarget, String verb) {
            if (hit != null || rawTarget == null) {
                return;
            }

            String t = rawTarget.trim();
            if (t.isEmpty() || isOptionLike(t) || isNullTarget(t) || isNonFileSystemDrive(t)) {
                return;
            }

            String expanded = expandVars(t);
            if (expanded == null || expanded.trim().isEmpty()) {
                return;
            }
            expanded = expanded.trim();

            // 剥 PowerShell 的 FileSystem:: 前缀（显式指定文件系统提供程序）
            if (expanded.toLowerCase(Locale.ROOT).startsWith("filesystem::")) {
                expanded = expanded.substring("filesystem::".length()).trim();
            }

            // 变量引用：值只在运行期存在，本层确实无法判定 → 放行（能力边界）
            if (hasUnresolvedVar(expanded)) {
                return;
            }

            // 通配符：目标集合未知，但「归属目录」是字面量 → 退判该前缀目录。
            // 一律放行会让 `del D:\out\*.*` 这类越界批量删除完全无人看守。
            String wildcardTail = wildcardPrefix(expanded);
            if (wildcardTail != null) {
                // 空串 = 通配符前没有目录部分（`*.txt`），归属就是当前基准目录
                expanded = wildcardTail.isEmpty() ? "." : wildcardTail;
            }

            Path p;
            try {
                p = Paths.get(expanded);
            } catch (InvalidPathException e) {
                return;
            }

            try {
                if (!p.isAbsolute()) {
                    p = base.resolve(p);
                }
                p = p.normalize();
            } catch (RuntimeException e) {
                return;
            }

            Path resolved = realOrLexical(p);

            if (isInside(root, resolved)) {
                return;
            }
            for (Path ex : exempts) {
                if (isInside(ex, resolved)) {
                    return;
                }
            }

            hit = new Violation(resolved.toString(), verb, writeMode);
        }

        /**
         * 解析目标为绝对真实路径（供 {@link #applyCd} 使用）。
         *
         * <p>符号链接防护与 {@code TerminalSupport.resolveSafePath} 同构：目标存在时取
         * {@code toRealPath}；不存在时取「最近存在祖先的真实路径 + 剩余词法段」。
         * 少了这一步，工作区里放一个指向 {@code D:\} 的符号链接就能把越界写伪装成界内写。</p>
         */
        Path resolve(String rawTarget) {
            if (rawTarget == null) {
                return null;
            }
            String expanded = expandVars(rawTarget.trim());
            if (expanded == null || expanded.trim().isEmpty() || isUnjudgeable(expanded.trim())) {
                return null;
            }
            try {
                Path p = Paths.get(expanded.trim());
                if (!p.isAbsolute()) {
                    p = base.resolve(p);
                }
                return realOrLexical(p.normalize());
            } catch (RuntimeException e) {
                return null;
            }
        }
    }

    // ==========================================================================
    // 测试可见的辅助（包级）
    // ==========================================================================

    static boolean isOptionLikeForTest(String t) {
        return isOptionLike(t);
    }

    static boolean isNonFileSystemDriveForTest(String t) {
        return isNonFileSystemDrive(t);
    }

    static String expandVarsForTest(String t) {
        return expandVars(t);
    }

    /**
     * 已登记的<b>写</b>动词名（小写），用于测试断言写表没有意外收缩。
     */
    static Set<String> knownWriteVerbsForTest() {
        return new LinkedHashSet<>(WRITE_RULES.keySet());
    }

    /**
     * 已登记的<b>读</b>动词名（小写），用于测试断言读表没有意外收缩。
     */
    static Set<String> knownReadVerbsForTest() {
        return new LinkedHashSet<>(READ_RULES.keySet());
    }
}
