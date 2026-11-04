/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.command.builtin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Git worktree 管理器，用于创建、删除和清理 worktree。
 *
 * @author oisin
 * @since 3.9.1
 */
public class WorktreeManager {
    private static final Logger log = LoggerFactory.getLogger(WorktreeManager.class);
    private static final String LOOP_PREFIX = "loop/";
    private static final String DEFAULT_WORKTREE_DIR = ".loop-worktrees";
    private static final int TIMEOUT_SECONDS = 30;

    private final String worktreeDir;

    /**
     * 使用默认 worktree 目录名（.loop-worktrees）
     */
    public WorktreeManager() {
        this(DEFAULT_WORKTREE_DIR);
    }

    /**
     * 使用指定 worktree 目录名
     *
     * @param worktreeDir worktree 目录名（如 ".gwork/loop-worktrees"）
     */
    public WorktreeManager(String worktreeDir) {
        this.worktreeDir = worktreeDir;
    }

    /**
     * 创建 worktree，返回 worktree 路径
     *
     * @param basePath    git 仓库根路径
     * @param branchName  分支名称（不含 loop/ 前缀）
     * @return worktree 的绝对路径，失败时返回 null
     */
    public String create(String basePath, String branchName) {
        if (!isGitRepo(basePath)) {
            return null;
        }

        Path baseDir = Paths.get(basePath);
        Path worktreePath = baseDir.resolve(worktreeDir).resolve(branchName).toAbsolutePath();
        String fullBranch = LOOP_PREFIX + branchName;
        String worktreePathStr = worktreePath.toString();

        // 先尝试创建新分支
        String output = execGit(baseDir.toFile(), "worktree", "add", worktreePathStr, "-b", fullBranch);
        if (output != null) {
            log.info("Created worktree with new branch '{}' at: {}", fullBranch, worktreePathStr);
            return worktreePathStr;
        }

        // 分支已存在，直接用已有分支
        output = execGit(baseDir.toFile(), "worktree", "add", worktreePathStr, fullBranch);
        if (output != null) {
            log.info("Created worktree with existing branch '{}' at: {}", fullBranch, worktreePathStr);
            return worktreePathStr;
        }

        log.warn("Failed to create worktree for branch '{}'", branchName);
        return null;
    }

    /**
     * 提交 worktree 内的全部改动（含未跟踪文件）。
     *
     * <p>worktree 目录在单轮执行后会被移除，若不先提交则 AI 在其中产出的成果会被丢弃。
     * 调用方需根据返回值决定是否可安全删除目录：仅 {@link CommitOutcome#COMMITTED} 与
     * {@link CommitOutcome#NO_CHANGES} 下删除才不会丢失数据。</p>
     *
     * @param worktreePath worktree 路径
     * @param message      提交信息
     * @return 提交结果
     */
    public CommitOutcome commitAll(String worktreePath, String message) {
        if (worktreePath == null || worktreePath.isEmpty()) {
            return CommitOutcome.NO_CHANGES;
        }

        File dir = new File(worktreePath);
        if (!dir.isDirectory()) {
            return CommitOutcome.NO_CHANGES;
        }

        String status = execGit(dir, "status", "--porcelain");
        if (status == null) {
            log.warn("Cannot read worktree status, treat as dirty to avoid data loss: {}", worktreePath);
            return CommitOutcome.FAILED;
        }
        if (status.isEmpty()) {
            return CommitOutcome.NO_CHANGES;
        }

        if (execGit(dir, "add", "-A") == null) {
            log.warn("Failed to stage worktree changes: {}", worktreePath);
            return CommitOutcome.FAILED;
        }
        if (execGit(dir, "commit", "-m", message) == null) {
            log.warn("Failed to commit worktree changes (check git user.name/user.email): {}", worktreePath);
            return CommitOutcome.FAILED;
        }

        log.info("Committed worktree changes at: {}", worktreePath);
        return CommitOutcome.COMMITTED;
    }

    /**
     * 删除 worktree 目录，保留关联分支（不丢弃已提交成果）
     *
     * @param worktreePath worktree 路径
     */
    public void remove(String worktreePath) {
        remove(worktreePath, false);
    }

