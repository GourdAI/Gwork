/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.core.portal.cli;

import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ReasonDeltaEvent;
import com.gourdai.agent.event.ReasonEndEvent;
import org.jline.reader.EndOfFileException;
import org.jline.reader.LineReader;
import org.jline.reader.LineReaderBuilder;
import org.jline.reader.UserInterruptException;
import org.jline.terminal.Attributes;
import org.jline.terminal.Terminal;
import org.jline.terminal.TerminalBuilder;
import org.noear.solon.Utils;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.util.AgentUtil;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.event.RunEndEvent;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.harness.agent.RetryEvent;
import com.gourdai.harness.agent.AgentStartEvent;
import com.gourdai.harness.agent.AgentEndEvent;
import com.gourdai.agent.react.intercept.HITL;
import com.gourdai.agent.react.intercept.HITLDecision;
import com.gourdai.agent.react.intercept.HITLTask;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.harness.command.Command;
import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.noear.solon.ai.util.CmdUtil;
import com.gourdai.core.command.CliCommandContext;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.command.builtin.LoopScheduler;
import com.gourdai.core.config.AgentSettings;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.DateUtil;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.Disposable;
import reactor.core.scheduler.Schedulers;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Code CLI 终端
 */
@Preview("3.9.4")
public class CliShell implements Runnable {
    private final static Logger LOG = LoggerFactory.getLogger(CliShell.class);

    private final static String SESSION_ID_CLI = "cli";

    private Terminal terminal;
    private LineReader reader;
    private final HarnessEngine engine;
    private final AgentSettings agentProps;
    private final LoopScheduler loopScheduler;

    // ANSI 颜色常量
    private final static String
            BOLD = "\033[1m",      // 粗体 / 高亮
            DIM = "\033[2m",       // 暗淡 / 半透明（部分终端支持）
            GREEN = "\033[32m",    // 前景色：绿色
            YELLOW = "\033[33m",   // 前景色：黄色
            RED = "\033[31m",      // 前景色：红色
            CYAN = "\033[36m",     // 前景色：青色 / 蓝绿色
            BLUE = "\033[34m",     // 前景色：蓝色
            PURPLE = "\033[35m",   // 前景色：紫色 / 品红
            RESET = "\033[0m";     // 重置所有样式和颜色（恢复终端默认）


    public CliShell(HarnessEngine engine, AgentSettings agentProps, LoopScheduler loopScheduler) {
        this.engine = engine;
        this.agentProps = agentProps;
        this.loopScheduler = loopScheduler;

        try {
            this.terminal = TerminalBuilder.builder()
                    .jna(true).jansi(true).system(true).dumb(true)
                    .encoding(StandardCharsets.UTF_8)
                    .build();

            this.reader = LineReaderBuilder.builder()
                    .terminal(terminal)
                    .completer(new CliCompleter(engine))
                    .build();
        } catch (Throwable e) {
            LOG.error("JLine initialization failed", e);
        }
    }

    public Terminal getTerminal() {
        return terminal;
    }

    public LineReader getReader() {
        return reader;
    }

    /**
     * 预备开始
     */
    private AgentSession prepare(String sessionId) {
        // Windows 下将控制台切换为 UTF-8 代码页，避免中文输入乱码
        if (System.getProperty("os.name").toLowerCase().contains("win")) {
            try {
                Process process = new ProcessBuilder("cmd", "/c", "chcp", "65001").start();
                // 读取并丢弃输出，避免显示到控制台
                try (java.io.InputStream is = process.getInputStream()) {
                    while (is.read() != -1) {
                    }
                }
                process.waitFor();
            } catch (Exception ignored) {
            }
        }

        AgentSession session = engine.getSession(sessionId);
        printWelcome(session);
        return session;
    }

    /**
     * 单次调用
     */
    public void call(String input) {
        if (Assert.isEmpty(input)) {
            return;
        }

        AgentSession session = prepare(SESSION_ID_CLI);

        try {
            if (!isCommand(session, input)) {
                performAgentTask(session, input, null);
            }
        } catch (Throwable e) {
            terminal.writer().println("\n" + RED + "! Error: " + RESET + e.getMessage());
        }
    }

