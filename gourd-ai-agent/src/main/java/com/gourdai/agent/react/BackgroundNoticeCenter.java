package com.gourdai.agent.react;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ConcurrentMap;
import org.noear.solon.flow.FlowContext;

/**
 * 后台任务完成通知中心。
 *
 * <p>解决的问题：后台命令（bash run_in_background=true）跑完后，模型无从得知，只能反复调用
 * bash_output 轮询——每一次轮询都是一轮完整的 LLM 往返，且轮询结果会永久留在工作记忆里被后续
 * 每轮全量重发，token 消耗随轮询次数放大。本类把「完成」这件事从「模型主动问」改为「系统主动
 * 告知」：进程结束时投递一条通知，下一轮推理组装消息前注入工作记忆，模型无需轮询即可感知。</p>
 *
 * <p>归属隔离：TerminalTalent 是全局单例，多个会话共用同一个 TerminalSessionManager。若通知不做
 * 归属区分，A 会话会收到 B 会话的后台任务完成消息。故所有通知按 ownerKey（每个 agent 运行实例
 * 一个，存放于 FlowContext）分桶投递与消费。</p>
 *
 * <p>线程模型：投递方是命令等待线程（solon-ai-command-waiter-*），消费方是推理线程，故用并发容器。
 * {@link #CURRENT_OWNER} 为工具执行期间的归属传递通道——工具方法签名里拿不到 trace，只能借由
 * ThreadLocal 从 ActionTask 透传；bash 属于写工具，恒在 ActionTask 当前线程串行执行，
 * 不会落到并行只读段的线程池上，故 ThreadLocal 可靠。</p>
 *
 * @author oisin
 */
public final class BackgroundNoticeCenter {

    /**
     * 归属键在 FlowContext 中的属性名。
     */
    public static final String ATTR_OWNER = "__bg_notice_owner";

    /**
     * 单个归属最多堆积的通知条数：超出后丢弃最旧的。
     * 防止会话被遗弃（用户关闭页面）时通知无限堆积。
     */
    private static final int MAX_NOTICES_PER_OWNER = 32;

    /**
     * 最多同时保留多少个归属桶：超出后清理可回收桶，仍超出则拒绝新桶（宁可丢通知，不可拖垮进程）。
     */
    private static final int MAX_OWNERS = 128;

    /**
     * 归属桶的存活上限：超过此时长未被投递/消费的桶视为已遗弃，可回收。
     *
     * <p>为何必须有时间兜底：owner 存放于 FlowContext（内存态），而会话可能被 LruSessionCache 淘汰后
     * 从磁盘重载——重载出的 context 不含旧 ATTR_OWNER，于是旧桶再也无人认领。显式 {@link #discard}
     * 只能覆盖“用户主动删除会话”这一条路径，覆盖不到 LRU 淘汰与进程异常，故以 TTL 兜底。</p>
     */
    private static final long OWNER_TTL_MS = 6L * 60 * 60 * 1000;

    private static final ConcurrentMap<String, Bucket> NOTICES = new ConcurrentHashMap<>();

    private static final ThreadLocal<String> CURRENT_OWNER = new ThreadLocal<>();

    private BackgroundNoticeCenter() {
    }

    // ---------------- 归属传递（工具执行期） ----------------

    /**
     * 解析（必要时创建）当前会话的归属键，并缓存到 FlowContext。
     *
     * <p>一个 agent 运行实例（含子代理，子代理有自己的 context）对应一个归属键，
     * 保证后台任务的完成通知只回到启动它的那个会话。</p>
     */
    public static String resolveOwner(FlowContext context) {
        if (context == null) {
            return null;
        }
        String owner = context.getAs(ATTR_OWNER);
        if (owner == null || owner.isEmpty()) {
            owner = "bg_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
            context.put(ATTR_OWNER, owner);
        }
        return owner;
    }

    /**
     * 只读取已有归属键，不创建。
     *
     * <p>消费端（推理前注入通知）用此方法：从未启动过后台任务的会话不应白白生成归属键。</p>
     */
    public static String peekOwner(FlowContext context) {
        return context == null ? null : context.getAs(ATTR_OWNER);
    }

