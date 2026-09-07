package com.gourdai.harness.talents.cli;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 任务清单入参归一化（sanitizeTodoMarkdown）单元测试。
 *
 * <p>背景：模型偶发把工具调用的 JSON 外壳当作 todos 参数值输出，且换行退化为字面
 * {@code \n} 两字符，导致 TODO.md 塌缩成单行。所有按行锚定解析的下游（进度页脚、
 * {@code /web/chat/todos} 接口、前端任务面板）全部解析为 0 条，用户侧表现为
 * 「对话框上的任务按钮点击后闪消」，模型侧收到误导性的 {@code [进度] total: 0}。</p>
 *
 * <p>归一化采取「候选择优 + 平手保留原文」策略，因此除了验证脏入参被修好，
 * 必须同时验证正常清单（含任务描述里正当出现字面 {@code \n} 的情形）不被改写。</p>
 *
 * @author oisin
 */
public class TodoTalentSanitizeTest {

    /** 线上真实形态：JSON 数组壳 + 字面 \n（两个字符） */
    private static final String DIRTY_ENVELOPE_LITERAL =
            "[{\"todos\": \"- [x] 现场取证\\n- [ ] 代码取证\"}]";

    private static final String CLEAN_TWO_ITEMS = "- [x] 现场取证\n- [ ] 代码取证";

    // ==================== 脏入参修复 ====================

    @Test
    @DisplayName("JSON 数组壳 + 字面换行：解包并还原为多行清单")
    void repairsEnvelopeWithLiteralNewlines() {
        assertEquals(0, TodoTalent.countCheckboxLines(DIRTY_ENVELOPE_LITERAL), "脏入参本身应解析不出任务");
        assertEquals(CLEAN_TWO_ITEMS, TodoTalent.sanitizeTodoMarkdown(DIRTY_ENVELOPE_LITERAL));
    }

    @Test
    @DisplayName("JSON 壳 + 真换行：仍解包（塌行文本末尾也能命中一条，不能因『已解析出任务』就短路）")
    void repairsEnvelopeWithRealNewlines() {
        String dirty = "[{\"todos\": \"- [x] A\n- [ ] B\"}]";
        assertEquals(1, TodoTalent.countCheckboxLines(dirty), "未解包时只能命中尾行一条");
        assertEquals("- [x] A\n- [ ] B", TodoTalent.sanitizeTodoMarkdown(dirty));
    }

    @Test
    @DisplayName("JSON 对象壳（非数组）：同样解包")
    void repairsObjectEnvelope() {
        String dirty = "{\"todos\": \"## 分组\\n- [/] 进行中\\n- [x] 已完成\"}";
        String result = TodoTalent.sanitizeTodoMarkdown(dirty);
        assertEquals(2, TodoTalent.countCheckboxLines(result));
        assertTrue(result.startsWith("## 分组"), result);
        assertFalse(result.contains("todos"), "不应残留 JSON 外壳: " + result);
    }

    @Test
    @DisplayName("无 JSON 壳但整份清单塌在一行：还原字面换行")
    void repairsBareCollapsedList() {
        String dirty = "- [x] A\\n- [ ] B";
        assertEquals(1, TodoTalent.countCheckboxLines(dirty), "塌行时只命中首行");
        assertEquals("- [x] A\n- [ ] B", TodoTalent.sanitizeTodoMarkdown(dirty));
    }

    @Test
    @DisplayName("JSON 壳内的 \\uXXXX 转义：还原为真实字符")
    void repairsUnicodeEscapes() {
        String dirty = "[{\"todos\": \"- [x] \\u4e2d\\u6587\\n- [ ] \\u4f60\\u597d\"}]";
        assertEquals("- [x] 中文\n- [ ] 你好", TodoTalent.sanitizeTodoMarkdown(dirty));
    }

    @Test
    @DisplayName("修复后进度页脚不再误报 total: 0（模型侧闭环校验恢复）")
    void footerSeesRepairedItems() throws IOException {
        String repaired = TodoTalent.sanitizeTodoMarkdown(DIRTY_ENVELOPE_LITERAL);
        assertTrue(TodoTalent.hasUnfinishedItems(repaired), "修复后应能识别出未完成项");
    }

    // ==================== 保守性：不得改坏正常清单 ====================

    @Test
    @DisplayName("正常清单原样保留（仅 trim）")
    void keepsNormalListUntouched() {
        String ok = "## 方案C 修复\n- [x] 已完成\n- [/] 进行中\n- [ ] 待办\n";
        assertEquals(ok.trim(), TodoTalent.sanitizeTodoMarkdown(ok));
    }

    @Test
    @DisplayName("任务描述里正当出现字面 \\n：不得被反转义破坏")
    void keepsLiteralNewlineInsideTaskText() {
        String ok = "## 组\n- [ ] 说明字面 \\n 的用法\n- [x] 完成";
        assertEquals(ok, TodoTalent.sanitizeTodoMarkdown(ok));
    }