    /**
     * 长运行
     */
    @Override
    public void run() {
        AgentSession session = prepare(SESSION_ID_CLI);


        if (loopScheduler != null) {
            // 恢复上次未过期的 loop 定时任务（如果有）
            loopScheduler.restore(session.getSessionId(), engine.getWorkspace(), engine.getHarnessSessions());

            // 会话繁忙守卫：CLI 为单线程模型，仅当主线程在等待用户输入（reader.isReading）时才空闲。
            // 若不在等待输入，说明 agent 任务正在执行，loop 触发应跳过本次。
            loopScheduler.addBusyChecker(sessionId -> {
                if (SESSION_ID_CLI.equals(sessionId) == false) {
                    return false;
                }
                return reader == null || !reader.isReading();
            });

            // 注入任务执行器：loop 定时任务触发时，由主线程执行 agent 任务
            // 注：CLI 端不支持任务级的工作空间 / 模型 / 思考档位选择（固定跟随 CLI 当前会话与配置），
            // 这些选择仅在 Web 端生效（见 WebController 中的 TaskExecutor 实现）。
            loopScheduler.addTaskExecutor((sessionId, prompt, agentName, task) -> {
                if (SESSION_ID_CLI.equals(sessionId) == false) {
                    return null;
                }

                // P0-fix: 如果指定了 agentName，将 prompt 拼接为 @agentName prompt 格式
                // performAgentTask 内部通过 input.startsWith("@") 识别并路由到对应 agent
                String effectiveInput = prompt;
                if (agentName != null && !agentName.isEmpty()) {
                    effectiveInput = "@" + agentName + " " + prompt;
                }

                // 直接返回 ReAct 完成时的权威全文（goal 检查依赖此返回值）。
                // 含 [GOAL_ACHIEVED] 的全文来自 RunEndEvent，必须以此为准。
                return safeChatInput(session, effectiveInput);
            });
        }

        // 2. 主循环
        while (true) {
            try {
                String input;

                try {
                    terminal.writer().println();
                    terminal.writer().print(BOLD + CYAN + "User" + RESET);
                    terminal.writer().println();
                    terminal.flush();

                    input = reader.readLine(CYAN + "❯ " + RESET).trim();
                } catch (UserInterruptException e) {
                    continue;
                } catch (EndOfFileException e) {
                    terminal.writer().println("\nBye!");
                    terminal.flush();
                    break; // 直接跳出主循环，优雅退出
                }

                if (Assert.isEmpty(input)) {
                    continue;
                }

                if (!isCommand(session, input)) {
                    performAgentTask(session, input, null);
                }
            } catch (Throwable e) {
                LOG.warn(e.getMessage(), e);
                terminal.writer().println("\n" + RED + "! Error: " + RESET + e.getMessage());
            }
        }
    }

    private String safeChatInput(AgentSession session, String prompt) {
        if (reader != null && reader.isReading()) {
            try {
                return performAgentTask(session, prompt, null);
            } catch (Exception e) {
                LOG.error("Loop task execution failed: {}", e.getMessage(), e);
            } finally {
                //打断主线程的 readLine 阻塞 // 触发 run() 循环中的 UserInterruptException
                terminal.raise(Terminal.Signal.INT);
            }
        }
        return null;
    }