    /**
     * 绑定当前线程的归属键（由 ActionTask 在工具执行前后成对调用）。
     */
    public static void bindCurrentOwner(String owner) {
        if (owner == null || owner.isEmpty()) {
            CURRENT_OWNER.remove();
        } else {
            CURRENT_OWNER.set(owner);
        }
    }

    /**
     * 读取当前线程的归属键；工具在启动后台任务时调用。
     *
     * @return 未绑定时返回 null（此时不投递通知，退化为纯手动查询）
     */
    public static String currentOwner() {
        return CURRENT_OWNER.get();
    }

    /**
     * 解绑当前线程的归属键。必须在 finally 中调用，否则线程复用会导致归属串台。
     */
    public static void unbindCurrentOwner() {
        CURRENT_OWNER.remove();
    }

    // ---------------- 通知投递与消费 ----------------

    /**
     * 投递一条完成通知。
     *
     * @param owner  归属键；为空则直接丢弃（无人认领的通知没有意义）
     * @param notice 通知内容
     */
    public static void publish(String owner, Notice notice) {
        if (owner == null || owner.isEmpty() || notice == null) {
            return;
        }

        Bucket bucket = NOTICES.get(owner);
        if (bucket == null) {
            if (NOTICES.size() >= MAX_OWNERS) {
                evictReclaimableOwners();
                if (NOTICES.size() >= MAX_OWNERS) {
                    return;
                }
            }
            bucket = NOTICES.computeIfAbsent(owner, k -> new Bucket());
        }

        bucket.touch();
        bucket.queue.offer(notice);
        // 超量时丢弃最旧的：保留最近的完成事件更有价值
        while (bucket.queue.size() > MAX_NOTICES_PER_OWNER) {
            bucket.queue.poll();
        }
    }

    /**
     * 取走并清空某归属下的全部通知。
     *
     * @return 按投递顺序排列的通知；无通知时返回空列表（不返回 null）
     */
    public static List<Notice> drain(String owner) {
        if (owner == null || owner.isEmpty()) {
            return Collections.emptyList();
        }

        // 不可用 NOTICES.remove(owner) 整体摘桶：投递线程可能已持有旧队列引用，
        // 摘桶后它的 offer 会写进一个再也无人消费的队列，导致完成通知永久丢失
        // （模型据此死等，恰好击穿本机制存在的意义）。故只清空队列内容，桶本身留给 TTL/discard 回收。
        Bucket bucket = NOTICES.get(owner);
        if (bucket == null || bucket.queue.isEmpty()) {
            return Collections.emptyList();
        }

        bucket.touch();
        List<Notice> result = new ArrayList<>(bucket.queue.size());
        Notice item;
        while ((item = bucket.queue.poll()) != null) {
            result.add(item);
        }
        return result;
    }

    /**
     * 丢弃某归属下的全部通知，并回收归属桶。
     *
     * <p>调用时机：用户主动删除会话（AgentSessionProvider#removeSession）。此时会话不会再有
     * 下一轮推理去消费通知，桶必须立即回收，否则将驻留到 TTL 到期。</p>
     *
     * <p>注意不要在「单次请求结束」时调用：后台任务的典型形态就是跨请求完成——本轮启动、
     * 若干轮后才结束，通知要留到后续请求注入。请求级清理会直接废掉跨请求送达能力。</p>
     */
    public static void discard(String owner) {
        if (owner != null && owner.isEmpty() == false) {
            NOTICES.remove(owner);
        }
    }

    /**
     * 会话删除时的清理入口：从会话 context 中取出归属键并回收其通知桶。
     *
     * <p>做成静态便捷方法，免得调用方（Configurator）去感知 ATTR_OWNER 这个内部细节。</p>
     */
    public static void discardByContext(FlowContext context) {
        String owner = peekOwner(context);
        if (owner != null && owner.isEmpty() == false) {
            NOTICES.remove(owner);
        }
    }

    /**
     * 仅供测试：清空全部状态，避免用例间互相污染。
     */
    static void resetForTest() {
        NOTICES.clear();
        CURRENT_OWNER.remove();
    }

    /**
     * 仅供测试：查看某归属当前堆积的通知数量（不消费）。
     */
    static int pendingCountForTest(String owner) {
        Bucket bucket = NOTICES.get(owner);
        return bucket == null ? 0 : bucket.queue.size();
    }