    /**
     * 删除 worktree 目录
     *
     * @param worktreePath worktree 路径
     * @param deleteBranch 是否同时删除关联分支。仅在确认分支无有效成果时传 true，
     *                     否则会连同 AI 已提交的工作一起丢弃。
     */
    public void remove(String worktreePath, boolean deleteBranch) {
        if (worktreePath == null || worktreePath.isEmpty()) {
            return;
        }

        Path worktree = Paths.get(worktreePath);
        File gitRoot = findGitRoot(worktree.toFile());
        if (gitRoot == null) {
            log.warn("Cannot find git root for worktree: {}", worktreePath);
            return;
        }

        // 移除 worktree
        execGit(gitRoot, "worktree", "remove", worktreePath, "--force");

        String dirName = worktree.getFileName().toString();
        String branchName = LOOP_PREFIX + dirName;
        if (deleteBranch) {
            execGit(gitRoot, "branch", "-D", branchName);
            log.info("Removed worktree and branch '{}'", branchName);
        } else {
            log.info("Removed worktree dir, kept branch '{}'", branchName);
        }
    }

    /**
     * worktree 改动提交结果
     */
    public enum CommitOutcome {
        /** 无任何改动，无需提交 */
        NO_CHANGES,
        /** 改动已提交到分支 */
        COMMITTED,
        /** 存在改动但提交失败（删除目录会丢失数据） */
        FAILED
    }

    /**
     * 检查指定路径是否为 git 仓库
     *
     * @param path 待检查路径
     * @return 是否为 git 仓库
     */
    public boolean isGitRepo(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }

        String result = execGit(new File(path), "rev-parse", "--is-inside-work-tree");
        return "true".equals(result);
    }

    /**
     * 清理所有 loop/ 前缀的 worktree
     *
     * @param basePath git 仓库根路径
     */
    public void cleanup(String basePath) {
        if (!isGitRepo(basePath)) {
            return;
        }

        Path baseDir = Paths.get(basePath);
        String output = execGit(baseDir.toFile(), "worktree", "list", "--porcelain");
        if (output == null) {
            return;
        }

        // 用 porcelain 格式解析：只收集 branch 以 loop/ 开头的 worktree
        List<String> loopWorktrees = new ArrayList<>();
        String currentWorktree = null;

        for (String line : output.split("\n")) {
            line = line.trim();
            if (line.startsWith("worktree ")) {
                currentWorktree = line.substring("worktree ".length());
            } else if (line.startsWith("branch refs/heads/" + LOOP_PREFIX) && currentWorktree != null) {
                loopWorktrees.add(currentWorktree);
                currentWorktree = null;
            }
        }

        for (String wtPath : loopWorktrees) {
            log.info("Cleaning up worktree: {}", wtPath);
            // 保留分支：loop/ 分支上可能累积了 AI 已提交的成果，不得随目录一起删除
            remove(wtPath, false);
        }

        if (loopWorktrees.isEmpty()) {
            log.info("No loop/ worktrees found to clean up.");
        } else {
            log.info("Cleaned up {} loop/ worktree(s).", loopWorktrees.size());
        }
    }

    /**
     * 执行 git 命令，返回 stdout 字符串
     *
     * @param dir 工作目录
     * @param args git 命令参数
     * @return stdout 内容，失败时返回 null
     */
    protected String execGit(File dir, String... args) {
        try {
            List<String> command = new ArrayList<>();
            command.add("git");
            for (String arg : args) {
                command.add(arg);
            }

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(dir);
            pb.redirectErrorStream(true);

            Process process = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            boolean finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                log.warn("Git command timed out: {}", String.join(" ", command));
                return null;
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                log.warn("Git command failed (exit {}): {} — {}", exitCode, String.join(" ", command), output.toString().trim());
                return null;
            }

            return output.toString().trim();

        } catch (Exception e) {
            log.warn("Failed to execute git command: {} — {}", String.join(" ", args), e.getMessage());
            return null;
        }
    }

    /**
     * 从 worktree 目录向上查找 git 根目录
     */
    private File findGitRoot(File worktreeDir) {
        String output = execGit(worktreeDir, "rev-parse", "--show-toplevel");
        if (output != null && !output.isEmpty()) {
            return new File(output);
        }
        return null;
    }
}
