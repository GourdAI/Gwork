package com.gourdai.harness.talents.cli;

import com.gourdai.ai.chat.content.ImageBlock;
import com.gourdai.ai.chat.content.TextBlock;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.chat.tool.ToolResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * read 视觉通道的 FunctionTool 反射执行链测试。
 *
 * <p>e2e 曾抓到：read(pic.png) 的文本元数据正确到达模型，但 ImageBlock 从
 * 工具结果中消失（工具消息退化为纯文本）。TerminalTalent.read 的直接方法调用
 * （TerminalReadVisionTest）是绿的，本测试走与生产相同的
 * {@code MethodFunctionTool(反射+参数绑定) → call() → ToolResult}
 * 链路，钉住 blocks 在反射执行链上不丢失。</p>
 */
class TerminalReadVisionToolChainTest {

    private static final byte[] TINY_PNG = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");

    @TempDir
    Path workDir;

    private TerminalTalent talent;

    @BeforeEach
    void setUp() throws IOException {
        Files.createDirectories(workDir);
        talent = new TerminalTalent(null, ShellCommandFactory.detect());
    }

    /** 与生产同构：经 MethodFunctionTool（反射 + 参数绑定 + result 转换）调用 read。 */
    @Test
    void read_image_survives_the_reflective_tool_chain() throws Throwable {
        Files.write(workDir.resolve("shot.png"), TINY_PNG);

        FunctionTool tool = talent.getToolMap().get("read");
        assertNotNull(tool, "read 必须经 @ToolMapping 反射注册发现");

        Map<String, Object> args = new HashMap<>();
        args.put("file_path", "shot.png");
        args.put("__cwd", workDir.toAbsolutePath().toString());
        args.put("__accessMode", "full");

        ToolResult result = tool.call(args);

        assertNotNull(result);
        assertEquals(2, result.getBlocks().size(),
                "反射链上 blocks 不得丢失：" + result.getBlocks());
        assertTrue(result.getBlocks().get(0) instanceof TextBlock);
        assertTrue(result.getBlocks().get(1) instanceof ImageBlock,
                "ImageBlock 必须在 ToolResult.blocks 里，否则模型视觉通道断链");
        ImageBlock image = (ImageBlock) result.getBlocks().get(1);
        assertEquals("image/png", image.getMimeType());
        assertTrue(result.isMultiModal(), "ToolResult 应判定为多模态");
    }
}
