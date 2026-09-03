package com.gourdai.core.portal.web;

import lombok.Getter;
import lombok.Setter;
import com.gourdai.harness.agent.RetryChunk;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Web 通道消息块 —— 用于在 Web 门户与后端服务之间传递流式响应数据的最小单元。
 *
 * <h3>职责说明</h3>
 * <p>封装单条消息片段的类型、文本内容与相关元数据，作为 SSE / WebSocket 等推送协议的标准载荷载体。</p>
 *
 * <h3>type 类型枚举</h3>
 * <table>
 *   <tr><th>type 值</th><th>含义</th></tr>
 *   <tr><td>{@code text}</td><td>普通文本输出，通常为最终呈现给用户的回复内容</td></tr>
 *   <tr><td>{@code reason}</td><td>推理过程文本，表示模型正在进行的中间思考/分析过程</td></tr>
 *   <tr><td>{@code action}</td><td>动作说明文本，描述当前正在执行的操作（如调用工具前的简要说明）</td></tr>
 *   <tr><td>{@code command}</td><td>命令文本，表示需要前端展示或执行的命令内容</td></tr>
 *   <tr><td>{@code hitl}</td><td>人机协同中断（Human-in-the-Loop），暂停执行以等待人工审批或确认</td></tr>
 *   <tr><td>{@code rewind}</td><td>回退指令，表示需要撤销或回退之前若干步操作</td></tr>
 *   <tr><td>{@code done}</td><td>完成信号，表示当前响应流已全部发送完毕</td></tr>
 *   <tr><td>{@code error}</td><td>错误信息，表示处理过程中发生了异常</td></tr>
 *   <tr><td>{@code trace}</td><td>追踪信息，包含模型名称、token 消耗和推理耗时（仅在最终汇总时输出）</td></tr>
 *   <tr><td>{@code context_size}</td><td>上下文大小信息，包含当前上下文的消息数和 token 数（每次推理前推送）</td></tr>
     *   <tr><td>{@code retry}</td><td>模型调用失败后的自动重试提示，携带当前尝试序号与最大次数（每次重试时推送）</td></tr>
     *   <tr><td>{@code agent_start}</td><td>子代理启动信号，携带子代理名称和任务描述（供前端渲染「智能体」徽章卡片）</td></tr>
     *   <tr><td>{@code agent_end}</td><td>子代理结束信号，携带执行结果（供前端将徽章卡片转为完成态）</td></tr>
     * </table>
 *
 * <h3>架构位置</h3>
 * <p>位于 {@code portal.web} 层，属于 Web 门户模块的内部传输对象（DTO），
 * 由后端 Agent 执行引擎产出，经 Web 控制器推送至前端客户端。</p>
 *
 * @author oisin
 */
@Getter
@Setter
public class WebChunk {

    /**
     * 空消息块常量，用于表示无内容的占位实例。
     * 当 type 为 {@code null} 时，{@link #isNotEmpty(WebChunk)} 将返回 {@code false}。
     */
    public static final WebChunk EMPTY = new WebChunk();

    /**
     * 判断给定消息块是否为非空（即包含有效的 type 信息）。
     *
     * @param chunk 待检测的消息块，可以为 {@code null}
     * @return 当 chunk 不为 null 且 type 已赋值时返回 {@code true}，否则返回 {@code false}
     */
    public static boolean isNotEmpty(WebChunk chunk) {
        return chunk != null && chunk.type != null;
    }


    /** 会话标识，关联到具体的用户会话上下文。 */
    private String sessionId;

    /** 运行 id（一次任务运行，一个 runId） */
    private String runId;

    /**
     * 消息块类型标识。
     * 取值范围见类级文档中的 type 类型枚举表（text / reason / action / command / hitl / rewind / done / error）。
     */
    private String type;

    /** 消息块的文本内容，具体含义由 type 决定（如正文、推理过程、命令、错误描述等）。 */
    private String text;

    /**
     * 工具原名（裸名，不含 agentName 前缀）。
     * <p>供前端做工具识别、专用渲染器匹配、特判逻辑（如 todowrite 刷新任务面板）。
     * 注意：前端显示请用 {@link #toolTitle}，识别请用本字段。</p>
     */
    private String toolName;

