package com.gourdai.ai.util;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * frontmatter 降级提取器 {@link MarkdownUtil#salvageFrontmatter} 的口径契约。
 *
 * <p>它只在 SnakeYAML 整块解析失败时兜底，目标是「拿到能用的元数据」而不是复刻一个
 * YAML 解析器。因此口径必须收紧到<b>只认顶层 {@code key: value}</b>：放宽就会把
 * {@code allowed-tools} 下面的 {@code - Read} 或 {@code metadata.version} 误当成顶层字段，
 * 反而污染元数据。</p>
 *
 * <p>放在本包（而非 harness 侧）是因为该方法是包级私有的内部实现细节，
 * 刻意不为测试扩大 API 面。注入侧的端到端契约见
 * {@code SkillListingInjectionTest}。</p>
 *
 * @author oisin
 */
public class MarkdownUtilSalvageTest {

    @Test
    @DisplayName("只认顶层键：缩进嵌套项与列表项都不算")
    void skipsNestedAndListLines() {
        Map<String, String> salvaged = MarkdownUtil.salvageFrontmatter(Arrays.asList(
                "name: x",
                "  - Read",               // 缩进列表项
                "  version: \"42\"",      // 缩进嵌套键
                "\tindented: y",          // 制表符缩进
                "# comment",              // 注释
                "- dash",                 // 顶层列表项
                "no-colon line",          // 无冒号
                "url: https://a:8443/v1", // 值含冒号
                "foo.bar: x",             // 非标识符键
                ": orphan",               // 空键
                "ok_key: yes"
        ));

        assertEquals("x", salvaged.get("name"));
        assertEquals("yes", salvaged.get("ok_key"));
        assertEquals("https://a:8443/v1", salvaged.get("url"), "值里的冒号被截断了");

        assertFalse(salvaged.containsKey("version"), "缩进嵌套项被误当顶层键");
        assertFalse(salvaged.containsKey("Read"), "列表项被误当键");
        assertFalse(salvaged.containsKey("indented"), "制表符缩进项被误当顶层键");
        assertFalse(salvaged.containsKey("foo.bar"), "非标识符键被接受");
        assertFalse(salvaged.containsKey("# comment"), "注释被当键");
        assertFalse(salvaged.containsKey(""), "空键被接受");

        assertEquals(3, salvaged.size(), "降级提取的键集不对: " + salvaged.keySet());
    }

    @Test
    @DisplayName("剥掉成对包裹引号，但不做 YAML 转义还原")
    void stripsWrappingQuotesOnly() {
        Map<String, String> m = MarkdownUtil.salvageFrontmatter(Arrays.asList(
                "a: \"double\"",
                "b: 'single'",
                "c: \"内嵌 \\\" 转义\"",   // 不做转义还原，原样保留
                "d: 裸值",
                "e: \"",                   // 只有前引号：不成对，原样保留
                "f: \"\"",                 // 空串
                "g: \"a\"b\""              // 首尾都是引号但中间还有：只剥最外层
        ));

        assertEquals("double", m.get("a"));
        assertEquals("single", m.get("b"));
        assertEquals("内嵌 \\\" 转义", m.get("c"), "降级路径不该做转义还原");
        assertEquals("裸值", m.get("d"));
        assertEquals("\"", m.get("e"), "不成对的引号不该被剥");
        assertEquals("", m.get("f"));
        assertEquals("a\"b", m.get("g"));
    }

    @Test
    @DisplayName("agent-browser 的真实形态：引号串内嵌裸引号也能取出完整描述")
    void salvagesTheRealWorldBrokenDescription() {
        // 这是真实中招样本的简化形态：双引号串里嵌了裸双引号，SnakeYAML 必抛 ParserException
        Map<String, String> m = MarkdownUtil.salvageFrontmatter(Arrays.asList(
                "name: agent-browser",
                "slug: agent-browser",
                "displayName: \"Agent Browser\"",
                "version: 1.0.0",
                "description: \"Browser automation CLI. Triggers include requests to "
                        + "\"open a website\", \"fill out a form\", or any web task.\"",
                "license: MIT"
        ));

        assertEquals("agent-browser", m.get("name"));
        assertEquals("1.0.0", m.get("version"));
        String desc = m.get("description");
        assertNotNull(desc, "description 未取出");
        assertTrue(desc.startsWith("Browser automation CLI"), "描述开头不对: " + desc);
        assertTrue(desc.contains("open a website"), "描述里的触发词丢失: " + desc);
        assertEquals(6, m.size(), "键集不对: " + m.keySet());
    }

    @Test
    @DisplayName("enabled 必须能被取出（否则 UI 禁用开关失效）")
    void salvagesEnabledFlag() {
        Map<String, String> off = MarkdownUtil.salvageFrontmatter(Arrays.asList(
                "name: s",
                "description: \"d \"nested\" d\"",
                "enabled: false"
        ));
        assertEquals("false", off.get("enabled"), "enabled 丢失会让禁用开关失效");

        Map<String, String> on = MarkdownUtil.salvageFrontmatter(Arrays.asList(
                "name: s", "enabled: true"));
        assertEquals("true", on.get("enabled"));
    }

    @Test
    @DisplayName("空输入与全无效行返回空 map（不抛异常）")
    void emptyAndAllInvalidYieldEmptyMap() {
        assertTrue(MarkdownUtil.salvageFrontmatter(Collections.emptyList()).isEmpty());
        assertTrue(MarkdownUtil.salvageFrontmatter(Arrays.asList("# c", "- x", "no colon", "  indented: y"))
                .isEmpty(), "全无效行应返回空 map");
    }

    @Test
    @DisplayName("null 行被跳过而不是抛 NPE")
    void nullLinesAreSkipped() {
        Map<String, String> m = MarkdownUtil.salvageFrontmatter(Arrays.asList("name: x", null, "version: 1"));
        assertEquals(2, m.size());
        assertEquals("x", m.get("name"));
    }

    @Test
    @DisplayName("端到端：非法 YAML 经 resolve 后元数据不再全丢")
    void resolveFallsBackToSalvage() {
        String md = "---\n"
                + "name: broken\n"
                + "description: \"Triggers include \"open a website\", \"click\".\"\n"
                + "version: 3.0\n"
                + "enabled: false\n"
                + "---\n\n# Body\n";

        Markdown m = MarkdownUtil.resolve(Arrays.asList(md.split("\n")), true);

        assertEquals("broken", m.getName(), "name 丢失");
        assertEquals("3.0", m.getVersion(), "version 丢失");
        assertNotNull(m.getDescription(), "description 仍为 null");
        assertTrue(m.getDescription().contains("open a website"), "描述内容未恢复: " + m.getDescription());
        assertFalse(m.isEnabled(), "enabled: false 未生效 —— 这正是禁用开关失效的根因");
    }
}
