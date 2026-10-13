package com.gourdai.ai.util;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

/**
 * MarkdownUtil frontmatter 解析的 BOM 契约测试。
 *
 * <p>背景（2026-10 codereview 抓出）：Windows 记事本/部分编辑器写出的 SKILL.md
 * 带 UTF-8 BOM，{@code Files.readAllLines} 不剥 BOM，首行变成 {@code "\uFEFF---"}；
 * 旧实现 {@code "---".equals(lines.get(0).trim())} 判定失败 → 整份 frontmatter
 * 被静默丢弃（description/enabled/when_to_use 全丢且无报错），表现为
 * 「技能描述为空」「启禁用开关写进去读不出来」。</p>
 *
 * <p>契约：带 BOM 与不带 BOM 的同一份 frontmatter 解析结果必须一致。</p>
 */
class MarkdownUtilBomTest {

    private static final List<String> BODY = Arrays.asList(
            "---",
            "name: demo-skill",
            "description: 演示技能",
            "enabled: false",
            "when_to_use: 用户提到演示时",
            "---",
            "",
            "# 正文");

    @Test
    @DisplayName("带 BOM 的 frontmatter 与不带 BOM 解析结果一致")
    void bomDoesNotSilentlyDropFrontmatter() {
        Markdown plain = MarkdownUtil.resolve(BODY, true);
        List<String> withBom = new java.util.ArrayList<>(BODY);
        withBom.set(0, "\uFEFF" + withBom.get(0));

        Markdown bom = MarkdownUtil.resolve(withBom, true);

        Assertions.assertEquals(plain.getDescription(), bom.getDescription(), "description 不得因 BOM 丢失");
        Assertions.assertEquals(plain.isEnabled(), bom.isEnabled(), "enabled 不得因 BOM 丢失");
        Assertions.assertEquals(plain.resolveWhenToUse(), bom.resolveWhenToUse(), "when_to_use 不得因 BOM 丢失");
        Assertions.assertFalse(bom.isEnabled(), "本样本 enabled=false 必须被读到");
        Assertions.assertEquals("演示技能", bom.getDescription());
    }

    @Test
    @DisplayName("无 BOM 行为不回退：边界/正文语义保持")
    void plainFrontmatterUnchanged() {
        Markdown md = MarkdownUtil.resolve(BODY, false);
        Assertions.assertEquals("演示技能", md.getDescription());
        Assertions.assertTrue(md.getContent().startsWith("# 正文"), "正文起点不得因 BOM 处理偏移");
    }
}