    /**
     * 工具调用标识：并发/并行工具执行时，前端据此将 action_start 与 action_end 精确配对、
     * 并把同一批工具归组渲染为批量卡片。HITL 批量审批时亦按此标识寻址单个调用。
     */
    private String actionId;

    /** 同一次模型聚合响应中可见工具卡的批次标识；旧历史或单卡为 null。 */
    private String batchId;

    /** 批次内可见工具卡的 0-based 顺序；旧历史或单卡为 null。 */
    private Integer batchIndex;

    /** 批次内实际可见工具卡数量；旧历史或单卡为 null。 */
    private Integer batchSize;

    /**
     * 工具显示名，仅供前端展示。
     * <p>本引擎工具时与 {@link #toolName} 相同；子代理工具时为 {@code agentName + "/" + toolName}。</p>
     */
    private String toolTitle;

    /** 工具调用参数映射，保留字段，可用于携带结构化的工具调用参数。 */
    private Map<String, Object> args;

    /** 命令内容，仅在 type 为 {@code hitl} 时使用，表示需要人工审批的命令文本。 */
    private String command;

    /** 模型名称，仅在 type 为 {@code trace} 时使用，记录本次推理使用的模型标识。 */
    private String model;

    /** 输入 token 数，仅在 type 为 {@code trace} 时使用，记录本次推理消耗的输入 token 数。 */
    private Long inputTokens;

    /** 输出 token 数，仅在 type 为 {@code trace} 时使用，记录本次推理消耗的输出 token 数。 */
    private Long outputTokens;

    /** 总 token 数，仅在 type 为 {@code trace} 时使用，记录本次推理消耗的总 token 数。 */
    private Long totalTokens;

    /** 缓存创建输入 token 数（Prompt Caching），用于 {@code trace} / {@code context_size} 展示，可为 null。 */
    private Long cacheCreationTokens;

    /** 缓存读取输入 token 数（Prompt Caching，命中缓存按折扣计费的部分），用于 {@code trace} / {@code context_size} 展示，可为 null。 */
    private Long cacheReadTokens;

    /**
     * 缓存命中率（百分比 0~100，= cacheReadTokens / inputTokens），
     * 用于 {@code trace} / {@code context_size} 展示，可为 null。
     * <p>相对于绝对值，百分比自带分母，能直接看出本轮输入有多大比例走了缓存。</p>
     */
    private Double cacheRate;

    /** 推理耗时秒数，仅在 type 为 {@code trace} 时使用，记录从 ReAct 开始到结束的耗时。 */
    private Long elapsedSeconds;

    /** 最终答案正文，仅在 type 为 {@code trace} 时使用，携带 ReAct 完成时的全量最终答复，供前端复制使用。 */
    private String finalAnswer;

    /** 会话所属工作空间根（仅 {@code user_input} 自动化任务推送时填充）：
     * 携带任务的工作空间根，供前端把执行记录登记进侧栏时直接归属到对应项目/对话区，
     * 避免误挂到用户当前所选工作空间。 */
    private String root;

    /** 客户端输入幂等标识，仅 user 事件使用；用于回放时识别已在本地渲染的用户气泡。 */
    private String clientMessageId;

    /** 消息块创建时间戳（ epoch 毫秒），由工厂方法自动填充。 */
    private Long createdAt;

    /**
     * 会话内单调递增的可恢复事件序号。实时 WebSocket 与 replay 使用同一序号，
     * 前端据此在断线重连时排他地补取并去重；旧历史事件可能没有该字段。
     */
    private Long eventSeq;

