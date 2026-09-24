package com.gourdai.core.portal.web;

import com.gourdai.agent.event.ToolCallEndEvent;
import com.gourdai.agent.event.ToolCallStartEvent;

import lombok.Getter;
import lombok.Setter;
import com.gourdai.ai.chat.LlmErrorMessages;
import com.gourdai.harness.agent.RetryEvent;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Web 通道消息块 —— 用于在 Web 门户与后端服务之间传递流式响应数据的最小单元。
 *
 * <h3>职责说明</h3>
 * <p>封装单条消息片段的类型、文本内容与相关元数据，作为 SSE / WebSocket 等推送协议的标准载荷载体。</p>
 *
 * <h3>type 类型枚举</h3>
 * <p>下表为本类实际产出的全部 type 取值，与各 {@code ofXxx} 工厂方法、以及
 * {@code WebStreamBuilder#onContextUsageEvent}（{@code context_size}）、
 * {@code SessionStreamStore#recordUser}（{@code user}）中的 {@code setType} 调用一一对应。
 * 已废弃的 {@code action} 不再产出：工具调用改由 {@code action_start} / {@code action_end} 成对表达。</p>
 * <table>
 *   <tr><th>type 值</th><th>含义</th></tr>
 *   <tr><td>{@code text}</td><td>正文增量，最终呈现给用户的回复内容</td></tr>
 *   <tr><td>{@code reason}</td><td>推理增量，模型的中间思考/分析过程（与正文同走此通道，按 isThinking 区分）</td></tr>
 *   <tr><td>{@code action_start}</td><td>工具调用开始（来源 ToolCallStartEvent），携带工具名与参数、不含结果，前端渲染 loading 骨架</td></tr>
 *   <tr><td>{@code action_end}</td><td>工具调用结束（来源 ToolCallEndEvent），填充执行结果并将工具卡转为完成/失败态</td></tr>
 *   <tr><td>{@code action_draft}</td><td>工具卡骨架（来源 ToolCallDraftEvent），模型刚说出函数名时下发，前端提前渲染骨架卡</td></tr>
 *   <tr><td>{@code action_args}</td><td>参数生成进度（来源 ToolCallArgsDeltaEvent），仅报累计字节数，更新骨架卡头部</td></tr>
 *   <tr><td>{@code action_batch}</td><td>批次声明（来源 ToolCallBatchEvent），整批工具执行前一次性下发 batchId/size/成员清单，前端据此建容器并一次性收编骨架卡</td></tr>
 *   <tr><td>{@code command}</td><td>命令文本，需前端展示或执行的命令内容</td></tr>
 *   <tr><td>{@code hitl}</td><td>人机协同中断（Human-in-the-Loop），暂停执行以等待人工审批或确认</td></tr>
 *   <tr><td>{@code question}</td><td>结构化提问（ask_user），任务挂起等待用户回答，args 携带 questions 数组</td></tr>
 *   <tr><td>{@code question_answered}</td><td>用户已提交答案，args 携带 answers 数组，供前端把问答卡转为已答态</td></tr>
 *   <tr><td>{@code rewind}</td><td>回退指令，撤销或回退之前若干步操作</td></tr>
 *   <tr><td>{@code user}</td><td>IM 通道的用户消息，在 Web 端同步展示非本端发送的用户输入</td></tr>
 *   <tr><td>{@code user_input}</td><td>后端推送的自动化任务（如 Loop 定时任务）中的用户提示词，补齐对话的用户侧消息</td></tr>
 *   <tr><td>{@code agent_start}</td><td>子代理启动信号，携带名称与任务描述（前端渲染「智能体」徽章卡片）</td></tr>
 *   <tr><td>{@code agent_end}</td><td>子代理结束信号，携带执行结果（前端将徽章卡片转为完成态）</td></tr>
 *   <tr><td>{@code steer_applied}</td><td>插话已生效：邮箱中的插话已在 Reason 边界注入 WorkingMemory</td></tr>
 *   <tr><td>{@code steer_cancelled}</td><td>插话已取消：用户主动 Stop 后残留插话被丢弃</td></tr>
 *   <tr><td>{@code steer_dropped}</td><td>插话已丢弃：任务正常结束后残留插话被转入持久化队列</td></tr>
 *   <tr><td>{@code context_size}</td><td>上下文用量，推理后依据模型真实 usage 生成（输入/输出/缓存明细），刷新「上下文长度」指示器</td></tr>
 *   <tr><td>{@code trace}</td><td>追踪信息：模型名称、token 消耗与推理耗时（最终汇总时输出）</td></tr>
 *   <tr><td>{@code retry}</td><td>模型调用失败后的自动重试提示，携带当前尝试序号、最大次数与失败原因摘要（供应商返回体真实错误）</td></tr>
 *   <tr><td>{@code file_changes}</td><td>Agent 文件变更账本事件，args 携带该 revision 的完整轻量摘要</td></tr>
 *   <tr><td>{@code done}</td><td>完成信号，当前响应流已全部发送完毕</td></tr>
 *   <tr><td>{@code error}</td><td>错误信息，处理过程中发生了异常</td></tr>
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

    // ── 相位常量（生命周期状态机）─────────────────────────────────────────────
    // 与前端 app-streaming.js 的 PHASE_* 一一对应。相位表达的是「本帧之后引擎正处于什么状态」，
    // 前端据此在帧间隙显示语义正确的等待指示器，而不再靠「静默 1 秒」猜测。

    /** 相位：等待模型响应（上一相位已结束，尚无新增量）。 */
    public static final String PHASE_WAITING = "waiting";

    /** 相位：思考增量输出中（思维链）。 */
    public static final String PHASE_THINKING = "thinking";

    /** 相位：正文增量输出中。 */
    public static final String PHASE_TEXT = "text";

    /** 相位：工具执行中（已下发 action_start，等待 action_end）。 */
    public static final String PHASE_TOOL = "tool";

    /** 相位：等待人工审批（HITL）。 */
    public static final String PHASE_HITL = "hitl";

    /** 相位：等待用户回答（ask_user 结构化问答）。 */
    public static final String PHASE_QUESTION = "question";

    /** 相位：模型调用失败自动重试中。 */
    public static final String PHASE_RETRY = "retry";

    /** 相位：本轮运行已结束。 */
    public static final String PHASE_DONE = "done";

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
     * 取值范围以类级文档中的「type 类型枚举」表为准（共 25 种，含 text / reason / action_start / action_end / action_draft / action_args / action_batch / context_size / file_changes / steer_* / user / user_input / question / question_answered 等；已废弃 action）。
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

    /**
     * 本帧是否为「挂起态收尾」：等待用户回答（ask_user）或人工审批（HITL）时，
     * 引擎流会正常结束并补发一个 done，但本轮任务并未真正完成——恢复后同一批工具的
     * 剩余帧还会回来。
     *
     * <p>前端据此区分「真结束的 done」与「因挂起而发的 done」：后者不得清空批次/卡片索引，
     * 否则恢复后同一批次会被拆成两组渲染。旧前端读不到该字段时按相位降级判断，行为不变。</p>
     */
    private Boolean suspended;

    /** 同一次模型聚合响应中可见工具卡的批次标识；旧历史或单卡为 null。 */
    private String batchId;

    /** 批次内可见工具卡的 0-based 顺序；旧历史或单卡为 null。 */
    private Integer batchIndex;

    /** 批次内实际可见工具卡数量；旧历史或单卡为 null。 */
    private Integer batchSize;

    /**
     * 批次成员清单，仅 {@code action_batch} 使用：按 batchIndex 升序的成员数组，
     * 每项含 {@code actionId} / {@code index} / {@code toolName}（无原生 id 调用的 actionId 为 null）。
     */
    private List<Map<String, Object>> batchMembers;

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

    /** 模型稳定 uid（统计归组锚点，{@code ModelDo#uidOf} 派生），trace 专用附加字段：
     * 落盘进 .stream.ndjson 与月度账本，统计页按它归组，改名前后并成一条。旧事件无此字段为 null。 */
    private String modelId;

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

    /**
     * 单轮耗时（毫秒），仅在 type 为 {@code trace} 时使用。
     *
     * <p><b>与 {@link #elapsedSeconds} 的关系</b>：同一时长的两种精度。{@code elapsedSeconds}
     * 由 {@code Duration.getSeconds()} 向下截断，历史帧一直只有它，前端「用时 28秒」徽标继续读它；
     * 本字段是未截断的原始毫秒值，供耗时详情卡计算输出速度（秒级分母在短轮次会退化成 0，无法作除数）。</p>
     *
     * <p><b>兼容性</b>：附加字段，旧历史帧反序列化为 null，前端须降级到 {@code elapsedSeconds}。</p>
     */
    private Long elapsedMs;

    /**
     * 首 Token 延迟 TTFT（毫秒），仅在 type 为 {@code trace} 时使用，可为 null。
     *
     * <p><b>口径</b>：本轮订阅时刻 → <b>第一个真正下发给用户的可见内容帧</b>（正文或思考文本）
     * 到达时刻。含排队、首包网络往返与 prompt 预填充，是用户「等了多久才看见第一个字」的体感值。</p>
     *
     * <p><b>为什么必须限定「可见」</b>：空增量帧、被过滤掉的内部工具帧（task/memory/todowrite）、
     * 以及系统在工具执行生命周期中补发的事件都不是模型吐给用户的字；把它们计入会让 TTFT
     * 被无声提前，测出一个用户根本没看到的「首字」。</p>
     *
     * <p><b>为什么不由前端自行计时</b>：前端只有实时流才有起算点，历史回放拿不到；且实时与回放
     * 两套算法必然漂移。后端在唯一出口测量并随 trace 落盘后，历史消息同样可展示。</p>
     *
     * <p><b>兼容性</b>：附加字段，本次改动之前的历史帧没有该值（null），前端须显示占位符而非 0。</p>
     */
    private Long ttftMs;

    /**
     * 模型解码时长（毫秒），仅在 type 为 {@code trace} 时使用，可为 null。
     *
     * <p><b>存在的理由</b>：这是 {@link #generatedTokens} 的<b>同口径分母</b>，专供输出速度（TPS）计算。
     * 单轮总时长 {@link #elapsedMs} 里含工具执行、审批等待、子代理调度与多次模型往返的间隙，
     * 拿它作分母算出来的既不是解码速度也不是任何可比较的吞吐量。</p>
     *
     * <p><b>口径</b>：本轮内所有<b>主代理</b>模型调用的解码段累加——每段从该次调用的首个可见输出帧
     * 起算，到该次调用的用量结算（{@code ContextUsageEvent}）止，工具执行时间天然落在段与段之间，
     * 不会被计入。</p>
     *
     * <p><b>兼容性</b>：附加字段，旧历史帧为 null；前端在缺失时不得退回总时长顶替，只能显示占位符。</p>
     */
    private Long generationMs;

    /**
     * 与 {@link #generationMs} 严格配对的输出 token 数，仅在 type 为 {@code trace} 时使用，可为 null。
     *
     * <p><b>为什么不能直接用 {@link #outputTokens}</b>：后者取自 {@code trace.getMetrics()}，是整轮累计值，
     * 且 {@code Metrics.addMetrics} 会把<b>子代理</b>的产出也并进来；子代理在自己的时间线上解码
     * （甚至并行），其 token 与主代理的解码时长没有对应关系，相除会得到虚高且不可比的数字。</p>
     *
     * <p>本字段只累加那些<b>解码段被成功计时的主代理调用</b>所产出的 token，与 {@code generationMs}
     * 同增同减，保证 TPS 的分子分母统计范围完全一致。</p>
     */
    private Long generatedTokens;

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
     * 相位标识（生命周期状态机），取值见本类 {@code PHASE_*} 常量。
     *
     * <p><b>为什么需要它：</b>引擎内部本就有完整的生命周期（思考开始/增量/结束、正文增量、
     * 工具开始/结束），但旧实现只把「增量帧」下发，边界帧一律丢弃，前端只能靠
     * 「静默 1 秒就弹思考点」来猜测状态。该猜测与相位无关，会在正文流式、工具执行、
     * 等待审批等场景一律误报为「思考中」。</p>
     *
     * <p><b>兼容性：</b>本字段是<b>附加</b>在既有帧上的，不新增 type、不改变任何已有字段语义，
     * 因此线格式与磁盘历史格式（{@code SessionStreamStore} 落盘的 ndjson）完全向后兼容：
     * 旧历史帧没有该字段（反序列化为 null），前端降级为按 type 推断相位，不会失效。</p>
     */
    private String phase;

    /**
     * 工具真实耗时（毫秒），仅 {@code action_end} 使用。
     * <p>来源 {@link ToolCallEndEvent#getDurationMs()}。旧实现从未下发该值，
     * 故前端工具卡无法显示真实执行耗时，只能自增计时。</p>
     */
    private Long durationMs;

    /**
     * 工具是否执行失败，仅 {@code action_end} 使用；为 {@code null} 或 {@code false} 表示成功。
     *
     * <p><b>存在原因：</b>旧实现在 {@code ToolCallEndEvent.getError() != null} 时直接返回
     * {@code WebChunk.EMPTY}，把失败帧整个吞掉。后果是 {@code action_start} 建出的 loading
     * 工具卡永远等不到配对的结束帧，卡片上的绿色状态点<b>永久闪烁</b>、计时器永久累加。
     * 现改为下发带本标记的 {@code action_end}，前端据此把卡片收成错误态。</p>
     */
    private Boolean failed;

    /**
     * 工具参数已生成的累计字符数，仅 {@code action_args} 使用。
     *
     * <p><b>为什么只传字节数而不传内容：</b>前端在参数生成期需要的只是「还在动、
     * 进展到哪」的进度语义；完整参数最终由 {@code action_start} 的 {@code args} 提供。
     * 不传内容同时免去了对未闭合 JSON 片段（如 {@code '{"comm'}）的容错解析。</p>
     */
    private Long argsBytes;

    /**
     * 创建「动作草稿」消息块。
     *
     * <p>type 为 {@code action_draft}，在<b>模型刚说出函数名、参数尚在流式生成时</b>下发
     * （来源于引擎的 ToolCallDraftEvent）。与 {@code action_start} 共享同一个 {@code actionId}，
     * 前端据此幂等接管同一张卡片，不会重复建卡。</p>
     *
     * <p><b>不落盘：</b>本帧为瞬态进度帧，不写入会话历史，历史回放时由
     * {@code action_start} + {@code action_end} 完整重建卡片，行为与改造前一致。</p>
     *
     * @return 不携带参数的动作草稿块（工具标识由 projectToolCommon 回填）
     */
    public static WebChunk ofActionDraft() {
        WebChunk tmp = new WebChunk();
        tmp.type = "action_draft";
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「动作参数进度」消息块。
     *
     * <p>type 为 {@code action_args}，报告某个工具调用的参数已生成多少字符。
     * 生产方已做双阈值节流（见 {@code ReasonTask}），故本帧频率可控。</p>
     *
     * <p><b>不落盘：</b>同 {@link #ofActionDraft()}。</p>
     *
     * @param argsBytes 累计已生成的参数字符数
     * @return 携带进度的动作参数块
     */
    public static WebChunk ofActionArgs(long argsBytes) {
        WebChunk tmp = new WebChunk();
        tmp.type = "action_args";
        tmp.argsBytes = argsBytes;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「批次声明」消息块。
     *
     * <p>type 为 {@code action_batch}，在<b>整批工具执行前</b>一次性下发（来源于引擎的
     * ToolCallBatchEvent）：声明 batchId / batchSize 与按 batchIndex 升序的成员清单。
     * 前端收到后立即建出批量容器，并把已存在的成员骨架卡一次性收编——消除旧链路
     * 「单卡先出 → 容器后到 → 逐张搬入」的中间态跳变。尚未建卡的成员保留空槽，
     * 由随后的 action_start / action_end 照常填充。</p>
     *
     * <p><b>不落盘：</b>本帧为瞬态帧，不写入会话历史；历史回放时由
     * action_start + action_end 携带的批次元数据完整重建分组，行为与改造前一致。</p>
     *
     * @param batchId     批次标识
     * @param batchSize   批次内可见工具卡数量
     * @param members     成员清单（按 batchIndex 升序）
     * @return 携带批次结构的动作批次声明块
     */
    public static WebChunk ofActionBatch(String batchId, Integer batchSize, List<Map<String, Object>> members) {
        WebChunk tmp = new WebChunk();
        tmp.type = "action_batch";
        tmp.batchId = batchId;
        tmp.batchSize = batchSize;
        tmp.batchMembers = members;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

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
     * <p>type 为 {@code error}，从异常链中提取最贴近根因的可读描述
     * （含 HTTP 错误响应体中的真实消息）；都取不到时才退化为简单类名，
     * 不再把裸 {@code getMessage()}（可能为 null 或仅含包装层描述）直接抛给用户。</p>
     *
     * @param err 异常对象
     * @return 携带异常描述的消息块
     */
    public static WebChunk ofError(Throwable err) {
        WebChunk tmp = new WebChunk();
        tmp.type = "error";
        tmp.text = LlmErrorMessages.describe(err);
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
     * 创建「思考已开始」信号块（不携带内容）。
     *
     * <p>type 为 {@code reason_start}。部分模型（如 Claude 系）会屏蔽思维链明文：思考真实发生、
     * 计费与耗时照常，但思考文本全程为空。而 {@code reason} 帧以「有内容」为下发前提，
     * 于是整段思考期零帧，相位停在 {@link #PHASE_WAITING}、前端持续显示「等待响应」并从头
     * 累加计时，直到正文首字才跳变——可后端早已开始响应。本帧把「思考已开始」独立于
     * 「思考有无内容」表达出来，使空思考链下相位同样能推进到 {@link #PHASE_THINKING}。</p>
     *
     * <p><b>刻意不携带 text</b>：它是纯相位信号，不是可渲染内容。前端据此切换等待指示器文案，
     * 不得据此向会话追加任何 DOM（否则历史回放会凭空多出空思考块）。</p>
     *
     * @return 不带内容的思考开始信号块
     */
    public static WebChunk ofReasonStart() {
        WebChunk tmp = new WebChunk();
        tmp.type = "reason_start";
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }


    /**
     * 创建「动作结束」消息块。
     * <p>type 为 {@code action_end}，在工具执行完成后发送（来源于引擎的 ToolCallEndEvent），
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
     * 创建「动作结束」消息块（携带工具真实耗时）。
     *
     * @param text       工具执行结果文本
     * @param durationMs 工具真实耗时（毫秒），取自 {@link ToolCallEndEvent#getDurationMs()}
     * @return 携带执行结果与耗时的动作结束消息块
     */
    public static WebChunk ofActionEnd(String text, Long durationMs) {
        WebChunk tmp = ofActionEnd(text);
        tmp.durationMs = durationMs;

        return tmp;
    }

    /**
     * 创建「动作开始」消息块。
     * <p>type 为 {@code action_start}，在工具实际执行前发送（来源于引擎的 ToolCallStartEvent），
     * 携带工具名与调用参数但不含结果。前端据此提前渲染一张 loading 状态的工具卡片骨架，
     * 待后续 {@code action_end}（来源于 ToolCallEndEvent）到达时填充结果并转为完成态。</p>
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
     * 创建「人工审批」消息块（带调用标识）。
     *
     * <p>{@code actionId} 与 {@code action_draft}/{@code action_start} 同源，前端据此把审批卡
     * 精确接管参数生成期已建的骨架卡；为 {@code null} 时（旧快照恢复的挂起任务）
     * 前端应降级为按工具名匹配。</p>
     *
     * @param toolName 需要人工审批的工具名称
     * @param command  需要人工审批的命令文本
     * @param actionId 触发审批的调用标识（可为 null）
     * @return 携带工具名、命令内容与调用标识的人机协同消息块
     */
    public static WebChunk ofHitl(String toolName, String command, String actionId) {
        WebChunk tmp = new WebChunk();
        tmp.type = "hitl";
        tmp.toolName = toolName;
        tmp.command = command;
        tmp.actionId = actionId;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /**
     * 创建「结构化提问」消息块。
     * <p>type 为 {@code question}，表示 Agent 通过 ask_user 工具向用户发起结构化提问，
     * 任务已挂起等待回答。args 携带完整的 questions 数组，供前端渲染问答卡。</p>
     *
     * <p>{@code actionId} 与触发提问的那次工具调用同源，用于识别「同一轮提问」：
     * 前端据此对重复下发的 question 帧做幂等处理（保留已作答进度，只刷新题面），
     * 不同 actionId 则视为新一轮提问。为 {@code null} 时（旧快照恢复的挂起任务）
     * 前端退化为按工具名识别。</p>
     *
     * <p>注意：ask_user 已被 {@code WebToolVisibilityPolicy} 排除在工具卡之外，
     * 参数生成期不会产生骨架卡，因此这里的 actionId 不承担「接管骨架卡」职责。</p>
     *
     * @param toolName  发起提问的工具名称（当前恒为 ask_user）
     * @param questions 结构化问题清单（每项含 header/detail/options）
     * @param actionId  触发提问的调用标识（可为 null）
     * @return 携带工具名、问题清单与调用标识的结构化提问消息块
     */
    public static WebChunk ofQuestion(String toolName, List<Map<String, Object>> questions, String actionId) {
        WebChunk tmp = new WebChunk();
        tmp.type = "question";
        tmp.toolName = toolName;
        tmp.actionId = actionId;
        tmp.createdAt = Instant.now().toEpochMilli();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("questions", questions);
        tmp.args = args;

        return tmp;
    }

    /**
     * 创建「用户已回答」消息块（带调用标识）。
     *
     * <p>{@code actionId} 与触发提问的 {@code question} 帧同源，用于把确认帧精确回到「那一道题」上：
     * 不带标识时前端只能无条件清掉当前问答卡，历史回放或多端并发下会误收【另一道题】的卡。</p>
     *
     * <p>为 {@code null} 时（旧快照恢复的挂起任务、旧前端不传标识）前端降级为旧行为。</p>
     *
     * @param toolName 发起提问的工具名称（当前恒为 ask_user）
     * @param answers  用户答案列表（每项含 index/text/skipped/custom）
     * @param actionId 本轮提问的调用标识（可为 null）
     * @return 携带工具名、答案列表与调用标识的已回答消息块
     */
    public static WebChunk ofQuestionAnswered(String toolName, List<Map<String, Object>> answers, String actionId) {
        WebChunk tmp = new WebChunk();
        tmp.type = "question_answered";
        tmp.toolName = toolName;
        tmp.actionId = actionId;
        tmp.createdAt = Instant.now().toEpochMilli();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("answers", answers);
        tmp.args = args;

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
        return ofRetry(attempt, maxRetries, null);
    }

    /**
     * 创建「重试」消息块（带失败原因）。
     * <p>原因非空时文案形如「模型调用失败，正在重试 2/20：HTTP 400: xxx」，
     * 让用户在等待重试期间就能看到供应商返回的真实错误，而非无从判断发生了什么。</p>
     *
     * @param attempt    当前是第几次尝试（从 1 开始）
     * @param maxRetries 最大尝试次数（用户配置的模型重试次数）
     * @param reason     上一次尝试的失败原因摘要，可为 null（未知）
     * @return 携带重试进度与失败原因文案的消息块
     */
    public static WebChunk ofRetry(int attempt, int maxRetries, String reason) {
        WebChunk tmp = new WebChunk();
        tmp.type = "retry";
        tmp.text = RetryEvent.formatText(attempt, maxRetries, reason);
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
        return ofAgentStart(agentName, description, null);
    }

    public static WebChunk ofAgentStart(String agentName, String description, String invocationId) {
        WebChunk tmp = new WebChunk();
        tmp.type = "agent_start";
        tmp.toolName = agentName;
        tmp.toolTitle = agentName;
        tmp.text = description;
        tmp.createdAt = Instant.now().toEpochMilli();
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("agentName", agentName);
        args.put("description", description);
        if (invocationId != null) args.put("invocationId", invocationId);
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
        return ofAgentEnd(agentName, description, success, result, null);
    }

    public static WebChunk ofAgentEnd(String agentName, String description, boolean success, String result, String invocationId) {
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
        if (invocationId != null) args.put("invocationId", invocationId);
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
     * @param outputTokens   输出 token 消耗数（整轮累计，含子代理），可为 null（无指标时）
     * @param cacheCreationTokens 缓存创建输入 token 数，可为 null
     * @param cacheReadTokens     缓存读取输入 token 数，可为 null
     * @param cacheRate      缓存命中率（百分比 0~100），可为 null
     * @param timing         单轮耗时指标快照（总时长 / TTFT / 解码段），不得为 null，无数据时传 {@link TurnTiming#EMPTY}
     * @param finalAnswer    ReAct 完成时的全量最终答复，供前端复制使用，可为 null
     * @return 携带追踪元数据的消息块
     */
    public static WebChunk ofTrace(String model, Long inputTokens, Long outputTokens,
                                   Long cacheCreationTokens, Long cacheReadTokens,
                                   Double cacheRate,
                                   TurnTiming timing, String finalAnswer) {
        return ofTrace(model, null, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
                cacheRate, timing, finalAnswer);
    }

    /** {@link #ofTrace} 的完整版：额外携带模型稳定 uid（统计归组锚点）。 */
    public static WebChunk ofTrace(String model, String modelId, Long inputTokens, Long outputTokens,
                                   Long cacheCreationTokens, Long cacheReadTokens,
                                   Double cacheRate,
                                   TurnTiming timing, String finalAnswer) {
        WebChunk tmp = new WebChunk();
        tmp.type = "trace";
        tmp.model = model;
        tmp.modelId = modelId;
        tmp.inputTokens = inputTokens;
        tmp.outputTokens = outputTokens;
        tmp.totalTokens = (inputTokens != null && outputTokens != null) ? (inputTokens + outputTokens) : null;
        tmp.cacheCreationTokens = cacheCreationTokens;
        tmp.cacheReadTokens = cacheReadTokens;
        tmp.cacheRate = cacheRate;

        TurnTiming t = (timing == null) ? TurnTiming.EMPTY : timing;
        tmp.elapsedSeconds = t.getElapsedSeconds();
        tmp.elapsedMs = t.getElapsedMs();
        tmp.ttftMs = t.getTtftMs();
        tmp.generationMs = t.getGenerationMs();
        tmp.generatedTokens = t.getGeneratedTokens();

        tmp.finalAnswer = finalAnswer;
        tmp.createdAt = Instant.now().toEpochMilli();

        return tmp;
    }

    /** 创建 Agent 文件变更账本事件；args 始终携带该 revision 的完整轻量摘要。 */
    public static WebChunk ofFileChanges(String runId, Map<String, Object> summary) {
        WebChunk tmp = new WebChunk();
        tmp.type = "file_changes";
        tmp.runId = runId;
        tmp.args = summary == null ? new LinkedHashMap<>() : new LinkedHashMap<>(summary);
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
                // 附件路径随事件下发：前端据此在插话卡上显示数量徽标，历史回放同样能还原。
                // 只传路径不传内容，卡片本身不回显缩略图。
                row.put("imagePaths", item.getImagePaths());
                row.put("filePaths", item.getFilePaths());
                serialized.add(row);
            }
        }
        args.put("count", serialized.size());
        args.put("items", serialized);
        return args;
    }
}
