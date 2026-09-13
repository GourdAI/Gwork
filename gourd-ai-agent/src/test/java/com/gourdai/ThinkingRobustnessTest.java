package com.gourdai;

import com.gourdai.core.portal.web.thinking.ReasoningCapabilities;
import com.gourdai.core.portal.web.thinking.ReasoningCapability;
import com.gourdai.core.portal.web.thinking.ThinkingLevel;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 思考档位健壮性回归 —— 锁定 code review 实测暴露的两类真实缺陷。
 *
 * <h3>缺陷一：Locale 敏感的大小写转换</h3>
 * <p>{@code String.toLowerCase()} / {@code toUpperCase()} 的无参重载使用 JVM 默认 Locale。
 * 在土耳其语 Locale（tr_TR）下字母 i/I 的大小写映射与 ASCII 不同：</p>
 * <pre>
 *   "HIGH".toLowerCase()  → "hıgh"   （无点小写 ı）
 *   "high".toUpperCase()  → "HİGH"   （带点大写 İ）
 * </pre>
 * <p>两处后果都已实测：档位编码查表失配后被静默归为 AUTO（用户选的档位凭空消失且无报错）；
 * Gemini 的 {@code thinkingLevel} 收到 "HİGH" 是非法枚举值，直接 400。</p>
 *
 * <h3>缺陷二：预算 clamp 可能跌破厂商下限</h3>
 * <p>「预算必须小于最大输出长度」这条收口在「不得低于厂商下限」之后执行，
 * 当基数过小时会把预算压到下限以下，发出必然被拒的请求。</p>
 *
 * @author oisin
 */
public class ThinkingRobustnessTest {

    private static final Locale TURKISH = new Locale("tr", "TR");

    private final Locale original = Locale.getDefault();

    @AfterEach
    void restoreLocale() {
        Locale.setDefault(original);
    }

    // ==================================================================
    // 一、Locale 敏感的大小写转换
    // ==================================================================

    @Test
    @DisplayName("土耳其语 Locale 下档位编码解析不得失配（负样本：无参 toLowerCase 会退化成 AUTO）")
    void levelParsingIsLocaleIndependent() {
        Locale.setDefault(TURKISH);

        // 先证明负样本确实会坏——否则本测试无法证伪，PASS 也没有意义
        assertEquals("hıgh", "HIGH".toLowerCase(),
                "前提失效：当前 JDK 在 tr_TR 下未复现 i/I 特例，本测试失去判别力");

        assertEquals(ThinkingLevel.HIGH, ThinkingLevel.from("HIGH"));
        assertEquals(ThinkingLevel.XHIGH, ThinkingLevel.from("XHIGH"));
        assertEquals(ThinkingLevel.HIGH, ThinkingLevel.from("High"));
        // 历史值迁移在特殊 Locale 下同样要成立
        assertEquals(ThinkingLevel.LOW, ThinkingLevel.from("MINIMAL"));
        assertEquals(ThinkingLevel.AUTO, ThinkingLevel.from("OFF"));
        assertEquals("high", ThinkingLevel.normalize("HIGH"));
        assertEquals("xhigh", ThinkingLevel.normalize("XHIGH"));
    }

    @Test
    @DisplayName("土耳其语 Locale 下规则表匹配不得失配")
    void ruleMatchingIsLocaleIndependent() {
        Locale.setDefault(TURKISH);

        // MINIMAL / HIGH 两个含 i 的片段都要能命中
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "GPT-5.6-SOL", null);
        assertTrue(cap.effectiveEfforts().contains("max"));
        assertEquals("max", cap.resolveEffort(ThinkingLevel.MAX));

