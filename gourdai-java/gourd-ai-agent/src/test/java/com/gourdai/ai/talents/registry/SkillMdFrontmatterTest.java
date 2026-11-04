package com.gourdai.ai.talents.registry;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SkillMdFrontmatter 单元测试 — 技能启禁用开关的落盘行为。
 *
 * <p>核心契约：最小改写（其余行逐字保留）、行尾保持原主行尾、
 * 无 frontmatter 时头部补块、isEnabled 与 Markdown.isEnabled 同口径。</p>
 *
 * @author oisin
 */
public class SkillMdFrontmatterTest {

    @TempDir
    Path tempDir;

    private Path skillDirWith(String content) throws Exception {
        Path dir = Files.createTempDirectory(tempDir, "skill-");
        Files.write(dir.resolve("SKILL.md"), content.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    private String read(Path dir) throws Exception {
        return new String(Files.readAllBytes(dir.resolve("SKILL.md")), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("已有 frontmatter 无 enabled 键：禁用应在结束分隔符前插入键行，其余逐字保留")
    void insertEnabledKey() throws Exception {
        Path dir = skillDirWith("---\nname: demo\ndescription: 描述一行\n---\n\n# 正文\n保持不动\n");

        assertTrue(SkillMdFrontmatter.setEnabled(dir, false));

        String out = read(dir);
        assertTrue(out.contains("enabled: false"), "应写入 enabled: false");
        assertTrue(out.contains("name: demo"), "既有键必须保留");
        assertTrue(out.contains("# 正文\n保持不动\n"), "正文必须逐字保留");
        // 插入位置在 frontmatter 内（结束 --- 之前）
        int enabledIdx = out.indexOf("enabled: false");
        int fenceEnd = out.indexOf("---", out.indexOf("---") + 3);
        assertTrue(enabledIdx < fenceEnd, "enabled 必须落在 frontmatter 块内");
        assertFalse(SkillMdFrontmatter.isEnabled(dir), "isEnabled 应读到 false");
    }

    @Test
    @DisplayName("已有 enabled 键：只替换该行值，不产生重复键")
    void replaceExistingKey() throws Exception {
        Path dir = skillDirWith("---\nname: demo\nenabled: false\nversion: 1.0.0\n---\nbody\n");

        assertTrue(SkillMdFrontmatter.setEnabled(dir, true));

        String out = read(dir);
        int first = out.indexOf("enabled:");
        int second = out.indexOf("enabled:", first + 1);
        assertEquals(-1, second, "不得出现第二个 enabled 键");
        assertTrue(out.contains("enabled: true"));
        assertTrue(out.contains("version: 1.0.0"), "其它键必须保留");
        assertTrue(SkillMdFrontmatter.isEnabled(dir));
    }

    @Test
    @DisplayName("无 frontmatter：头部补 --- 块且正文逐字保留")
    void prependFrontmatterWhenMissing() throws Exception {
        Path dir = skillDirWith("# 标题\n\n正文第一段\n");

        assertTrue(SkillMdFrontmatter.setEnabled(dir, false));

        String out = read(dir);
        assertTrue(out.startsWith("---\n"), "应以 frontmatter 开始");
        assertTrue(out.contains("# 标题\n\n正文第一段\n"), "正文必须逐字保留");
        assertFalse(SkillMdFrontmatter.isEnabled(dir));
    }

    @Test
    @DisplayName("CRLF 文件写回后仍为纯 CRLF（不引入裸 LF）")
    void preserveCrlf() throws Exception {
        Path dir = skillDirWith("---\r\nname: demo\r\n---\r\n\r\nbody line\r\n");

        assertTrue(SkillMdFrontmatter.setEnabled(dir, false));

        String out = read(dir);
        int lf = 0;
        int crlf = 0;
        for (int i = 0; i < out.length(); i++) {
            if (out.charAt(i) == '\n') {
                if (i > 0 && out.charAt(i - 1) == '\r') crlf++;
                else lf++;
            }
        }
        assertEquals(0, lf, "不得引入裸 LF");
        assertTrue(crlf >= 4, "CRLF 行数应保持");
        // 双重 CR 门禁：拆行未归一 CRLF 时，写回会把每行变成 \r\r\n。
        // 只数裸 LF 的旧断言对此完全看不见（\r\r\n 里的 \n 前有 \r，计入 crlf）。
        assertEquals(-1, out.indexOf("\r\r"), "不得产生双重 CR（\\r\\r\\n 污染）");
        assertTrue(out.contains("---\r\nname: demo\r\n"), "既有行必须逐字保留（含行尾）");
        assertFalse(SkillMdFrontmatter.isEnabled(dir));
    }

    @Test
    @DisplayName("带 BOM 的 CRLF 文件：写回后 BOM 仍在文件头且无双重 CR")
    void preserveBomAndCrlf() throws Exception {
        Path dir = skillDirWith("\uFEFF# 标题\r\n正文\r\n");

        assertTrue(SkillMdFrontmatter.setEnabled(dir, false));

        String out = read(dir);
        assertTrue(out.startsWith("\uFEFF---\r\n"), "BOM 必须仍在文件头（不得落到文件中部）");
        assertEquals(-1, out.indexOf("\r\r"), "不得产生双重 CR");
        assertTrue(out.contains("# 标题\r\n正文\r\n"), "正文必须逐字保留");
        assertFalse(SkillMdFrontmatter.isEnabled(dir));
    }

    @Test
    @DisplayName("缺少 SKILL.md 时 setEnabled 返回 false 且不抛异常")
    void missingSkillMd() throws Exception {
        Path dir = Files.createTempDirectory(tempDir, "empty-");
        assertFalse(SkillMdFrontmatter.setEnabled(dir, false));
        assertTrue(SkillMdFrontmatter.isEnabled(dir), "缺文件按启用处理（与扫描容错同口径）");
    }

    @Test
    @DisplayName("frontmatterKey：识别一级键、排除注释/列表/URL 误判")
    void frontmatterKeyParsing() {
        assertEquals("name", SkillMdFrontmatter.frontmatterKey("name: demo"));
        assertEquals("enabled", SkillMdFrontmatter.frontmatterKey("  enabled: false  "));
        assertEquals("", SkillMdFrontmatter.frontmatterKey("# 注释"));
        assertEquals("", SkillMdFrontmatter.frontmatterKey("  - item"));
        assertEquals("", SkillMdFrontmatter.frontmatterKey(""));
        assertEquals("", SkillMdFrontmatter.frontmatterKey(null));
        // 无冒号值分隔的行不是键
        assertEquals("", SkillMdFrontmatter.frontmatterKey("plain text"));
    }

    @Test
    @DisplayName("detectEol：CRLF 多数判 CRLF，LF 多数判 LF")
    void detectEol() {
        assertEquals("\r\n", SkillMdFrontmatter.detectEol("a\r\nb\r\nc\n"));
        assertEquals("\n", SkillMdFrontmatter.detectEol("a\nb\nc\r\n"));
        assertEquals("\n", SkillMdFrontmatter.detectEol("no newline"));
    }
}