    /**
     * 创建「完成」消息块。
     * <p>type 为 {@code done}，表示当前响应流已全部发送完毕，前端收到后可结束等待状态。</p>
     *
     * @return 不携带文本内容的完成信号块
     */
    public static WebChunk ofDone() {
        WebChunk tmp = new WebChunk();
        tmp.type = "done";
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「错误」消息块（基于字符串描述）。
     * <p>type 为 {@code error}，用于向前端传递处理过程中产生的错误信息。</p>
     *
     * @param text 错误描述文本
     * @return 携带错误描述的消息块
     */
    public static WebChunk ofError(String text) {
        WebChunk tmp = new WebChunk();
        tmp.type = "error";
        tmp.text = text;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「错误」消息块（基于异常对象）。
     * <p>type 为 {@code error}，自动从异常对象中提取错误信息；
     * 若异常消息为 {@code null}，则使用 "Unknown error" 作为兜底描述。</p>
     *
     * @param err 异常对象
     * @return 携带异常描述的消息块
     */
    public static WebChunk ofError(Throwable err) {
        WebChunk tmp = new WebChunk();
        tmp.type = "error";
        tmp.text = (err.getMessage() == null ? "Unknown error" : err.getMessage());
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「普通文本」消息块。
     * <p>type 为 {@code text}，通常为最终呈现给用户的回复正文内容。</p>
     *
     * @param text 文本内容
     * @return 携带普通文本的消息块
     */
    public static WebChunk ofText(String text) {
        WebChunk tmp = new WebChunk();
        tmp.type = "text";
        tmp.text = text;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「推理过程」消息块。
     * <p>type 为 {@code reason}，表示模型正在进行的中间思考或分析过程，
     * 前端通常以折叠或特殊样式展示。</p>
     *
     * @param text 推理过程文本
     * @return 携带推理文本的消息块
     */
    public static WebChunk ofReason(String text) {
        WebChunk tmp = new WebChunk();
        tmp.type = "reason";
        tmp.text = text;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }


    /**
     * 创建「动作结束」消息块。
     * <p>type 为 {@code action_end}，在工具执行完成后发送（来源于引擎的 ObservationChunk），
     * 携带工具执行结果。与 {@code action_start} 成对：前者标记调用开始并渲染 loading 骨架，
     * 本块到达时填充结果并将工具卡转为完成态。</p>
     *
     * @param text 工具执行结果文本
     * @return 携带执行结果的动作结束消息块
     */
    public static WebChunk ofActionEnd(String text) {
        WebChunk tmp = new WebChunk();
        tmp.type = "action_end";
        tmp.text = text;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「动作开始」消息块。
     * <p>type 为 {@code action_start}，在工具实际执行前发送（来源于引擎的 ActionChunk），
     * 携带工具名与调用参数但不含结果。前端据此提前渲染一张 loading 状态的工具卡片骨架，
     * 待后续 {@code action}（来源于 ObservationChunk）到达时填充结果并转为完成态。</p>
     *
     * @param toolName  工具原名（裸名，供前端识别）
     * @param toolTitle 工具显示名（供前端展示，可含 agentName 前缀）
     * @param args      工具调用参数
     * @return 携带工具名与参数的动作开始消息块
     */
    public static WebChunk ofActionStart(String toolName, String toolTitle, Map<String, Object> args) {
        WebChunk tmp = new WebChunk();
        tmp.type = "action_start";
        tmp.toolName = toolName;
        tmp.toolTitle = toolTitle;
        tmp.args = args;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「命令」消息块。
     * <p>type 为 {@code command}，表示需要前端展示或执行的命令内容。</p>
     *
     * @param text 命令文本
     * @return 携带命令内容的消息块
     */
    public static WebChunk ofCommand(String text){
        WebChunk tmp = new WebChunk();
        tmp.type = "command";
        tmp.text = text;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「回退」消息块。
     * <p>type 为 {@code rewind}，表示需要撤销或回退之前若干步操作，
     * 前端据此调整会话上下文状态。</p>
     *
     * @param count 需要回退的步数
     * @return 携带回退步数的消息块（步数存储在 text 字段中）
     */
    public static WebChunk ofRewind(int count) {
        WebChunk tmp = new WebChunk();
        tmp.type = "rewind";
        tmp.text = String.valueOf(count);
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「用户输入」消息块。
     * <p>type 为 {@code user_input}，用于后端推送的自动化任务（如 Loop 定时任务）中，
     * 将用户提示词显示到前端对话记录中，避免对话只显示 AI 回复而无用户侧消息的问题。</p>
     *
     * @param text 用户输入文本
     * @param source 来源标识（如 "Loop"）
     * @param root 任务所属工作空间根（可为 null，null 表示全局区）
     * @return 携带用户输入文本的消息块
     */
    public static WebChunk ofUserInput(String text, String source, String root) {
        WebChunk tmp = new WebChunk();
        tmp.type = "user_input";
        tmp.text = text;
        tmp.toolName = source; // 复用 toolName 字段传递来源标识
        tmp.root = root;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「用户消息」消息块。
     * <p>type 为 {@code user}，表示来自 IM 通道的用户输入，
     * 用于在 Web 端同步展示非本端发送的用户消息。</p>
     *
     * @param text   用户发送的文本内容
     * @param source 消息来源标识（如 "WeChat"、"Feishu"、"DingTalk"）
     * @return 携带用户消息文本和来源的消息块
     */
    public static WebChunk ofUser(String text, String source) {
        WebChunk tmp = new WebChunk();
        tmp.type = "user";
        tmp.text = text;
        tmp.toolName = source;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「人机协同中断」消息块。
     * <p>type 为 {@code hitl}（Human-in-the-Loop），表示执行流程暂停，
     * 等待人工对指定工具调用进行审批或确认后才会继续执行。</p>
     *
     * @param toolName 需要人工审批的工具名称
     * @param command  需要人工审批的命令文本
     * @return 携带工具名与命令内容的人机协同消息块
     */
    public static WebChunk ofHitl(String toolName, String command) {
        WebChunk tmp = new WebChunk();
        tmp.type = "hitl";
        tmp.toolName = toolName;
        tmp.command = command;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「重试」消息块。
     * <p>type 为 {@code retry}，表示模型调用失败后正在自动重试，
     * 供前端展示「正在重试 N/M」的中间状态提示。文案已在 text 中组装完毕。</p>
     *
     * @param attempt    当前是第几次尝试（从 1 开始）
     * @param maxRetries 最大尝试次数（用户配置的模型重试次数）
     * @return 携带重试进度文案的消息块
     */
    public static WebChunk ofRetry(int attempt, int maxRetries) {
        WebChunk tmp = new WebChunk();
        tmp.type = "retry";
        tmp.text = RetryChunk.formatText(attempt, maxRetries);
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「代理启动」消息块。
     * <p>type 为 {@code agent_start}，表示子代理开始执行，
     * 供前端渲染类似 Claude Code 的「智能体」徽章卡片（loading 状态）。</p>
     *
     * @param agentName 子代理名称
     * @param description 任务描述
     * @return 携带子代理信息的启动消息块
     */
    public static WebChunk ofAgentStart(String agentName, String description) {
        WebChunk tmp = new WebChunk();
        tmp.type = "agent_start";
        tmp.toolName = agentName;
        tmp.toolTitle = agentName;
        tmp.text = description;
        tmp.createdAt = Instant.now().toEpochMilli();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("agentName", agentName);
        args.put("description", description);
        tmp.args = args;
        return tmp;
    }

    /**
     * 创建「代理结束」消息块。
     * <p>type 为 {@code agent_end}，表示子代理执行完毕，
     * 供前端将「智能体」徽章卡片转为完成态，并附带结果摘要。</p>
     *
     * @param agentName 子代理名称
     * @param description 任务描述
     * @param success 是否成功
     * @param result 执行结果摘要
     * @return 携带子代理结束信息的消息块
     */
    public static WebChunk ofAgentEnd(String agentName, String description, boolean success, String result) {
        WebChunk tmp = new WebChunk();
        tmp.type = "agent_end";
        tmp.toolName = agentName;
        tmp.toolTitle = agentName;
        tmp.text = description;
        tmp.createdAt = Instant.now().toEpochMilli();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("agentName", agentName);
        args.put("description", description);
        args.put("success", success);
        args.put("resultSummary", result != null ? result : "");
        tmp.args = args;
        return tmp;
    }

    /**
     * 创建「追踪信息」消息块。
     * <p>type 为 {@code trace}，携带模型名称、token 消耗和推理耗时等元数据，
     * 供前端以独立样式渲染，不混入回复正文。</p>
     *
     * @param model          模型名称（如 "gpt-4o"）
     * @param inputTokens    输入 token 消耗数（真实值，含缓存口径已归一），可为 null（无指标时）
     * @param outputTokens   输出 token 消耗数，可为 null（无指标时）
     * @param cacheCreationTokens 缓存创建输入 token 数，可为 null
     * @param cacheReadTokens     缓存读取输入 token 数，可为 null
     * @param cacheRate      缓存命中率（百分比 0~100），可为 null
     * @param elapsedSeconds 推理耗时（秒），可为 null（无开始时间时）
     * @param finalAnswer    ReAct 完成时的全量最终答复，供前端复制使用，可为 null
     * @return 携带追踪元数据的消息块
     */
    public static WebChunk ofTrace(String model, Long inputTokens, Long outputTokens,
                                   Long cacheCreationTokens, Long cacheReadTokens,
                                   Double cacheRate,
                                   Long elapsedSeconds, String finalAnswer) {
        WebChunk tmp = new WebChunk();
        tmp.type = "trace";
        tmp.model = model;
        tmp.inputTokens = inputTokens;
        tmp.outputTokens = outputTokens;
        tmp.totalTokens = (inputTokens != null && outputTokens != null) ? (inputTokens + outputTokens) : null;
        tmp.cacheCreationTokens = cacheCreationTokens;
        tmp.cacheReadTokens = cacheReadTokens;
        tmp.cacheRate = cacheRate;
        tmp.elapsedSeconds = elapsedSeconds;
        tmp.finalAnswer = finalAnswer;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    // ── 插话（Steer）事件工厂方法 ──────────────────────────────────────────────

    /**
     * 创建「插话已生效」消息块。
     * <p>type 为 {@code steer_applied}，表示邮箱中的插话已在当前 Reason 边界注入 WorkingMemory。</p>
     */
    public static WebChunk ofSteerApplied(String runId, java.util.List<SteerEnvelope> items) {
        WebChunk tmp = new WebChunk();
        tmp.type = "steer_applied";
        tmp.runId = runId;
        tmp.createdAt = Instant.now().toEpochMilli();
        tmp.args = buildSteerArgs(items);
        return tmp;
    }

    /**
     * 创建「插话已取消」消息块。
     * <p>type 为 {@code steer_cancelled}，表示用户主动 Stop 后残留插话被丢弃。</p>
     */
    public static WebChunk ofSteerCancelled(String runId, java.util.List<SteerEnvelope> items) {
        WebChunk tmp = new WebChunk();
        tmp.type = "steer_cancelled";
        tmp.runId = runId;
        tmp.createdAt = Instant.now().toEpochMilli();
        tmp.args = buildSteerArgs(items);
        return tmp;
    }

    /**
     * 创建「插话已丢弃」消息块。
     * <p>type 为 {@code steer_dropped}，表示任务正常结束后残留插话被转入持久化队列。</p>
     */
    public static WebChunk ofSteerDropped(String runId, java.util.List<SteerEnvelope> items) {
        WebChunk tmp = new WebChunk();
        tmp.type = "steer_dropped";
        tmp.runId = runId;
        tmp.createdAt = Instant.now().toEpochMilli();
        tmp.args = buildSteerArgs(items);
        return tmp;
    }

    private static Map<String, Object> buildSteerArgs(java.util.List<SteerEnvelope> items) {
        Map<String, Object> args = new LinkedHashMap<>();
        java.util.List<Map<String, Object>> serialized = new java.util.ArrayList<>();
        if (items != null) {
            for (SteerEnvelope item : items) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("steerId", item.getSteerId());
                row.put("text", item.getText());
                row.put("runId", item.getRunId());
                row.put("createdAt", item.getCreatedAt());
                serialized.add(row);
            }
        }
        args.put("count", serialized.size());
        args.put("items", serialized);
        return args;
    }
}
