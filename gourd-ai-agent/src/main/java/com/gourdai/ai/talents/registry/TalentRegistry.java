/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.ai.talents.registry;

import com.gourdai.ai.util.Markdown;
import com.gourdai.ai.util.MarkdownUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitOption;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 技能与子代理的发现器：扫描固定的四个目录。
 *
 * <p>取代已移除的 {@code MountManager}。两者的差别不是改名，而是砍掉了一整层没有承载信息的抽象：</p>
 * <ul>
 *   <li><b>目录不可配置</b>。原实现允许把任意目录注册成 {@code @别名}，但产品实际只注册过四个
 *       内置目录，且全部标记 {@code primary=true}（不可删除）；用户自定义挂载点长期为空。
 *       一个「可配置却从不被配置」的映射表，代价是提示词里的挂载点清单、{@code @alias} 逻辑路径
 *       解析、REST 增删改端点、前端整个设置页 tab，以及 {@code resolveSafePath} 里一整段
 *       只为它存在的符号链接校验分支。</li>
 *   <li><b>不再有 {@code @alias} 逻辑路径</b>。文件工具只认工作区相对路径；技能脚本的位置改由
 *       {@link #getTrustedReadRoots()} 精确授权（见该方法说明）。</li>
 * </ul>
 *
 * <p>扫描的四个目录（{@code harnessHome} 形如 {@code .gwork/}）：</p>
 * <pre>
 *   全局技能   &lt;globalBase&gt;/&lt;harnessHome&gt;skills/
 *   工作区技能 &lt;workspace&gt;/&lt;harnessHome&gt;skills/
 *   全局代理   &lt;globalBase&gt;/&lt;harnessHome&gt;agents/
 *   工作区代理 &lt;workspace&gt;/&lt;harnessHome&gt;agents/
 * </pre>
 *
 * <p><b>刻意不依赖 {@code core.config.AgentFlags}</b>：本包属于 {@code ai} 层，反向依赖产品层
 * 会造成层次倒置。全局基准目录由调用方（{@code HarnessOptions}）算好后作为普通路径传入。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
public class TalentRegistry {
    private static final Logger LOG = LoggerFactory.getLogger(TalentRegistry.class);

    /** 技能 / 代理目录的最大扫描深度（与原 MountManager 一致，够覆盖 {@code 分类/技能名/} 两级） */
    private static final int SCAN_DEPTH = 3;

    private final String workDir;
    private final Path globalSkillsDir;
    private final Path workspaceSkillsDir;
    private final Path globalAgentsDir;
    private final Path workspaceAgentsDir;

    /** 技能名 -> 技能目录 */
    private volatile Map<String, SkillDir> skillMap = new ConcurrentHashMap<>();

    /** 代理名 -> 代理文件 */
    private volatile Map<String, AgentMd> agentMap = new ConcurrentHashMap<>();

    /** 受信只读根（已解符号链接的真实路径），见 {@link #getTrustedReadRoots()} */
    private final List<Path> trustedReadRoots;

    /**
     * @param workspace   当前工作区根目录
     * @param globalBase  全局区基准目录（不含 {@code harnessHome}），通常为 {@code ~/.gwork} 的父级
     * @param harnessHome 框架目录名，形如 {@code .gwork/}（必须以 {@code /} 结尾）
     */
    public TalentRegistry(String workspace, String globalBase, String harnessHome) {
        String home = (harnessHome == null || harnessHome.isEmpty()) ? ".gwork/" : harnessHome;
        if (!home.endsWith("/")) {
            home = home + "/";
        }

        this.workDir = workspace;
        this.globalSkillsDir = resolveDir(globalBase, home + "skills/");
        this.workspaceSkillsDir = resolveDir(workspace, home + "skills/");
        this.globalAgentsDir = resolveDir(globalBase, home + "agents/");
        this.workspaceAgentsDir = resolveDir(workspace, home + "agents/");

        // 只有全局区的两个目录需要授权：工作区本就在隔离边界内，不必重复放行。
        List<Path> roots = new ArrayList<>(2);
        Path realGlobalSkills = toRealOrLexical(globalSkillsDir);
        if (realGlobalSkills != null) {
            roots.add(realGlobalSkills);
        }
        Path realGlobalAgents = toRealOrLexical(globalAgentsDir);
        if (realGlobalAgents != null) {
            roots.add(realGlobalAgents);
        }
        this.trustedReadRoots = Collections.unmodifiableList(roots);

        refresh();
    }

    /**
     * 解符号链接；目录不存在时退回词法路径。
     *
     * <p>退回是安全的：目录不存在就不可能有任何真实文件落在其下，
     * {@code startsWith} 自然不可能命中，不会因此误放行。而目录存在时若它本身是符号链接，
     * 不解开就会让「把受信目录链到别处 → 用受信名字访问」把任意目录洗白成受信路径。</p>
     */
    private static Path toRealOrLexical(Path path) {
        if (path == null) {
            return null;
        }
        try {
            return path.toRealPath();
        } catch (IOException | SecurityException e) {
            return path.toAbsolutePath().normalize();
        }
    }

    private static Path resolveDir(String base, String relative) {
        if (base == null || base.trim().isEmpty()) {
            return null;
        }
        return Paths.get(base, relative).toAbsolutePath().normalize();
    }

    // ========== 工作区根 ==========

    /**
     * 工作区根目录（供终端工具在缺少 {@code __cwd} 时兜底）。
     */
    public String getWorkDir() {
        return workDir;
    }

    // ========== 目录访问（供 REST 安装 / 卸载定位落盘位置） ==========

    /**
     * 指定作用域的技能目录。
     */
    public Path getSkillsDir(TalentScope scope) {
        return scope == TalentScope.WORKSPACE ? workspaceSkillsDir : globalSkillsDir;
    }

    /**
     * 工作区之外、但文件工具仍应允许<b>读取</b>的目录（已解符号链接的真实路径）。
     *
     * <p><b>存在的理由</b>：全局技能装在全局区（通常在用户主目录下），而空间隔离默认档
     * 会把「工作区之外」的一切读取请求拒掉——包括 {@code skillread} 刚刚告诉模型的那些
     * {@code scripts/*.py}。若不加这个白名单，移除 {@code @alias} 逻辑路径就会连带废掉
     * 「技能带脚本」这类用法。</p>
     *
     * <p><b>范围刻意收到最窄</b>：只有全局的 skills 与 agents 两个目录，不是整个全局区、
     * 更不是整个用户主目录。这两个目录的内容本就由框架自己扫描并向模型公示，
     * 授权它们不构成额外的信息泄漏面。<b>写操作不在授权范围内</b>（调用方须自行把关）。</p>
     *
     * <p><b>调用约定：real-to-real 比对</b>。这里存的是 {@code toRealPath()} 结果，
     * 调用方传入的目标路径也必须先解符号链接再比对。只做词法比对的话，
     * 受信目录<b>内部</b>的一个软链接指向外部就能穿过边界。</p>
     */
    public Collection<Path> getTrustedReadRoots() {
        return trustedReadRoots;
    }

    /**
     * 目标路径是否落在受信只读目录内。
     *
     * @param target 已完成 normalize <b>且已解符号链接</b>的目标路径（见类注释的 real-to-real 约定）
     */
    public boolean isTrustedReadPath(Path target) {
        if (target == null) {
            return false;
        }
        for (Path root : trustedReadRoots) {
            if (target.startsWith(root)) {
                return true;
            }
        }
        return false;
    }

    // ========== 技能 ==========

    public Collection<SkillDir> getSkills() {
        return skillMap.values();
    }

    public int getSkillCount() {
        return skillMap.size();
    }

    public SkillDir getSkill(String name) {
        return skillMap.get(name);
    }

    /**
     * 按作用域取技能（REST 的技能安装下拉、卸载定位用）。
     */
    public List<SkillDir> getSkillsByScope(TalentScope scope) {
        List<SkillDir> list = new ArrayList<>();
        for (SkillDir skill : skillMap.values()) {
            if (skill.getScope() == scope) {
                list.add(skill);
            }
        }
        return list;
    }

    // ========== 子代理 ==========

    public Collection<AgentMd> getAgents() {
        return agentMap.values();
    }

    public AgentMd getAgent(String name) {
        return agentMap.get(name);
    }

    // ========== 扫描 ==========

    /**
     * 重新扫描四个目录（全量重建，非增量）。
     *
     * <p>不做增量：目录规模是几十个量级，全量重建比维护「哪个作用域该清哪些键」的增量逻辑
     * 更不容易出错，也让 {@code skillrefresh} 工具的语义变得可预期。</p>
     */
    public synchronized void refresh() {
        Map<String, SkillDir> skills = new LinkedHashMap<>();
        Map<String, AgentMd> agents = new LinkedHashMap<>();

        // 先全局后工作区：同名时工作区覆盖全局（项目内定制压过全局默认）。
        // 原实现遍历 ConcurrentHashMap 后 put，覆盖方向取决于哈希顺序，不可复现。
        scanSkills(globalSkillsDir, TalentScope.GLOBAL, skills);
        scanSkills(workspaceSkillsDir, TalentScope.WORKSPACE, skills);

        scanAgents(globalAgentsDir, TalentScope.GLOBAL, agents);
        scanAgents(workspaceAgentsDir, TalentScope.WORKSPACE, agents);

        this.skillMap = new ConcurrentHashMap<>(skills);
        this.agentMap = new ConcurrentHashMap<>(agents);
    }

    private static void scanSkills(Path root, TalentScope scope, Map<String, SkillDir> out) {
        if (!isDirectory(root)) {
            return;
        }

        try {
            Files.walkFileTree(root, EnumSet.noneOf(FileVisitOption.class), SCAN_DEPTH, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                    if (isSkillDir(dir)) {
                        // 支持两级组织（分类/技能名）：名字保留相对路径，与原实现一致
                        String name = root.relativize(dir).toString().replace("\\", "/");
                        Markdown markdown = parseMarkdown(dir);
                        out.put(name, new SkillDir(name, scope, dir, markdown.getDescription(), markdown.getVersion()));
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    if (dir.getFileName().toString().startsWith(".")) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            LOG.error("Scan skill dir failed: {}", root, e);
        }
    }

    private static void scanAgents(Path root, TalentScope scope, Map<String, AgentMd> out) {
        if (!isDirectory(root)) {
            return;
        }

        try {
            Files.walkFileTree(root, EnumSet.noneOf(FileVisitOption.class), SCAN_DEPTH, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    String fileName = file.getFileName().toString();
                    if (fileName.endsWith(".md") && !fileName.startsWith(".")) {
                        String name = fileName.substring(0, fileName.length() - 3);
                        out.put(name, new AgentMd(name, scope, file));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    if (dir.getFileName().toString().startsWith(".")) {
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            LOG.error("Scan agent dir failed: {}", root, e);
        }
    }

    private static boolean isDirectory(Path path) {
        return path != null && Files.exists(path) && Files.isDirectory(path);
    }

    private static boolean isSkillDir(Path p) {
        return Files.exists(p.resolve("SKILL.md")) || Files.exists(p.resolve("skill.md"));
    }

    /**
     * 只解析 frontmatter 取 description / version；解析失败返回空对象而不抛出——
     * 一个技能包的元数据写坏了，不应该让整个技能库扫描失败。
     */
    private static Markdown parseMarkdown(Path dir) {
        Path md = dir.resolve("SKILL.md");
        if (!Files.exists(md)) {
            md = dir.resolve("skill.md");
        }

        try {
            List<String> lines = Files.readAllLines(md, StandardCharsets.UTF_8);
            return MarkdownUtil.resolve(lines, true);
        } catch (Throwable e) {
            return new Markdown();
        }
    }
}
