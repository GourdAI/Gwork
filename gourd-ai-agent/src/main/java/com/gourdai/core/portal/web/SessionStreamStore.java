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
package com.gourdai.core.portal.web;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 会话流式事件存储 —— 把每轮 AI 交互的完整流式过程（推理、工具卡片、正文、trace 等）
 * 逐条落盘到 {@code <sessionId>.stream.ndjson}，供历史加载时原样回放。
 *
 * <h3>为什么需要它</h3>
 * <p>{@code <sessionId>.messages.ndjson} 只保存 harness 引擎跑完后的<b>最终 assistant 文本</b>，
 * 流式期间通过 {@link WebGate#emitToClient} 推给前端的工具调用卡片（read/edit/bash…）、
 * 中间过程叙述、思考块等都是<b>临时 UI 事件</b>，从不落盘。因此历史会话再打开时，
 * 只能看到最终一段话，看不到「做了哪些操作」。本存储在 {@code emitToClient} 处旁路捕获这些事件，
 * 使其可持久化、可回放。</p>
 *
 * <h3>落盘策略</h3>
 * <ul>
 *   <li><b>逐会话串行写</b>：每个 sessionId 一把锁，保证 ndjson 行不交错。</li>
 *   <li><b>实时粒度落盘</b>：text/reason 与其它可见事件都按实际广播粒度保存，
 *       并带会话内单调 eventSeq，保证断线后可按排他游标准确补流。</li>
 *   <li><b>存全文、传预览</b>：落盘<b>保留完整</b>工具结果（read 大文件/bash 长日志），磁盘即
 *       完整源真相、可回溯（仅保留 1MB 病态防护上限）；仅在 {@link #load} 回传前端时，对超长块
 *       截断为预览 + {@code truncated} 标记，把卡顿问题收敛在传输/渲染层，而不是靠丢数据。</li>
 *   <li><b>完整事件序列</b>：retry、done 等事件同样落盘，恢复后 UI 状态与实时展示一致。</li>
 * </ul>
 *
 * @author oisin
 * @see WebGate#emitToClient
 * @see SessionLocator
 */
public class SessionStreamStore {
    private static final Logger LOG = LoggerFactory.getLogger(SessionStreamStore.class);

    /** 流式事件文件后缀（与 messages.ndjson 并列存放） */
    public static final String STREAM_SUFFIX = ".stream.ndjson";

    /**
     * 单个块 {@code text} 落盘的<b>病态防护上限</b>（非功能性截断）。
     * <p>历史回溯要求「信息零丢失」，故正常工具结果（read 大文件、bash 长日志）一律<b>全文落盘</b>，
     * 磁盘文件即完整源真相，可回溯/导出。此上限仅用于兜底极端异常——某个工具一次吐出数百 MB
     * 会撑爆磁盘与内存。触及此限（1MB）才截断，属于不应发生的病态场景，附标记以示区分。</p>
     * <p>与传输瘦身（{@link #PREVIEW_CHARS}）是两回事：落盘存全文，仅回放<b>传输</b>时才做预览。</p>
     */
    private static final int MAX_TEXT_CHARS = 1024 * 1024;

    /** 触及病态上限时追加的提示标记（正常流程永不出现） */
    private static final String TRUNCATE_MARK = "\n…（内容超长已截断）";

    /**
     * 回放<b>传输</b>时单个块 {@code text} 的预览上限。落盘是全文，但 {@link #load} 把整个 stream 文件
     * 读回内存并作为一个 JSON 响应回传前端——若把每条数 MB 的工具结果全量传输 + 重建 DOM 会明显卡顿。
     * 故超过此长度的块在<b>返回副本</b>上截断为预览，并置 {@code truncated=true}、{@code fullLength}，
     * 前端据此展示「结果较长（N 字符）」提示。磁盘全文不受影响，始终可追溯。
     *
     * <p><b>为何是 32KB 而非更大</b>：本值同时是「单条事件体积的硬上限」。响应体总预算
     * {@link #RESPONSE_BYTE_BUDGET} 为 96KB，而预算截断必须保证<b>至少返回一条事件</b>
     * （否则单条超大事件会让分页永远返回空、前端无限重试）。32K 字符即使全为 3 字节的中日韩字符
     * 也只有 96KB，恰好不越过 smart-socket 的 ~130KB 栈溢出阈值；换成 64KB 则最坏 192KB，
     * 单条就能把响应体打爆。因此这里从 64KB 下调为 32KB，是栈溢出防线的一部分，不可随意上调。</p>
     */
    private static final int PREVIEW_CHARS = 32 * 1024;

    /**
     * 分页默认加载的<b>对话轮数</b>（一轮 = 一条 user 消息及其后的全部 AI 过程事件）。
     *
     * <p>历史分页以「轮」为首选单位，不能以 ndjson 物理行为单位：text/reason 是<b>token 级增量</b>，
     * 按行分页时切片会落在半句话中间。但轮<b>不能是唯一约束</b>，见 {@link #MAX_PAGE_EVENTS}。</p>
     */
    private static final int DEFAULT_PAGE_ROUNDS = 5;

    /**
     * 单页<b>事件数硬上限</b>（合并后的事件，不是原始行）。这是分页的<b>第一约束</b>，
     * 轮边界对齐是第二约束：能对齐就对齐，对齐不了就在轮内切，前端按 runId 缝合。
     *
     * <h3>为何必须有硬上限（实测订正）</h3>
     * <p>旧实现以「轮」为唯一单位，{@code start} 取最后一个 user 边界，这一步<b>没有任何行数保护</b>
     * （{@code MAX_PAGE_LINES} 只在「往前扩展更多轮」时才检查）。而自动化任务场景下一轮可以极大：
     * 实测某真实会话 24.3 万行事件里<b>只有 2 条 user 消息</b>，最后一轮独占 241,674 行（全文件的 99.4%）——
     * 「按轮分页」彻底退化成「全量加载」，直接导致 512m 堆 OOM。
     * 加上硬上限后，任何形态的会话打开耗时与内存占用都恒定。</p>
     *
     * <p>取 800：合并后的事件平均体积较大，800 条已能覆盖绝大多数完整对话轮，
     * 且与 {@link #RESPONSE_BYTE_BUDGET} 相乘后仍在安全水位；前端一次性构建 800 个节点无感。</p>
     */
    private static final int MAX_PAGE_EVENTS = 800;

    /**
     * 单页<b>原始行</b>扫描上限（合并前）。防止未压缩的存量文件里一页就要 parse 几十万行：
     * 即使合并后事件数不多，反序列化本身的开销也必须封顶。
     */
    private static final int MAX_PAGE_LINES = 4000;

    /**
     * 写侧增量攒批的<b>空闲超时阈值</b>（毫秒）。text/reason 是 token 级增量，实测占全部行的 99.6%，
     * 单行真实文本仅 ~8 字节而元数据（sessionId/runId/type/createdAt…）占 ~150 字节，放大近 15 倍。
     * 在内存按归属攒批、空闲后再落成一行，可把这部分放大系数直接摊薄一个数量级。
     *
     * <h3>为何是「空闲超时」而不是「固定窗口」（实测订正）</h3>
     * <p>旧实现按<b>组开启时刻</b>（{@code firstAt}）算固定 200ms 窗口。但真实会话里同归属相邻增量的
     * 到达间隔实测 <b>p50=215ms、p95=270ms、p99=361ms</b>——<b>96.3% 的间隔超过 200ms</b>，
     * 意味着几乎每一条增量到来时窗口都已过期，组被立刻落盘，合并率趋近于零。
     * 改为按<b>最后一次追加时刻</b>（{@code lastAt}）计空闲超时 500ms：只要上游还在持续吐字就一直攒，
     * 真正停下来了才落盘。实测行数降幅由 0.0% 提升到 98.4%。</p>
     *
     * <p>阈值不能太大：{@link #flush} 之外的可见性完全依赖读取前的强制冲刷，攒批期内进程被强杀
     * 才有丢失窗口（有 shutdown hook 兜底）。500ms 已安全覆盖 p99=361ms 的正常间隔，
     * 再放大到 1s 实测仅多省 0.1%，收益持平却让强杀丢失窗口翻倍，故取 500ms。</p>
     */
    private static final long DELTA_FLUSH_IDLE_MS = 500L;

    /**
     * 写侧攒批的<b>文本长度阈值</b>（字符）。与 {@link #PREVIEW_CHARS} 对齐，保证任何一条合并行的
     * text 都不会超过传输预览上限——否则合并行会在回传时被 {@link #previewForTransport} 截断，
     * 而截断块的「展开全文」依赖物理行号回指，语义上仍能工作，但白白多一次往返。
     */
    private static final int DELTA_FLUSH_CHARS = PREVIEW_CHARS;

    /**
     * 单个 replay 响应体的<b>字节预算</b>（保护性硬约束，非功能性分页）。
     *
     * <p>根因：smart-socket 的 {@code WriteBufferImpl.write} 按 {@code writeChunkSize} 递归切分写出，
     * 默认 128 字节且框架全量类零引用、不可配置。于是响应体每多 128 字节就多一层栈帧，
     * 实测任何 &gt;~130KB 的单个 HTTP 响应体必定 {@code StackOverflowError}。三方库改不了，
     * 只能从响应体侧治理：在组装返回前按累计字节数截断，超预算即停止追加并置 {@code hasMore=true}，
     * 让前端按既有分页语义继续拉下一页。</p>
     *
     * <p>取 96KB 而非贴着 130KB：留 ~25% 安全边距吸收 JSON 转义膨胀、响应包装字段与估算误差
     * （估算按 UTF-8 最坏 3 字节/字符上界，见 {@link #approxJsonBytes}，恒 ≥ 实际字节数）。</p>
     */
    private static final int RESPONSE_BYTE_BUDGET = 96 * 1024;

    /**
     * 无参全量回放（{@code /web/chat/replay} 不带 tail/rounds/afterSeq）的默认事件上限。
     *
     * <p>这是历史遗留的裸露后门：老前端不传任何分页参数时会把整个 stream 文件读回内存并一次性回传，
     * 而线上已存在 132MB 的单会话文件。字节预算只保证「不撑爆响应体」，这里再加一道
     * <b>响应事件数</b>上限：只回传尾部 N 条，与 {@code tail=N} 语义一致，不影响任何显式传
     * tail/rounds/afterSeq 的调用方。</p>
     *
     * <p>注意：它只限制<b>响应体</b>；文件解析本身仍是全量读入逐行反序列化（内存峰值不受此限制，
     * 历史大文件依赖懒压缩在多次打开后逐步瘦身）。</p>
     */
        public static final int DEFAULT_FULL_TAIL = 2000;

    /**
     * {@link #loadWithMeta} 尾部窗口的<b>字符上限</b>（与条数上限双约束，先触为准）。
     *
     * <p>只按条数圈窗口在压缩后的文件上会失效：一行合并后最大可达 {@link #PREVIEW_CHARS}，
     * 4000 行最坏就是上百 MB。取 8 倍 {@link #RESPONSE_BYTE_BUDGET} 的字符量：既足以让
     * {@code coalesceDeltas} 拿到完整的待合并区间（合并后再由预算截断），又把峰值内存钉死在
     * 百 KB 量级，与文件大小彻底解耦。</p>
     */
    private static final int WINDOW_CHAR_CAP = 8 * RESPONSE_BYTE_BUDGET;

    /**
     * 长驻 Writer 的空闲回收时限（毫秒）。Windows 上 {@code FileOutputStream} 未带 FILE_SHARE_DELETE，
     * 文件被打开期间外部的删除/替换（会话删除、用量归档搬移）会抛 AccessDeniedException。
     * 故 Writer 只在「正在流式写入」的窗口内长驻，空闲超时即由后台清扫线程冲刷并关闭，
     * 把文件占用窗口压缩到与实际写入活动一致。
     */
    private static final long WRITER_IDLE_MS = 5_000L;

    /**
     * 懒压缩的「空闲判定」时限（毫秒）：距最近一次写入不足此值即认为会话仍在流式，坚决不压缩，
     * 避免与写入竞争导致尾部被截断。
     */
    private static final long COMPACT_IDLE_MS = 10_000L;

    /** 懒压缩的收益门槛：文件行数低于此值不值得重写（收益 &lt; 一次全文件 I/O 的代价）。 */
    private static final int COMPACT_MIN_LINES = 200;

    private final SessionLocator sessionLocator;

    /**
     * 逐物理 stream 文件锁。不能只用 sessionId：不同 workspace 可以存在同名会话，
     * 反之同一文件也可能分别通过显式 root 与已绑定 root 访问。规范化绝对路径保证所有
     * 读、追加、回退与删除命中同一把锁，读取不会观察到半行或替换中间态。
     */
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    /**
     * 会话内下一事件序号缓存。Key 同时包含 sessionId 与实际存储目录，避免不同工作区
     * 使用相同 sessionId 时共享序号状态。
     */
    private final Map<String, Long> nextSequences = new ConcurrentHashMap<>();

    /**
     * 长驻追加 Writer 缓存（A1）。Key 与 {@link #locks} 同口径（规范化绝对路径），所有访问均在
     * {@code synchronized(lockFor(file))} 内完成，故本身不需额外同步。
     *
     * <p><b>为何需要</b>：旧实现每写一行就 {@code new FileOutputStream(file, true)} 一次 open-write-close，
     * 一次长任务可产生数万行，即数万次文件句柄开关 + 元数据更新，Windows 上尤其昂贵。</p>
     *
     * <p><b>Windows 文件占用约束</b>：句柄未关时 {@code Files.move}/{@code delete} 会抛 AccessDeniedException。
     * 故 {@link #delete}、{@link #rewindToMessageState}、{@link #rewindTurns} 与懒压缩替换前必须先调
     * {@link #closeWriter(File)}；另由空闲清扫线程在 {@link #WRITER_IDLE_MS} 后主动关闭，
     * 避免会话长期占着句柄阻挡外部（用量归档、手动清理）操作。</p>
     */
    private final Map<String, WriterHandle> writers = new ConcurrentHashMap<>();

    /**
     * 写侧 delta 攒批缓冲（A2）。外层 Key 为规范化绝对路径，内层按<b>归属</b>
     * （type + runId + phase + agentName）分桶，每个归属各自攒一组。
     *
     * <h3>为何从「每文件单组」改为「按归属分桶」（实测订正）</h3>
     * <p>旧实现每个物理文件只允许一个待冲组，理由是「落盘顺序即回放顺序」。但实测真实会话
     * （13 个并发 run 交错输出）里<b>每 1.12 行就发生一次归属切换</b>，而切换必须先落盘旧组——
     * 于是 <b>99.6% 的组只含 1 帧</b>，合并完全失效，84MB 文件实测压缩降幅 0.0%。
     *
     * <p>改为分桶后，时序安全由<b>同 run 因果屏障</b>保证（见 {@link #flushRun}）：
     * 写入任何非增量事件（工具卡 / trace / done / user）前，强制冲刷<b>同一个 runId</b> 的全部桶。
     * 于是同一 run 内「正文在前、工具卡在后」的因果顺序绝对不变；不同 run 之间本就是并发产生的，
     * 前端按 runId 分气泡渲染，它们在文件里的相对交错顺序不影响展示。</p>
     */
    private final Map<String, Map<String, PendingDelta>> pendings = new ConcurrentHashMap<>();

    /** 已完成（或已判定无需）懒压缩的文件，保证同一进程内幂等、不重复重写。 */
    private final Set<String> compacted = ConcurrentHashMap.newKeySet();

    /** 正在压缩中的文件，防止同一文件并发压缩。 */
    private final Set<String> compacting = ConcurrentHashMap.newKeySet();

    /** 最近一次写入时间（逐文件），供懒压缩的「会话是否仍在流式」判定与空闲 Writer 回收。 */
    private final Map<String, Long> lastWriteAt = new ConcurrentHashMap<>();

    /**
     * 懒压缩执行器：<b>单线程 + daemon</b>。单线程保证多个大文件不会同时重写把磁盘打死；
     * daemon 保证不阻碍 JVM 退出（压缩是纯优化，中途放弃不丢数据：原子替换未完成即保留原文件）。
     */
    private final ExecutorService compactPool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "stream-store-compact");
        t.setDaemon(true);
        return t;
    });

    /**
     * 攒批兼空闲 Writer 的定时清扫（daemon）。没有它时，最后一组增量在无后续帧、
     * 也无人读取的情况下会停在内存里；虽然所有 load* 入口都会先强制 flush（可见性不受影响），
     * 但落盘延迟越长，进程被强杀时的丢失窗口越大。
     */
    private final ScheduledExecutorService sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "stream-store-sweeper");
        t.setDaemon(true);
        return t;
    });

    /**
     * 进程退出兜底（A2 的最后一道防线）：JVM 正常关闭时把所有实例的待写缓冲落盘并关闭句柄。
     * 用弱引用登记，避免大量临时实例（尤其单测）被 hook 永久持有而泄漏。
     */
    private static final List<WeakReference<SessionStreamStore>> LIVE_STORES = new CopyOnWriteArrayList<>();

    static {
        Thread hook = new Thread(() -> {
            for (WeakReference<SessionStreamStore> ref : LIVE_STORES) {
                SessionStreamStore store = ref.get();
                if (store != null) {
                    try {
                        store.flushAll();
                    } catch (Throwable ignore) {
                        // 关机路径不抛异常：能冲刷多少算多少
                    }
                }
            }
        }, "stream-store-shutdown-flush");
        hook.setDaemon(false);
        try {
            Runtime.getRuntime().addShutdownHook(hook);
        } catch (Throwable ignore) {
            // 已处于关机流程中注册失败时忽略（此时也不会再产生待写数据）
        }
    }

    public SessionStreamStore(SessionLocator sessionLocator) {
        this.sessionLocator = sessionLocator;
        LIVE_STORES.add(new WeakReference<>(this));
        // 扫描周期取空闲阈值的一半：保证「真正空闲」到「实际落盘」的额外延迟不超过半个阈值，
        // 同时避免扫描过密白烧 CPU（空闲时每轮只是一次 map 遍历）。
        sweeper.scheduleWithFixedDelay(this::sweepIdle,
                DELTA_FLUSH_IDLE_MS / 2, DELTA_FLUSH_IDLE_MS / 2, TimeUnit.MILLISECONDS);
    }

    private Object lockFor(File file) {
        return locks.computeIfAbsent(pathKey(file), k -> new Object());
    }

    /** 逐文件状态（锁、Writer、攒批缓冲、压缩标记）的统一 Key 口径。 */
    private static String pathKey(File file) {
        return file == null ? "<unresolved>" : file.toPath().toAbsolutePath().normalize().toString();
    }

    /** 在当前会话写锁内分配不会因 rewind 而复用的事件序号。 */
    private long nextEventSeq(String sessionId, String projectRoot) {
        String sequenceKey = sequenceKey(sessionId, projectRoot);
        Long next = nextSequences.get(sequenceKey);
        if (next == null) {
            long max = 0;
            File file = streamFile(sessionId, projectRoot);
            if (file != null && file.exists()) {
                try (BufferedReader br = new BufferedReader(new InputStreamReader(
                        new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        try {
                            Map bean = ONode.ofJson(line.trim()).toBean(Map.class);
                            Object seq = bean.get("eventSeq");
                            if (seq instanceof Number) max = Math.max(max, ((Number) seq).longValue());
                            else if (seq != null) max = Math.max(max, Long.parseLong(String.valueOf(seq)));
                        } catch (Throwable ignore) {
                            // 兼容旧文件中的损坏行或无 eventSeq 行
                        }
                    }
                } catch (Throwable e) {
                    LOG.warn("[StreamStore] scan sequence failed for session {}: {}", sessionId, e.getMessage());
                }
            }
            next = max + 1;
        }
        nextSequences.put(sequenceKey, next + 1);
        return next;
    }

    private String sequenceKey(String sessionId, String projectRoot) {
        File file = streamFile(sessionId, projectRoot);
        return (file == null ? "" : file.getAbsolutePath()) + '\u0001' + sessionId;
    }
    public void record(String sessionId, String projectRoot, WebChunk chunk) {
        if (chunk == null || chunk.getType() == null) {
            return;
        }
        // 瞬态进度帧不落盘：action_draft / action_args / action_batch 只表达「参数正在生成」
        // 与「批次结构声明」的实时进度，一次大参数调用可产生数百帧，落盘会让历史文件与回放规模失控
        // （回放按轮分页，这些帧会把一轮撑成上千行）。历史回放时由 action_start（含完整 args）+
        // action_end 完整重建卡片与分组，因此跳过它们不会丢失任何历史信息。
        if (isEphemeralType(chunk.getType())) {
            return;
        }
        try {
            File file = streamFile(sessionId, projectRoot);
            if (file == null) return;
            synchronized (lockFor(file)) {
                chunk.setSessionId(sessionId);
                chunk.setEventSeq(nextEventSeq(sessionId, projectRoot));
                // file_changes 也走纯追加：旧实现每帧重写整个 ndjson（长会话数十 MB），
                // 而该链路同步压在 Agent 每次 write/edit/bash 的工具边界上，且与未加锁的读取路径
                // 在 Windows 下存在文件替换竞态（AccessDeniedException 会吞掉事件）。
                // 去重改由读取侧按 runId 取 eventSeq 最大者完成，见 dedupeFileChanges。
                //
                // A2：text/reason 增量不再逐帧落盘，而是进入攒批缓冲（见 offerDelta）；
                // 其它帧一律先把待冲组落盘再写自己，严格保持时序。
                if (isMergeableDelta(chunk)) {
                    offerDelta(file, sessionId, chunk);
                } else {
                    // 同 run 因果屏障：只冲刷本 run 的桶，保证「先输出的正文排在后发生的工具卡之前」；
                    // 其它 run 的桶不受影响——旧实现在这里无差别冲刷全部，并发会话下每个无关事件
                    // 都会把别的 run 刚攒的几个 token 提前切断，是合并率归零的原因之一。
                    flushRun(file, chunk.getRunId());
                    appendLine(file, sessionId, serialize(chunk));
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] record failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 是否为可写侧合并的 token 级增量帧。
     *
     * <p>只合并 {@code text}/{@code reason}：它们占实测行数的 99.6%，且前端渲染管线本就是
     * 「把同一 run 的连续增量拼进同一个气泡」，合并后回放结果逐字符等价（见单测）。
     * 超长块（已达 {@link #MAX_TEXT_CHARS} 病态上限的工具结果）不参与合并。</p>
     */
    private static boolean isMergeableDelta(WebChunk chunk) {
        String type = chunk.getType();
        if (!"text".equals(type) && !"reason".equals(type)) {
            return false;
        }
        String text = chunk.getText();
        return text != null && text.length() <= DELTA_FLUSH_CHARS;
    }

    /**
     * 是否为瞬态帧（仅实时下发、不写入历史）。
     *
     * <p>判据是「该帧的全部信息是否能由其他持久帧重建」：
     * {@code action_draft} / {@code action_args} 只携带工具名与参数字节数，
     * 而这两者在随后的 {@code action_start} 中都有（且参数是完整的）；
     * {@code action_batch} 声明的成员清单同样由随后各 start/end 帧的批次元数据重建。</p>
     */
    private static boolean isEphemeralType(String type) {
        return "action_draft".equals(type) || "action_args".equals(type) || "action_batch".equals(type);
    }

    /**
     * 读取侧收敛：同一 runId 的 file_changes 只保留 eventSeq 最大的一条（该 run 的终态摘要），
     * 保留位置为该条在原序列中的物理位置，其余同 run 的旧帧丢弃。
     *
     * <p>非 file_changes 事件、以及缺失 runId 的 file_changes 一律原样保留，顺序不变。</p>
     */
    private static List<Map> dedupeFileChanges(List<Map> src) {
        if (src == null || src.isEmpty()) {
            return src == null ? new ArrayList<>() : src;
        }
        // 第一遍：记录每个 runId 的终态所在下标（seq 相同时取靠后的物理行）
        Map<String, Integer> keepAt = new java.util.HashMap<>();
        Map<String, Long> keepSeq = new java.util.HashMap<>();
        boolean any = false;
        for (int i = 0; i < src.size(); i++) {
            Map bean = src.get(i);
            if (bean == null || !"file_changes".equals(String.valueOf(bean.get("type")))) {
                continue;
            }
            Object runId = bean.get("runId");
            if (runId == null) {
                continue;
            }
            any = true;
            String key = String.valueOf(runId);
            long seq = seqOf(bean);
            Long prev = keepSeq.get(key);
            if (prev == null || seq >= prev) {
                keepSeq.put(key, seq);
                keepAt.put(key, i);
            }
        }
        if (!any) {
            return src;
        }
        List<Map> out = new ArrayList<>(src.size());
        for (int i = 0; i < src.size(); i++) {
            Map bean = src.get(i);
            if (bean != null && "file_changes".equals(String.valueOf(bean.get("type")))) {
                Object runId = bean.get("runId");
                if (runId != null) {
                    Integer at = keepAt.get(String.valueOf(runId));
                    if (at != null && at != i) {
                        continue;
                    }
                }
            }
            out.add(bean);
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════════
    //  写侧攒批与长驻 Writer（A1 + A2）
    // ═══════════════════════════════════════════════════════════════

    /**
     * 冲刷指定会话的<b>写侧攒批缓冲</b>并把长驻 Writer 的字节推到磁盘。
     *
     * <p>旧实现是 no-op（那时每帧都独立 open-write-close，天然可见）。A2 引入内存攒批后，
     * 这个方法承担起真实的<b>可见性契约</b>：调用返回后，此前 {@link #record} 过的全部事件
     * 一定能被任意读取路径（本进程或外部进程）观察到。</p>
     *
     * <p><b>flush 纪律</b>（缺一不可，否则会出现「刚输出的内容回放不到」）：</p>
     * <ul>
     *   <li>所有 {@code load*} / {@code loadFull} / {@code exists} 之外的读取入口，进锁后第一件事
     *       就是 {@link #ensureVisible(File)}；</li>
     *   <li>{@code delete} / {@code rewind*} / 懒压缩替换文件前，先 {@link #closeWriter(File)}
     *       （含冲刷），否则 Windows 下文件被占用会让 move/delete 直接失败；</li>
     *   <li>攒批组达时间/长度阈值、归属切换、非增量帧到达时立即落盘；</li>
     *   <li>空闲清扫线程兜底冲刷超时组；JVM 正常退出时由 shutdown hook 冲刷全部实例。</li>
     * </ul>
     */
    public void flush(String sessionId, String projectRoot) {
        File file = streamFile(sessionId, projectRoot);
        if (file == null) {
            return;
        }
        synchronized (lockFor(file)) {
            ensureVisible(file);
        }
    }

    /**
     * 让该物理文件的全部已记录事件对读取可见：先把攒批组落成一行，再把 Writer 缓冲推给操作系统。
     * <b>必须在 {@code lockFor(file)} 内调用</b>（synchronized 可重入，读取路径可安全嵌套调用）。
     */
    private void ensureVisible(File file) {
        flushPending(file);
        flushWriter(file);
    }

    /**
     * 把当前攒批组（若有）序列化为<b>一行</b>写出。返回是否确实写出了一行。
     *
     * <p>时序保证：本方法是「写新帧之前」的强制前置动作，故合并行在文件中的位置恒为该组
     * <b>首帧原本应在</b>的位置，绝不会跳到后续的工具卡/trace 之后。</p>
     */
    /**
     * 把该文件<b>全部</b>攒批桶落盘。返回是否确实写出过行。
     *
     * <p>用于「必须看到全部已记录内容」的场景（读取前的 {@link #ensureVisible}、
     * 文件替换前、进程退出前）。写新帧前的时序保障请用粒度更细的 {@link #flushRun}。</p>
     */
    private boolean flushPending(File file) {
        Map<String, PendingDelta> byOwner = pendings.remove(pathKey(file));
        if (byOwner == null || byOwner.isEmpty()) {
            return false;
        }
        // 按组开启时刻排序落盘：同一批多个 run 的桶一起冲刷时，保持与它们真实开始的先后顺序一致，
        // 而不是 HashMap 的任意遍历序（同一 run 内的因果顺序由 flushRun 保证，此处只求稳定可预期）。
        List<PendingDelta> ordered = new ArrayList<>(byOwner.values());
        ordered.sort((a, b) -> Long.compare(a.firstAt, b.firstAt));
        boolean wrote = false;
        for (PendingDelta pending : ordered) {
            appendLine(file, pending.sessionId, pending.toLine());
            wrote = true;
        }
        return wrote;
    }

    /**
     * <b>同 run 因果屏障</b>：把指定 {@code runId} 名下的全部攒批桶落盘。
     *
     * <p>在写入任何<b>非增量</b>事件（工具卡 / trace / done / agent_* 等）之前调用，
     * 保证同一 run 内「先输出的正文」永远排在「后发生的工具卡」之前。不碰其它 run 的桶，
     * 因此并发会话的合并率不会被无关 run 的事件抹平——这正是旧「单组」实现失效的根源。</p>
     *
     * <p>{@code runId} 为 null 时退化为冲刷全部桶：无归属事件无法判定因果范围，保守处理。</p>
     */
    private boolean flushRun(File file, String runId) {
        if (runId == null) {
            return flushPending(file);
        }
        String key = pathKey(file);
        Map<String, PendingDelta> byOwner = pendings.get(key);
        if (byOwner == null || byOwner.isEmpty()) {
            return false;
        }
        List<PendingDelta> hit = new ArrayList<>();
        for (PendingDelta pending : byOwner.values()) {
            if (runId.equals(pending.head.getRunId())) {
                hit.add(pending);
            }
        }
        if (hit.isEmpty()) {
            return false;
        }
        hit.sort((a, b) -> Long.compare(a.firstAt, b.firstAt));
        for (PendingDelta pending : hit) {
            byOwner.remove(ownerKey(pending.head));
            appendLine(file, pending.sessionId, pending.toLine());
        }
        if (byOwner.isEmpty()) {
            pendings.remove(key);
        }
        return true;
    }

    /**
     * 接纳一帧可合并增量：并入<b>同归属的桶</b>（没有则新建），达阈值立即落盘。
     * <b>必须在 {@code lockFor(file)} 内调用</b>。
     *
     * <p>不同归属不再互相驱逐：多个 run / 主对话与子代理 / reason 与 text 可并行攒批，
     * 各自按空闲超时独立落盘。</p>
     */
    private void offerDelta(File file, String sessionId, WebChunk chunk) {
        String key = pathKey(file);
        Map<String, PendingDelta> byOwner = pendings.computeIfAbsent(key, k -> new LinkedHashMap<>());
        String owner = ownerKey(chunk);
        PendingDelta pending = byOwner.get(owner);
        // 先判后加（与压缩侧 acceptForCompact 同口径）：装不下本帧就先把已攒的落盘。
        // 若改成“先追加再判 buf >= 阈值”，落盘行长度必定落在
        // [DELTA_FLUSH_CHARS, DELTA_FLUSH_CHARS + 末帧长度) —— 而 DELTA_FLUSH_CHARS == PREVIEW_CHARS，
        // 于是每一个攒满的桶都恰好越过预览阈值一点点，回放时被 previewForTransport
        // 当成“超长工具结果”截掉并标 truncated（实测：4 万字正文落盘首行 32800 字符，
        // 回放只剩 32767 + “内容超长已截断”）。正常流式正文不应走截断语义。
        boolean rolled = false;
        if (pending != null && chunk.getText() != null
                && pending.buf.length() + chunk.getText().length() > DELTA_FLUSH_CHARS) {
            byOwner.remove(owner);
            appendLine(file, pending.sessionId, pending.toLine());
            pending = null;
            rolled = true;
        }
        if (pending == null) {
            // 同 run 内严格单桶：开新桶前先把本 run 名下其它归属的桶落盘。
            // 跨 run 仍允许多桶并行（子代理与主对话不互相驱逐，这是合并率的来源），
            // 但同一 run 内 text↔reason、相位切换必须断批：否则两个桶并存时，
            // 后到的 text 会被追加进早已开的那个 text 桶，落盘后回放出“两段正文粘连、
            // 中间的思考被挤到后面”的串位时序。
            // 同归属超长切行（rolled）不算归属切换，无需断其它桶的批
            if (!rolled) {
                flushSameRunOtherOwners(file, byOwner, chunk.getRunId(), owner);
            }
            pending = new PendingDelta(sessionId, chunk);
            byOwner.put(owner, pending);
        } else {
            pending.append(chunk);
        }
        // 长度超限立即落盘；时间维度改由空闲超时驱动（见 sweepIdle），
        // 不再在每次追加时按「组开启时刻」判过期——后者正是合并率归零的直接原因。
        if (pending.shouldFlushBySize()) {
            byOwner.remove(owner);
            if (byOwner.isEmpty()) {
                pendings.remove(key);
            }
            appendLine(file, pending.sessionId, pending.toLine());
        }
    }

    /**
     * 把指定 run 名下、归属键不等于 {@code keepOwner} 的桶全部落盘（按开组时刻排序）。
     *
     * <p>只移除条目、不动整张表，调用方手里的 {@code byOwner} 引用始终有效。
     * {@code runId} 为 null 时与其它无归属桶相匹配，同样断批（无法判定因果范围时保守处理）。</p>
     */
    private void flushSameRunOtherOwners(File file, Map<String, PendingDelta> byOwner,
                                         String runId, String keepOwner) {
        if (byOwner.isEmpty()) {
            return;
        }
        List<PendingDelta> hit = new ArrayList<>();
        for (Map.Entry<String, PendingDelta> entry : byOwner.entrySet()) {
            if (keepOwner.equals(entry.getKey())) {
                continue;
            }
            if (eq(runId, entry.getValue().head.getRunId())) {
                hit.add(entry.getValue());
            }
        }
        if (hit.isEmpty()) {
            return;
        }
        hit.sort((a, b) -> Long.compare(a.firstAt, b.firstAt));
        for (PendingDelta stale : hit) {
            byOwner.remove(ownerKey(stale.head));
            appendLine(file, stale.sessionId, stale.toLine());
        }
    }

    /** 归属键：type + runId + phase + agentName 四元组，与 {@code sameDeltaOwner} 读侧口径一致。 */
    private static String ownerKey(WebChunk chunk) {
        Object agent = chunk.getArgs() == null ? null : chunk.getArgs().get("agentName");
        return String.valueOf(chunk.getType()) + '\u0001'
                + String.valueOf(chunk.getRunId()) + '\u0001'
                + String.valueOf(chunk.getPhase()) + '\u0001'
                + String.valueOf(agent);
    }

    /**
     * 空闲清扫：冲刷超过时间阈值的攒批组、关闭长期空闲的 Writer。
     *
     * <p>纯兜底职责——正常路径由归属切换、长度阈值与读取前的强制冲刷驱动。没有它时，
     * 一轮对话最后一组增量会停在内存里直到下次读取；虽不影响正确性（读取必先冲刷），
     * 但会拉长「进程被强杀」时的数据丢失窗口，也让文件句柄被无谓长期占用。</p>
     */
    private void sweepIdle() {
        long now = System.currentTimeMillis();
        for (String key : new ArrayList<>(pendings.keySet())) {
            Map<String, PendingDelta> byOwner = pendings.get(key);
            if (byOwner == null || byOwner.isEmpty()) {
                continue;
            }
            File file = new File(key);
            synchronized (lockFor(file)) {
                try {
                    // 重取：进锁前可能已被其它路径冲刷或移除
                    Map<String, PendingDelta> live = pendings.get(key);
                    if (live == null || live.isEmpty()) {
                        continue;
                    }
                    // 只落盘真正空闲超时的桶；仍在持续接收增量的桶继续攒，不被无关桶连坐。
                    List<PendingDelta> due = new ArrayList<>();
                    for (PendingDelta pending : live.values()) {
                        if (pending.shouldFlushByIdle(now)) {
                            due.add(pending);
                        }
                    }
                    if (!due.isEmpty()) {
                        due.sort((a, b) -> Long.compare(a.firstAt, b.firstAt));
                        for (PendingDelta pending : due) {
                            live.remove(ownerKey(pending.head));
                            appendLine(file, pending.sessionId, pending.toLine());
                        }
                        if (live.isEmpty()) {
                            pendings.remove(key);
                        }
                        flushWriter(file);
                    }
                } catch (Throwable e) {
                    LOG.warn("[StreamStore] sweep flush failed for {}: {}", key, e.getMessage());
                }
            }
        }
        for (String key : new ArrayList<>(writers.keySet())) {
            WriterHandle handle = writers.get(key);
            if (handle == null || now - handle.lastUsed < WRITER_IDLE_MS) {
                continue;
            }
            File file = new File(key);
            synchronized (lockFor(file)) {
                // 关闭前再冲刷一次：清扫与写入之间可能刚好插入了新帧
                flushPending(file);
                closeWriter(file);
            }
        }
    }

    /** 冲刷本实例的全部待写缓冲（shutdown hook 用）。 */
    private void flushAll() {
        for (String key : new ArrayList<>(pendings.keySet())) {
            File file = new File(key);
            synchronized (lockFor(file)) {
                flushPending(file);
            }
        }
        for (String key : new ArrayList<>(writers.keySet())) {
            File file = new File(key);
            synchronized (lockFor(file)) {
                closeWriter(file);
            }
        }
    }

    /** 取得（或懒建）该文件的长驻追加 Writer。<b>必须在 {@code lockFor(file)} 内调用</b>。 */
    private WriterHandle writerFor(File file) throws java.io.IOException {
        String key = pathKey(file);
        WriterHandle handle = writers.get(key);
        if (handle != null) {
            return handle;
        }
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) {
            dir.mkdirs();
        }
        // 8KB 缓冲：单行平均 ~160 字节，约 50 行一次系统调用，既显著削减 write 次数，
        // 又不至于在进程异常终止时积压过多未落盘数据。
        handle = new WriterHandle(new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(file, true), StandardCharsets.UTF_8), 8192));
        writers.put(key, handle);
        return handle;
    }

    /** 把 Writer 缓冲推给操作系统（不关闭句柄）。<b>必须在 {@code lockFor(file)} 内调用</b>。 */
    private void flushWriter(File file) {
        WriterHandle handle = writers.get(pathKey(file));
        if (handle == null) {
            return;
        }
        try {
            handle.writer.flush();
        } catch (Throwable e) {
            LOG.warn("[StreamStore] flush writer failed for {}: {}", file.getName(), e.getMessage());
            closeWriter(file);   // 自愈：丢弃坏句柄，下次写入自动重建
        }
    }

    /**
     * 幂等地关闭并移除该文件的长驻 Writer。<b>必须在 {@code lockFor(file)} 内调用</b>。
     *
     * <p>凡是要对文件做 move/delete/replace 的路径（{@link #delete}、{@code rewind*}、懒压缩）
     * 都必须先调它：Windows 的 {@code FileOutputStream} 不带 FILE_SHARE_DELETE，
     * 句柄未关时替换/删除会抛 AccessDeniedException，且异常会被 catch 吞掉，表现为「回退没生效」。</p>
     */
    private void closeWriter(File file) {
        WriterHandle handle = writers.remove(pathKey(file));
        if (handle == null) {
            return;
        }
        try {
            handle.writer.close();
        } catch (Throwable e) {
            LOG.warn("[StreamStore] close writer failed for {}: {}", file.getName(), e.getMessage());
        }
    }

    /** 长驻 Writer 及其最近使用时间（空闲回收依据）。 */
    private static final class WriterHandle {
        final Writer writer;
        long lastUsed;

        WriterHandle(Writer writer) {
            this.writer = writer;
            this.lastUsed = System.currentTimeMillis();
        }
    }

    /**
     * 内存中正在累积的一组同归属 token 增量。
     *
     * <h3>eventSeq 语义（A2 的核心难点，务必理解后再改）</h3>
     * <p>实时广播给前端的帧仍是<b>逐条</b>的（各自带自增 eventSeq），而落盘合并后一行代表 [seqFrom, eventSeq]
     * 这一整个区间。前端断线重连走 {@code recoverStreamingSession}（app-streaming.js:903），
     * 它对返回的每条事件调用 {@code applySequencedGateChunk}（:879），后者只做
     * 「seq &lt;= lastEventSeq 则丢弃，否则 {@code dispatchGateChunk} 追加渲染」——
     * 是<b>直接 append 续接</b>，不是「重置当前气泡后重放」（气泡重置只发生在 app-history.js 的整页回放路径）。</p>
     * <p>因此若断线发生在组中间（前端已收到 seq=30，重连请求 afterSeq=30，而磁盘合并行是 [2,50]），
     * 直接按 {@code eventSeq=50 > 30} 返回整行，2..30 的文本会被<b>二次追加</b>，用户看到重复正文。
     * 落盘 {@code seqFrom} 正是为了让 {@link #loadAfter} 能识别这种「跨游标的边界组」并保守处理。</p>
     * <p>向后兼容：{@code seqFrom} 仅在组含多帧时写出；旧文件没有该字段，读取侧按
     * {@code seqFrom = eventSeq}（单帧组）处理，语义与旧行为完全一致。</p>
     */
    private static final class PendingDelta {
        final String sessionId;
        final WebChunk head;          // 组内首帧，充当元数据模板（type/runId/phase/args/createdAt）
        final StringBuilder buf;
        final long seqFrom;           // 组内首条 eventSeq（区间左端，闭区间）
        final long firstAt;           // 组开启时刻，用于多桶共同落盘时的稳定排序
        long lastAt;                  // 最后一次追加时刻，空闲超时的基准
        long seqTo;                   // 组内末条 eventSeq（区间右端，闭区间）

        PendingDelta(String sessionId, WebChunk head) {
            this.sessionId = sessionId;
            this.head = head;
            this.buf = new StringBuilder(head.getText() == null ? "" : head.getText());
            this.seqFrom = head.getEventSeq() == null ? 0L : head.getEventSeq();
            this.seqTo = this.seqFrom;
            this.firstAt = System.currentTimeMillis();
            this.lastAt = this.firstAt;
        }

        void append(WebChunk chunk) {
            if (chunk.getText() != null) {
                buf.append(chunk.getText());
            }
            if (chunk.getEventSeq() != null) {
                seqTo = chunk.getEventSeq();
            }
            lastAt = System.currentTimeMillis();
        }

        /** 长度达阈：立即落盘，与时间无关。 */
        boolean shouldFlushBySize() {
            return buf.length() >= DELTA_FLUSH_CHARS;
        }

        /**
         * 空闲超时：距<b>最后一次追加</b>超过 {@link #DELTA_FLUSH_IDLE_MS} 无新内容。
         * 注意基准是 {@code lastAt} 而非 {@code firstAt}——后者（固定窗口）会在上游持续吐字时
         * 把组提前切断，实测使合并率归零。
         */
        boolean shouldFlushByIdle(long now) {
            return buf.length() > 0 && (now - lastAt) >= DELTA_FLUSH_IDLE_MS;
        }

        /** 序列化为落盘行：text 为整组拼接结果，eventSeq 取组内末条，多帧组额外带 seqFrom。 */
        String toLine() {
            head.setText(buf.toString());
            head.setEventSeq(seqTo);
            if (seqFrom == seqTo) {
                // 单帧组与旧格式逐条落盘完全一致，不写 seqFrom，省字节也省去读取侧特判
                return serialize(head);
            }
            ONode node = ONode.ofBean(head);
            node.set("text", buf.toString());
            node.set("eventSeq", seqTo);
            node.set("seqFrom", seqFrom);
            return node.toJson();
        }

        private static Object agentNameOf(Map<String, Object> args) {
            return args == null ? null : args.get("agentName");
        }
    }

    /**
     * 直接记录一条用户输入事件（网页手动输入不走 emitToClient）。
     */
    public void recordUser(String sessionId, String projectRoot, String text, long createdAt) {
        recordUser(sessionId, projectRoot, text, createdAt, null);
    }

    public void recordUser(String sessionId, String projectRoot, String text, long createdAt, String clientMessageId) {
        if (text == null) {
            return;
        }
        try {
            File file = streamFile(sessionId, projectRoot);
            if (file == null) return;
            synchronized (lockFor(file)) {
                WebChunk uc = new WebChunk();
                uc.setType("user");
                uc.setText(text);
                uc.setSessionId(sessionId);
                uc.setCreatedAt(createdAt);
                uc.setClientMessageId(clientMessageId);
                uc.setEventSeq(nextEventSeq(sessionId, projectRoot));
                // user 是轮边界（loadRounds 依赖它分页），必须先把攒批组落盘，
                // 否则合并行会排到用户消息之后，翻页时上一轮的正文会跑到下一轮开头。
                flushPending(file);
                appendLine(file, sessionId, serialize(uc));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] recordUser failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 增量加载 eventSeq 大于 afterSeq 的事件。afterSeq 为排他游标，供断线重连补流。
     *
     * <h3>与写侧合并（A2）的交互：边界组的保守处理</h3>
     * <p>写侧合并后一行代表 {@code [seqFrom, eventSeq]} 区间。前端的
     * {@code applySequencedGateChunk}（app-streaming.js:879）是<b>直接 append 续接</b>：
     * 只按 {@code seq <= lastEventSeq} 丢弃整帧，不会重置气泡。因此当断线点落在组中间
     * （{@code seqFrom <= afterSeq < eventSeq}）时，整行回传会把前端<b>已渲染过</b>的
     * {@code [seqFrom, afterSeq]} 那段文本再追加一遍，用户看到重复正文。</p>
     * <p>处理方式：对这种<b>跨游标边界组整组跳过</b>，但仍把 {@code latestSeq} 推进到它的右端（不丢游标）。
     * 宁可丢掉该组末尾几十个 token（后续正文仍会续上，且下次打开历史会完整回放），
     * 也绝不能默默产生重复文本——后者是不可逆的内容损伤，前者只是瞬时的少量缺失。
     * 旧文件无 {@code seqFrom} 字段时视为单帧组（{@code seqFrom = eventSeq}），永远不会命中此分支，
     * 行为与改造前完全一致。</p>
     */
    public LoadResult loadAfter(String sessionId, String projectRoot, long afterSeq, Integer limit) {
        LoadResult result = new LoadResult();
        File file = streamFile(sessionId, projectRoot);
        if (file == null) return result;
        int max = limit == null || limit <= 0 ? 500 : Math.min(limit, 2000);
        try {
            synchronized (lockFor(file)) {
                // flush 纪律：先把攒批中的增量落盘，否则刚输出的内容回放不到。
                ensureVisible(file);
                if (!file.exists()) return result;
                int budget = 0;
                try (BufferedReader br = new BufferedReader(new InputStreamReader(
                        new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    int lineNo = 0;
                    while ((line = br.readLine()) != null) {
                        lineNo++;
                        try {
                            Map bean = ONode.ofJson(line.trim()).toBean(Map.class);
                            result.totalCount++;
                            Object rawSeq = bean.get("eventSeq");
                            if (rawSeq == null) continue;
                            long seq = rawSeq instanceof Number ? ((Number) rawSeq).longValue() : Long.parseLong(String.valueOf(rawSeq));
                            result.latestSeq = Math.max(result.latestSeq, seq);
                            if (seq <= afterSeq) continue;
                            // 跨游标的合并边界组：整组跳过，绝不重复渲染已显示过的文本
                            if (seqFromOf(bean) <= afterSeq) continue;
                            if (result.events.size() >= max) {
                                result.hasMore = true;
                                continue;
                            }
                            previewForTransport(bean, lineNo);
                            // 响应体字节预算（A4）：超预算即停止追加，但必须至少返回一条
                            int size = approxJsonBytes(bean);
                            if (!result.events.isEmpty() && budget + size > RESPONSE_BYTE_BUDGET) {
                                result.hasMore = true;
                                continue;
                            }
                            budget += size;
                            result.events.add(bean);
                            if (result.firstSeq == 0) result.firstSeq = seq;
                            result.lastSeq = seq;
                        } catch (Throwable ignore) {
                            // 跳过已完整落盘但损坏的历史行；读锁保证不会把正在追加的半行误判为损坏。
                        }
                    }
                    if (!result.events.isEmpty() && result.lastSeq < result.latestSeq) result.hasMore = true;
                    // 同一 run 的 file_changes 只留终态摘要（写入侧已改为纯追加）；不影响游标与分页元信息。
                    // A3：补上读侧合并。旧文件（逐条落盘）补流时同样能受益；合并只在物理相邻、
                    // 同归属的块之间发生，且 eventSeq 推进到组内最后一条（与写侧口径一致），
                    // 而 firstSeq/lastSeq/hasMore 已在合并前按原始事件算好，游标推进不受影响。
                    result.events = dedupeFileChanges(coalesceDeltas(result.events));
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] loadAfter failed for session {}: {}", sessionId, e.getMessage());
        }
        return result;
    }
    /**
     * 读取指定会话已落盘的全部流式事件（供 {@code /web/chat/replay} 回放）。
     *
     * <p>对超过预览上限的文本仅在传输副本上截断，磁盘仍保留完整事件。</p>
     */
    public List<Map> load(String sessionId, String projectRoot) {
        return loadWithMeta(sessionId, projectRoot, null).events;
    }

    /**
     * 带分页元信息的加载方法。
     *
     * @param sessionId   会话标识
     * @param projectRoot code 会话项目根
     * @param tail        若不为 null，只取最后 tail 条事件；null 表示全量加载
     * @return 包含事件列表、总数和 hasMore 标记的加载结果
     */
    public LoadResult loadWithMeta(String sessionId, String projectRoot, Integer tail) {
        LoadResult result = new LoadResult();
        File file = streamFile(sessionId, projectRoot);
        if (file == null) {
            return result;
        }
        synchronized (lockFor(file)) {
            ensureVisible(file);   // flush 纪律：读前必须看到攒批中的数据
            if (!file.exists()) {
                return result;
            }
            try {
                /* 尾部快照语义：只需要最后 N 条。旧实现把整个文件反序列化进 List<Map> 再切尾部，
                   84MB 文件实测约 250MB 堆（24 万个 HashMap），直接把 512m 堆打爆。
                   改为「定长环形窗口」流式读取：窗口只保留最后 N 条，逐行读过即弃，
                   峰值内存为 O(N) 与文件大小无关。tail 为空时用 DEFAULT_FULL_TAIL 兜底
                   （该入口本就只回传尾部，见其常量注释）。 */
                int want = (tail != null && tail > 0) ? tail : DEFAULT_FULL_TAIL;
                // 多取一些原始行：coalesceDeltas 会把多行合并成一条，先按行攒够再合并，
                // 避免合并后不足 want 条。系数 4 足以覆盖压缩后文件的合并比。
                int rawCap = Math.max(want, Math.min(MAX_PAGE_LINES, want * 4));
                /* 环里存<b>原始行字符串</b>而非反序列化后的 Map：窗口外的行（85MB 样本里是 45.4 万行
                   中的 45.0 万行）压根不会被返回，为它们各建一个 HashMap 纯属浪费——实测全量 parse
                   耗时 1656ms、堆增量 100MB，而只 parse 窗口内那几千行后降到百毫秒级。
                   同时按<b>条数 + 字节</b>双约束驱逐：只按条数约束时，4000 条压缩行最坏可达上百 MB。 */
                String[] ring = new String[rawCap];
                int[] lineNos = new int[rawCap];
                long ringBytes = 0;
                int head = 0;      // 环内最旧一条的下标（相对 total 的绝对序号）
                int total = 0;
                try (BufferedReader br = new BufferedReader(new InputStreamReader(
                        new FileInputStream(file), StandardCharsets.UTF_8), 1 << 16)) {
                    String line;
                    int lineNo = 0;
                    while ((line = br.readLine()) != null) {
                        lineNo++;
                        String trimmed = line.trim();
                        if (trimmed.isEmpty()) {
                            continue;
                        }
                        // latestSeq 必须覆盖全文件（含被窗口丢弃的头部），否则断线补流游标会退化。
                        // rawEventSeq 是纯字符串扫描，不建对象，跑全文件也廉价。
                        long seq = rawEventSeq(trimmed);
                        if (seq > 0 && seq > result.latestSeq) {
                            result.latestSeq = seq;
                        }
                        int slot = total % rawCap;
                        if (total - head >= rawCap) {
                            // 条数溢出：环自然覆盖最旧一条，把它的字节一并扣除
                            ringBytes -= ring[slot] == null ? 0 : ring[slot].length();
                            head = total - rawCap + 1;
                        }
                        ring[slot] = trimmed;
                        lineNos[slot] = lineNo;
                        ringBytes += trimmed.length();
                        total++;
                        // 字节溢出：从最旧一侧逐出，直到回到预算内（至少保留一条）
                        while (ringBytes > WINDOW_CHAR_CAP && head < total - 1) {
                            int drop = head % rawCap;
                            ringBytes -= ring[drop] == null ? 0 : ring[drop].length();
                            ring[drop] = null;
                            head++;
                        }
                    }
                }
                result.totalCount = total;
                int keep = total - head;
                List<Map> window = new ArrayList<>(Math.max(0, keep));
                for (int i = head; i < total; i++) {
                    int slot = i % rawCap;
                    String raw = ring[slot];
                    if (raw == null) {
                        continue;
                    }
                    try {
                        Map bean = ONode.ofJson(raw).toBean(Map.class);
                        previewForTransport(bean, lineNos[slot]);
                        window.add(bean);
                    } catch (Throwable ignore) {
                        // 跳过损坏行；统一文件锁保证这里不会读到正在追加或替换的半行
                    }
                }
                List<Map> merged = dedupeFileChanges(coalesceDeltas(window));
                // hasMore 有三个独立来源，任一成立即为真：环形窗口丢过更早的行、tail 截断、
                // 字节预算截断。必须先合并前两者再交给 capToBudgetFromTail（它只会把 false 置 true），
                // 否则预算截断刚置上的标记会被后面的赋值无条件抹掉，前端以为已到顶而停止翻页。
                boolean dropped = total > keep;
                if (merged.size() > want) {
                    merged = new ArrayList<>(merged.subList(merged.size() - want, merged.size()));
                    dropped = true;
                }
                result.hasMore = dropped;
                result.events = capToBudgetFromTail(merged, result);
                // firstSeq/lastSeq 按<b>实际回传</b>的事件算，与返回体口径一致
                if (!result.events.isEmpty()) {
                    result.firstSeq = seqFromOf(result.events.get(0));
                    result.lastSeq = seqOf(result.events.get(result.events.size() - 1));
                }
                scheduleCompactIfWorthwhile(file, sessionId, projectRoot);
            } catch (Throwable e) {
                LOG.warn("[StreamStore] load failed for session {}: {}", sessionId, e.getMessage());
            }
        }
        return result;
    }

    /**
     * 按<b>对话轮</b>分页加载历史事件（供「显示之前的 N 条消息」向上翻页）。
     *
     * <h3>分页约束的优先级（实测订正后的核心设计）</h3>
     * <ol>
     *   <li><b>事件数硬上限优先</b>（{@link #MAX_PAGE_EVENTS} / {@link #MAX_PAGE_LINES}）：
     *       先用行数窗口圈定「最多读这么多」，保证任何形态的会话打开耗时与内存占用都恒定。</li>
     *   <li><b>轮边界对齐次之</b>：在窗口内尽量把页首对齐到 user 轮边界；对齐不了就在轮内切，
     *       由前端按 {@code runId} 缝合（缝合逻辑已存在）。</li>
     * </ol>
     *
     * <p><b>为何不能只按轮分页</b>：旧实现以轮为唯一单位，{@code start} 取最后一个 user 边界，
     * 这一步没有任何行数保护。而自动化任务场景下「一轮」可以极大——实测某真实会话 24.3 万行事件里
     * <b>只有 2 条 user 消息</b>，最后一轮独占 241,674 行（全文件的 99.4%），于是「按轮分页」
     * 退化为「全量加载」，直接撑爆 512m 堆。</p>
     *
     * <h3>两遍流式扫描（峰值内存与文件大小解耦）</h3>
     * <p>第一遍 {@link #scanForPage} 只记录「轮边界行号+字节偏移」「尾部窗口起点偏移」等
     * <b>轻量索引</b>，逐行读过即弃，<b>绝不把文件内容驻留进堆</b>；第二遍按字节偏移 seek 到页首，
     * 只反序列化本页那几百行。旧实现是整文件读进 {@code List<String>}（84MB 文件约占 180MB 堆）
     * 再全量 parse，这正是 OOM 与「越点越慢」的直接原因。</p>
     *
     * @param sessionId   会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param beforeSeq   游标：只取 eventSeq 严格小于它的事件；null 表示从尾部开始
     * @param rounds      本页期望的对话轮数；null/&lt;=0 用 {@link #DEFAULT_PAGE_ROUNDS}
     * @return 本页事件（已按 runId 合并 token 增量）与轮次元信息
     */
    public LoadResult loadRounds(String sessionId, String projectRoot, Long beforeSeq, Integer rounds) {
        LoadResult result = new LoadResult();
        File file = streamFile(sessionId, projectRoot);
        if (file == null) {
            return result;
        }
        int wantRounds = (rounds == null || rounds <= 0) ? DEFAULT_PAGE_ROUNDS : rounds;
        try {
            synchronized (lockFor(file)) {
            ensureVisible(file);   // flush 纪律：点开会话时必须能看到刚刚的输出
            if (!file.exists()) {
                return result;
            }

            // ── 第一遍：流式扫描，只建轻量索引，不驻留行内容 ──
            PageScan scan = scanForPage(file, beforeSeq);
            result.totalCount = scan.totalLines;
            result.totalRounds = scan.boundLines.size();
            result.latestSeq = scan.latestSeq;
            if (scan.endLine <= 1) {
                // 游标已经指到文件最前面，没有更早的内容了
                return result;
            }

            // ── 起点决策：硬上限窗口优先，轮边界对齐次之 ──
            int startLine = scan.windowStartLine;
            long startOffset = scan.windowStartOffset;
            // 在窗口 [windowStartLine, endLine) 内挑轮边界：取能容纳 wantRounds 轮的最早那个。
            // 窗口内没有任何边界时保持 windowStartLine（轮内切，交给前端缝合）。
            int lastBound = -1;
            int pickIdx = -1;
            for (int i = 0; i < scan.boundLines.size(); i++) {
                int bl = scan.boundLines.get(i);
                if (bl >= scan.windowStartLine && bl < scan.endLine) {
                    if (pickIdx < 0) {
                        pickIdx = i;
                    }
                    lastBound = i;
                }
            }
            // 轮边界优先、行数兜底。
            //
            // 「一轮 = 一条用户消息 + 其后全部 AI 过程」这个分页前提对自动化长任务并不成立：
            // 实测 53171 行的会话只有 1 个 user 边界，464700 行的只有 3 个——整个会话就是一轮。
            // 但轮对齐仍是默认契约（页首落在 user 行上，用户看到的是完整对话），不得为了
            // 塔满一页而破坏它；只有当扫描窗口<b>确实被填满</b>（即 endLine 已超过
            // MAX_PAGE_LINES，windowStartLine > 1）时，才说明前面确实堆着大量内容、
            // 而轮边界又稀疏得切不出有效页 —— 此时才退化为按行切。
            //
            // 小文件（窗口未满）恒走轮对齐：否则三轮对话会被一页全返回，
            // 用户点「加载更早」时本该逐轮展开的内容一次涌出，反而丢了分页语义。
            if (pickIdx >= 0 && lastBound >= pickIdx) {
                int avail = lastBound - pickIdx + 1;
                int take = Math.min(wantRounds, avail);
                int chosen = lastBound - take + 1;
                int boundStart = scan.boundLines.get(chosen);
                // 窗口未被填满（小文件/翻到接近开头）时恒用轮对齐：此时没有"被浪费的扫描"，
                // 强行改按行切只会把本该逐轮展开的内容一次全吐出去，丢掉分页语义。
                boolean windowSaturated = scan.windowStartLine > 1;
                // 轮边界能覆盖窗口的 1/4 以上就算有效页；低于此说明边界过于稀疏
                // （自动化长任务整段只有一个 user 行），退化为按行切，避免每页只吐几行。
                boolean boundPageUsable = (scan.endLine - boundStart)
                        >= (scan.endLine - scan.windowStartLine) / 4;
                if (!windowSaturated || boundPageUsable) {
                    startLine = boundStart;
                    startOffset = scan.boundOffsets.get(chosen);
                }
            }

            // ── 第二遍：seek 到页首，只反序列化本页 ──
            List<Map> page = new ArrayList<>();
            // bean -> 物理行号的旁路表。不能改用 bean 里的 seq 字段：那个字段只在文本超
            // PREVIEW_CHARS 被截断时才注入（语义是“可回指拉全文”），普通事件压根没有，
            // 拿不到就会退回 fallback 把页首误判成第 1 行，hasMore 恒为 false（翻页入口直接消失）；
            // 而无条件给每条都注入 seq 又会让前端以为任意块都可展开。故行号只做服务端旁路记账。
            java.util.IdentityHashMap<Map, Integer> lineOfBean = new java.util.IdentityHashMap<>();
            try (BufferedReader br = openAt(file, startOffset)) {
                String line;
                int lineNo = startLine - 1;
                while ((line = br.readLine()) != null) {
                    lineNo++;
                    if (lineNo >= scan.endLine) {
                        break;
                    }
                    String trimmed = line.trim();
                    if (trimmed.isEmpty()) {
                        continue;
                    }
                    try {
                        Map bean = ONode.ofJson(trimmed).toBean(Map.class);
                        previewForTransport(bean, lineNo);   // seq 用物理行号（1 起），供展开全文回指
                        page.add(bean);
                        lineOfBean.put(bean, lineNo);
                    } catch (Throwable ignore) {
                        // 跳过损坏行
                    }
                }
            }

            List<Map> merged = dedupeFileChanges(coalesceDeltas(page));

            // ── 事件数上限：合并后仍超限就只保尾部（向上翻页语义，页尾紧邻用户视口必须保留）──
            if (merged.size() > MAX_PAGE_EVENTS) {
                merged = new ArrayList<>(merged.subList(merged.size() - MAX_PAGE_EVENTS, merged.size()));
            }
            // ── 字节预算：保尾丢头，且至少返回一条 ──
            merged = capToBudgetFromHead(merged);

            result.events = merged;
            result.firstSeq = merged.isEmpty() ? 0 : seqFromOf(merged.get(0));
            result.lastSeq = merged.isEmpty() ? 0 : seqOf(merged.get(merged.size() - 1));

            // ── 本页真实起点（物理行号）：用于 hasMore 与剩余轮数，口径必须与返回体一致 ──
            int pageFirstLine = startLine;
            if (!merged.isEmpty()) {
                Integer ln = lineOfBean.get(merged.get(0));
                pageFirstLine = (ln != null) ? ln : lineNoOf(merged.get(0), startLine);
            }
            result.hasMore = pageFirstLine > 1;
            // 无 eventSeq 的旧数据给不出可用游标：继续翻页会让前端把同一页反复 prepend，
            // 碎片成倍堆叠。此时宁可收起加载入口。
            if (result.firstSeq <= 0) {
                result.hasMore = false;
            }
            // 剩余轮数按「本页首行所属的那一轮」计，而不是按首行行号直接数。
            // 字节预算反向截断可能把本轮的 user 行丢掉（单条正文即超预算的极长回答），
            // 但该轮内容已经部分呈现给用户，再把它算进“未加载”会多报一轮。
            int ownerBound = pageFirstLine;
            for (int i = 0; i < scan.boundLines.size(); i++) {
                int bl = scan.boundLines.get(i);
                if (bl > pageFirstLine) {
                    break;
                }
                ownerBound = bl;
            }
            int remaining = 0;
            for (int i = 0; i < scan.boundLines.size(); i++) {
                if (scan.boundLines.get(i) < ownerBound) {
                    remaining++;
                }
            }
            // 轮边界不足时改按「剩余页数」估算，而不是报个恒定的小数字。
            // 自动化长任务会话实测只有 1~3 个 user 边界，原口径下 remainingRounds 恒为 2，
            // 不论用户翻了多少页都一直显示「还有 2 条」，既无信息量又像卡住了。
            // 此时用未加载物理行数 / 本页行数 估算还需几页，下限 1（hasMore 为真即至少还有一页）。
            if (remaining <= 0 && result.hasMore) {
                int pageLines = Math.max(1, scan.endLine - pageFirstLine);
                remaining = Math.max(1, (pageFirstLine - 1) / pageLines);
            }
            result.remainingRounds = remaining;
            scheduleCompactIfWorthwhile(file, sessionId, projectRoot);
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] loadRounds failed for session {}: {}", sessionId, e.getMessage());
        }
        return result;
    }

    /**
     * 第一遍流式扫描的产物：只含轻量索引，<b>不持有任何行内容</b>。
     * 内存占用为 O(轮数 + 窗口行数)，与文件大小无关。
     */
    private static final class PageScan {
        int totalLines;
        long latestSeq;
        /** 本页独占上界（物理行号，1 起）：游标命中行，或文件末尾+1。 */
        int endLine;
        /** 尾部窗口起点（= endLine - MAX_PAGE_LINES，下限 1）及其字节偏移。 */
        int windowStartLine = 1;
        long windowStartOffset;
        final List<Integer> boundLines = new ArrayList<>();
        final List<Long> boundOffsets = new ArrayList<>();
    }

    /**
     * 流式扫描文件，建立分页所需的最小索引。
     *
     * <p>用定长环形缓冲记录「最近 {@link #MAX_PAGE_LINES} 行的字节偏移」，
     * 一旦确定 {@code endLine} 就能 O(1) 取出窗口起点偏移，无需回头重扫，也无需驻留行内容。</p>
     */
    private static PageScan scanForPage(File file, Long beforeSeq) throws java.io.IOException {
        PageScan scan = new PageScan();
        final int cap = MAX_PAGE_LINES + 1;
        long[] ring = new long[cap];
        boolean endFound = false;
        long offset = 0;
        int lineNo = 0;
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8), 1 << 16)) {
            String line;
            while ((line = br.readLine()) != null) {
                lineNo++;
                // 只在游标命中前维护环：命中后 endLine 已定，窗口起点 ws = endLine - MAX_PAGE_LINES
                // 的槽位必须冻结。扫描不会在 endLine 处停止（仍要统计 totalLines/latestSeq/轮边界
                // 直到文件末尾），若继续写环，第 ws + cap 行就会把 ws 的偏移覆盖成一个
                // 远在 endLine 之后的位置 —— 于是第二遍 seek 直接跳到游标后方，向上翻页
                // 反而取回更新的内容，firstSeq 不降反升，前端永远翻不完（实测：12000 行会话
                // 翻页三次拿到的都是尾部同一批，每次 firstSeq 只 +1）。
                if (!endFound) {
                    ring[lineNo % cap] = offset;
                }
                if (!line.isEmpty()) {
                    long seq = rawEventSeq(line);
                    if (seq > 0) {
                        if (seq > scan.latestSeq) {
                            scan.latestSeq = seq;
                        }
                        if (beforeSeq != null && !endFound && seq >= beforeSeq) {
                            scan.endLine = lineNo;
                            endFound = true;
                        }
                    }
                    if (isRoundBoundary(line)) {
                        scan.boundLines.add(lineNo);
                        scan.boundOffsets.add(offset);
                    }
                }
                // 行首字节偏移递推：内容字节数 + 1 个 '\n'（appendLine 恒写 '\n'）
                offset += utf8Length(line) + 1;
            }
        }
        scan.totalLines = lineNo;
        if (!endFound) {
            scan.endLine = lineNo + 1;
        }
        int ws = Math.max(1, scan.endLine - MAX_PAGE_LINES);
        scan.windowStartLine = ws;
        scan.windowStartOffset = (scan.endLine - ws) >= cap ? 0L : ring[ws % cap];
        return scan;
    }

    /** 打开文件并把读游标定位到指定<b>字节</b>偏移（行首）。 */
    private static BufferedReader openAt(File file, long offset) throws java.io.IOException {
        FileInputStream fis = new FileInputStream(file);
        try {
            long remaining = offset;
            while (remaining > 0) {
                long skipped = fis.skip(remaining);
                if (skipped <= 0) {
                    break;
                }
                remaining -= skipped;
            }
        } catch (java.io.IOException e) {
            try { fis.close(); } catch (java.io.IOException ignore) { /* 关闭失败不掩盖原异常 */ }
            throw e;
        }
        return new BufferedReader(new InputStreamReader(fis, StandardCharsets.UTF_8), 1 << 16);
    }

    /** 计算字符串的 UTF-8 字节长度，<b>不分配中间数组</b>（扫描热路径，24 万行不产生 GC 压力）。 */
    private static int utf8Length(String s) {
        int n = 0;
        for (int i = 0, len = s.length(); i < len; i++) {
            char c = s.charAt(i);
            if (c < 0x80) {
                n += 1;
            } else if (c < 0x800) {
                n += 2;
            } else if (Character.isHighSurrogate(c) && i + 1 < len
                    && Character.isLowSurrogate(s.charAt(i + 1))) {
                n += 4;
                i++;
            } else {
                n += 3;
            }
        }
        return n;
    }

    /** 取事件的物理行号（{@link #previewForTransport} 注入的 {@code seq}）；缺失时回退给定默认值。 */
    private static int lineNoOf(Map bean, int fallback) {
        Object v = bean == null ? null : bean.get("seq");
        if (v instanceof Number) {
            return ((Number) v).intValue();
        }
        return fallback;
    }

    /**
     * 按 {@link #RESPONSE_BYTE_BUDGET} 截断，<b>保留尾部</b>（从后往前累加，丢弃最早的）。
     * 向上翻页语义：页尾紧邻用户当前视口必须保留，被丢的头部由下一页继续拉取。
     * 与 {@link #capToBudgetFromTail} 方向相同但不改写 {@code LoadResult}，供 loadRounds 专用。
     */
    private static List<Map> capToBudgetFromHead(List<Map> events) {
        if (events.isEmpty()) {
            return events;
        }
        int budget = 0;
        int from = events.size();
        for (int i = events.size() - 1; i >= 0; i--) {
            int size = approxJsonBytes(events.get(i));
            // 至少保留一条：单条即超预算时也必须返回，否则前端拿到空页会无限重试
            if (from < events.size() && budget + size > RESPONSE_BYTE_BUDGET) {
                break;
            }
            budget += size;
            from = i;
        }
        return from > 0 ? new ArrayList<>(events.subList(from, events.size())) : events;
    }

    /**
     * 合并相邻的 token 级增量（{@code text}/{@code reason}）为整段文本。
     *
     * <p>回放渲染管线本就是把同一 runId 的连续增量拼进同一个气泡，逐条回传只是把「拼接」
     * 的成本转嫁给传输与 DOM：实测 15383 行里 14190 行是增量，合并后事件数降一个数量级，
     * 回放耗时与响应体同步下降。</p>
     *
     * <p>合并的安全边界：只合并<b>物理相邻</b>、同 type、同 runId、同归属智能体的块；
     * 中间只要夹了任何其它事件（工具卡片、trace…）即断开，保证时序与原样回放一致。
     * 合并后的文本长度受 {@link #PREVIEW_CHARS} 约束，超出即另起一条，
     * 因此永不触发 {@link #previewForTransport} 的截断（截断块带物理行号 seq，合并后无法回指）。</p>
     */
    private static List<Map> coalesceDeltas(List<Map> src) {
        if (src == null || src.isEmpty()) {
            return src == null ? new ArrayList<>() : src;
        }
        List<Map> out = new ArrayList<>();
        Map open = null;              // 当前正在累积的合并块
        StringBuilder buf = null;
        for (int i = 0; i < src.size(); i++) {
            Map bean = src.get(i);
            if (bean == null) {
                continue;
            }
            Object typeObj = bean.get("type");
            String type = typeObj == null ? "" : String.valueOf(typeObj);
            boolean mergeable = ("text".equals(type) || "reason".equals(type))
                    && !Boolean.TRUE.equals(bean.get("truncated"))
                    && bean.get("text") instanceof String;

            if (mergeable && open != null
                    && sameDeltaOwner(open, bean)
                    && buf.length() + ((String) bean.get("text")).length() <= PREVIEW_CHARS) {
                buf.append((String) bean.get("text"));
                // 游标推进到组内最后一条，避免断线重连时重复补发已合并的增量；
                // 同时保留区间左端 seqFrom（取 open 已有的），让下游仍能辨识这是一个区间而非单点。
                if (bean.get("eventSeq") != null) {
                    open.put("eventSeq", bean.get("eventSeq"));
                }
                continue;
            }

            if (open != null) {
                open.put("text", buf.toString());
                open = null;
                buf = null;
            }
            if (mergeable) {
                open = bean;
                buf = new StringBuilder((String) bean.get("text"));
                // 开组时固定区间左端：本身已是合并行就沿用它的 seqFrom，否则用自己的 eventSeq。
                // 这保证「写侧已合并 + 读侧再合并」后，seqFrom 仍指向真正的第一个 token，
                // loadAfter 的边界组判定才不会漏判。
                long from = seqFromOf(bean);
                if (from > 0) {
                    bean.put("seqFrom", from);
                }
            }
            out.add(bean);
        }
        if (open != null) {
            open.put("text", buf.toString());
        }
        return out;
    }

    /** 两个增量块是否属于同一渲染目标（同 run、同相位、同归属智能体）。与写侧
     *  {@code PendingDelta.sameOwner} 保持同口径，保证「写侧已合并」与「读侧再合并」结果一致。 */
    private static boolean sameDeltaOwner(Map a, Map b) {
        if (!eq(a.get("type"), b.get("type")) || !eq(a.get("runId"), b.get("runId"))) {
            return false;
        }
        if (!eq(a.get("phase"), b.get("phase"))) {
            return false;
        }
        return eq(agentNameOf(a), agentNameOf(b));
    }

    /**
     * 取一条事件代表的 seq 区间<b>左端</b>（闭区间）。
     *
     * <p>写侧合并行携带 {@code seqFrom}（组内首条 seq）；单帧行与<b>旧格式文件</b>没有该字段，
     * 此时区间退化为 {@code [eventSeq, eventSeq]}，与改造前语义完全一致——这就是向后兼容的全部成本。</p>
     */
    private static long seqFromOf(Map bean) {
        Object raw = bean == null ? null : bean.get("seqFrom");
        if (raw instanceof Number) {
            return ((Number) raw).longValue();
        }
        if (raw != null) {
            try {
                return Long.parseLong(String.valueOf(raw));
            } catch (NumberFormatException ignore) {
                // 损坏值：退回 eventSeq
            }
        }
        return seqOf(bean);
    }

    /**
     * 估算一条事件序列化后占用的响应体字节数（A4 的预算计量器）。
     *
     * <p>仍是<b>上界估算</b>而非真序列化（真序列化要把每条多转一遍 JSON，一页 800 条就是 800 次），
     * 栈溢出防护只需要「不超」的保证。但「不低估」不等于可以随意高估：</p>
     *
     * <p><b>为何必须用 {@link #utf8Length} 精确计长，而不能按 3 字节/字符拍脑袋</b>：
     * 旧实现对 text 一律按 UTF-8 最坏情况（中日韩 3 字节/字符）计价，而真实内容里
     * 代码块、路径、JSON、英文叙述都是 1 字节/字符 —— 实测 125MB 会话单页真实序列化
     * 只有 32~38KB 就被判定占满 96KB 预算，<b>预算利用率仅 1/3</b>。后果不是「安全」而是
     * 用户每页只能拿到本该拿到的三分之一：2191 行的会话（整个文件都装得进 4000 行扫描窗口）
     * 竟要翻 176 页。估高一样是缺陷，只是它以「加载不出来」而非崩溃的形式暴露。</p>
     *
     * <p>{@code utf8Length} 逐字符分支计长，对纯 ASCII 恰为 1 字节/字符、中日韩恰为 3、
     * 代理对恰为 4，是精确值而非估算；仍保留 512 字节固定开销覆盖其它字段
     * （sessionId/runId/toolName…）与 JSON 结构字符，保证整体不低估。</p>
     */
    private static int approxJsonBytes(Map bean) {
        if (bean == null) {
            return 0;
        }
        int bytes = 512;
        Object text = bean.get("text");
        if (text instanceof String) {
            bytes += utf8Length((String) text);
        }
        Object args = bean.get("args");
        if (args instanceof Map) {
            for (Object v : ((Map<?, ?>) args).values()) {
                bytes += v instanceof String ? utf8Length((String) v) : 64;
            }
        }
        return bytes;
    }

    /**
     * 按 {@link #RESPONSE_BYTE_BUDGET} 截断事件列表，<b>保留列表尾部</b>（从后往前累加，
     * 丢弃最早的若干条）。
     *
     * <p><b>为何必须保尾而非保头</b>：本方法只服务于 {@link #loadWithMeta}，其语义是
     * 「会话快照 = 最近 tail 条」——前端初始加载/断线重连都从响应尾部续接实时流。
     * 若保头丢尾，用户打开会话看到的是<b>最旧</b>的一页、最新回复整段消失，且该入口没有
     * 向前补页的游标，丢失不可恢复。向上翻页的 {@link #loadRounds} 语义相反（保尾丢头），
     * 其截断内联实现，不与本方法共用。</p>
     *
     * <p><b>至少返回一条</b>（{@code i < size-1} 条件）：否则单条超大事件会导致永远返回空列表，
     * 前端看到 hasMore 又拉不到东西，陷入无限重试。超大单条已由 {@link #previewForTransport}
     * 截到 {@link #PREVIEW_CHARS}（最坏 96KB），仍在栈溢出阈值以下。</p>
     */
    private static List<Map> capToBudgetFromTail(List<Map> events, LoadResult result) {
        if (events == null || events.isEmpty()) {
            return events == null ? new ArrayList<>() : events;
        }
        int budget = 0;
        for (int i = events.size() - 1; i >= 0; i--) {
            budget += approxJsonBytes(events.get(i));
            if (budget > RESPONSE_BYTE_BUDGET && i < events.size() - 1) {
                result.hasMore = true;
                return new ArrayList<>(events.subList(i + 1, events.size()));
            }
        }
        return events;
    }

    private static Object agentNameOf(Map bean) {
        Object args = bean.get("args");
        return (args instanceof Map) ? ((Map) args).get("agentName") : null;
    }

    private static boolean eq(Object a, Object b) {
        return a == null ? b == null : a.equals(b);
    }

    private static long seqOf(Map bean) {
        Object raw = bean == null ? null : bean.get("eventSeq");
        if (raw instanceof Number) {
            return ((Number) raw).longValue();
        }
        try {
            return raw == null ? 0 : Long.parseLong(String.valueOf(raw));
        } catch (NumberFormatException ignore) {
            return 0;
        }
    }

    /**
     * 不做 JSON 反序列化地取出一行的 {@code eventSeq}（分页扫描要跑全文件，全量 parse 太浪费）。
     * 取不到时返回 0，调用方按「无序号的旧行」处理。
     */
    private static long rawEventSeq(String line) {
        int at = line.indexOf("\"eventSeq\":");
        if (at < 0) {
            return 0;
        }
        int i = at + 11;
        int n = line.length();
        while (i < n && (line.charAt(i) == ' ' || line.charAt(i) == '"')) {
            i++;
        }
        long v = 0;
        boolean any = false;
        while (i < n && line.charAt(i) >= '0' && line.charAt(i) <= '9') {
            v = v * 10 + (line.charAt(i) - '0');
            any = true;
            i++;
        }
        return any ? v : 0;
    }

    /**
     * 是否为一轮对话的起始边界。{@code user}（网页手输）与 {@code user_input}（定时任务推送）
     * 在前端回放里都渲染成用户气泡，故都算边界。
     *
     * <p>与 {@link #isUserLine} 分开：后者服务于 rewind 的回退语义，口径改动会影响回退轮数。</p>
     */
    private static boolean isRoundBoundary(String line) {
        if (line == null) {
            return false;
        }
        if (line.indexOf("\"type\":\"user\"") < 0 && line.indexOf("\"type\":\"user_input\"") < 0) {
            return false;
        }
        try {
            String type = ONode.ofJson(line).get("type").getString();
            return "user".equals(type) || "user_input".equals(type);
        } catch (Throwable ignore) {
            return false;
        }
    }

    /**
     * Bean 形态的轮边界判定（服务于 loadRounds 的截断吸附）。
     *
     * <p>user 事件不是可合并增量，在 {@link #coalesceDeltas} 后仍独立成条，故合并列表里的
     * user bean 与物理行一一对应，可直接用 type 字段判定，无需再序列化回 JSON。</p>
     */
    private static boolean isRoundBoundaryBean(Map bean) {
        Object type = bean == null ? null : bean.get("type");
        return "user".equals(type) || "user_input".equals(type);
    }

    public static class LoadResult {
        public List<Map> events = new ArrayList<>();
        public int totalCount;
        public boolean hasMore;
        public long firstSeq;
        public long lastSeq;
        public long latestSeq;
        /** 会话内的对话轮总数（user 消息条数） */
        public int totalRounds;
        /** 本页之前尚未加载的对话轮数（供「显示之前的 N 条消息」计数） */
        public int remainingRounds;
    }

    /**
     * 传输层预览瘦身：若事件的 {@code text} 超过 {@link #PREVIEW_CHARS}，就地截断返回副本的 text，
     * 并注入 {@code truncated=true}、{@code fullLength}（原始全长）与 {@code seq}（物理行号，供前端
     * 回指拉取全文）供前端提示与展开。仅作用于回传的 Map 副本，磁盘行不变。未超限的块原样返回。
     */
    @SuppressWarnings("unchecked")
    private static void previewForTransport(Map bean, int seq) {
        if (bean == null) {
            return;
        }
        Object t = bean.get("text");
        if (!(t instanceof String)) {
            return;
        }
        String text = (String) t;
        if (text.length() <= PREVIEW_CHARS) {
            return;
        }
        bean.put("text", text.substring(0, PREVIEW_CHARS)
                + "\n…（结果较长，已折叠预览前 " + (PREVIEW_CHARS / 1024) + "KB，共 " + text.length() + " 字符）");
        bean.put("truncated", Boolean.TRUE);
        bean.put("fullLength", text.length());
        bean.put("seq", seq);
    }

    /**
     * 按物理行号 {@code seq} 回取单个块的<b>完整 text 全文</b>（供前端对被预览截断的块
     * “点击展开”时按需拉取）。{@code seq} 由 {@link #load} 注入，与文件物理行（1 起）一一对应。
     *
     * @param sessionId   会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param seq         目标行号（{@link #load} 回传的 {@code seq}）
     * @return 该块的完整 text；行号越界、行无 text 或文件缺失时返回 null
     */
    public String loadFull(String sessionId, String projectRoot, int seq) {
        if (seq <= 0) return null;
        File file = streamFile(sessionId, projectRoot);
        if (file == null) return null;
        synchronized (lockFor(file)) {
            ensureVisible(file);   // flush 纪律：攒批未落盘时行号会对不上
            if (!file.exists()) return null;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                String line;
                int lineNo = 0;
                while ((line = br.readLine()) != null) {
                    lineNo++;
                    if (lineNo < seq) continue;
                    if (lineNo > seq) break;
                    String trimmed = line.trim();
                    if (trimmed.isEmpty()) return null;
                    return ONode.ofJson(trimmed).get("text").getString();
                }
            } catch (Throwable e) {
                LOG.warn("[StreamStore] loadFull failed for session {} seq {}: {}", sessionId, seq, e.getMessage());
            }
        }
        return null;
    }

    /**
     * 判断指定会话是否已有流式事件文件（有则回放，无则回退旧的纯文本加载）。
     */
    public boolean exists(String sessionId, String projectRoot) {
        File file = streamFile(sessionId, projectRoot);
        return file != null && file.exists();
    }

    /**
     * 按 messages.ndjson 裁剪后的真实状态裁剪富 stream。
     *
     * @param retainedUserCount messages 文件中保留下来的 user 消息数
     * @param trailingUserOnly  保留消息是否以 user 结尾；为 true 时只保留该 user 边界本身，
     *                          删除其后尚未形成 assistant 消息的流式过程
     */
    public void rewindToMessageState(String sessionId, String projectRoot,
                                     int retainedUserCount, boolean trailingUserOnly) {
        File file = streamFile(sessionId, projectRoot);
        if (file == null) return;
        try {
            synchronized (lockFor(file)) {
                // 先把攒批落盘再关句柄：不冲刷会丢掉本轮末尾文本（可能正是要保留的部分），
                // 不关句柄则 Windows 下 {@code Files.move}/{@code deleteIfExists} 会抛 AccessDeniedException，
                // 异常被下方 catch 吞掉，表现为「回退静默失败」。
                ensureVisible(file);
                closeWriter(file);
                if (!file.exists()) return;
                List<String> lines = readNonEmptyLines(file);
                List<Integer> userBounds = new ArrayList<>();
                for (int i = 0; i < lines.size(); i++) {
                    if (isUserLine(lines.get(i))) userBounds.add(i);
                }

                if (retainedUserCount <= 0 || userBounds.isEmpty()) {
                    Files.deleteIfExists(file.toPath());
                    return;
                }

                int cutExclusive;
                if (trailingUserOnly) {
                    if (retainedUserCount > userBounds.size()) return;
                    cutExclusive = userBounds.get(retainedUserCount - 1) + 1;
                } else if (retainedUserCount < userBounds.size()) {
                    cutExclusive = userBounds.get(retainedUserCount);
                } else {
                    return; // 全部现有轮次均有对应 assistant，stream 无需裁剪
                }
                replaceWithPrefix(file.toPath(), lines, cutExclusive);
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] rewindToMessageState failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /** 兼容旧调用：按完整用户轮次回退。 */
    public void rewindTurns(String sessionId, String projectRoot, int turns) {
        if (turns <= 0) turns = 1;
        File file = streamFile(sessionId, projectRoot);
        if (file == null) return;
        try {
            synchronized (lockFor(file)) {
                ensureVisible(file);   // 同 rewindToMessageState：先落盘再释放句柄，否则 Windows 下删不掉
                closeWriter(file);
                if (!file.exists()) return;
                List<String> lines = readNonEmptyLines(file);
                int totalUsers = 0;
                for (String line : lines) if (isUserLine(line)) totalUsers++;
                int retained = Math.max(0, totalUsers - turns);
                if (retained == 0) Files.deleteIfExists(file.toPath());
                else rewindToMessageState(sessionId, projectRoot, retained, false);
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] rewindTurns failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    private static List<String> readNonEmptyLines(File file) throws java.io.IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (!line.trim().isEmpty()) lines.add(line);
            }
        }
        return lines;
    }

    private static void replaceWithPrefix(Path target, List<String> lines, int cutExclusive) throws java.io.IOException {
        if (cutExclusive <= 0) {
            Files.deleteIfExists(target);
            return;
        }
        Path temp = Files.createTempFile(target.getParent(), target.getFileName() + ".", ".rewind.tmp");
        boolean moved = false;
        try {
            try (Writer w = new OutputStreamWriter(new FileOutputStream(temp.toFile()), StandardCharsets.UTF_8)) {
                for (int i = 0; i < Math.min(cutExclusive, lines.size()); i++) {
                    w.write(lines.get(i));
                    w.write('\n');
                }
            }
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
        } finally {
            if (!moved) Files.deleteIfExists(temp);
        }
    }

    /** 快速判断一行是否为 user 轮次边界（避免全量反序列化，先做字符串预判） */
    private static boolean isUserLine(String line) {
        if (line == null || line.indexOf("\"user\"") < 0) {
            return false;
        }
        try {
            ONode node = ONode.ofJson(line);
            return "user".equals(node.get("type").getString());
        } catch (Throwable ignore) {
            return false;
        }
    }

    /**
     * 删除指定会话的流式事件文件（会话删除时调用）。
     */
    public void delete(String sessionId, String projectRoot) {
        File file = streamFile(sessionId, projectRoot);
        if (file == null) return;
        try {
            synchronized (lockFor(file)) {
                String key = pathKey(file);
                // 丢弃待写缓冲（文件都要删了，再写回去反而会把文件“复活”），并必须先关句柄：
                // Windows 下文件被打开时 deleteIfExists 会抛 AccessDeniedException。
                pendings.remove(key);
                closeWriter(file);
                Files.deleteIfExists(file.toPath());
                nextSequences.remove(sequenceKey(sessionId, projectRoot));
                lastWriteAt.remove(key);
                compacted.remove(key);
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] delete failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  历史文件懒压缩（A5）
    // ═══════════════════════════════════════════════════════════════

    /**
     * 首次读取某会话时，在<b>后台</b>把存量文件按与 A2 同口径合并重写。
     *
     * <p><b>本次请求不等压缩</b>：直接读当前文件返回，避免首次打开 132MB 文件卡住数秒；
     * 压缩完成后下次打开自然受益。</p>
     *
     * <h3>硬约束（每一条都是踩过的坑）</h3>
     * <ul>
     *   <li><b>流式中绝不压缩</b>：距最近写入不足 {@link #COMPACT_IDLE_MS} 即跳过，否则重写期间
     *       新追加的行会被旧快照覆盖（尾部截断）。同时整个重写在 {@code lockFor(file)} 内完成，
     *       与写入互斥。</li>
     *   <li><b>幂等可重入</b>：{@link #compacting} 保证同一文件不并发，{@link #compacted} 保证不重复重写；
     *       单线程 daemon 执行器保证多文件也不会同时重写。</li>
     *   <li><b>信息零丢失</b>：只合并相邻同归属的 text/reason，其它行（工具卡、trace、
     *       file_changes、user 轮边界）<b>原样保留、顺序不变</b>。user 行尤其关键：
     *       {@link #loadRounds} 靠它分页。</li>
     *   <li><b>seq 缓存</b>：压缩只会合并行、不会降低 max(eventSeq)（合并行取组内末条 seq），
     *       故 {@link #nextSequences} 无需修正；为防存量文件存在异常，压缩后仍把缓存推高到
     *       {@code max(现有, 压缩后最大 seq + 1)}，保证绝不回退、不重复。</li>
     * </ul>
     *
     * <h3>对 {@code loadFull} 物理行号的影响（已知取舍）</h3>
     * <p>{@link #previewForTransport} 注入的 {@code seq} 是<b>物理行号</b>，压缩会改变行号。
     * 缓解措施：只有超过 {@link #PREVIEW_CHARS} 的块才会被截断并需要行号回指，而这类超长块
     * （工具结果）<b>不参与合并，压缩后仍各占一行</b>，内容本身不会丢。残留影响仅为：
     * 压缩<b>瞬间已打开</b>的页面持有旧行号，此时点「展开全文」可能取到错行或空。
     * 考虑到压缩仅在会话空闲 10s 后、每个文件一生只发生一次，且刷新页面即恢复，接受此代价。</p>
     */
    private void scheduleCompactIfWorthwhile(File file, String sessionId, String projectRoot) {
        String key = pathKey(file);
        if (compacted.contains(key) || compacting.contains(key)) {
            return;
        }
        if (!compacting.add(key)) {
            return;
        }
        try {
            compactPool.submit(() -> {
                try {
                    compactNow(file, sessionId, projectRoot);
                } catch (Throwable e) {
                    LOG.warn("[StreamStore] compact failed for session {}: {}", sessionId, e.getMessage());
                } finally {
                    compacting.remove(key);
                }
            });
        } catch (Throwable e) {
            // 执行器已关闭（进程退出中）：压缩是纯优化，放弃即可
            compacting.remove(key);
        }
    }

    /**
     * 执行一次压缩。在文件锁内完成「读→合并→写临时文件→原子替换」。
     * 任何不满足前置条件（正在流式/行数太少/收益不足）都直接标记为已处理并返回。
     */
    private void compactNow(File file, String sessionId, String projectRoot) throws java.io.IOException {
        String key = pathKey(file);
        synchronized (lockFor(file)) {
            if (!file.exists()) {
                compacted.add(key);
                return;
            }
            // 流式中绝不压缩（不标记 compacted，下次打开再试）
            Long last = lastWriteAt.get(key);
            if (last != null && System.currentTimeMillis() - last < COMPACT_IDLE_MS) {
                return;
            }
            // 先冲刷待写组并关长驻句柄，再取文件快照（顺序不能反）：
            // 1) 待写组不先落盘，快照就会漏掉它，随后替换用旧快照整体覆盖 → 静默丢数据。
            //    offerDelta 不更新 lastWriteAt（挂起>10s 后首组增量恰可能落进这个窗口）；
            // 2) Windows：替换前必须先关长驻句柄，否则 ATOMIC_MOVE 抛 AccessDeniedException。
            ensureVisible(file);
            closeWriter(file);

            /* 流式压缩：边读边写临时文件，全程只在内存里保留「各归属的待合并组」，
               不再把整个文件读进 List<String>（84MB 文件约 180MB 堆，压缩自身就会 OOM，
               于是最需要压缩的大文件永远压不动）。 */
            long srcLen = file.length();
            Path target = file.toPath();
            Path temp = Files.createTempFile(target.getParent(), target.getFileName() + ".", ".compact.tmp");
            boolean moved = false;
            int inLines = 0;
            int outLines = 0;
            long maxSeq = 0;
            try {
                try (BufferedReader br = new BufferedReader(new InputStreamReader(
                             new FileInputStream(file), StandardCharsets.UTF_8), 1 << 16);
                     Writer w = new BufferedWriter(new OutputStreamWriter(
                             new FileOutputStream(temp.toFile()), StandardCharsets.UTF_8), 1 << 16)) {
                    LinkedHashMap<String, CompactGroup> buckets = new LinkedHashMap<>();
                    List<String> sink = new ArrayList<>(4);
                    String line;
                    while ((line = br.readLine()) != null) {
                        String trimmed = line.trim();
                        if (trimmed.isEmpty()) {
                            continue;
                        }
                        inLines++;
                        sink.clear();
                        acceptForCompact(trimmed, buckets, sink);
                        for (int i = 0; i < sink.size(); i++) {
                            String out = sink.get(i);
                            w.write(out);
                            w.write('\n');
                            outLines++;
                            maxSeq = Math.max(maxSeq, rawEventSeq(out));
                        }
                    }
                    sink.clear();
                    flushCompactBuckets(buckets, null, sink);
                    for (int i = 0; i < sink.size(); i++) {
                        String out = sink.get(i);
                        w.write(out);
                        w.write('\n');
                        outLines++;
                        maxSeq = Math.max(maxSeq, rawEventSeq(out));
                    }
                }
                if (inLines < COMPACT_MIN_LINES) {
                    compacted.add(key);
                    return;
                }
                // 收益门槛：可合并行占比不足 20% 时，重写整个文件不划算（也避免已压缩文件被反复重写）
                if (outLines > inLines * 0.8) {
                    compacted.add(key);
                    return;
                }
                try {
                    Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException e) {
                    Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
                }
                moved = true;
            } finally {
                if (!moved) {
                    Files.deleteIfExists(temp);
                }
            }
            // 压缩不降低 max(eventSeq)，但仍把缓存推高到不低于压缩后的最大值+1，防止任何情况下 seq 回退
            String seqKey = sequenceKey(sessionId, projectRoot);
            Long current = nextSequences.get(seqKey);
            if (current == null || current < maxSeq + 1) {
                nextSequences.put(seqKey, maxSeq + 1);
            }
            compacted.add(key);
            LOG.info("[StreamStore] compacted {} : {} -> {} lines, {} -> {} bytes",
                    file.getName(), inLines, outLines, srcLen, file.length());
        }
    }

    /**
     * 压缩的单行处理：可合并行并入对应归属的桶；非增量行触发<b>同 run 因果屏障</b>后原样输出。
     * 需要立即落盘的行写入 {@code sink}（由调用方负责写出），本方法不做 IO。
     */
    private static void acceptForCompact(String trimmed,
                                         LinkedHashMap<String, CompactGroup> buckets,
                                         List<String> sink) {
        Map bean = null;
        // 快速预判：只有 text/reason 行才需要反序列化，其它行（工具卡片等）直接透传
        if (trimmed.indexOf("\"type\":\"text\"") >= 0 || trimmed.indexOf("\"type\":\"reason\"") >= 0) {
            try {
                bean = ONode.ofJson(trimmed).toBean(Map.class);
            } catch (Throwable ignore) {
                bean = null;   // 损坏行：当作不可合并原样保留
            }
        }
        boolean mergeable = bean != null
                && ("text".equals(String.valueOf(bean.get("type"))) || "reason".equals(String.valueOf(bean.get("type"))))
                && !Boolean.TRUE.equals(bean.get("truncated"))
                && bean.get("text") instanceof String
                && ((String) bean.get("text")).length() <= DELTA_FLUSH_CHARS;

        if (mergeable) {
            String owner = ownerKeyOf(bean);
            String text = (String) bean.get("text");
            CompactGroup g = buckets.get(owner);
            if (g != null && g.buf.length() + text.length() > DELTA_FLUSH_CHARS) {
                sink.add(emitCompacted(g.head, g.buf, g.seqFrom, g.seqTo));
                buckets.remove(owner);
                g = null;
            }
            if (g == null) {
                buckets.put(owner, new CompactGroup(bean, text, seqFromOf(bean), seqOf(bean)));
            } else {
                g.buf.append(text);
                g.seqTo = Math.max(g.seqTo, seqOf(bean));
            }
            return;
        }
        // 非增量行：同 run 因果屏障（无 runId 时保守冲刷全部），再原样输出
        flushCompactBuckets(buckets, runIdOf(trimmed, bean), sink);
        sink.add(trimmed);
    }

    /**
     * 把原始行列表按「同归属 text/reason」合并。与 {@code PendingDelta} 同口径：
     * 合并行的 {@code eventSeq} 取组内末条，{@code seqFrom} 取组内首条，其它字段沿用首条。
     * 非增量行、损坏行、超长块均<b>原样透传</b>（原字符串，不重序列化，避免字段丢失与格式漂移）。
     *
     * <h3>为何从「相邻合并」改为「分桶合并」（实测订正）</h3>
     * <p>旧实现要求两行<b>物理相邻</b>才合并。但并发会话里多个 run 的增量是逐行交错写入的，
     * 实测 84MB/24 万行的真实文件里「连续同归属段」的长度 p50/p90/p99 全是 1，
     * 相邻合并只能降 <b>10.4%</b>——低于 20% 收益门槛，于是被判定「不值得压」并永久跳过，
     * 存量大文件永远不会自愈。改为按归属分桶后实测降幅 <b>98.4% 行 / 83.8% 字节</b>。</p>
     *
     * <h3>时序保障（与写侧同构）</h3>
     * <p>遇到非增量行时，先把<b>同一 runId</b> 的全部桶按开启顺序落盘，再写该行（同 run 因果屏障）。
     * 合并行的位置恒为该组<b>首帧原本所在的位置</b>，因此同一 run 内「正文在前、工具卡在后」
     * 的因果顺序与压缩前完全一致；user 轮边界行会冲刷全部桶（runId 为空时退化为全量），
     * 保证 {@link #loadRounds} 的分页边界不被跨轮合并破坏。</p>
     */
    private static List<String> compactLines(List<String> lines) {
        List<String> out = new ArrayList<>();
        // 归属 -> 待合并组；LinkedHashMap 保证同批落盘时的顺序稳定可预期
        LinkedHashMap<String, CompactGroup> buckets = new LinkedHashMap<>();
        for (String raw : lines) {
            String trimmed = raw == null ? "" : raw.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            Map bean = null;
            // 快速预判：只有 text/reason 行才需要反序列化，其它行（工具卡片等）直接透传，
            // 避免把数十万行全量 parse 一遍。
            if (trimmed.indexOf("\"type\":\"text\"") >= 0 || trimmed.indexOf("\"type\":\"reason\"") >= 0) {
                try {
                    bean = ONode.ofJson(trimmed).toBean(Map.class);
                } catch (Throwable ignore) {
                    bean = null;   // 损坏行：当作不可合并原样保留
                }
            }
            boolean mergeable = bean != null
                    && ("text".equals(String.valueOf(bean.get("type"))) || "reason".equals(String.valueOf(bean.get("type"))))
                    && !Boolean.TRUE.equals(bean.get("truncated"))
                    && bean.get("text") instanceof String
                    && ((String) bean.get("text")).length() <= DELTA_FLUSH_CHARS;

            if (mergeable) {
                String owner = ownerKeyOf(bean);
                CompactGroup g = buckets.get(owner);
                String text = (String) bean.get("text");
                if (g != null && g.buf.length() + text.length() > DELTA_FLUSH_CHARS) {
                    out.add(emitCompacted(g.head, g.buf, g.seqFrom, g.seqTo));
                    buckets.remove(owner);
                    g = null;
                }
                if (g == null) {
                    g = new CompactGroup(bean, text, seqFromOf(bean), seqOf(bean));
                    buckets.put(owner, g);
                } else {
                    g.buf.append(text);
                    g.seqTo = Math.max(g.seqTo, seqOf(bean));
                }
                continue;
            }

            // 非增量行：同 run 因果屏障（无 runId 时保守地冲刷全部）
            String runId = runIdOf(trimmed, bean);
            flushCompactBuckets(buckets, runId, out);
            out.add(trimmed);   // 非增量行原样保留（含 user 轮边界）
        }
        flushCompactBuckets(buckets, null, out);
        return out;
    }

    /** 压缩期的待合并组（与写侧 {@code PendingDelta} 同语义，但持有已反序列化的 Map）。 */
    private static final class CompactGroup {
        final Map head;
        final StringBuilder buf;
        final long seqFrom;
        long seqTo;

        CompactGroup(Map head, String text, long seqFrom, long seqTo) {
            this.head = head;
            this.buf = new StringBuilder(text);
            this.seqFrom = seqFrom;
            this.seqTo = seqTo;
        }
    }

    /**
     * 落盘指定 {@code runId} 名下的全部待合并组（{@code runId} 为 null 时落盘全部）。
     * 按插入顺序输出，保持与各组首帧出现先后一致。
     */
    private static void flushCompactBuckets(LinkedHashMap<String, CompactGroup> buckets,
                                            String runId, List<String> out) {
        if (buckets.isEmpty()) {
            return;
        }
        java.util.Iterator<Map.Entry<String, CompactGroup>> it = buckets.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, CompactGroup> e = it.next();
            CompactGroup g = e.getValue();
            if (runId != null && !runId.equals(String.valueOf(g.head.get("runId")))) {
                continue;
            }
            out.add(emitCompacted(g.head, g.buf, g.seqFrom, g.seqTo));
            it.remove();
        }
    }

    /** 读侧归属键：与写侧 {@code ownerKey(WebChunk)} 四元组口径一致。 */
    private static String ownerKeyOf(Map bean) {
        Object agent = null;
        Object args = bean.get("args");
        if (args instanceof Map) {
            agent = ((Map) args).get("agentName");
        }
        return String.valueOf(bean.get("type")) + '\u0001'
                + String.valueOf(bean.get("runId")) + '\u0001'
                + String.valueOf(bean.get("phase")) + '\u0001'
                + String.valueOf(agent);
    }

    /**
     * 取非增量行的 runId。已反序列化的直接读字段；否则做一次轻量反序列化——
     * 非增量行实测只占总行数的 ~1%，不会带来可观察开销。
     * 取不到时返回 null，调用方会退化为「冲刷全部桶」的保守行为。
     */
    private static String runIdOf(String trimmed, Map bean) {
        if (bean != null) {
            Object v = bean.get("runId");
            return v == null ? null : String.valueOf(v);
        }
        try {
            Object v = ONode.ofJson(trimmed).get("runId").getString();
            return v == null ? null : String.valueOf(v);
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static String emitCompacted(Map head, StringBuilder buf, long seqFrom, long seqTo) {
        ONode node = ONode.ofBean(head);
        node.set("text", buf.toString());
        if (seqTo > 0) {
            node.set("eventSeq", seqTo);
        }
        if (seqFrom > 0 && seqFrom != seqTo) {
            node.set("seqFrom", seqFrom);
        }
        return node.toJson();
    }

    /** 临时文件 + 原子替换写入全量行（与 {@link #replaceWithPrefix} 同范式）。 */
    private static void replaceWithAll(Path target, List<String> lines) throws java.io.IOException {
        Path temp = Files.createTempFile(target.getParent(), target.getFileName() + ".", ".compact.tmp");
        boolean moved = false;
        try {
            try (Writer w = new BufferedWriter(new OutputStreamWriter(
                    new FileOutputStream(temp.toFile()), StandardCharsets.UTF_8), 1 << 16)) {
                for (String line : lines) {
                    w.write(line);
                    w.write('\n');
                }
            }
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
        } finally {
            if (!moved) Files.deleteIfExists(temp);
        }
    }

    /**
     * 序列化一个待落盘的块：默认存全文，仅在 text 达到病态上限时截断。
     */
    private static String serialize(WebChunk chunk) {
        String text = chunk.getText();
        if (text == null || text.length() <= MAX_TEXT_CHARS) {
            return ONode.serialize(chunk);
        }
        ONode node = ONode.ofBean(chunk);
        node.set("text", text.substring(0, MAX_TEXT_CHARS) + TRUNCATE_MARK);
        return node.toJson();
    }

    /**
     * 追加一行到长驻 Writer（A1）。<b>必须在 {@code lockFor(file)} 内调用</b>。
     *
     * <p>旧实现每行 open-write-close，一次长任务几万行就是几万次句柄开关；现在复用缓存句柄。
     * 写入异常时丢弃坏句柄（{@link #closeWriter}），下一次写入会自动重建，实现自愈。</p>
     *
     * <p><b>为何每行写完就 flush</b>（看似与缓冲矛盾，实则必须）：本类之外还有<b>不经本类</b>
     * 直接读该 ndjson 的路径（{@code UsageStatsService}、{@code UsageArchiveService} 按文件名
     * 自行打开），它们无从得知内存里还存着数 KB 未落盘的字节。为了不引入「统计/归档漏计」
     * 这类隐形 bug，这里保持「行级可见」语义。体积与系统调用的收益来自 A2 的<b>行合并</b>
     * （行数降一个数量级 → flush 次数同步降一个数量级）与 A1 的<b>句柄复用</b>，
     * 而不是来自「拖延落盘」；拖延落盘只会换来可见性风险，不值得。</p>
     */
    private void appendLine(File file, String sessionId, String json) {
        if (file == null) {
            return;
        }
        try {
            WriterHandle handle = writerFor(file);
            handle.writer.write(json);
            handle.writer.write('\n');
            handle.writer.flush();
            handle.lastUsed = System.currentTimeMillis();
            lastWriteAt.put(pathKey(file), handle.lastUsed);
        } catch (Throwable e) {
            LOG.warn("[StreamStore] append failed for session {}: {}", sessionId, e.getMessage());
            closeWriter(file);
        }
    }

    private File streamFile(String sessionId, String projectRoot) {
        try {
            File dir = sessionLocator.resolveDir(sessionId, projectRoot);
            return new File(dir, sessionId + STREAM_SUFFIX);
        } catch (Throwable e) {
            LOG.warn("[StreamStore] resolve dir failed for session {}: {}", sessionId, e.getMessage());
            return null;
        }
    }
}
