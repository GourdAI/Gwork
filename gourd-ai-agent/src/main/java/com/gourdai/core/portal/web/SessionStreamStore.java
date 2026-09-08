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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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
     */
    private static final int PREVIEW_CHARS = 64 * 1024;

    /**
     * 分页默认加载的<b>对话轮数</b>（一轮 = 一条 user 消息及其后的全部 AI 过程事件）。
     *
     * <p>历史分页必须以「轮」为单位，不能以 ndjson 物理行为单位：text/reason 是<b>token 级增量</b>，
     * 实测占全部行的 ~92%（某会话 15383 行里 14190 行是增量，真实用户消息只有 11 条）。按行分页时
     * 「一页 150 行」实际只有 0.1 轮对话，用户点一次几乎看不到新内容，且切片会落在半句话中间。</p>
     */
    private static final int DEFAULT_PAGE_ROUNDS = 5;

    /**
     * 单页原始事件行的软上限：某一轮若异常庞大（长任务刷了几万条增量），
     * 达到上限就提前收尾留给下一页。但<b>至少保证一整轮</b>，绝不在轮中间切断。
     */
    private static final int MAX_PAGE_LINES = 4000;

    private final SessionLocator sessionLocator;

    /** 逐会话写锁，防止并发轮次的行交错 */
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    /**
     * 会话内下一事件序号缓存。Key 同时包含 sessionId 与实际存储目录，避免不同工作区
     * 使用相同 sessionId 时共享序号状态。
     */
    private final Map<String, Long> nextSequences = new ConcurrentHashMap<>();

    public SessionStreamStore(SessionLocator sessionLocator) {
        this.sessionLocator = sessionLocator;
    }

    private Object lockFor(String sessionId) {
        return locks.computeIfAbsent(sessionId, k -> new Object());
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
        try {
            synchronized (lockFor(sessionId)) {
                chunk.setSessionId(sessionId);
                chunk.setEventSeq(nextEventSeq(sessionId, projectRoot));
                appendLine(sessionId, projectRoot, serialize(chunk));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] record failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /** 兼容旧调用方：实时事件已逐条落盘，不再需要冲刷内存文本缓冲。 */
    public void flush(String sessionId, String projectRoot) {
        // no-op
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
            synchronized (lockFor(sessionId)) {
                WebChunk uc = new WebChunk();
                uc.setType("user");
                uc.setText(text);
                uc.setSessionId(sessionId);
                uc.setCreatedAt(createdAt);
                uc.setClientMessageId(clientMessageId);
                uc.setEventSeq(nextEventSeq(sessionId, projectRoot));
                appendLine(sessionId, projectRoot, serialize(uc));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] recordUser failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 增量加载 eventSeq 大于 afterSeq 的事件。afterSeq 为排他游标，供断线重连补流。
     */
    public LoadResult loadAfter(String sessionId, String projectRoot, long afterSeq, Integer limit) {
        LoadResult result = new LoadResult();
        File file = streamFile(sessionId, projectRoot);
        if (file == null || !file.exists()) return result;
        int max = limit == null || limit <= 0 ? 500 : Math.min(limit, 2000);
        try {
            synchronized (lockFor(sessionId)) {
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
                            if (result.events.size() >= max) {
                                result.hasMore = true;
                                continue;
                            }
                            previewForTransport(bean, lineNo);
                            result.events.add(bean);
                            if (result.firstSeq == 0) result.firstSeq = seq;
                            result.lastSeq = seq;
                        } catch (Throwable ignore) {
                            // 跳过已完整落盘但损坏的历史行；读锁保证不会把正在追加的半行误判为损坏。
                        }
                    }
                    if (!result.events.isEmpty() && result.lastSeq < result.latestSeq) result.hasMore = true;
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
        if (file == null || !file.exists()) {
            return result;
        }
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            int lineNo = 0;
            List<Map> allData = new ArrayList<>();
            while ((line = br.readLine()) != null) {
                lineNo++;
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                try {
                    ONode node = ONode.ofJson(trimmed);
                    Map bean = node.toBean(Map.class);
                    previewForTransport(bean, lineNo);
                    allData.add(bean);
                } catch (Throwable ignore) {
                    // 跳过损坏行
                }
            }
            result.totalCount = allData.size();
            for (Map bean : allData) {
                Object rawSeq = bean.get("eventSeq");
                if (rawSeq == null) {
                    continue;
                }
                try {
                    long seq = rawSeq instanceof Number
                            ? ((Number) rawSeq).longValue()
                            : Long.parseLong(String.valueOf(rawSeq));
                    result.latestSeq = Math.max(result.latestSeq, seq);
                    if (result.firstSeq == 0) result.firstSeq = seq;
                    result.lastSeq = seq;
                } catch (NumberFormatException ignore) {
                    // 兼容损坏或非数字 eventSeq；事件本身仍可按旧格式回放
                }
            }
            if (tail != null && tail > 0 && allData.size() > tail) {
                result.events = coalesceDeltas(new ArrayList<>(allData.subList(allData.size() - tail, allData.size())));
                result.hasMore = true;
            } else {
                result.events = coalesceDeltas(allData);
                result.hasMore = false;
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] load failed for session {}: {}", sessionId, e.getMessage());
        }
        return result;
    }

    /**
     * 按<b>对话轮</b>分页加载历史事件（供「显示之前的 N 条消息」向上翻页）。
     *
     * <p>相比旧的 {@code tail=N} 行分页，本方法解决三个问题：</p>
     * <ul>
     *   <li><b>每次出一整轮</b>：以 user 事件为边界切页，不会把一轮对话截成半句。</li>
     *   <li><b>游标翻页</b>：{@code beforeSeq} 指向上一页的起始事件，只回传<b>更早</b>的事件。
     *       旧实现每次都从尾部重取 {@code 已加载+150} 条（第 N 页要重传前 N-1 页的全部数据），
     *       翻到深处后每次点击都要重新传输、去重、渲染整段历史，越点越慢。</li>
     *   <li><b>计数稳定</b>：回传 {@code remainingRounds}（剩余用户消息数），
     *       不再把 token 级增量行当成「条消息」显示，也不会因会话仍在流式而越点越多。</li>
     * </ul>
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
        if (file == null || !file.exists()) {
            return result;
        }
        int wantRounds = (rounds == null || rounds <= 0) ? DEFAULT_PAGE_ROUNDS : rounds;
        try {
            List<String> lines = new ArrayList<>();
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    lines.add(line);
                }
            }
            result.totalCount = lines.size();

            // 一次轻量扫描（只做 indexOf，不做 JSON 反序列化）定位：轮边界、游标位置、最大 seq。
            // 全量 parse 15k 行是纯浪费——本页只需要其中一小段。
            List<Integer> bounds = new ArrayList<>();
            int endIdx = lines.size();
            boolean endFound = false;
            for (int i = 0; i < lines.size(); i++) {
                String raw = lines.get(i);
                if (raw == null || raw.trim().isEmpty()) {
                    continue;
                }
                long seq = rawEventSeq(raw);
                if (seq > 0) {
                    result.latestSeq = Math.max(result.latestSeq, seq);
                    if (beforeSeq != null && !endFound && seq >= beforeSeq) {
                        endIdx = i;
                        endFound = true;
                    }
                }
                if (isRoundBoundary(raw)) {
                    bounds.add(i);
                }
            }
            result.totalRounds = bounds.size();

            // 本页起点：游标之前的最后 wantRounds 个轮边界；至少含一整轮，且受单页行数软上限约束
            List<Integer> before = new ArrayList<>();
            for (int i = 0; i < bounds.size(); i++) {
                if (bounds.get(i) < endIdx) {
                    before.add(bounds.get(i));
                }
            }
            int start = before.isEmpty() ? 0 : before.get(before.size() - 1);
            int taken = before.isEmpty() ? 0 : 1;
            for (int i = before.size() - 2; i >= 0 && taken < wantRounds; i--) {
                int cand = before.get(i);
                if (endIdx - cand > MAX_PAGE_LINES) {
                    break;
                }
                start = cand;
                taken++;
            }

            List<Map> page = new ArrayList<>();
            for (int i = start; i < endIdx; i++) {
                String trimmed = lines.get(i) == null ? "" : lines.get(i).trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                try {
                    Map bean = ONode.ofJson(trimmed).toBean(Map.class);
                    previewForTransport(bean, i + 1);   // seq 用物理行号（1 起），供展开全文回指
                    page.add(bean);
                } catch (Throwable ignore) {
                    // 跳过损坏行
                }
            }

            result.events = coalesceDeltas(page);
            result.hasMore = start > 0;
            // 下一页游标 = 本页首个事件的 seq；剩余轮数 = 本页起点之前的轮边界数
            result.firstSeq = page.isEmpty() ? 0 : seqOf(page.get(0));
            result.lastSeq = page.isEmpty() ? 0 : seqOf(page.get(page.size() - 1));
            int remaining = 0;
            for (int i = 0; i < bounds.size(); i++) {
                if (bounds.get(i) < start) {
                    remaining++;
                }
            }
            result.remainingRounds = remaining;
        } catch (Throwable e) {
            LOG.warn("[StreamStore] loadRounds failed for session {}: {}", sessionId, e.getMessage());
        }
        return result;
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
                // 游标推进到组内最后一条，避免断线重连时重复补发已合并的增量
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
            }
            out.add(bean);
        }
        if (open != null) {
            open.put("text", buf.toString());
        }
        return out;
    }

    /** 两个增量块是否属于同一渲染目标（同 run、同归属智能体）。 */
    private static boolean sameDeltaOwner(Map a, Map b) {
        if (!eq(a.get("type"), b.get("type")) || !eq(a.get("runId"), b.get("runId"))) {
            return false;
        }
        return eq(agentNameOf(a), agentNameOf(b));
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
        if (seq <= 0) {
            return null;
        }
        File file = streamFile(sessionId, projectRoot);
        if (file == null || !file.exists()) {
            return null;
        }
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            int lineNo = 0;
            while ((line = br.readLine()) != null) {
                lineNo++;
                if (lineNo < seq) {
                    continue;
                }
                if (lineNo > seq) {
                    break;
                }
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    return null;
                }
                ONode node = ONode.ofJson(trimmed);
                return node.get("text").getString();
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] loadFull failed for session {} seq {}: {}", sessionId, seq, e.getMessage());
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
     * 按用户轮次边界裁剪 stream 文件（回退时调用）——保留未回退轮次的完整富回放。
     *
     * <p>rewind 是高频操作（重发/改一句重问），若每次都整删 stream 文件，代价是整段会话
     * 的工具卡片/过程叙述永久丢失。故改为以 {@code user} 事件为边界，仅剔除最后 {@code turns}
     * 个用户轮次（含其后的全部 AI 过程事件），与 messages.ndjson 的裁剪对齐。</p>
     *
     * @param sessionId  会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param turns      剔除的用户轮次数（至少 1）
     */
    public void rewindTurns(String sessionId, String projectRoot, int turns) {
        if (turns <= 0) {
            turns = 1;
        }
        try {
            synchronized (lockFor(sessionId)) {
                File file = streamFile(sessionId, projectRoot);
                if (file == null || !file.exists()) {
                    return;
                }

                List<String> lines = new ArrayList<>();
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        if (!line.trim().isEmpty()) {
                            lines.add(line);
                        }
                    }
                }

                // 从尾向前找第 turns 个 user 边界，截至该边界（含）之前
                int cut = -1;
                int seen = 0;
                for (int i = lines.size() - 1; i >= 0; i--) {
                    if (isUserLine(lines.get(i))) {
                        seen++;
                        if (seen >= turns) {
                            cut = i;
                            break;
                        }
                    }
                }

                if (cut < 0) {
                    // 要回退的轮次多于文件中的 user 边界（如回退超出历史），整删
                    file.delete();
                    return;
                }

                if (cut == 0) {
                    file.delete();
                    return;
                }

                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < cut; i++) {
                    sb.append(lines.get(i)).append('\n');
                }
                try (Writer w = new OutputStreamWriter(new FileOutputStream(file, false), StandardCharsets.UTF_8)) {
                    w.write(sb.toString());
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] rewindTurns failed for session {}: {}", sessionId, e.getMessage());
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
        try {
            synchronized (lockFor(sessionId)) {
                File file = streamFile(sessionId, projectRoot);
                if (file != null && file.exists()) {
                    file.delete();
                }
                nextSequences.remove(sequenceKey(sessionId, projectRoot));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] delete failed for session {}: {}", sessionId, e.getMessage());
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

    private void appendLine(String sessionId, String projectRoot, String json) {
        File file = streamFile(sessionId, projectRoot);
        if (file == null) {
            return;
        }
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) {
            dir.mkdirs();
        }
        try (Writer w = new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
            w.write(json);
            w.write('\n');
        } catch (Throwable e) {
            LOG.warn("[StreamStore] append failed for session {}: {}", sessionId, e.getMessage());
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
