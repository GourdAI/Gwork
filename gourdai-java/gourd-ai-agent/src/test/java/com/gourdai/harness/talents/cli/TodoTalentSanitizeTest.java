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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
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

    // ==================== JSON 数组主契约 ====================

    @Test
    @DisplayName("JSON 数组入参（主契约）：状态映射、分组提升为标题")
    void jsonArrayIsThePrimaryContract() {
        String dirty = "[{\"content\": \"现场取证\", \"status\": \"done\"},"
                + "{\"content\": \"代码取证\", \"status\": \"in_progress\", \"header\": \"取证\"},"
                + "{\"content\": \"补测试\", \"status\": \"pending\"}]";
        String out = TodoTalent.sanitizeTodoMarkdown(dirty);
        assertEquals(3, TodoTalent.countCheckboxLines(out), out);
        assertTrue(out.contains("## 取证"), out);
        assertTrue(out.contains("- [x] 现场取证"), out);
        assertTrue(out.contains("- [/] 代码取证"), out);
    }

    @Test
    @DisplayName("截图同款退化外壳：占位项丢弃、todos_note 保留为散文")
    void placeholderItemsAreDroppedAndTheNoteIsKept() {
        String dirty = "[{\"todos_note\": \"承接自审：已完成 6 项，继续剩余 5 项\","
                + " \"content\": \"placeholder\", \"id\": \"x\"}]";
        String out = TodoTalent.sanitizeTodoMarkdown(dirty);
        assertTrue(out.contains("承接自审"), out);
        assertFalse(out.toLowerCase().contains("placeholder"), out);
        assertEquals(0, TodoTalent.countCheckboxLines(out), "进度说明是散文不是任务: " + out);
    }

    @Test
    @DisplayName("嵌套 todos 数组：比字符串解包深一层的外壳也能 salvage")
    void nestedTodosArrayIsSalvaged() {
        String dirty = "[{\"todos\": [{\"content\": \"A\", \"status\": \"done\"},"
                + "{\"content\": \"B\", \"status\": \"pending\"}]}]";
        assertEquals("- [x] A\n- [ ] B", TodoTalent.sanitizeTodoMarkdown(dirty));
    }

    @Test
    @DisplayName("垃圾数组不得被升格成凭空任务")
    void jsonConversionRefusesToInventTasks() {
        assertEquals(null, TodoTalent.convertJsonItems("not json"));
        assertEquals(null, TodoTalent.convertJsonItems("[1,2,3]"));
        assertEquals(null, TodoTalent.convertJsonItems("[{\"id\":\"1\"}]"));
        assertEquals(null, TodoTalent.convertJsonItems("[\"junk\"]"));
        assertEquals(null, TodoTalent.convertJsonItems("[]"));
    }

    // ==================== 读侧自愈 ====================

    @Test
    @DisplayName("healContent：存量 JSON 外壳修复为可解析清单")
    void healRepairsStoredEnvelope() {
        String dirty = "[{\"content\": \"读取源码\", \"status\": \"done\"},"
                + "{\"content\": \"补测试\", \"status\": \"pending\"}]";
        String healed = TodoTalent.healContent(dirty);
        assertNotNull(healed);
        assertEquals(2, TodoTalent.countCheckboxLines(healed), healed);
    }

    @Test
    @DisplayName("healContent：已可解析的清单与纯散文均不动")
    void healLeavesParseableAndProseUntouched() {
        assertNull(TodoTalent.healContent("- [x] A\n- [ ] B"));
        assertNull(TodoTalent.healContent(""));
        assertNull(TodoTalent.healContent("纯散文，不是清单也不是 JSON"));
        // 单任务行边界：守卫是 >0 而非 >1。若读者改写单行清单，会与写路径
        // 在每次轮询上争抢一份本就合法的文件。
        assertNull(TodoTalent.healContent("- [ ] 唯一一项"));
        assertNull(TodoTalent.healContent("- [x] 唯一一项"));
    }

    @Test
    @DisplayName("todoRead 读侧自愈：存量外壳就地回写，模型读到真清单")
    void todoReadHealsStoredEnvelopeInPlace(@TempDir Path work) throws IOException {
        Path dir = work.resolve("s9");
        Files.createDirectories(dir);
        Files.write(dir.resolve(TodoTalent.TODO_FILE_NAME),
                ("[{\"content\": \"读取源码\", \"status\": \"done\"},"
                        + "{\"content\": \"补测试\", \"status\": \"pending\"}]")
                        .getBytes(StandardCharsets.UTF_8));

        String out = new TodoTalent().todoRead(work.toString(), "s9");
        assertTrue(out.contains("[进度] total: 2"), out);
        assertTrue(out.contains("- [x] 读取源码"), out);

        String saved = new String(Files.readAllBytes(dir.resolve(TodoTalent.TODO_FILE_NAME)),
                StandardCharsets.UTF_8);
        assertEquals(2, TodoTalent.countCheckboxLines(saved), saved);
    }

    @Test
    @DisplayName("displayText：数组入参字符串化后仍归一成可解析清单")
    void displayTextNormalizesStringifiedArray() {
        String raw = "[{\"content\": \"A\", \"status\": \"done\"}, {\"content\": \"B\", \"status\": \"pending\"}]";
        String out = TodoTalent.displayText(raw);
        assertEquals(2, TodoTalent.countCheckboxLines(out), out);
        // 正常 markdown 原样透传
        assertEquals("- [ ] A", TodoTalent.displayText("- [ ] A"));
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

    // ==================== 死循环对抗语料（收敛性护栏） ====================
    //
    // todo 链路坐在代理循环的脊柱上：面板每轮轮询会 heal+回写，模型每次重写会
    // sanitize，恢复校准会把快照喂回模型。任何一环不是「收缩映射」（应用第二次
    // 等于没应用），会话就会在两种表示之间永远振荡。以下用例钉住收缩性。

    /** 真实会话可能落盘 / 可能作为入参收到的全部形态。 */
    private static String[] adversarialCorpus() {
        return new String[]{
                // 截图同款：note + 占位项
                "[{\"todos_note\": \"承接自审：已完成 6 项，继续剩余 5 项\", \"content\": \"placeholder\", \"id\": \"x\"}]",
                // 数组壳真任务
                "[{\"content\": \"读取源码\", \"status\": \"done\"}, {\"content\": \"补测试\", \"status\": \"pending\"}]",
                // 字符串壳 + 字面换行
                "[{\"todos\": \"- [x] 现场取证\\n- [ ] 代码取证\"}]",
                // 字符串壳 + 真换行
                "[{\"todos\": \"- [x] A\n- [ ] B\"}]",
                // 无壳塌行
                "- [x] A\\n- [ ] B",
                // 人类散文（绝不得被改写）
                "纯散文，不是清单也不是 JSON",
                "",
                "   \n  ",
                // CRLF 清单
                "- [x] A\r\n- [ ] B\r\n",
                // 任务藏在 note 里且带字面换行
                "[{\"todos_note\": \"- [ ] 真任务一\\n- [ ] 真任务二\", \"content\": \"placeholder\"}]",
                // 嵌套数组壳
                "[{\"todos\": [{\"content\": \"A\", \"status\": \"done\"}]}]",
                // 不得升格的垃圾
                "[\"junk\", \"more junk\"]",
                "[1,2,3]",
        };
    }

    /**
     * 面板每轮轮询都会 heal+回写（回写体 = healed + "\n"）：healed 必须是
     * healContent 的不动点，否则每次轮询都重写一次文件，面板/模型/磁盘永远不一致。
     */
    @Test
    @DisplayName("heal 是收缩映射：heal(heal(x)+换行) 恒为 null（面板轮询不会反复回写）")
    void healIsAContractionOnAdversarialCorpus() {
        for (String raw : adversarialCorpus()) {
            String healed = TodoTalent.healContent(raw);
            if (healed == null) {
                continue;
            }
            assertNull(TodoTalent.healContent(healed + "\n"),
                    "heal 不幂等（轮询会永远重写）: " + raw);
            assertNull(TodoTalent.healContent(healed),
                    "heal 不幂等（无尾换行）: " + raw);
        }
    }

    /**
     * 跨写者振荡护栏：恢复校准会把快照喂回模型，模型常原样 todowrite 回写。
     * sanitize 对 healed 输出必须是恒等映射，否则文件在每次写/读周期翻转。
     */
    @Test
    @DisplayName("sanitize 对 healed 输出恒等（写/读周期不振荡）")
    void sanitizeIsIdentityOnHealedOutputs() {
        for (String raw : adversarialCorpus()) {
            String healed = TodoTalent.healContent(raw);
            if (healed == null) {
                continue;
            }
            assertEquals(healed, TodoTalent.sanitizeTodoMarkdown(healed),
                    "sanitize 移动了 healed 清单（写/读振荡）: " + raw);
        }
    }

    /** sanitize 自身必须是不动点：模型重试时回显上一次入参不得得到不同结果。 */
    @Test
    @DisplayName("sanitize 幂等：sanitize(sanitize(x)) == sanitize(x)")
    void sanitizeIsIdempotentOnAdversarialCorpus() {
        for (String raw : adversarialCorpus()) {
            String once = TodoTalent.sanitizeTodoMarkdown(raw);
            assertEquals(once, TodoTalent.sanitizeTodoMarkdown(once), "sanitize 不幂等: " + raw);
        }
    }

    /**
     * 深嵌套 DoS 探针：ONode.ofJson 若对深嵌套抛 StackOverflowError（Error，
     * catch(Exception) 接不住），会穿透到 ToolRetryInterceptor 被放大成 3 次重试。
     * 本用例只要求「必须返回」——任何结论（salvage 或保留原文）都可接受，
     * 挂死或 SOE 才是缺陷。
     */
    @Test
    @DisplayName("深嵌套入参必须终止：不得抛 StackOverflowError（catch(Exception) 接不住）")
    void deepNestingMustTerminateWithoutStackOverflow() {
        String deep = "[{\"content\": \"A\", \"status\": \"done\"}]";
        for (int i = 0; i < 300; i++) {
            deep = "[{\"todos\": " + deep + "}]";
        }
        try {
            assertNotNull(TodoTalent.sanitizeTodoMarkdown(deep));
            String healed = TodoTalent.healContent(deep);
            if (healed != null) {
                assertNull(TodoTalent.healContent(healed + "\n"), "heal 不幂等");
            }
        } catch (StackOverflowError e) {
            throw new AssertionError("深嵌套导致 StackOverflowError（DoS 向量）", e);
        }
    }

    /**
     * 病态引号串：「"todos": 后引号永不闭合」不得让字节扫描空转或越界。
     */
    @Test
    @DisplayName("未闭合引号的病态入参必须终止且原样保留")
    void unclosedQuoteTerminates() {
        StringBuilder sb = new StringBuilder("{\"todos\": \"");
        for (int i = 0; i < 200_000; i++) {
            sb.append('x');
        }
        String pathological = sb.toString();
        assertEquals(pathological, TodoTalent.sanitizeTodoMarkdown(pathological));
    }

    /**
     * 双重外壳（模型 stringify 两次）：解包一层后值本身仍是外壳。
     * 探针断言：最终输出不得残留任何 JSON 外壳字符，任务必须完整解出。
     */
    @Test
    @DisplayName("双重外壳：逐层解包直到任务解出，不得残留外壳")
    void doubleEnvelopeIsFullyUnwrapped() {
        String dirty = "[{\"todos\": \"[{\\\"todos\\\": \\\"- [x] A\\\\n- [ ] B\\\"}]\"}]";
        String out = TodoTalent.sanitizeTodoMarkdown(dirty);
        assertEquals("- [x] A\n- [ ] B", out, "双重外壳未解净: " + out);
        assertEquals(2, TodoTalent.countCheckboxLines(out), out);
    }

    // ==================== 指南完整性护栏（死循环的行为出口） ====================

    /**
     * 规划指南必须给 [格式警告] 一个行为出口：模型收到警告后若指南不说
     * 「修正后重写」，它会带着同一份坏入参反复重试——警告本身就成了循环的
     * 一部分。Rust 侧指南有这句而 Java 侧曾丢失（双核口径漂移），故钉住。
     */
    @Test
    @DisplayName("规划指南必须解释 [格式警告] 的逃生口（否则警告成为循环的一部分）")
    void guideExplainsTheFormatWarningEscapeHatch() {
        String guide = new TodoTalent().getInstruction(
                com.gourdai.ai.chat.prompt.Prompt.of("帮我重构这个模块并补测试"));
        assertNotNull(guide, "多步任务不得跳过指南");
        assertTrue(guide.contains("[格式警告]"), "指南丢失格式警告说明: " + guide);
        assertTrue(guide.contains("修正后重写") || guide.contains("修正入参"),
                "指南未给警告后的行为出口: " + guide);
    }

    /**
     * 指南编号必须连续：跳号/重号会被模型读成「规则可取舍」，而第 4 条
     * （闭环校验）与第 6 条（以返回为准）正是死循环的行为开关。
     */
    @Test
    @DisplayName("规划指南编号连续（0-7），不得跳号重号")
    void guideNumberingIsConsecutive() {
        String guide = new TodoTalent().getInstruction(
                com.gourdai.ai.chat.prompt.Prompt.of("帮我重构这个模块并补测试"));
        int expected = 0;
        for (String line : guide.split("\n")) {
            String t = line.trim();
            int dot = t.indexOf(". ");
            if (dot <= 0) {
                continue;
            }
            String digits = t.substring(0, dot);
            if (!digits.chars().allMatch(Character::isDigit)) {
                continue;
            }
            assertEquals(expected, Integer.parseInt(digits), "指南编号不连续: " + t);
            expected++;
        }
        assertTrue(expected >= 7, "指南条目丢失: 仅 " + expected + " 条");
    }
}