        ReasoningCapability gemini = ReasoningCapabilities.resolve("gemini", "GEMINI-3-FLASH", null);
        assertTrue(gemini.effectiveEfforts().contains("minimal"));
    }

    @Test
    @DisplayName("源码契约：思考档位相关类禁止使用无 Locale 参数的大小写转换")
    void noLocaleSensitiveCaseConversionInSource() throws IOException {
        List<Path> targets = new ArrayList<>();
        Path thinking = Paths.get("src/main/java/com/gourdai/core/portal/web/thinking");
        try (Stream<Path> walk = Files.walk(thinking)) {
            walk.filter(p -> p.toString().endsWith(".java")).forEach(targets::add);
        }
        targets.add(Paths.get("src/main/java/com/gourdai/core/portal/web/ThinkingDepth.java"));

        // 剔除注释：本文件与被检测文件的注释里都会举例写出问题写法，不剔除会自我误报
        Pattern bad = Pattern.compile("to(Lower|Upper)Case\\s*\\(\\s*\\)");
        List<String> violations = new ArrayList<>();
        for (Path p : targets) {
            assertTrue(Files.exists(p), "待检查的源文件不存在: " + p);
            String[] lines = new String(Files.readAllBytes(p), StandardCharsets.UTF_8).split("\r?\n");
            boolean inBlockComment = false;
            for (int i = 0; i < lines.length; i++) {
                String code = lines[i];
                String trimmed = code.trim();
                if (inBlockComment) {
                    if (trimmed.contains("*/")) {
                        inBlockComment = false;
                        code = trimmed.substring(trimmed.indexOf("*/") + 2);
                    } else {
                        continue;
                    }
                }
                if (trimmed.startsWith("/*")) {
                    if (!trimmed.contains("*/")) {
                        inBlockComment = true;
                    }
                    continue;
                }
                int lineComment = code.indexOf("//");
                if (lineComment >= 0) {
                    code = code.substring(0, lineComment);
                }
                Matcher m = bad.matcher(code);
                if (m.find()) {
                    violations.add(p.getFileName() + ":" + (i + 1) + "  " + lines[i].trim());
                }
            }
        }
        assertTrue(violations.isEmpty(),
                "发现 Locale 敏感的大小写转换（必须显式传 Locale.ROOT）：\n  "
                        + String.join("\n  ", violations));
    }

    // ==================================================================
    // 二、预算 clamp 跌破厂商下限
    // ==================================================================

    @Test
    @DisplayName("最大输出长度过小时宁可不注入，也不得发出低于厂商下限的思考预算")
    void budgetNeverFallsBelowVendorMinimum() {
        ReasoningCapability claude = ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5", null);
        assertEquals(ReasoningCapability.Shape.ANTHROPIC_BUDGET, claude.shape());
        Integer min = claude.budgetMin();
        assertNotNull(min, "经典 Claude 必须声明官方预算下限");

        // 基数小于等于下限时，任何档位都容不下合法预算 —— 必须返回 null（不注入）
        for (int base : new int[]{1, 512, 1024}) {
            for (ThinkingLevel level : ThinkingLevel.ladder()) {
                assertNull(claude.resolveBudget(level, base),
                        "base=" + base + " level=" + level.code() + " 应不注入，实际发出了非法预算");
            }
        }

        // 基数足够大时必须照常产出，且始终落在 [min, base) 内
        for (int base : new int[]{2000, 32000, 64000}) {
            for (ThinkingLevel level : ThinkingLevel.ladder()) {
                Integer budget = claude.resolveBudget(level, base);
                assertNotNull(budget, "base=" + base + " level=" + level.code() + " 不应为空");
                assertTrue(budget >= min, "base=" + base + " level=" + level.code()
                        + " 预算 " + budget + " 低于官方下限 " + min);
                assertTrue(budget < base, "base=" + base + " level=" + level.code()
                        + " 预算 " + budget + " 未严格小于最大输出长度");
            }
        }
    }

    @Test
    @DisplayName("默认基数下 Anthropic 预算保持零回归（12.5%/37.5%/75% 锚定旧实现）")
    void anthropicBudgetStaysBackwardCompatible() {
        ReasoningCapability claude = ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5", null);
        assertEquals(4000, claude.resolveBudget(ThinkingLevel.LOW, null));
        assertEquals(12000, claude.resolveBudget(ThinkingLevel.MEDIUM, null));
        assertEquals(24000, claude.resolveBudget(ThinkingLevel.HIGH, null));
    }

    @Test
    @DisplayName("Gemini 2.5 预算受官方上限 clamp，且不低于下限")
    void geminiBudgetRespectsBounds() {
        ReasoningCapability g = ReasoningCapabilities.resolve("gemini", "gemini-2.5-flash", null);
        assertEquals(ReasoningCapability.Shape.GEMINI_BUDGET, g.shape());
        for (int base : new int[]{1000, 8000, 32000, 128000}) {
            for (ThinkingLevel level : ThinkingLevel.ladder()) {
                Integer budget = g.resolveBudget(level, base);
                if (budget == null) {
                    continue;
                }
                assertTrue(budget >= g.budgetMin(),
                        "base=" + base + " " + level.code() + " 低于下限: " + budget);
                assertTrue(budget <= g.budgetMax(),
                        "base=" + base + " " + level.code() + " 超出上限: " + budget);
                assertTrue(budget < base,
                        "base=" + base + " " + level.code() + " 未小于最大输出长度: " + budget);
            }
        }
    }
}
