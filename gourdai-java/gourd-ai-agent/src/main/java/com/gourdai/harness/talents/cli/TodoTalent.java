/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.talents.cli;

import com.gourdai.ai.annotation.ToolMapping;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.talent.AbsTalent;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Param;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.List;

/**
 * 任务进度追踪才能
 *
 * @author oisin
 * @since 3.9.5
 */
public class TodoTalent extends AbsTalent {
    public static final String TOOL_TODOREAD = "todoread";
    public static final String TOOL_TODOWRITE = "todowrite";

    public static final String TODO_FILE_NAME = "TODO.md";

    public static final String PARAM_TODOS = "todos";

    /**
     * 入参经归一化后仍识别不出任务行时追加的提示（不改变落盘行为，仅告知模型修正入参）。
     * 文案刻意不出现「短横线 + 方括号状态符」的完整形态，避免被前端兜底统计正则误判为任务行。
     */
    private static final String FORMAT_WARN =
            "\n[格式警告] 未能从入参中识别出任何任务行，进度统计为 0、任务面板无法展示。"
                    + "请传入 JSON 数组（元素为含 content 与 status 的对象），或 Markdown 原文：每条任务独占一行、以短横线开头并带方括号状态标记；"
                    + "使用真实换行分隔，不要把换行写成字面反斜杠 n，也不要传 placeholder 之类的占位符。";

    /** 任务文本字段名（跨模型实测命名）。 */
    private static final String[] TEXT_KEYS = {"content", "task", "title", "description", "detail", "text"};
    /** 分组字段名。 */
    private static final String[] GROUP_KEYS = {"header", "group", "section"};
    /** 进度说明字段名：实战中退化外壳里唯一真实信息所在。 */
    private static final String[] NOTE_KEYS = {"todos_note", "note", "notes", "summary"};
    /** 状态字段名。 */
    private static final String[] STATUS_KEYS = {"status", "state"};
    /** 不携带任何工作的占位文本：salvage 不得把它们升格成任务行。 */
    private static final String[] PLACEHOLDER_TEXTS = {
            "placeholder", "place holder", "todo", "todos", "task", "tasks", "item", "items",
            "x", "xx", "xxx", "-", "--", ".", "..", "...", "n/a", "na", "null", "none", "tbd"};

    private final String relativeDir;

    public TodoTalent() {
       this(null);
    }

    public TodoTalent(String relativeDir) {
        this.relativeDir = relativeDir;
    }


    @Override
    public String description() {
        return "提供复杂任务的拆解、进度跟踪及计划修订能力。适用于需要多步协作的长链路任务。";
    }

