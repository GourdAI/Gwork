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

import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.prompt.Prompt;
import org.noear.solon.ai.chat.talent.AbsTalent;
import org.noear.solon.annotation.Param;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

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
                    + "请传入 Markdown 原文：每条任务独占一行、以短横线开头并带方括号状态标记；"
                    + "使用真实换行分隔，不要包 JSON 外壳，也不要把换行写成字面反斜杠 n。";

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
        return "## 任务规划指南 (Task Planning Guide)\n" +
                "1. **启动机制**: 超过3步以上的复杂任务，要通过 `todowrite` 创建计划；任务边界或目标发生重大变化时，用 `todowrite` 重构完整计划。\n" +
                "2. **状态感知（恢复优先）**: 凡是你对当前进度没有十足把握时，必须 **先** `todoread` 再行动，禁止凭记忆推断。以下场景一律强制先读：上下文被压缩/截断后、用户说“继续/接着做/还有吗”、开启新一轮对话、或任务中途被打断后恢复。**注意：中断恢复后清单状态可能滞后于实际进度（中断时刻可能未及时 todowrite）**，对未完成项要先核对历史 Observation 中是否已有对应执行证据，确已完成的直接用 `todowrite` 确认状态即可，禁止盲目重做。\n" +
                "3. **实时推进（状态变化即更新）**: 状态变更要随做随记，禁止跨回合攒着批量补记。**任何工具结果使某项状态发生变化的那一刻，下一轮的首个动作必须是 `todowrite` 落盘状态，然后才能继续后续动作**：开始做某项前先置 `[/]`；某项拿到执行结果后立即置 `[x]`；尤其收到 `task`/`multitask` 委派结果后，必须马上更新对应项。串行任务通常同一时刻只有一项 `[/]`；并行场景允许多项同时 `[/]`，但每项一旦完成都要第一时间单独更新，避免进度失真。**状态标记**: `[ ]` 待办；`[/]` 进行中；`[x]` 已完成。\n" +
                "4. **闭环校验（禁止半途收尾）**: 只要清单中还存在 `[ ]` 或 `[/]`，即视为任务未完成。默认行为是 **继续把它做完**，不得停下、不得输出总结。仅当遇到真正的停止条件——外部阻塞（缺少权限、缺少必要信息）或**等待用户拍板方案/决策**（见“改造门禁”）——时，才允许停下并明确说明；不得把“可自行完成的剩余工作”当作追问理由，但**已提交方案、正在等待用户选择时停下是合规行为，不是半途收尾**。\n" +
                "5. **改造门禁（先方案后动手）**: 对现有代码、配置或架构做复杂改造（如多文件修改、跨模块重构、破坏性/不可逆变更、涉及多种可行实现路径）时，**禁止未经用户确认直接动手**。必须先完成调研，产出 ≥2 个可行实施方案（含实现思路、改动范围、优缺点对比）及推荐项，停下等待用户选择；用户拍板后，再据此创建或更新清单并执行。用户已明确指定实现方式、或仅为单点小修（如改文案、修明显 Bug）时可豁免。\n" +
                "6. **以返回为准**: `todoread`/`todowrite` 的返回值会附带 [进度] 与 [继续]/[完成] 提示，请以该提示作为“是否可以收尾”的判定依据。\n" +
                "7. **适用边界**: 不要为常识性提问、简单计算或单次工具创建计划。";
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
            return content.trim().isEmpty() ? null : content;
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
        int best = countCheckboxLines(text);

        // ① 入参带着 JSON 外壳：取出 todos 字段的字符串值（内部转义已一并还原）
        String unwrapped = extractTodosField(text);
        if (unwrapped != null) {
            String value = unwrapped.trim();
            int count = countCheckboxLines(value);
            if (count > best) {
                best = count;
                text = value;
            }
        }

        // ② 字面换行序列还原为真换行（覆盖「有壳且塌行」与「无壳但塌行」两类）
        String unescaped = unescapeLiteralNewlines(text);
        if (countCheckboxLines(unescaped) > best) {
            text = unescaped;
        }

        return text;
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
        return content + buildProgressFooter(content);
    }

    @ToolMapping(name = TOOL_TODOWRITE, description = "写入任务列表（新建、更新或重构）。接收完整的 Markdown 格式清单。")
    public String todoWrite(
            @Param(value = "todos", description = "完整 Markdown 任务清单。可使用 `##` 标题分组；所有可跟踪任务必须使用 checkbox 行：`- [ ]` 待办、`- [/]` 进行中、`- [x]` 已完成。不要用无状态普通列表 `- xxx` 表示任务，必须带 checkbox 标记。") String todosMarkdown,
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