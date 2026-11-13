package com.gourdai.core.portal.web.market.impl;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ClawHub 描述 frontmatter 剥离的单元测试。
 *
 * <p>背景（2026-11 实测）：clawhub.ai {@code /api/v1/skills/{slug}} 的
 * {@code skill.description} 返回 SKILL.md 原文——{@code ---} frontmatter 块打头，
 * 详情弹窗直接展示会把 {@code ---\nname: xxx} 机器头泄露给用户（用户报
 * 「clawhub 源的详情展示也有问题」）。剥离规则与 Rust 内核
 * {@code strip_skill_md_frontmatter} 逐条镜像，两侧测试用例同构。</p>
 *
 * @author oisin
 */
public class ClawhubFrontmatterStripTest {

    @Test
    @DisplayName("实测形态：frontmatter 块整体剥离，保留 Markdown 正文")
    void stripsTheObservedShape() {
        String raw = "---\nname: innerwarden-security\ndescription: Install, verify and run\n"
                + "user-invocable: true\nmetadata: {\"a\":1}\n---\n\n# InnerWarden, from inside\n\n正文段落。";
        String out = ClawhubMarket.stripSkillMdFrontmatter(raw);
        assertNotNull(out);
        assertTrue(out.startsWith("# InnerWarden"), out);
        assertFalse(out.contains("name: innerwarden-security"), out);
        assertFalse(out.startsWith("---"), out);
    }

    @Test
    @DisplayName("无 frontmatter 的普通描述原样返回")
    void plainTextUntouched() {
        assertEquals("Just a description.", ClawhubMarket.stripSkillMdFrontmatter("Just a description."));
        assertEquals("", ClawhubMarket.stripSkillMdFrontmatter(""));
        assertNull(ClawhubMarket.stripSkillMdFrontmatter(null));
    }

    @Test
    @DisplayName("未闭合的 --- 不剥离（宁可多展示也不误删正文）")
    void unclosedFenceUntouched() {
        String raw = "---\nname: x\ndescription: y\n正文里提到 --- 分隔线";
        assertEquals(raw, ClawhubMarket.stripSkillMdFrontmatter(raw));
    }

    @Test
    @DisplayName("首行非恰为 --- 时不剥离（---foo / ---- 是正文）")
    void nonExactOpeningUntouched() {
        assertEquals("----\nbody", ClawhubMarket.stripSkillMdFrontmatter("----\nbody"));
        assertEquals("---foo\n---\nbody", ClawhubMarket.stripSkillMdFrontmatter("---foo\n---\nbody"));
    }

    @Test
    @DisplayName("正文中的 ---foo 行不被误认作闭合行，真正的闭合行才生效")
    void closingLineMustBeExact() {
        String raw = "---\nname: x\n---\nbody\n---not-a-fence\nmore";
        String out = ClawhubMarket.stripSkillMdFrontmatter(raw);
        assertEquals("body\n---not-a-fence\nmore", out);
    }

    @Test
    @DisplayName("CRLF 与闭合行在文末的形态均可剥离")
    void crlfAndEofClosing() {
        assertEquals("body", ClawhubMarket.stripSkillMdFrontmatter("---\r\nname: x\r\n---\r\nbody"));
        assertNull(ClawhubMarket.stripSkillMdFrontmatter("---\nname: x\n---"),
                "剥离后为空应返回 null（与 ONode 缺省语义一致，前端回退 summary）");
    }
}