    @Override
    public String getInstruction(Prompt prompt) {
        // 短寒暄且无任务延续语义时不注入规划指南（约 500 字），省常驻 token。
        // 阈值必须极小，理由见 SHORT_INPUT_MAX 的 javadoc：中文密度高，长度不等于复杂度。
        //
        // 【为何不能用 isSupported 实现这个开关】TalentUtil.activeTalents 对 isSupported()==false
        // 的才能是整体 continue（L46-54），连后面的 onAttach / injectTalentInstruction / toolAdd
        // 一并跳过——工具会直接从本轮可用集中消失。后果比省下的几百字严重得多：模型想更新
        // 清单时发现 todowrite 不存在，要么卡住要么改用其他方式表达进度。
        // 而 getInstruction 返回 null 只走 injectTalentInstruction 的空指令分支（TalentUtil L81），
        // 工具仍然挂载，Talent 标题块也会保留（L97 的 tools 非空分支），仅省掉指南正文。
        if (shouldSkipInstruction(prompt)) {
            return null;
        }

        return "## 任务规划指南 (Task Planning Guide)\n" +
                "0. **格式契约**: `todowrite` 的 todos 参数优先传 JSON 数组：每个元素为对象，含 `content`（任务文本，必填）与 `status`（`pending` / `in_progress` / `done`），可选 `header`/`group` 作为分组；也兼容 Markdown 字符串：每条任务独占一行、以 `- ` 开头并带 `[ ]` / `[/]` / `[x]` 状态标记，使用真实换行分隔。不要把换行写成字面反斜杠 n，不要传 `placeholder` 之类占位符，不要用无状态的普通列表项。\n" +
                "1. **启动机制**: 超过3步以上的复杂任务，要通过 `todowrite` 创建计划；任务边界或目标发生重大变化时，用 `todowrite` 重构完整计划。\n" +
                "2. **状态感知（恢复优先）**: 凡是你对当前进度没有十足把握时，必须 **先** `todoread` 再行动，禁止凭记忆推断。以下场景一律强制先读：上下文被压缩/截断后、用户说“继续/接着做/还有吗”、开启新一轮对话、或任务中途被打断后恢复。**注意：中断恢复后清单状态可能滞后于实际进度（中断时刻可能未及时 todowrite）**，对未完成项要先核对历史 Observation 中是否已有对应执行证据，确已完成的直接用 `todowrite` 确认状态即可，禁止盲目重做。\n" +
                "3. **实时推进（状态变化即更新）**: 状态变更要随做随记，禁止跨回合攒着批量补记。**任何工具结果使某项状态发生变化的那一刻，下一轮的首个动作必须是 `todowrite` 落盘状态，然后才能继续后续动作**：开始做某项前先置 `[/]`；某项拿到执行结果后立即置 `[x]`；尤其收到 `task`/`multitask` 委派结果后，必须马上更新对应项。串行任务通常同一时刻只有一项 `[/]`；并行场景允许多项同时 `[/]`，但每项一旦完成都要第一时间单独更新，避免进度失真。**状态标记**: `[ ]` 待办；`[/]` 进行中；`[x]` 已完成。\n" +
                "4. **闭环校验（禁止半途收尾）**: 只要清单中还存在 `[ ]` 或 `[/]`，即视为任务未完成。默认行为是 **继续把它做完**，不得停下、不得输出总结。仅当遇到真正的停止条件——外部阻塞（缺少权限、缺少必要信息）或**等待用户拍板方案/决策**（见“改造门禁”）——时，才允许停下并明确说明；不得把“可自行完成的剩余工作”当作追问理由，但**已提交方案、正在等待用户选择时停下是合规行为，不是半途收尾**。\n" +
                "5. **改造门禁（先方案后动手）**: 对现有代码、配置或架构做复杂改造（如多文件修改、跨模块重构、破坏性/不可逆变更、涉及多种可行实现路径）时，**禁止未经用户确认直接动手**。必须先完成调研，产出 ≥2 个可行实施方案（含实现思路、改动范围、优缺点对比）及推荐项，停下等待用户选择；用户拍板后，再据此创建或更新清单并执行。用户已明确指定实现方式、或仅为单点小修（如改文案、修明显 Bug）时可豁免。\n" +
                "6. **以返回为准**: `todoread`/`todowrite` 的返回值会附带 [进度] 与 [继续]/[完成] 提示，请以该提示作为“是否可以收尾”的判定依据；返回值出现 [格式警告] 时说明入参格式有误，须按第 0 条修正后重写。\n" +
                "7. **适用边界**: 不要为常识性提问、简单计算或单次工具创建计划。";
    }

    /**
     * 短寒暄的最大字符阈值（超过则一律注入指南）。
     *
     * <p><b>为何必须这么小：</b>首版取 20，实测误伤严重——
     * 「帮我把这个类的注释补齐并跑一遍测试」只有 <b>17 个字符</b>，却是一个明确的
     * 「改代码 + 跑验证」多步任务，恰恰是指南第 1 条要求建计划的场景。中文信息密度高，
     * 20 字 ≈ 英文 40-60 token 的语义量，足以描述完整任务。而「是否需要计划」的真实依据是
     * <b>任务复杂度</b>，不是输入长度，用长度做启发式判据本身就不可靠。</p>
     *
     * <p>降到 6 后，只有「你好 / hi / 谢谢 / 好的 / 1+1」这类纯寒暄与单行确认会跳过；
     * 6 字中文不可能表达一个需要建计划的多步任务，误伤风险接近于零。收益也随之变小
     * （只在寒暄轮省 ~350 token），但这正是可接受的取舍：本优化的目标是省上下文，
     * 而不是用行为不确定性去换那几百 token。</p>
     */
    private static final int SHORT_INPUT_MAX = 6;