    /**
     * 仅供测试：当前归属桶数量（drain 后空桶仍在，故与通知数不等价）。
     */
    static int ownerCountForTest() {
        return NOTICES.size();
    }

    /**
     * 仅供测试：把某归属桶的最后活动时间强行推早，用于验证 TTL 回收。
     */
    static void agingForTest(String owner, long millis) {
        Bucket bucket = NOTICES.get(owner);
        if (bucket != null) {
            bucket.lastTouchMs = System.currentTimeMillis() - millis;
        }
    }

    /**
     * 仅供测试：直接触发一次回收。
     */
    static void evictForTest() {
        evictReclaimableOwners();
    }

    /**
     * 回收可清理的归属桶：空桶（已被消费完）或超过 TTL 的遗弃桶。
     *
     * <p>空桶可直接回收——即便此刻有投递线程正持有该桶引用并写入，写入的通知也只是
     * 落进一个即将被丢弃的桶；这与「会话已消费完且长期不再活动」的语义一致，可接受。
     * 真正不可接受的是 drain 时摘桶（见 {@link #drain}），那会在会话仍活跃时丢通知。</p>
     */
    private static void evictReclaimableOwners() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, Bucket>> it = NOTICES.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Bucket> entry = it.next();
            Bucket bucket = entry.getValue();
            if (bucket.queue.isEmpty() || now - bucket.lastTouchMs > OWNER_TTL_MS) {
                it.remove();
            }
        }
    }

    /**
     * 一个归属的通知桶：队列 + 最后活动时间（供 TTL 回收）。
     */
    private static final class Bucket {
        private final Queue<Notice> queue = new ConcurrentLinkedQueue<>();
        private volatile long lastTouchMs = System.currentTimeMillis();

        private void touch() {
            lastTouchMs = System.currentTimeMillis();
        }
    }

    /**
     * 一条后台任务完成通知。
     */
    public static final class Notice {
        private final String sessionId;
        private final String command;
        private final Integer exitCode;
        private final boolean timedOut;
        private final boolean terminated;
        private final long wallTimeMs;
        private final String tailOutput;

        public Notice(String sessionId, String command, Integer exitCode, boolean timedOut,
                      boolean terminated, long wallTimeMs, String tailOutput) {
            this.sessionId = sessionId;
            this.command = command;
            this.exitCode = exitCode;
            this.timedOut = timedOut;
            this.terminated = terminated;
            this.wallTimeMs = wallTimeMs;
            this.tailOutput = tailOutput;
        }

        public String sessionId() {
            return sessionId;
        }

        public String command() {
            return command;
        }

        public Integer exitCode() {
            return exitCode;
        }

        public boolean timedOut() {
            return timedOut;
        }

        public boolean terminated() {
            return terminated;
        }

        public long wallTimeMs() {
            return wallTimeMs;
        }

        public String tailOutput() {
            return tailOutput;
        }

        /**
         * 渲染为注入工作记忆的文本。
         *
         * <p>刻意保持精简：这条消息会随历史被后续每轮重发，冗长的输出会持续放大 token 成本。
         * 只给「结论 + 少量尾部输出」，需要完整内容时模型可自行调用 bash_output。</p>
         */
        public String render() {
            StringBuilder sb = new StringBuilder();
            sb.append("[后台任务完成] session_id=").append(sessionId);
            if (timedOut) {
                sb.append(" status=timeout");
            } else if (terminated) {
                sb.append(" status=terminated");
            } else {
                sb.append(" status=finished");
            }
            sb.append(" exit_code=").append(exitCode == null ? "unknown" : exitCode);
            sb.append(" wall_time_ms=").append(wallTimeMs);
            sb.append('\n');
            sb.append("command: ").append(command).append('\n');
            if (tailOutput != null && tailOutput.isEmpty() == false) {
                sb.append("tail output:\n").append(tailOutput);
                if (tailOutput.endsWith("\n") == false) {
                    sb.append('\n');
                }
            } else {
                sb.append("(无输出)\n");
            }
            sb.append("如需完整输出，可用 bash_output 查询该 session_id。");
            return sb.toString();
        }
    }
}
