package com.gourdai.harness.talents.cli;

import com.gourdai.ai.chat.content.ImageBlock;
import com.gourdai.ai.chat.tool.ToolResult;
import com.gourdai.ai.talents.registry.TalentRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * read 工具视觉通道（图片直读）契约测试。
 *
 * <p>背景：此前磁盘图片对模型不可见——read 按纯文本工具设计拒绝二进制，
 * 而两内核均无视觉工具，导致“看磁盘图片”只能靠 OCR。修复后 read 遇图片
 * 返回 文本元数据 + ImageBlock，经多模态出站链以 image_url 进入请求体。</p>
 */
class TerminalReadVisionTest {

    private static final byte[] TINY_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    @TempDir
    Path workDir;

    private TerminalTalent talent;
    private String cwd;

    @BeforeEach
    void setUp() throws IOException {
        Files.createDirectories(workDir);
        // registry 仅用于技能/代理查找，read 不触达；与 TerminalAccessModeFoldingTest 同构
        talent = new TerminalTalent(null, ShellCommandFactory.detect());
        cwd = workDir.toAbsolutePath().toString();
    }

    private void writeTinyImage(String name) throws IOException {
        Files.write(workDir.resolve(name), TINY_PNG);
    }

    // ─── 1. 图片返回视觉块 ───────────────────────────────────────────────

    @Test
    void read_image_returns_tool_result_with_image_block() throws IOException {
        writeTinyImage("shot.png");
        ToolResult result = talent.read("shot.png", null, null, cwd, "full");

        assertNotNull(result);
        ImageBlock image = result.getBlocks().stream()
                .filter(b -> b instanceof ImageBlock)
                .map(b -> (ImageBlock) b)
                .findFirst()
                .orElse(null);
        assertNotNull(image, "read(png) 必须携带 ImageBlock（模型视觉通道）");
        assertEquals("image/png", image.getMimeType());
        // getData() 返回 base64 字符串，须与磁盘字节重新编码后比对
        assertEquals(
                Base64.getEncoder().encodeToString(TINY_PNG),
                image.getData());
        // 同时保留文本元数据，说明路径与大小
        assertTrue(result.getContent().contains("shot.png"), "文本应含路径");
    }

    @Test
    void read_jpg_maps_to_image_jpeg_mime() throws IOException {
        writeTinyImage("photo.JPG"); // 大写扩展名也要命中
        ToolResult result = talent.read("photo.JPG", null, null, cwd, "full");

        ImageBlock image = result.getBlocks().stream()
                .filter(b -> b instanceof ImageBlock)
                .map(b -> (ImageBlock) b)
                .findFirst()
                .orElse(null);
        assertNotNull(image);
        assertEquals("image/jpeg", image.getMimeType());
    }

    // ─── 2. 非图片二进制保持既有拒绝 ─────────────────────────────────────

    @Test
    void read_non_image_binary_still_rejected() throws IOException {
        Files.write(workDir.resolve("blob.bin"), new byte[]{0x00, 0x01, 0x02, 0x03});
        ToolResult result = talent.read("blob.bin", null, null, cwd, "full");

        assertNotNull(result);
        assertTrue(result.getBlocks().stream().noneMatch(b -> b instanceof ImageBlock),
                "非图片二进制不得携带视觉块");
        assertEquals("错误：该文件是二进制格式，无法作为文本读取。", result.getContent());
    }

    // ─── 3. 超限明确报错而不是静默丢图 ──────────────────────────────────

    @Test
    void read_oversize_image_reports_explicit_error() throws IOException {
        // 构造 4MB+1 字节的 png 后缀文件（不写 5MB 真实数据到临时目录，
        // 内容无所谓——上限检查在读字节之前，先 Files.size 判断）
        Path big = workDir.resolve("huge.png");
        byte[] chunk = new byte[1024 * 1024];
        try (var out = Files.newOutputStream(big)) {
            for (int i = 0; i < 4; i++) out.write(chunk);
            out.write(new byte[1]);
        }
        ToolResult result = talent.read("huge.png", null, null, cwd, "full");

        assertTrue(result.getBlocks().stream().noneMatch(b -> b instanceof ImageBlock),
                "超限图片必须拒绝，不得截断后偷偷内联");
        assertTrue(result.getContent().contains("上限"), "超限必须给出明确原因");
        assertTrue(result.getContent().contains("附件"), "超限应引导改走附件通道");
    }

    // ─── 4. 文本文件行为不变 ─────────────────────────────────────────────

    @Test
    void read_text_file_unchanged() throws IOException {
        Files.write(workDir.resolve("note.txt"), List.of("hello", "world"),
                StandardCharsets.UTF_8);
        ToolResult result = talent.read("note.txt", null, null, cwd, "full");

        assertNotNull(result);
        assertTrue(result.getBlocks().stream().noneMatch(b -> b instanceof ImageBlock));
        assertTrue(result.getContent().contains("hello"));
        assertTrue(result.getContent().contains("[文件读取完毕]"));
    }

    // ─── 5. 助手函数：格式判定与 mime 映射 ───────────────────────────────

    @Test
    void vision_image_detection_covers_supported_formats() throws IOException {
        for (String name : new String[]{"a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp"}) {
            Path p = workDir.resolve(name);
            Files.write(p, TINY_PNG);
            assertTrue(TerminalSupport.isVisionImageFile(p), "应识别: " + name);
        }
        for (String name : new String[]{"a.svg", "a.pdf", "a.zip", "note.txt"}) {
            Path p = workDir.resolve(name);
            Files.write(p, TINY_PNG);
            assertFalse(TerminalSupport.isVisionImageFile(p), "不支持/非图片不应命中: " + name);
        }
    }

    @Test
    void image_mime_mapping_matches_attachment_channel() throws IOException {
        // 与附件通道（WebGate.extensionToMime）图片集合对齐；未匹配默认 png
        assertEquals("image/jpeg", TerminalSupport.imageMimeOf(workDir.resolve("x.jpg")));
        assertEquals("image/jpeg", TerminalSupport.imageMimeOf(workDir.resolve("x.jpeg")));
        assertEquals("image/png", TerminalSupport.imageMimeOf(workDir.resolve("x.png")));
        assertEquals("image/gif", TerminalSupport.imageMimeOf(workDir.resolve("x.gif")));
        assertEquals("image/webp", TerminalSupport.imageMimeOf(workDir.resolve("x.webp")));
        assertEquals("image/bmp", TerminalSupport.imageMimeOf(workDir.resolve("x.bmp")));
    }
}
