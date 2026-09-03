package com.gourdai.harness.talents.cli;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.talents.mount.MountManager;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Collections;
import java.util.HashSet;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 敏感路径准入校验（enforceFilesystemPolicy）单元测试。
 *
 * <p>背景：MANDATORY_DENY 名单此前是死代码（定义存在、零调用点），导致沙盒模式下
 * .gitconfig / .git/hooks / .gwork/agents 等敏感路径可被文件工具自由读写。</p>
 *
 * @author oisin
 */
public class TerminalSupportPolicyTest {

    private TerminalSupport newSupport() {
        return new TerminalSupport(new MountManager(""), new HashSet<>(Collections.emptyList()), ShellMode.UNIX_SHELL);
    }

    // ==================== 写拦截：全量 deny 名单 ====================

    @Test
    @DisplayName("沙盒模式：写 .gitconfig 被拒绝")
    void writeGitconfigDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        SecurityException e = assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".gitconfig", true, true, false));
        assertTrue(e.getMessage().contains("禁止写入"), e.getMessage());
    }

    @Test
    @DisplayName("沙盒模式：写 .git/hooks 下的文件被拒绝（持久化后门路径）")
    void writeGitHooksDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".git/hooks/pre-commit", true, true, false));
    }

    @Test
    @DisplayName("沙盒模式：写 .gwork/agents 下的文件被拒绝（自我改写路径）")
    void writeGworkAgentsDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".gwork/agents/evil.md", true, true, false));
    }

    @Test
    @DisplayName("沙盒模式：写嵌套子目录中的 .bashrc 同样被拒绝")
    void writeNestedBashrcDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, "sub/dir/.bashrc", true, true, false));
    }

    @Test
    @DisplayName("沙盒模式：写普通业务文件正常放行")
    void writeNormalFileAllowed(@TempDir Path work) throws IOException {
        TerminalSupport support = newSupport();
        Path target = support.resolveSafePath(work, "src/main/App.java", true, true, false);
        assertTrue(target.toString().replace("\\", "/").endsWith("src/main/App.java"));
    }

    // ==================== 读拦截：仅凭据子集 ====================

    @Test
    @DisplayName("沙盒模式：读 .gitconfig 被拒绝（含凭据）")
    void readGitconfigDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        SecurityException e = assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".gitconfig", false, true, false));
        assertTrue(e.getMessage().contains("禁止读取"), e.getMessage());
    }

    @Test
    @DisplayName("沙盒模式：读 .mcp.json 被拒绝（含凭据）")
    void readMcpJsonDenied(@TempDir Path work) {
        TerminalSupport support = newSupport();
        assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".mcp.json", false, true, false));
    }

    @Test
    @DisplayName("沙盒模式：读 .vscode 目录放行（威胁在写不在读，避免影响正常浏览）")
    void readVscodeAllowed(@TempDir Path work) throws IOException {
        TerminalSupport support = newSupport();
        assertNotNull(support.resolveSafePath(work, ".vscode/settings.json", false, true, false));
    }

    @Test
    @DisplayName("沙盒模式：读 .gwork/agents 放行，但写被拒绝（读写不对称）")
    void readGworkAgentsAllowedButWriteDenied(@TempDir Path work) throws IOException {
        TerminalSupport support = newSupport();
        assertNotNull(support.resolveSafePath(work, ".gwork/agents/a.md", false, true, false));
        assertThrows(SecurityException.class,
                () -> support.resolveSafePath(work, ".gwork/agents/a.md", true, true, false));
    }

    // ==================== 开放模式：零行为变更 ====================

    @Test
    @DisplayName("开放模式：写 .gitconfig 不受限制（用户已明确放弃隔离）")
    void openModeWriteAllowed(@TempDir Path work) throws IOException {
        TerminalSupport support = newSupport();
        assertNotNull(support.resolveSafePath(work, ".gitconfig", true, false, false));
    }

    @Test
    @DisplayName("开放模式：读 .mcp.json 不受限制")
    void openModeReadAllowed(@TempDir Path work) throws IOException {
        TerminalSupport support = newSupport();
        assertNotNull(support.resolveSafePath(work, ".mcp.json", false, false, false));
    }

    // ==================== 名单判定纯函数 ====================

    @Test
    @DisplayName("isMandatoryDenyRelativePath：路径分隔符与 ./ 前缀归一")
    void denyPathNormalization() {
        assertTrue(TerminalSupport.isMandatoryDenyRelativePath(".gitconfig"));
        assertTrue(TerminalSupport.isMandatoryDenyRelativePath("./.gitconfig"));
        assertTrue(TerminalSupport.isMandatoryDenyRelativePath(".git\\hooks\\pre-commit"));
        assertFalse(TerminalSupport.isMandatoryDenyRelativePath("src/App.java"));
        assertFalse(TerminalSupport.isMandatoryDenyRelativePath(null));
    }

    @Test
    @DisplayName("isReadDenied：仅命中凭据子集，不误伤同前缀的普通文件")
    void readDenyScope() {
        assertTrue(TerminalSupport.isReadDenied(".gitconfig"));
        assertTrue(TerminalSupport.isReadDenied("sub/.zshrc"));
        assertFalse(TerminalSupport.isReadDenied(".gitconfig.bak"));
        assertFalse(TerminalSupport.isReadDenied(".vscode/settings.json"));
        assertFalse(TerminalSupport.isReadDenied(null));
    }
}
