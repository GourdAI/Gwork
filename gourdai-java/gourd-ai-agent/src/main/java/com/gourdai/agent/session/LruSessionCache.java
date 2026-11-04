package com.gourdai.agent.session;

import com.gourdai.agent.AgentSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 会话对象的 LRU 内存缓存（访问序淘汰）。
 *
 * <p>背景：原先会话缓存使用无界 ConcurrentHashMap，会话对象（含全量消息历史）
 * 只进不出，长期运行后内存持续累积。本缓存按最近访问时间排序，
 * 超过容量上限时淘汰最久未访问的会话。
 *
 * <p>淘汰安全性：
 * <ul>
 *   <li>仅从内存移除引用，<b>不删除磁盘文件</b>；被淘汰会话下次访问时
 *       由 {@link FileAgentSession} 构造函数从磁盘重新加载（消息与快照均已持久化），
 *       对话历史、压缩摘要消息不会丢失；</li>
 *   <li>正在执行任务的会话（attrs 中存在活跃的 disposable）不淘汰，
 *       避免中断在途推理/工具调用；</li>
 *   <li>已挂起的会话（isPending，如等待 HITL 用户确认）不淘汰，
 *       避免丢失挂起上下文。</li>
 * </ul>
 *
 * @author oisin
 * @since 3.9.1
 */
public class LruSessionCache {
    private static final Logger LOG = LoggerFactory.getLogger(LruSessionCache.class);

    /** 默认容量上限 */
    public static final int DEFAULT_CAPACITY = 100;

    private final int capacity;
    private final LinkedHashMap<String, AgentSession> map;

    public LruSessionCache() {
        this(DEFAULT_CAPACITY);
    }

    public LruSessionCache(int capacity) {
        this.capacity = Math.max(1, capacity);
        // accessOrder=true：每次访问后移到尾部，头部即为最久未访问者
        this.map = new LinkedHashMap<String, AgentSession>(16, 0.75f, true);
    }

    /**
     * 获取或创建会话。超出容量时先触发淘汰。
     *
     * @param sessionId 会话标识
     * @param factory   缓存未命中时的创建器
     */
    public synchronized AgentSession getOrLoad(String sessionId, java.util.function.Function<String, AgentSession> factory) {
        AgentSession session = map.get(sessionId);
        if (session == null) {
            session = factory.apply(sessionId);
            map.put(sessionId, session);
            evictIfNeeded();
        }
        return session;
    }

    /**
     * 移除会话（显式删除场景，调用方负责后续清理磁盘文件）
     */
    public synchronized AgentSession remove(String sessionId) {
        return map.remove(sessionId);
    }

    public synchronized int size() {
        return map.size();
    }

    /**
     * 超限时从最久未访问的一端逐个寻找可淘汰目标。
     * 优先淘汰空会话（草稿/仅切换过模型的会话），其次淘汰最老的非活跃会话。
     * 在途（busy）或挂起（pending）的会话一律跳过。
     */
    private void evictIfNeeded() {
        if (map.size() <= capacity) {
            return;
        }

        // 第一轮：优先找最老的空会话
        String victim = findEvictable(true);
        if (victim == null) {
            // 第二轮：找最老的非活跃会话
            victim = findEvictable(false);
        }

        if (victim != null) {
            map.remove(victim); // 仅摘除内存引用，磁盘文件保留，下次访问自动重载
            if (LOG.isDebugEnabled()) {
                LOG.debug("Session cache LRU evicted: {} (size={}/{})", victim, map.size(), capacity);
            }
        } else if (LOG.isWarnEnabled()) {
            LOG.warn("Session cache over capacity ({}/{}) but all sessions are busy or pending, skip eviction",
                    map.size(), capacity);
        }
    }

    /**
     * 从头部（最久未访问）扫描第一个可淘汰目标。
     *
     * @param onlyEmpty 为 true 时仅接受空会话（无消息）
     */
    private String findEvictable(boolean onlyEmpty) {
        Iterator<Map.Entry<String, AgentSession>> it = map.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, AgentSession> entry = it.next();
            AgentSession session = entry.getValue();

            if (isBusy(session) || session.isPending()) {
                continue; // 在途或挂起的会话不可淘汰
            }
            if (onlyEmpty && !session.isEmpty()) {
                continue;
            }
            return entry.getKey();
        }
        return null;
    }

    /** 会话是否有正在执行的 AI 任务（WebGate/WsGate 在任务开始时向 attrs 写入 disposable） */
    private boolean isBusy(AgentSession session) {
        return session.attrs().get("disposable") != null;
    }
}
