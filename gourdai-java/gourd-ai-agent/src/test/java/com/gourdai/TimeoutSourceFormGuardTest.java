package com.gourdai;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 源码形态防回归：把「毫秒当秒」的超时写法钉在编译期之外的第二道门上。
 *
 * <p>为什么必须做源码扫描而非行为断言：{@code HttpUtils.timeout(int)} 的单位是<b>秒</b>，
 * 写成 {@code .timeout(30000)} 语法完全合法、编译通过、运行不报错，实际含义是
 * <b>8.3 小时</b>——等价于「没有超时」。这种缺陷没有任何运行期信号可供断言，
 * 只有源码形态可以拦。</p>
 *
 * <p>本仓库已有同类源码文本扫描测试的先例（见 {@code ThinkingReplaySuppressionTest}
 * 末尾的 {@code reasonTask_keepsSuppressionGuard}），此处沿用其 {@code locate} 双工作目录兼容写法。</p>
 */
class TimeoutSourceFormGuardTest {

    /** 市场类：查询类用 {@code .timeout(10, 10, 30)}，下载类用 {@code .timeout(10, 10, 120)}。 */
    private static final List<String> MARKET_SOURCES = Arrays.asList(
            "src/main/java/com/gourdai/core/portal/web/market/impl/ClawhubMarket.java",
            "src/main/java/com/gourdai/core/portal/web/market/impl/ModelscopeMarket.java",
            "src/main/java/com/gourdai/core/portal/web/market/impl/SkillhubMarket.java",
            "src/main/java/com/gourdai/core/portal/web/market/impl/SkillsShMarket.java");

    /**
     * 单参数 {@code .timeout(N)} 且 N 为 4 位以上整数——必然是「把毫秒写进了秒位」。
     * 合法的秒级单参配置最多三位（999s ≈ 16 分钟已远超任何 HTTP 场景）。
     */
    private static final Pattern MILLIS_AS_SECONDS = Pattern.compile("\\.timeout\\(\\s*\\d{4,}\\s*\\)");

    /** 三参形态 {@code .timeout(connect, write, read)}：修复后的正确写法。 */
    private static final Pattern THREE_ARG_TIMEOUT =
            Pattern.compile("\\.timeout\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*\\)");

    @Test
    @DisplayName("防回归：4 个市场类不得出现单参裸大数值 .timeout(N)（毫秒当秒 = 事实上没有超时）")
    void marketSources_haveNoMillisAsSecondsTimeout() throws IOException {
        List<String> violations = new ArrayList<>();

        for (String relative : MARKET_SOURCES) {
            Path path = locate(relative);
            assertTrue(Files.exists(path), "未找到市场类源码：" + path.toAbsolutePath());

            String[] lines = read(path).split("\r\n|\n|\r");
            for (int i = 0; i < lines.length; i++) {
                Matcher m = MILLIS_AS_SECONDS.matcher(lines[i]);
                while (m.find()) {
                    violations.add(path + ":" + (i + 1) + " -> " + lines[i].trim());
                }
            }
        }

        assertTrue(violations.isEmpty(),
                "HttpUtils.timeout(int) 的单位是【秒】，出现 4 位以上单参数值即为毫秒误用（30000 秒 = 8.3 小时）。"
                        + " 请改用三参 .timeout(connect, write, read)。命中：" + violations);
    }

    @Test
    @DisplayName("防回归：4 个市场类必须各自使用三参 .timeout(connect, write, read)")
    void marketSources_useThreeArgTimeout() throws IOException {
        for (String relative : MARKET_SOURCES) {
            Path path = locate(relative);
            String src = read(path);

            assertTrue(THREE_ARG_TIMEOUT.matcher(src).find(),
                    "必须显式声明三段式超时，防止回退到单参秒级写法：" + path);
            // 具体口径：查询类 30s 读、下载类 120s 读，建连/写均为 10s
            assertTrue(src.contains(".timeout(10, 10, 30)") || src.contains(".timeout(10, 10, 120)"),
                    "三段式取值口径漂移（期望查询类 (10, 10, 30) 或下载类 (10, 10, 120)）：" + path);
        }
    }

    @Test
    @DisplayName("防回归：市场类中被修复的 8 处具体数值不得回到 30000 / 15000")
    void marketSources_haveNoLegacyLiterals() throws IOException {
        for (String relative : MARKET_SOURCES) {
            Path path = locate(relative);
            String src = read(path);

            assertFalse(src.contains(".timeout(30000)"), "旧的毫秒误用写法回归：" + path);
            assertFalse(src.contains(".timeout(15000)"), "旧的毫秒误用写法回归：" + path);
        }
    }

    @Test
    @DisplayName("防回归：MCP 两个文件不得回到 HttpTimeout.of((int) ...) 截断写法")
    void mcpSources_haveNoIntTruncatingHttpTimeout() throws IOException {
        List<String> mcpSources = Arrays.asList(
                "src/main/java/com/gourdai/ai/mcp/client/McpClientProperties.java",
                "src/main/java/com/gourdai/ai/mcp/client/McpClientProviders.java");

        for (String relative : mcpSources) {
            Path path = locate(relative);
            assertTrue(Files.exists(path), "未找到 MCP 源码：" + path.toAbsolutePath());

            String src = read(path);
            // 注释里会解释旧写法，只扫描去掉注释后的有效代码
            String code = stripComments(src);

            assertFalse(code.contains("HttpTimeout.of((int)"),
                    "(int) getSeconds() 会把亚秒配置截断成 0，而 HttpTimeout.of(0) = 永不超时：" + path);
            assertFalse(code.replaceAll("\\s+", "").contains("HttpTimeout.of((int)"),
                    "同上（忽略空白后的等价写法）：" + path);
        }
    }

    @Test
    @DisplayName("防回归：MCP 换算口径单点收口——Providers 必须复用 resolveHttpTimeout")
    void mcpProviders_reusesResolveHttpTimeout() throws IOException {
        Path path = locate("src/main/java/com/gourdai/ai/mcp/client/McpClientProviders.java");
        String code = stripComments(read(path));

        assertTrue(code.contains("McpClientProperties.resolveHttpTimeout("),
                "必须复用 McpClientProperties.resolveHttpTimeout，避免两处换算口径漂移：" + path);
    }

    @Test
    @DisplayName("防回归：AiConfig 的 HTTP 超时必须是三段式 Duration 形态")
    void aiConfig_usesThreeSegmentDurationTimeout() throws IOException {
        Path path = locate("src/main/java/com/gourdai/ai/AiConfig.java");
        String code = stripComments(read(path));

        assertTrue(code.contains("HttpTimeout.of(CONNECT_TIMEOUT, resolveIoTimeout(), resolveIoTimeout())"),
                "建连必须固定、读写必须过 resolveIoTimeout() 下限收口：" + path);
        assertFalse(code.contains("HttpTimeout.of((int)"), "不得回退到秒级截断写法：" + path);
    }

    /** 去掉块注释与行注释：避免注释里解释旧写法的文本被判为违规。 */
    private static String stripComments(String src) {
        return src.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)//.*$", " ");
    }

    private static String read(Path path) throws IOException {
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    /** 兼容两种工作目录：模块目录（Maven 默认）与仓库根目录。 */
    private static Path locate(String relative) {
        Path direct = Paths.get(relative);
        if (Files.exists(direct)) {
            return direct;
        }

        return Paths.get("gourd-ai-agent").resolve(relative);
    }
}
