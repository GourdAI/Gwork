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
package com.gourdai.harness.talents.code;

import com.gourdai.harness.talents.code.impl.*;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.talent.AbsTalent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Code 规范对齐的才能
 *
 * @author oisin
 * @since 3.9.4
 */
public class CodeTalent extends AbsTalent {
    private static final Logger LOG = LoggerFactory.getLogger(CodeTalent.class);

    public final static String NAME_WORK_MD = "WORK.md";
    public final static String ATTR_CWD = "__cwd";

    private final String workDir;
    private final String codeDir;
    private final List<LanguageProvider> providers = new ArrayList<>();

    public CodeTalent(String workDir, String codeDir) {
        this.workDir = workDir;
        this.codeDir = codeDir;

        providers.add(new MavenProvider());
        providers.add(new GradleProvider());
        providers.add(new NodeProvider());
        providers.add(new GoProvider());
        providers.add(new PythonProvider());
        providers.add(new RustProvider());

        providers.add(new CangjieProvider());
        providers.add(new CMakeProvider());
        providers.add(new FlutterProvider());
        providers.add(new PhpProvider());
        providers.add(new DotNetProvider());
    }

    public String HOME_WORK_MD() {
        return codeDir + NAME_WORK_MD;
    }


    @Override
    public String description() {
        return "代码专家。支持项目初始化、技术栈自动识别以及 `" + HOME_WORK_MD() + "` 规约生成。";
    }

    @Override
    public boolean isSupported(Prompt prompt) {
        String __cwd = prompt.attrAs(ATTR_CWD);
        Path rootPath = getRootPath(__cwd);

        if (rootExists(rootPath, HOME_WORK_MD())) {
            return true;
        }

        Set<String> markers = providers.stream()
                .flatMap(p -> Arrays.stream(p.markers()))
                .collect(Collectors.toSet());

        markers.addAll(Arrays.asList(".git", ".github", ".gitee", "src", "lib"));

        for (String marker : markers) {
            if (rootExists(rootPath, marker)) return true;
        }

        for (String marker : markers) {
            if (deepExists(rootPath, marker)) return true;
        }

        return false;
    }

    @Override
    public String getInstruction(Prompt prompt) {
        String __cwd = prompt.attrAs(ATTR_CWD);

        StringBuilder buf = new StringBuilder();

        String msg = init(__cwd);

        buf.append("\n## 核心工程规约 (Core Engineering Protocol)\n");
        buf.append("> 项目当前上下文: ").append(msg).append("\n\n");

        buf.append("为了确保工程质量，要严格执行以下操作：\n")
                .append("1. **动作前导**: 在开始任何任务前，先读 `" + HOME_WORK_MD() + "` 以获取构建和测试指令。\n")
                .append("2. **验证驱动**: 修改代码后，参考 `" + HOME_WORK_MD() + "` 中的指令运行测试，严禁未验证提交。\n");

        return buf.toString();
    }

    private Path getRootPath(String __cwd) {
        String path = (__cwd != null) ? __cwd : workDir;
        if (path == null) throw new IllegalStateException("Working directory is not set.");
        return Paths.get(path).toAbsolutePath().normalize();
    }