    @Test
    @DisplayName("无法修复的垃圾文本：原样返回，不做破坏性猜测")
    void keepsUnrepairableTextAsIs() {
        String junk = "这完全不是一份任务清单";
        assertEquals(junk, TodoTalent.sanitizeTodoMarkdown(junk));
    }

    @Test
    @DisplayName("null 与空白入参：返回空串")
    void handlesNullAndBlank() {
        assertEquals("", TodoTalent.sanitizeTodoMarkdown(null));
        assertEquals("", TodoTalent.sanitizeTodoMarkdown("   \n  "));
    }

    @Test
    @DisplayName("checkbox 行识别口径：状态符非法或缺少方括号均不计入")
    void checkboxRecognitionIsStrict() {
        assertEquals(0, TodoTalent.countCheckboxLines("- [z] 非法状态符"));
        assertEquals(0, TodoTalent.countCheckboxLines("-[] 缺少空格"));
        assertEquals(0, TodoTalent.countCheckboxLines("普通列表项 - [x] 不在行首"));
        // 四种状态标记（x / X / / / 空格）均计入
        assertEquals(4, TodoTalent.countCheckboxLines("- [x] a\n- [X] b\n- [/] c\n- [ ] d"));
    }

    /**
     * 前后端口径一致性护栏：{@code /web/chat/todos} 接口（WebController#todos）是独立实现的
     * 一套按行锚定正则，与本类的统计逻辑并不共用代码。此处把接口侧的正则原样引入并断言
     * 「归一化前解析 0 条、归一化后解析 2 条」，既钉住闪消 Bug 的直接成因，也防止两侧口径日后漂移。
     */
    @Test
    @DisplayName("归一化结果能被 /web/chat/todos 的解析正则识别（钉住前后端口径一致）")
    void repairedListIsParseableByWebEndpoint() {
        // 与 WebController#todos 中匹配 checkbox 行的正则保持一致
        Pattern webPattern = Pattern.compile("^\\s*-\\s*\\[( |x|X|/)\\]\\s+.+$");

        assertEquals(0, countMatches(webPattern, DIRTY_ENVELOPE_LITERAL),
                "脏入参在接口侧应解析为 0 条——这正是面板被异步回包清空的直接成因");
        assertEquals(2, countMatches(webPattern, TodoTalent.sanitizeTodoMarkdown(DIRTY_ENVELOPE_LITERAL)),
                "归一化后接口侧应解析出完整任务");
    }

    private static int countMatches(Pattern pattern, String content) {
        int matched = 0;
        for (String line : content.split("\n")) {
            if (pattern.matcher(line).matches()) {
                matched++;
            }
        }
        return matched;
    }

    // ==================== 落盘端到端 ====================

    @Test
    @DisplayName("todoWrite 落盘：脏入参写出的是多行清单，进度页脚统计正确")
    void todoWritePersistsRepairedList(@TempDir Path work) throws IOException {
        String result = new TodoTalent().todoWrite(DIRTY_ENVELOPE_LITERAL, work.toString(), "s1");

        String saved = new String(
                Files.readAllBytes(work.resolve("s1").resolve(TodoTalent.TODO_FILE_NAME)),
                StandardCharsets.UTF_8);

        assertEquals(2, TodoTalent.countCheckboxLines(saved), "落盘内容应可被按行解析: " + saved);
        assertTrue(saved.contains("\n"), "落盘内容不应只有一行: " + saved);
        assertFalse(saved.contains("\"todos\""), "落盘内容不应残留 JSON 外壳: " + saved);
        assertTrue(result.contains("total: 2"), result);
        assertFalse(result.contains("[格式警告]"), result);
    }

    @Test
    @DisplayName("todoWrite 落盘：确实无法识别任务时返回格式警告，提示模型修正入参")
    void todoWriteWarnsOnUnrecognizableInput(@TempDir Path work) throws IOException {
        String result = new TodoTalent().todoWrite("随便一句话，没有任务行", work.toString(), "s2");

        assertTrue(result.contains("[格式警告]"), result);
        assertTrue(result.contains("total: 0"), result);
        assertFalse(result.contains("[继续]"), result);
    }

    /**
     * 回归护栏：格式警告文案本身不得含「短横线 + 方括号状态符」形态，
     * 否则前端兜底统计正则会把它误计为任务行，反而制造新的统计偏差。
     */
    @Test
    @DisplayName("格式警告文案不会被前端兜底正则误判为任务行")
    void formatWarningIsNotMistakenForTaskLine(@TempDir Path work) throws IOException {
        String result = new TodoTalent().todoWrite("随便一句话", work.toString(), "s3");

        for (String line : result.split("\n")) {
            if (line.contains("[格式警告]")) {
                assertEquals(0, TodoTalent.countCheckboxLines(line), "警告行被误判为任务行: " + line);
            }
        }
    }
}