    private boolean isCommand(AgentSession session, String input) throws Exception {
        if (!input.startsWith("/")) {
            return false;
        }

        // 解析命令名和参数
        List<String> parts = CmdUtil.parseArguments(input.trim().substring(1));
        String cmdName = parts.get(0).toLowerCase();
        List<String> args = parts.size() > 1
                ? parts.subList(1, parts.size())
                : Collections.emptyList();

        // 查找命令
        Command command = engine.getCommandRegistry().find(cmdName);
        if (command == null) {
            return false;
        }

        // 构建 context（注入 agentTaskRunner 回调）
        CliCommandContext ctx = new CliCommandContext(session, terminal, reader,
                engine, input, cmdName, args,
                (prompt, model) -> {
                    try {
                        performAgentTask(session, prompt, model);
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                });

        // 执行命令
        command.execute(ctx);

        // clear 命令后重新打印 welcome
        if ("clear".equals(cmdName)) {
            printWelcome(session);
        }

        return true;
    }

    private String getTimeNow() {
        return LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
    }

    private String performAgentTask(AgentSession session, String input, String modelSelected) throws Exception {
        terminal.writer().println("\n" + BOLD + "Assistant" + RESET + DIM + " " + getTimeNow() + RESET);

        String agentName = null;
        String currentInput = input;
        final AtomicBoolean isTaskCompleted = new AtomicBoolean(false);
        final AtomicBoolean isFirstConversation = new AtomicBoolean(true);
        // ReAct 完成时的权威全文（含 [GOAL_ACHIEVED]），多轮 HITL 时以最后一轮为准。
        final AtomicReference<String> finalAnswer = new AtomicReference<>();

        if (modelSelected == null) {
            modelSelected = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
        }


        if (input != null) {
            if (input.startsWith("@")) {
                int agentNameIdx = input.indexOf(" ");
                if (agentNameIdx > 0) {
                    agentName = input.substring(1, agentNameIdx);

                    if (engine.getAgentManager().hasAgent(agentName)) {
                        currentInput = currentInput.substring(agentNameIdx + 1);
                    }
                }
            }
        }

        ChatModel chatModel = engine.getModelOrMain(modelSelected);
        ReActAgent agent = engine.getAgentOrMain(agentName);

        // 中断续跑：上次异常中断（如模型调用失败）时，用户再发消息保留断点工作记忆并追加新消息接着跑，
        // 而非从头重跑。currentInput 置空后下方以空 Prompt 发起，触发库的恢复分支复用工作记忆。
        if (Assert.isNotEmpty(currentInput)) {
            ReActTrace resumeTrace = engine.resolveTrace(session, agentName);
            if (engine.canResume(resumeTrace)) {
                // 自动续跑仅在异常中断时触发，最后一条是失败兜底消息，需移除重生成
                engine.prepareResume(resumeTrace, session, currentInput, true);
                currentInput = null;
            }
        }

        while (true) {
            // 简化状态提示：只在非首次且任务未完成时打印等待符
            if (currentInput == null && !isTaskCompleted.get()) {
                terminal.writer().print("\r" + DIM + "  ... " + RESET);
                terminal.flush();
            }

            CountDownLatch latch = new CountDownLatch(1);
            final AtomicBoolean isInterrupted = new AtomicBoolean(false);
            final AtomicBoolean isFirstReasonDeltaChunk = new AtomicBoolean(true);

            // 本轮任务的起始时刻。不用 trace.getBeginTimeMs()：trace 在会话内跨轮复用，
            // 「继续/恢复」时不重置，其 beginTimeMs 停留在最初任务起点，会把耗时累计成整段对话时长。
            // 循环每一圈恰对应一轮任务，在此计时才是「单轮耗时」。
            final long turnStartMs = System.currentTimeMillis();

            Prompt originalPrompt = Prompt.of(currentInput);

            Disposable disposable = agent.prompt(originalPrompt)
                    .session(session)
                    .options(o -> {
                        o.chatModel(chatModel);

                        // 每次请求读取实时配置，使通用设置的修改即时生效（无需重启/重建 Agent）
                        o.retryConfig(engine.getModelRetries());
                        o.maxTurns(engine.getMaxTurns());
                        o.sessionWindowSize(engine.getSessionWindowSize());
                    })
                    .stream()
                    .subscribeOn(Schedulers.boundedElastic())
                    .doOnNext(chunk -> {
                        if (chunk instanceof ReasonDeltaEvent) {
                            // ReasonDeltaEvent 为思考或正文的增量块（按 isThinking() 区分；工具调用时为全量，不需要打印）
                            onReasonDeltaEvent((ReasonDeltaEvent) chunk, isFirstReasonDeltaChunk, isFirstConversation);
                        } else if (chunk instanceof ReasonEndEvent) {
                            //ReasonEndEvent 为一轮推理的完成块（同时承载思考与正文，经 getThinking()/getText() 物理分离）
                            onReasonEndEvent((ReasonEndEvent) chunk);
                        } else if (chunk instanceof ToolCallEndEvent) {
                            //ToolCallEndEvent 为全量，一次工具调用产生一个 ToolCallEndEvent
                            onToolCallEndEvent((ToolCallEndEvent) chunk, isFirstReasonDeltaChunk);
                        } else if (chunk instanceof AgentStartEvent) {
                            // 子代理启动：打印紫色提示
                            terminal.writer().println("\n" + PURPLE + "  ⟳ Sub-agent started: " + ((AgentStartEvent) chunk).getAgentName() + RESET);
                            String desc = ((AgentStartEvent) chunk).getDescription();
                            if (Assert.isNotEmpty(desc)) {
                                terminal.writer().println(DIM + "    " + desc + RESET);
                            }
                            terminal.flush();
                        } else if (chunk instanceof AgentEndEvent) {
                            // 子代理结束：打印完成/失败提示
                            AgentEndEvent aec = (AgentEndEvent) chunk;
                            if (aec.isSuccess()) {
                                terminal.writer().println(GREEN + "  ✓ Sub-agent completed: " + aec.getAgentName() + RESET);
                            } else {
                                terminal.writer().println(RED + "  ✗ Sub-agent failed: " + aec.getAgentName() + RESET);
                            }
                            String summary = aec.getResultSummary();
                            if (Assert.isNotEmpty(summary)) {
                                terminal.writer().println(DIM + "    " + summary + RESET);
                            }
                            terminal.flush();
                        } else if (chunk instanceof RetryEvent) {
                            //RetryEvent 模型调用失败自动重试时推送，提示"正在重试 N/M"
                            terminal.writer().println("\n" + YELLOW + "  ⟳ " + ((RetryEvent) chunk).toText() + RESET);
                            terminal.flush();
                        } else if (chunk instanceof RunEndEvent) {
                            // RunEndEvent 为全量，ReAct 完成任务时的最后答复
                            String answer = onRunEndEvent((RunEndEvent) chunk, turnStartMs);
                            if (Assert.isNotEmpty(answer)) {
                                finalAnswer.set(answer);
                            }
                        }
                    })
                    .doOnError(e -> {
                        LOG.error("Task fail: {}", e.getMessage(), e);

                        terminal.writer().println("\n" + RED + "── Error ────────────────" + RESET);
                        terminal.writer().println(e.getMessage());
                        terminal.flush();
                    })
                    .doFinally(signal -> {
                        isTaskCompleted.set(true);
                        latch.countDown();
                    })
                    .subscribe();

            // 监听回车中断
            if (disposable == null || disposable.isDisposed()) {
                // 处理订阅失败的情况
                return finalAnswer.get();
            }

            waitForTask(latch, disposable, session, isInterrupted);

            if (isInterrupted.get()) {
                terminal.writer().println(DIM + "[Task interrupted]" + RESET);
                terminal.flush();
                session.addMessage(ChatMessage.ofAssistant("用户已取消任务."));
                LOG.info("用户已取消任务.");
                return finalAnswer.get();
            }

            // HITL 处理 (授权交互)
            if (HITL.isHitl(session)) {
                if (handleHITL(session)) {
                    currentInput = null;
                    continue;
                } else {
                    return finalAnswer.get();
                }
            }

            if (isTaskCompleted.get()) {
                terminal.writer().println();
                terminal.flush();
                return finalAnswer.get();
            }

            currentInput = null;
        }
    }

    private void waitForTask(CountDownLatch latch, Disposable disposable,
                             AgentSession session, AtomicBoolean isInterrupted) throws Exception {
        Attributes originalAttributes = terminal.getAttributes();
        try {
            terminal.enterRawMode();

            while (latch.getCount() > 0) {
                int c = terminal.reader().read(50);
                if (c > 0) {
                    if (c == 27) { //|| c == '\r' || c == '\n'
                        disposable.dispose();
                        isInterrupted.set(true);
                        latch.countDown();
                        break;
                    }
                }

                if (HITL.isHitl(session)) {
                    latch.countDown();
                    break;
                }
            }
        } catch (Throwable e) {
            LOG.warn(e.getMessage(), e);
        } finally {
            terminal.setAttributes(originalAttributes);
        }

        latch.await();
    }

    private boolean handleHITL(AgentSession session) {
        HITLTask task = HITL.getPendingTask(session);
        HITLDecision decision = HITL.getDecision(session, task);

        if (decision != null) {
            if (decision.isRejected()) {
                return false;
            } else {
                return true;
            }
        }

        terminal.writer().println("\n" + BOLD + YELLOW + "Permission Required" + RESET);
        if ("bash".equals(task.getToolName())) {
            terminal.writer().println(DIM + "Command: " + RESET + task.getArgs().get("command"));
        }

        String choice = reader.readLine(BOLD + GREEN + "Approve? (y/n) " + RESET).trim().toLowerCase();
        if ("y".equals(choice) || "yes".equals(choice)) {
            HITL.approve(session, task.getToolName());
            return true;
        } else {
            HITL.reject(session, task.getToolName());
            terminal.writer().println(DIM + "Action rejected." + RESET);
            return false;
        }
    }

    private StringBuilder getTraceInfo(ReActTrace trace, long start_time) {
        StringBuilder buf = new StringBuilder();
        buf.append(" (");

        if (trace.getMetrics() != null) {
            long inputTokens = trace.getMetrics().getPromptTokens();
            long outputTokens = trace.getMetrics().getCompletionTokens();

            buf.append("输入: ").append(formatTokens(inputTokens)).append(" tokens");
            buf.append(", 输出: ").append(formatTokens(outputTokens)).append(" tokens");
        }

        if (start_time > 0) {
            if (buf.length() > 2) {
                buf.append(", ");
            }

            long seconds = Duration.ofMillis(System.currentTimeMillis() - start_time).getSeconds();
            buf.append("耗时: ").append(formatTime(seconds));
        }

        buf.append(")");

        return buf;
    }

    private String formatTokens(long n) {
        if (n >= 1_000_000) {
            return String.format("%.1fM", n / 1_000_000.0).replaceAll("\\.0", "");
        } else if (n >= 1_000) {
            return String.format("%.1fK", n / 1_000.0).replaceAll("\\.0", "");
        }
        return String.valueOf(n);
    }

    private String formatTime(long seconds) {
        if (seconds >= 60) {
            long mins = seconds / 60;
            long secs = seconds % 60;
            return secs > 0 ? mins + "min " + secs + "s" : mins + "min";
        }
        return seconds + "s";
    }

    private String onRunEndEvent(RunEndEvent react, long turnStartMs) {
        StringBuilder traceInfo = getTraceInfo(react.getTrace(), turnStartMs);

        if (traceInfo.length() > 4) {
            terminal.writer().println(DIM + traceInfo + RESET);
        }

        // 返回 ReAct 完成时的权威全量答复，由调用方用于 loop goal 判定。
        return clearThink(react.getContent());
    }

    private void onReasonDeltaEvent(ReasonDeltaEvent reason, AtomicBoolean isFirstReasonDeltaChunk, AtomicBoolean isFirstConversation) {
        if (!reason.isToolCalls() && reason.hasContent()) {
            String delta = clearThink(reason.getContent());

            if (reason.getMessage().isThinking()) {
                if (agentProps.getGeneral().getCliThinkPrinted()) {
                    writeReasonDelta(DIM + delta + RESET, isFirstReasonDeltaChunk, isFirstConversation);
                }
            } else {
                writeReasonDelta(delta, isFirstReasonDeltaChunk, isFirstConversation);
            }
        }
    }

    private void writeReasonDelta(String delta, AtomicBoolean isFirstReasonDeltaChunk, AtomicBoolean isFirstConversation) {
        if (Assert.isNotEmpty(delta)) {
            if (isFirstReasonDeltaChunk.get()) {
                String trimmed = delta.replaceAll("^[\\s\\n]+", "");
                if (Assert.isNotEmpty(trimmed)) {
                    if (isFirstConversation.get()) {
                        terminal.writer().print("  ");
                        isFirstConversation.set(false);
                    } else {
                        terminal.writer().print("\n  ");
                    }

                    terminal.writer().print(trimmed.replace("\n", "\n  "));
                    isFirstReasonDeltaChunk.set(false);
                }
            } else {
                // 连续的思考内容，保持缩进替换即可
                terminal.writer().print(delta.replace("\n", "\n  "));
            }
            terminal.flush();
        }
    }


    /**
     * 处理子代理的聚合载荷（ReasonEndEvent）。
     *
     * <p>正文必须用 {@code getText()} 而不是 {@code getAssistantMessage().getResultContent()}：
     * 后者内部是 stripThinkTags，对「inline-think 方言」（Qwen 等把思考直接写在正文里、用
     * &lt;think&gt; 标签包裹）会把标签前的真实正文一并吃掉，只剩标签后的残段。</p>
     *
     * <p>思考是否打印沿用 {@code cliThinkPrinted} 开关，与 {@link #onReasonDeltaEvent} 的增量路径
     * 保持同一口径：用户关了思考输出时，兜底路径也不能突然把整段思考糊到屏幕上。</p>
     */
    private void onReasonEndEvent(ReasonEndEvent thought) {
        if (!thought.hasMeta(TaskTalent.META_SUBAGENT)) {
            return;
        }

        // 子代理思考：旧实现完全不下发，终端里永远看不到委派出去的那一层在想什么
        if (thought.hasThinking() && agentProps.getGeneral().getCliThinkPrinted()) {
            printIndented(DIM + thought.getThinking().trim() + RESET);
        }

        String content = thought.getText();
        if (Assert.isNotEmpty(content)) {
            printIndented(content.trim());
        }
    }

    /** 按终端惯例缩进两格打印一段多行文本（前后各一空行作块分隔）。 */
    private void printIndented(String text) {
        if (Assert.isEmpty(text)) {
            return;
        }
        terminal.writer().println();
        terminal.writer().print("  " + text.replace("\n", "\n  "));
        terminal.writer().println();
        terminal.flush();
    }

    private void onToolCallEndEvent(ToolCallEndEvent action, AtomicBoolean isFirstReasonDeltaChunk) {
        if(action.getError() != null){
            String message = Assert.isNotEmpty(action.getError().getMessage())
                    ? action.getError().getMessage() : action.getError().getClass().getSimpleName();
            terminal.writer().println();
            terminal.writer().println(RED + "! Tool failed: " + action.getToolName() + RESET);
            terminal.writer().println(RED + "  " + message + RESET);
            terminal.flush();
            isFirstReasonDeltaChunk.set(true);
            return;
        }

        if (Assert.isNotEmpty(action.getToolName())) {
            if (TaskTalent.TOOL_MULTITASK.equals(action.getToolName()) ||
                    TaskTalent.TOOL_TASK.equals(action.getToolName()) ||
                    MemoryTalent.isMemoryTool(action.getToolName())) {
                return;
            }

            final String fullToolName;

            if (engine.getName().equals(action.getAgentName())) {
                fullToolName = action.getToolName();
            } else {
                fullToolName = action.getAgentName() + "/" + action.getToolName();
            }


            // 1. 准备参数字符串
            StringBuilder argsBuilder = new StringBuilder();
            Map<String, Object> args = action.getArgs();
            if (args != null && !args.isEmpty()) {
                args.forEach((k, v) -> {
                    if (argsBuilder.length() > 0) {
                        argsBuilder.append(" ");
                    }

                    if (v instanceof List) {
                        argsBuilder.append(k).append("=[").append(((List) v).size()).append("项]");
                    } else {
                        argsBuilder.append(k).append("=").append(v);
                    }
                });
            }

            boolean isTodo = TodoTalent.TOOL_TODOREAD.equals(action.getToolName()) || TodoTalent.TOOL_TODOWRITE.equals(action.getToolName());
            String argsStr = argsBuilder.toString().replace("\n", " ");
            boolean hasBigArgs = argsStr.length() > 100 || (args != null && args.values().stream().anyMatch(v -> v instanceof String && ((String) v).contains("\n")));

            if (agentProps.getGeneral().getCliPrintSimplified() && isTodo == false) {
                // --- 简化风格：单行摘要模式 ---
                String content = action.getContent() == null ? "" : action.getContent().trim();
                String summary;

                if (Assert.isEmpty(content)) {
                    summary = "completed";
                } else {
                    String[] lines = content.split("\n");
                    if (lines.length > 1) {
                        summary = "returned " + lines.length + " lines";
                    } else {
                        summary = content.length() > 40 ? content.substring(0, 37) + "..." : content;
                    }
                }

                // 简化模式下，参数也进行极简压缩
                String shortArgs = argsStr.length() > 40 ? argsStr.substring(0, 37) + "..." : argsStr;

                terminal.writer().println();
                terminal.writer().println(PURPLE + "❯ " + RESET + BOLD + fullToolName + RESET + " " + DIM + shortArgs + " (" + summary + ")" + RESET);
                terminal.flush();

            } else {
                // --- 全量风格 ---
                // 1. 打印指令行
                terminal.writer().println();
                if (TodoTalent.TOOL_TODOWRITE.equals(action.getToolName())) {
                    //优化 todowrite 打印
                    String todos = AgentUtil.asStringArg(args, TodoTalent.PARAM_TODOS);
                    argsStr = "\n" + (todos == null ? "" : todos.trim());
                    terminal.writer().println(PURPLE + "❯ " + RESET + BOLD + fullToolName + RESET + " " + DIM + argsStr + RESET);
                } else {

                    if (!hasBigArgs) {
                        // 短参数直接跟在后面
                        terminal.writer().println(PURPLE + "❯ " + RESET + BOLD + fullToolName + RESET + " " + DIM + argsStr + RESET);
                    } else {
                        // 大参数块，指令名独占一行，参数作为缩进内容打印（类似 write_file 的 content 部分）
                        terminal.writer().println(PURPLE + "❯ " + RESET + BOLD + fullToolName + RESET);
                        if (args != null) {
                            args.forEach((k, v) -> {
                                String val = String.valueOf(v).trim();
                                if ("content".equals(k) && val.split("\n").length > 10) {
                                    // 如果是写文件，且内容太长，只显示头尾
                                    String[] lines = val.split("\n");
                                    val = lines[0] + "\n    ...\n    " + lines[lines.length - 1];
                                }
                                terminal.writer().println(DIM + "  [" + k + "]: " + val.replace("\n", "\n    ") + RESET);
                            });
                        }
                    }
                }

                // 2. 处理工具返回的结果内容 (getContent)
                if (Assert.isNotEmpty(action.getContent())) {
                    // 在参数和结果之间如果内容较多，可以加个小分隔，或者直接缩进打印
                    String indentedContent = "  " + action.getContent().trim().replace("\n", "\n  ");
                    terminal.writer().println(DIM + indentedContent + RESET);
                }

                terminal.writer().println(DIM + "  (End of output)" + RESET);
                terminal.flush();
            }

            // 3. 接下来 AI 可能会针对这个结果进行分析 (Reasoning)，设置首行缩进标记
            isFirstReasonDeltaChunk.set(true);
        }
    }

    private String clearThink(String chunk) {
        if (chunk == null) {
            return null;
        }
        return chunk.replaceAll("(?s)<\\s*/?think\\s*>", "");
    }


    protected void printWelcome(AgentSession session) {
        final String modelName;

        if (engine.getModels().isEmpty()) {
            modelName = "no model";
        } else {
            if (session == null) {
                modelName = engine.getMainModel().getNameOrModel();
            } else {
                String modelSelected = session.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);
                modelName = engine.getModelOrMain(modelSelected).getNameOrModel();
            }
        }

        String path = new File(engine.getWorkspace()).getAbsolutePath();
        // 连带版本号，紧凑排列
        terminal.writer().println(BOLD + "GWork" + RESET + DIM + " " + AgentFlags.getVersion() + " PID-" + Utils.pid() + " Model:" + modelName + RESET);
        terminal.writer().println(DIM + path + RESET);
        terminal.writer().println(DIM + "Tips: " +
                RESET + "(esc)" + DIM + " interrupt | " +
                RESET + "/(tab)" + DIM + " command | " +
                RESET + "$(tab)" + DIM + " skill | " +
                RESET + "@(tab)" + DIM + " agent" + RESET);

        terminal.flush();
    }


    public void printWelcome(String text) {
        final String modelName;

        if (engine.getModels().isEmpty()) {
            modelName = "no model";
        } else {
            modelName = engine.getMainModel().getNameOrModel();
        }

        String path = new File(engine.getWorkspace()).getAbsolutePath();

        System.out.println(BOLD + "GWork" + RESET + DIM + " " + AgentFlags.getVersion() + " PID-" + Utils.pid() + " Model:" + modelName + RESET);
        System.out.println(DIM + path + RESET);
        System.out.println(DIM + DateUtil.format(new Date(), "yyyy-MM-dd HH:mm") + RESET);
        System.out.println(text);
        System.out.flush();
    }
}