    public String init(String __cwd) {
        try {
            Path rootPath = getRootPath(__cwd);

            if (!Files.isWritable(rootPath)) return "错误：目录不可写。";

            StringBuilder newContent = new StringBuilder();
            newContent.append("## 构建与测试指令 (Build and Test Commands)\n\n");

            List<String> detectedStacks = new ArrayList<>();
            Set<LanguageProvider> rootMatched = new HashSet<>();
            // 保留探测顺序的版本汇总：“位置描述” -> “版本标签”
            Map<String, String> detectedVersions = new LinkedHashMap<>();

            for (LanguageProvider provider : providers) {
                if (provider.isMatch(rootPath)) {
                    rootMatched.add(provider);
                    detectedStacks.add(provider.id() + "(Root)");
                    provider.appendRootCommands(newContent);

                    String ver = provider.detectVersion(rootPath);
                    if (ver != null) {
                        detectedVersions.put(provider.id() + " (Root)", ver);
                    }
                }
            }

            List<Path> allNodes = new ArrayList<>();
            try {
                Files.walkFileTree(rootPath, EnumSet.noneOf(FileVisitOption.class), 3, new SimpleFileVisitor<Path>() {
                    @Override
                    public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                        if (dir.equals(rootPath)) {
                            return FileVisitResult.CONTINUE;
                        }

                        if (isIgnored(dir)) {
                            return FileVisitResult.SKIP_SUBTREE;
                        }

                        allNodes.add(dir);
                        return FileVisitResult.CONTINUE;
                    }
                });
            } catch (IOException e) {
                LOG.error("Scan sub-modules failed", e);
            }

            boolean hasSubModulesSection = false;

            // 存储已经处理过的模块路径，防止重复（比如父子目录都被识别）
            Set<String> processedPaths = new HashSet<>();

            for (Path dir : allNodes) {
                String relativePath = rootPath.relativize(dir).toString().replace("\\", "/");

                // 如果父目录已经作为模块处理过了，子目录就不再单独列出（Maven 惯例）
                if (processedPaths.stream().anyMatch(p -> relativePath.startsWith(p + "/"))) continue;

                for (LanguageProvider provider : providers) {
                    if (provider.isMatch(dir)) {
                        processedPaths.add(relativePath);

                        // 判断异构：如果当前 Provider 没在根目录出现过，则是异构
                        boolean isHeterogeneous = !rootMatched.contains(provider);
                        String ver = provider.detectVersion(dir);

                        if (isHeterogeneous) {
                            detectedStacks.add(relativePath + "(" + provider.id() + ")");
                            provider.appendModuleCommands(newContent, relativePath);
                            if (ver != null) {
                                detectedVersions.put(relativePath + " (" + provider.id() + ")", ver);
                            }
                        } else {
                            if (!hasSubModulesSection) {
                                newContent.append("### 子模块与子项目 (Sub-modules & Sub-projects)\n");
                                hasSubModulesSection = true;
                            }
                            newContent.append("- ").append(relativePath).append(": ")
                                    .append(provider.typeName());
                            if (ver != null) {
                                newContent.append("（").append(ver).append("）");
                            }
                            newContent.append("。受根项目指令统一控制。\n");
                        }
                        break; // 一个目录识别为一个主语言即可
                    }
                }
            }

            if (hasSubModulesSection) newContent.append("\n");

            appendVersions(newContent, detectedVersions);

            appendGuidelines(newContent);

            Path targetPath = rootPath.resolve(HOME_WORK_MD());
            String finalContent = newContent.toString();
            boolean updated = true;
            if (Files.exists(targetPath)) {
                updated = !finalContent.equals(new String(Files.readAllBytes(targetPath), StandardCharsets.UTF_8));
            }
            if (updated) Files.write(targetPath, finalContent.getBytes(StandardCharsets.UTF_8));

            ensureInGitExclude(rootPath, ".gwork/");
            // 规约要求验证脚本放 `.tmp/`，那就必须真的让 git 看不见它。
            // 只写规约而不给黑名单，用户下一次 `git status` 依旧会看到一堆 probe 脚本——
            // 那等于把「不进变更面板」换成了「进 git 未跟踪列表」，问题只是换了个地方。
            ensureInGitExclude(rootPath, ".tmp/");

            StringBuilder resultMsg = new StringBuilder();
            resultMsg.append(updated ? "已更新" : "已验证").append("项目工程规范");
            if (!detectedStacks.isEmpty()) {
                resultMsg.append(" (检测到技术栈: ").append(String.join(", ", detectedStacks)).append(")");
            } else {
                resultMsg.append(" (未检测到明确的技术栈)");
            }
            if (!detectedVersions.isEmpty()) {
                resultMsg.append(" (环境版本: ").append(String.join(", ", detectedVersions.values())).append(")");
            }

            return resultMsg.toString();
        } catch (Throwable e) {
            LOG.error("Init failed", e);
            return "初始化失败: " + e.getMessage();
        }
    }

    private void appendVersions(StringBuilder buf, Map<String, String> versions) {
        if (versions.isEmpty()) {
            return;
        }

        buf.append("## 环境版本 (Environment Versions)\n\n")
                .append("> 以下为项目配置文件中**声明**的版本（非本机安装版本），写代码时请对齐该版本的语法特性。\n\n");
        for (Map.Entry<String, String> e : versions.entrySet()) {
            buf.append("- ").append(e.getKey()).append(": ").append(e.getValue()).append("\n");
        }
        buf.append("\n");
    }

    private void appendGuidelines(StringBuilder buf) {
        buf.append("## 工程规约 (Guidelines)\n\n")
                .append("- **读前必改**: 在进行任何修改前，务必完整阅读相关文件内容。\n")
                .append("- **原子作业**: 每次仅实现一个功能或修复一个 Bug。\n")
                .append("- **验证驱动**: 任务完成前必须运行测试进行验证。\n")
                .append("- **路径规范**: 仅使用相对路径（例如：`src/main/java/App.java`，严禁使用 `./src/...`）。\n")
                .append("- **风格对齐**: 必须遵循代码库中已有的编码风格和设计模式。\n")
                .append("- **版本对齐**: 参考「环境版本」章节声明的版本，不要使用超过该版本的语法特性；若未列出版本，应从配置文件或构建工具复核后再决定。\n")
                .append("- **环境感知**: 利用你对各语言默认本地仓库路径（如 Maven、Node）的知识，协助排查依赖问题或进行源码分析。\n")
                // 临时文件规约：对齐 Codex 的硬性要求——验证脚本不得污染变更面板。
                //
                // 【为何不写「一律写到系统临时目录」】上一版就是这么写的，但它不可执行：
                // write 工具走 TerminalSupport.resolveSafePath，默认档（AccessMode.DEFAULT）
                // 会直接拒给工作区外的绝对路径（“路径越界”），只有 FULL 档才放行。
                // 于是该规约把 agent 逗进一个死胡同：要么写不进去而反复重试，要么退回工作区。
                // 实测证据：Probe3 输出「拒绝 绝对路径写 %TEMP% / 允许 相对路径写 .tmp/」。
                // 改成「工作区内的临时目录 + 不必清理」：这是默认档真能执行的做法。
                // 脏不了仓库，因为最终由 EphemeralPaths 在账本层硬性排除。
                .append("- **临时文件**: 验证脚本、探测代码、对比截图等一次性文件放到工作区根的 `.tmp/` 目录下（例：`.tmp/probe.js`），")
                .append("用完可以删，**不删也不影响交付**：`.tmp/` 已被版本控制忽略，且不会出现在变更列表里。")
                .append("**严禁**把 `verify_*.js`、`probe_*.js`、`*.log`、临时截图这类文件放到 `src/`、项目根或任何会被提交的位置。")
                .append("若确需保留持久化的中间产物，先征得用户同意并加入忽略清单。\n\n");

    }

    /**
     * 把路径写进 {@code <root>/.git/info/exclude}（<b>不碰</b>用户的 .gitignore）。
     *
     * <p>可重复调用（每个条目一份）：{@code `.gwork/`} 与 {@code `.tmp/`} 共用本方法。</p>
     *
     * <p><b>WHY 不用 .gitignore：</b>旧实现直接向用户的 {@code .gitignore} 尾部追加一行。
     * 这有两个真实代价：① 污染用户的版本管理文件——用户会看到一个自己没写过的改动，
     * 并且它会被提交进仓库、影响其他协作者；② 与 {@code FileChangeService.ensureStoreExcluded}
     * 的做法自相矛盾（那里刻意选 info/exclude 并注释了理由：「效果等同于 ignore，但它是本地私有的、
     * 不会被提交、也不会污染用户版本管理中的文件」）。同一个产品不应该对同一件事有两套策略。</p>
     *
     * <p>worktree / submodule 形态下 {@code .git} 是文件而非目录，此时不猜 gitdir 指向，直接跳过。
     * 任何失败只忽略：这只是防误提交，绝不能反过来阻晓初始化。</p>
     */
    private void ensureInGitExclude(Path rootPath, String entry) {
        try {
            Path gitDir = rootPath.resolve(".git");
            if (!Files.isDirectory(gitDir)) {
                return;
            }
            Path info = gitDir.resolve("info");
            Files.createDirectories(info);
            Path exclude = info.resolve("exclude");
            String bare = entry.endsWith("/") ? entry.substring(0, entry.length() - 1) : entry;
            List<String> lines = Files.exists(exclude)
                    ? Files.readAllLines(exclude, StandardCharsets.UTF_8)
                    : new ArrayList<>();
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.equals(entry) || trimmed.equals(bare)) {
                    return;
                }
            }
            StringBuilder out = new StringBuilder();
            for (String line : lines) {
                out.append(line).append('\n');
            }
            if (out.length() > 0) {
                out.append('\n');
            }
            out.append(entry).append('\n');
            Files.writeString(exclude, out.toString(), StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            // 防误提交的辅助手段，失败不影响初始化
        }
    }

    private boolean rootExists(Path rootPath, String path) {
        return Files.exists(rootPath.resolve(path));
    }

    private boolean deepExists(Path rootPath, String path) {
        try {
            final boolean[] found = {false};

            Files.walkFileTree(rootPath, EnumSet.noneOf(FileVisitOption.class), 3, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    if (isIgnored(dir)) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }

                    if (Files.exists(dir.resolve(path))) {
                        found[0] = true;
                        return FileVisitResult.TERMINATE;
                    }

                    return FileVisitResult.CONTINUE;
                }
            });

            return found[0];
        } catch (IOException e) {
            return false;
        }
    }

    private boolean isIgnored(Path path) {
        String pathName = path.getFileName().toString();

        // 1. 基础全局忽略（隐藏目录如 .git, .idea, .gwork, .gourdai 等）
        if (pathName.startsWith(".")) {
            return true;
        }

        // 2. 业务无关的通用忽略
        if ("bin".equals(pathName) || "build".equals(pathName)) {
            return true;
        }

        // 3. 委派给各语言实现类
        return providers.stream().anyMatch(p -> p.isIgnored(pathName));
    }
}