    /**
     * 判定本轮能否略过规划指南。
     *
     * <p>只看用户输入的启发式，不查 TODO.md 落盘状态：指南的价值在于「何时该建计划」，
     * 而纯寒暄（如「你好」「谢谢」「1+1」）本就属于指南第 7 条自己划出的适用边界之外。
     * 但必须把恢复语义的短输入排除在外：「继续」「接着做」「还有吗」这类话短却是
     * 指南第 2 条（状态感知）的触发条件，跳过后模型会在有未完成清单时直接凭记忆行动。</p>
     */
    private static boolean shouldSkipInstruction(Prompt prompt) {
        if (prompt == null) {
            return false;
        }
        String userContent = prompt.getUserContent();
        if (userContent == null || userContent.length() > SHORT_INPUT_MAX) {
            return false;
        }
        String lc = userContent.toLowerCase();
        return !(lc.contains("继续") || lc.contains("接着") || lc.contains("还有")
                || lc.contains("continue") || lc.contains("todo")
                || lc.contains("任务") || lc.contains("计划"));
    }

    /**
     * 暴露跳过判定供契约测试直接验证（避免测试反向依赖 getInstruction 的全文内容）。
     */
    static boolean shouldSkipInstructionForTest(Prompt prompt) {
        return shouldSkipInstruction(prompt);
    }

    protected Path getWorkPath(String __cwd, String __sessionId) {
        if (relativeDir == null) {
            return Paths.get(__cwd).toAbsolutePath().normalize()
                    .resolve(__sessionId);
        } else {
            return Paths.get(__cwd, relativeDir).toAbsolutePath().normalize()
                    .resolve(__sessionId);
        }
    }

    /**
     * 获取 TODO.md 文件路径（供外部读取，如 Web 接口）
     */
    public Path getTodoPath(String cwd, String sessionId) {
        return getWorkPath(cwd, sessionId).resolve(TODO_FILE_NAME);
    }

    /**
     * 读取落盘清单内容；文件不存在或读取失败时返回 null（供恢复校准等场景使用）
     */
    public String readTodoContentOrNil(String cwd, String sessionId) {
        try {
            Path todoFile = getTodoPath(cwd, sessionId);
            if (Files.notExists(todoFile)) {
                return null;
            }
            byte[] encoded = Files.readAllBytes(todoFile);
            String content = new String(encoded, StandardCharsets.UTF_8);
            if (content.trim().isEmpty()) {
                return null;
            }
            // 读侧自愈（内存态）：旧内核落盘的 JSON 外壳解析不出任务行，
            // 恢复校准会因此对真实存量状态视而不见。此处不写盘，
            // 写盘由 todoRead 与 /web/chat/todos 负责。
            String healed = healContent(content);
            return healed != null ? healed : content;
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * checkbox 任务行的统一识别规则：形如 {@code - [x]} / {@code - [ ]} / {@code - [/]}，
     * 状态字符大小写均兼容。行首锚定——本方法的所有调用方（进度页脚、未完成项判定、
     * 入参归一化）必须共用此口径，否则会出现「前端统计到 N 条但后端解析到 0 条」的分歧。
     */
    private static boolean isCheckboxLine(String trimmed) {
        if (trimmed.length() < 5 || !trimmed.startsWith("- [") || trimmed.charAt(4) != ']') {
            return false;
        }
        char mark = Character.toLowerCase(trimmed.charAt(3));
        return mark == 'x' || mark == '/' || mark == ' ';
    }

    /**
     * 统计内容中可识别的 checkbox 任务行数（按行锚定，与 {@link #isCheckboxLine} 同口径）
     */
    static int countCheckboxLines(String content) {
        if (content == null || content.isEmpty()) {
            return 0;
        }
        int count = 0;
        for (String line : content.split("\n")) {
            if (isCheckboxLine(line.trim())) {
                count++;
            }
        }
        return count;
    }

    /**
     * 归一化模型传入的清单文本，修复「清单塌缩成单行」这一类脏入参。
     *
     * <p>实战中模型偶发把工具调用的 JSON 外壳当作参数值输出（形如
     * {@code [{"todos": "- [x] A\n- [ ] B"}]}），且其中的换行常退化为字面两字符而非真换行。
     * 原样落盘会让 TODO.md 只剩一行，于是所有按行锚定解析的下游——进度页脚、
     * {@code /web/chat/todos} 接口、前端任务面板、中断恢复校准——全部解析为 0 条，
     * 表现为「任务按钮点击后闪消」以及模型收到 {@code [进度] total: 0}。</p>
     *
     * <p>修复采取「候选择优」：对 原文 / 解包 JSON 壳 / 还原字面换行 几种形态各统计一次
     * 可识别任务数，取最多者；**平手时保留原文**，因此本就正常的清单（包括任务描述里
     * 正当出现字面 {@code \n} 的清单）不会被改写，任何情况下也不会把清单改得更差。</p>
     *
     * <p>为何不能只判「能解析出任务就不动」：塌行文本的首行往往已能命中一条（如
     * {@code - [x] A\n- [ ] B} 整体一行），带真换行的 JSON 壳末尾 {@code - [ ] B"}]}
     * 也能命中一条——这两种情况下都有更优形态存在，需要择优而非短路。</p>
     */
    static String sanitizeTodoMarkdown(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.trim();
        if (text.isEmpty()) {
            return text;
        }
        // 有界不动点迭代。双重外壳（模型把入参 stringify 了两次）需要两次解包，
        // 而第一次解包的收益不是更好的任务数——两层壳的尾行都计 1 条——而是
        // 「暴露内层壳让下一轮够得到任务」。若按「本次解包是否立即提升计数」逐层
        // 判断，会停在一层之差，把清单尾行写花并静默丢掉首条任务。
        // 迭代到不动点同时让 sanitize 天然幂等：模型重试时回显上一次入参，
        // 不会得到不同的落盘结果（跨写者振荡护栏）。
        // 4 轮覆盖三层外壳；更深的输入到此为止，不会空转（上界是常量，不随输入增长）。
        for (int i = 0; i < 4; i++) {
            String next = sanitizeOnce(text);
            if (next.equals(text)) {
                break;
            }
            text = next;
        }
        return text;
    }

    /** 单轮归一：解包外壳、salvage JSON 条目、还原字面换行，候选择优、平手保留输入。 */
    private static String sanitizeOnce(String input) {
        String text = input;
        int best = countCheckboxLines(text);

        // ① 入参带着 JSON 外壳：取出 todos 字段的字符串值（内部转义已一并还原）
        String unwrapped = extractTodosField(text);
        if (unwrapped != null) {
            String value = unwrapped.trim();
            int count = countCheckboxLines(value);
            // trim 后以 [ 或 { 开头的输入整体就是外壳，解码其 todos 字符串不会
            // 丢弃任何非外壳内容：计数平手也采纳。否则双重外壳会在此停住
            // （两层壳都计 0 条），随后 ③ 在仍编码的文本上改写转义序列，
            // 把载荷打碎到后续任何解码都救不回。
            String head = text.trim();
            boolean container = head.startsWith("[") || head.startsWith("{");
            if (count > best || (container && !value.equals(text))) {
                if (count > best) {
                    best = count;
                }
                text = value;
            }
        }

        // ② JSON 任务对象数组：主入参契约，也是磁盘上 26 个脏文件的真实形态。
        //    extractTodosField 够不到它——清单活在数组本身而非某个字符串字段里。
        //    刻意排在换行还原之前：JSON 字符串内的字面 \n 是合法转义，先改裸字节
        //    会把真换行塞进字符串字面量，数组反而永远解析不了。
        String converted = convertJsonItems(text);
        if (converted != null) {
            int count = countCheckboxLines(converted);
            if (count > best) {
                best = count;
                text = converted;
            } else if (best == 0 && !converted.isEmpty() && !converted.equals(text)) {
                // 零任务行的 salvage（进度说明 + 占位项的退化外壳）：原文同样
                // 解析不出任何任务，保留可读的 salvage 不会更差，且是读侧自愈
                // 能把 JSON 外壳换成模型可据以重建的散文的唯一途径。
                text = converted;
            }
        }

        // ③ 字面换行序列还原为真换行（覆盖「有壳且塌行」与「无壳但塌行」两类）。
        // 文本仍是 JSON 容器时不得作用：编码串内的字面 \n 是双重转义，在此改写
        // 会把载荷打碎到后续解码救不回（双重外壳写花的直接成因）。
        // 解码路径 ①/② 已正确还原转义；③ 只是「非 JSON 塌行文本」的兕底。
        String head3 = text.trim();
        boolean stillContainer = head3.startsWith("[") || head3.startsWith("{");
        if (!stillContainer) {
            String unescaped = unescapeLiteralNewlines(text);
            if (countCheckboxLines(unescaped) > best) {
                text = unescaped;
            }
        }

        return text;
    }

    /**
     * 展示通道归一：把 todowrite 的原始入参（JSON 数组 / 字符串化数组 / 塌行 Markdown）
     * 归一成前端任务面板能按行解析的清单文本。
     *
     * <p>action_end 帧的 text 是前端 todowrite 实时渲染与兑底统计的唯一数据源；
     * 传原始入参时，数组形态会被前端解析成 0 条，chip 先被藏起再被 loadTodos
     * 回包恢复——一次可见的闪烁。归一后两端同口径。</p>
     *
     * @param rawArg 模型传入的 todos 原始值（可能已被反射层字符串化）
     * @return 归一后的清单；入参为空或归一不产生变化时返回原值
     */
    public static String displayText(String rawArg) {
        if (rawArg == null || rawArg.trim().isEmpty()) {
            return rawArg;
        }
        String normalized = sanitizeTodoMarkdown(rawArg);
        return normalized.isEmpty() ? rawArg : normalized;
    }

    /**
     * 读侧自愈：修复已经落盘的脏清单。
     *
     * <p>{@link #sanitizeTodoMarkdown} 守的是写路径；在它存在之前（或缺少它的内核上）
     * 写下的 JSON 外壳仍躺在磁盘上，所有按行锚定的读者都只能解析出 0 条任务——
     * 即用户反复撞见的「任务清单格式异常」面板态。</p>
     *
     * <p>仅当落盘内容解析不出任何任务行、且归一化结果与落盘内容不同时返回修复结果：
     * 已有任务行的文件归写路径所有，读者不得改写；归一化后与自身相同的散文也原样保留，
     * 读路径永远不能重写人类的笔记。</p>
     */
    public static String healContent(String raw) {
        if (raw == null) {
            return null;
        }
        if (countCheckboxLines(raw) > 0) {
            return null;
        }
        String healed = sanitizeTodoMarkdown(raw);
        String trimmed = raw.trim();
        if (healed.isEmpty() || healed.equals(trimmed)) {
            return null;
        }
        return healed;
    }

    /**
     * 把模型写成 JSON 任务对象数组的清单 salvage 成 Markdown。
     *
     * <p>字段命名跨模型各异，识别表取自磁盘真实文件：文本 {@code content}/{@code task}/
     * {@code title}/{@code description}/{@code detail}/{@code text}，状态 {@code status}/
     * {@code state}，布尔 {@code checked}/{@code done}，分组 {@code header}/{@code group}/
     * {@code section}，进度说明 {@code todos_note}/{@code note}/{@code notes}/{@code summary}。
     * 未识别状态保守地归为待办——猜「已完成」会让 run 提前收尾。</p>
     *
     * <p>进度说明是散文而非任务，原样保留；占位文本（{@code "content": "placeholder"}）
     * 直接丢弃，绝不升格成凭空的任务行。条目文本逐行输出，已带标记的行原样拷贝。</p>
     *
     * @return salvage 结果；输入不是此类数组或无任何可用文本时返回 null，调用方保留原文
     */
    static String convertJsonItems(String text) {
        ONode root;
        try {
            root = ONode.ofJson(text);
        } catch (Exception e) {
            return null;
        }
        if (root == null) {
            return null;
        }
        List<ONode> items;
        if (root.isArray()) {
            items = root.getArray();
        } else if (root.isObject()) {
            items = Collections.singletonList(root);
        } else {
            return null;
        }

        StringBuilder out = new StringBuilder();
        int converted = 0;
        String lastGroup = "";

        for (ONode item : items) {
            if (item == null) {
                continue;
            }
            // 字符串元素：仅保留本身已是 Markdown 的行（["## 组", "- [x] a"] 形态）。
            // 限制在 Markdown 形态是为了不让 ["junk"] 被升格成凭空的任务。
            if (item.isValue() && !item.isObject() && !item.isArray()) {
                String s = item.getString();
                if (s == null) {
                    continue;
                }
                boolean emitted = false;
                for (String line : s.split("\n")) {
                    String t = line.trim();
                    if (t.isEmpty() || !(t.startsWith("- ") || t.startsWith("#"))) {
                        continue;
                    }
                    out.append(t).append('\n');
                    emitted = true;
                }
                if (emitted) {
                    converted++;
                }
                continue;
            }
            if (!item.isObject()) {
                continue;
            }

            String group = firstStringField(item, GROUP_KEYS);
            if (group != null && !group.equals(lastGroup)) {
                out.append("## ").append(group).append('\n');
                lastGroup = group;
            }

            boolean emitted = false;

            String note = firstStringField(item, NOTE_KEYS);
            if (note != null) {
                emitted |= pushLines(out, note);
            }

            // 嵌套清单数组（{"todos": [...]}）：外壳比 extractTodosField 能到的
            // 深一层——那个助手只认字符串值。
            ONode nested = item.get("todos");
            if (nested != null && nested.isArray()) {
                String inner = convertJsonItems(nested.toJson());
                if (inner != null) {
                    emitted |= pushLines(out, inner);
                }
            }

            String content = firstStringField(item, TEXT_KEYS);
            if (content != null && !isPlaceholder(content)) {
                char marker = statusOf(item);
                for (String line : content.split("\n")) {
                    String t = line.trim();
                    if (t.isEmpty()) {
                        continue;
                    }
                    if (isCheckboxLine(t)) {
                        out.append(t);
                    } else {
                        out.append("- [").append(marker).append("] ").append(t);
                    }
                    out.append('\n');
                }
                emitted = true;
            }

            if (emitted) {
                converted++;
            }
        }

        if (converted == 0) {
            return null;
        }
        String salvaged = out.toString();
        while (salvaged.endsWith("\n")) {
            salvaged = salvaged.substring(0, salvaged.length() - 1);
        }
        return salvaged.isEmpty() ? null : salvaged;
    }

    /** 把文本的非空行逐行追加（原样），返回是否追加了内容。 */
    private static boolean pushLines(StringBuilder out, String text) {
        boolean emitted = false;
        for (String line : text.split("\n")) {
            String t = line.trim();
            if (t.isEmpty()) {
                continue;
            }
            out.append(t).append('\n');
            emitted = true;
        }
        return emitted;
    }

    /** 占位文本判定：salvage 不得把模型放弃清单时吐的噪声变成任务行。 */
    private static boolean isPlaceholder(String text) {
        String t = text.trim().toLowerCase();
        for (String p : PLACEHOLDER_TEXTS) {
            if (p.equals(t)) {
                return true;
            }
        }
        return false;
    }

    /** 取第一个非空字符串字段。 */
    private static String firstStringField(ONode obj, String[] keys) {
        for (String key : keys) {
            ONode v = obj.get(key);
            if (v == null || !v.isString()) {
                continue;
            }
            String s = v.getString();
            if (s == null) {
                continue;
            }
            s = s.trim();
            if (!s.isEmpty()) {
                return s;
            }
        }
        return null;
    }

    /** 把条目状态映射为 checkbox 标记；未识别状态保守归为待办。 */
    private static char statusOf(ONode obj) {
        for (String key : new String[]{"checked", "done"}) {
            ONode v = obj.get(key);
            if (v != null && v.isBoolean()) {
                return v.getBoolean() ? 'x' : ' ';
            }
        }
        String raw = firstStringField(obj, STATUS_KEYS);
        if (raw == null) {
            return ' ';
        }
        StringBuilder norm = new StringBuilder();
        for (char c : raw.toLowerCase().toCharArray()) {
            if (c < 128 && Character.isLetterOrDigit(c)) {
                norm.append(c);
            }
        }
        String n = norm.toString();
        if (n.equals("x") || n.equals("done") || n.equals("completed")
                || n.equals("complete") || n.equals("finished")) {
            return 'x';
        }
        if (n.equals("inprogress") || n.equals("doing") || n.equals("active")
                || n.equals("ongoing") || n.equals("started")) {
            return '/';
        }
        return ' ';
    }

    /**
     * 从文本中定位 {@code "todos"} 键并取出其字符串字面量值（含 JSON 转义还原）。
     * 值不是字符串字面量、或引号未闭合时返回 null，交由调用方走后续兜底分支。
     */
    private static String extractTodosField(String text) {
        int key = text.indexOf("\"todos\"");
        if (key < 0) {
            return null;
        }
        int i = key + "\"todos\"".length();
        while (i < text.length() && (Character.isWhitespace(text.charAt(i)) || text.charAt(i) == ':')) {
            i++;
        }
        if (i >= text.length() || text.charAt(i) != '"') {
            return null;
        }
        int start = i + 1;
        for (int p = start; p < text.length(); p++) {
            char c = text.charAt(p);
            if (c == '\\') {
                p++;
                continue;
            }
            if (c == '"') {
                return unescapeJsonString(text.substring(start, p));
            }
        }
        return null;
    }

    /**
     * 还原 JSON 字符串字面量中的转义序列（{@code \n} {@code \r} {@code \t} {@code \\} {@code \"} {@code \/} {@code \b} {@code \f} {@code \\uXXXX}）；
     * 无法识别的转义按原样保留，不做破坏性处理。
     */
    private static String unescapeJsonString(String s) {
        if (s.indexOf('\\') < 0) {
            return s;
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) {
                sb.append(c);
                continue;
            }
            char next = s.charAt(++i);
            switch (next) {
                case 'n':
                    sb.append('\n');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case '"':
                    sb.append('"');
                    break;
                case '\\':
                    sb.append('\\');
                    break;
                case '/':
                    sb.append('/');
                    break;
                case 'u':
                    if (i + 4 < s.length()) {
                        try {
                            sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException e) {
                            sb.append('\\').append(next);
                        }
                    } else {
                        sb.append('\\').append(next);
                    }
                    break;
                default:
                    sb.append('\\').append(next);
            }
        }
        return sb.toString();
    }

    /**
     * 把字面书写（反斜杠 + n/r 两字符）的换行还原为真换行，并统一行尾为 LF。
     */
    private static String unescapeLiteralNewlines(String s) {
        if (s.indexOf("\\n") < 0 && s.indexOf("\\r") < 0) {
            return s;
        }
        return s.replace("\\r\\n", "\n")
                .replace("\\n", "\n")
                .replace("\\r", "\n")
                .replace("\r\n", "\n");
    }

    /**
     * 判断清单中是否存在未完成项（`[ ]` 待办或 `[/]` 进行中）
     */
    public static boolean hasUnfinishedItems(String content) {
        if (content == null || content.isEmpty()) {
            return false;
        }
        for (String line : content.split("\n")) {
            String trimmed = line.trim();
            // 与 buildProgressFooter 保持一致的 checkbox 行识别规则
            if (!isCheckboxLine(trimmed)) {
                continue;
            }
            char mark = Character.toLowerCase(trimmed.charAt(3));
            if (mark == ' ' || mark == '/') {
                return true;
            }
        }
        return false;
    }

    /**
     * 构造「恢复校准」消息：呈现落盘清单的真实状态，要求模型先核对历史证据再行动，
     * 防止异常中断恢复后盲目重复执行已完成的步骤（中断时刻模型可能未及时 todowrite，
     * 落盘状态会滞后于实际执行进度）。
     *
     * @param content 落盘的 TODO.md 全文
     * @return 校准消息文本；无未完成项时返回 null（无需校准）
     */
    public static String buildResumeCalibration(String content) {
        if (!hasUnfinishedItems(content)) {
            return null;
        }

        return "[TODO 恢复校准] 上一次任务异常中断，现在是恢复执行。" +
                "下方清单是 TODO.md 落盘的当前真实状态，它可能滞后于实际执行进度" +
                "（中断时刻可能未及时调用 todowrite），部分标记为 `[ ]` 或 `[/]` 的项实际可能已经完成：\n\n" +
                "<todo_snapshot>\n" + content.trim() + "\n</todo_snapshot>\n\n" +
                "要求：行动前必须逐项核对每个未完成项——检查历史 Observation 中是否已包含该项对应的执行结果/证据。" +
                "确已完成的，直接用 todowrite 将其置为 `[x]` 确认状态即可，不要重新执行；" +
                "只对确实未完成的部分继续推进。严禁盲目重复执行已完成的步骤。";
    }

    @ToolMapping(name = TOOL_TODOREAD, description = "读取任务清单。用于同步执行进度，确认下一步操作。")
    public String todoRead(String __cwd,
                           String __sessionId) throws IOException {
        Path workPath = getWorkPath(__cwd, __sessionId);

        Path todoFile = workPath.resolve(TODO_FILE_NAME);

        if (!Files.exists(todoFile)) {
            return "[] (当前任务清单为空。若任务复杂，请使用 `todowrite` 初始化计划。)";
        }

        byte[] encoded = Files.readAllBytes(todoFile);
        String content = new String(encoded, StandardCharsets.UTF_8);

        // 读侧自愈：旧内核落盘的 JSON 外壳解析出 0 条任务，模型会读到「空清单」
        // 并从头重建、丢掉存量状态。就地修复一次，回答与面板从此看到同一份真清单。
        String healed = healContent(content);
        if (healed != null) {
            if (!healed.endsWith("\n")) {
                healed = healed + "\n";
            }
            try {
                Files.write(todoFile, healed.getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // 回写失败仍按修复后的内容回答，下一次读取会重试自愈
            }
            content = healed;
        }

        return content + buildProgressFooter(content);
    }

    @ToolMapping(name = TOOL_TODOWRITE, description = "写入任务列表（新建、更新或重构）。接收 JSON 数组或 Markdown 格式的完整清单。")
    public String todoWrite(
            @Param(value = "todos", description = "完整任务清单。优先传 JSON 数组：每个元素为对象，含 `content`（任务文本，必填）与 `status`（`pending` / `in_progress` / `done`），可选 `header`/`group` 作为分组；也兼容 Markdown 字符串：可用 `##` 标题分组，所有可跟踪任务必须使用 checkbox 行：`- [ ]` 待办、`- [/]` 进行中、`- [x]` 已完成。不要把换行写成字面反斜杠 n，不要传 `placeholder` 之类占位符，不要用无状态普通列表 `- xxx` 表示任务。") String todosMarkdown,
            String __cwd,
            String __sessionId
    ) throws IOException {
        Path workPath = getWorkPath(__cwd, __sessionId);

        if (Files.notExists(workPath)) {
            Files.createDirectories(workPath);
        }

        Path todoFile = workPath.resolve(TODO_FILE_NAME);

        String content = sanitizeTodoMarkdown(todosMarkdown);

        // 【空入参不得落盘·勿删】content 为空（todosMarkdown 为 null / 纯空白）时，若照常
        // Files.write 会把已有 TODO.md <b>整份抗掉</b>；而且因 content.isEmpty()，
        // FORMAT_WARN 与「继续/完成」推力全部被跳过，模型只收到一条「TODO saved.」+
        // total: 0——清单没了、进度归零、还告诉它保存成功，是最坏的组合。
        // HarnessEngine 的中断恢复校准也依赖 TODO.md 内容，被抗后一并失效。
        // 故空内容视为非法入参：不碰磁盘，并把格式要求回给模型。
        if (content.isEmpty()) {
            return "TODO not saved: todos 参数为空（未改动已有清单）。" + FORMAT_WARN;
        }

        if (!content.endsWith("\n")) {
            content = content + "\n";
        }
        Files.write(todoFile, content.getBytes(StandardCharsets.UTF_8));

        String result = "TODO saved." + buildProgressFooter(content);
        if (countCheckboxLines(content) == 0) {
            result += FORMAT_WARN;
        }
        return result;
    }

    /**
     * 根据清单内容构造进度页脚，并在决策点给出明确的“继续/完成”推力。
     */
    private String buildProgressFooter(String content) {
        int total = 0, done = 0, inProgress = 0, pending = 0;
        String firstUnfinished = null;
        for (String line : content.split("\n")) {
            String trimmed = line.trim();
            // 仅识别 checkbox 行，口径见 isCheckboxLine（状态字符大小写均兼容）
            if (!isCheckboxLine(trimmed)) {
                continue;
            }
            char mark = Character.toLowerCase(trimmed.charAt(3));
            String text = trimmed.substring(5).trim();
            if (mark == 'x') {
                total++;
                done++;
            } else if (mark == '/') {
                total++;
                inProgress++;
                if (firstUnfinished == null) {
                    firstUnfinished = text;
                }
            } else if (mark == ' ') {
                total++;
                pending++;
                if (firstUnfinished == null) {
                    firstUnfinished = text;
                }
            }
        }

        StringBuilder footer = new StringBuilder();
        footer.append(String.format("%n[进度] total: %d, done: %d, in-progress: %d, pending: %d.",
                total, done, inProgress, pending));

        int unfinished = inProgress + pending;
        if (total == 0) {
            return footer.toString();
        }

        if (unfinished > 0) {
            footer.append(String.format("%n[继续] 还有 %d 项未完成，任务尚未结束。禁止现在收尾或输出总结，请继续推进未完成事项。", unfinished));
            if (firstUnfinished != null && !firstUnfinished.isEmpty()) {
                String next = firstUnfinished.length() > 80
                        ? firstUnfinished.substring(0, 80) + "..."
                        : firstUnfinished;
                footer.append(String.format("%n[待办首项] %s", next));
            }
            if (inProgress > 0) {
                footer.append(String.format("%n[提示] 存在 %d 个 `[/]` 进行中项：若当前是中断后的恢复执行，它们可能是上次异常中断的遗留项，实际或许已经完成。请先核对历史 Observation 中是否已有对应执行结果，确已完成的直接用 todowrite 置 [x] 确认，不要盲目重做。", inProgress));
            }
        } else {
            footer.append(String.format("%n[完成] 所有事项均已 [x]，可以收尾并向用户汇报结果。"));
        }

        return footer.toString();
    }
}