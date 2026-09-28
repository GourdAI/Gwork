/**
 * 消息执行队列 —— 服务端持久化管理
 *
 * 队列数据存储在会话目录下的 queue.json 文件中，
 * 通过 HTTP API 与后端交互，支持服务重启后恢复。
 */
class MessageQueue {
    /** 缓存自愈上限：超过则强制重拉（跨实例 stale 快照的最长存活期） */
    static CACHE_TTL_MS = 30000;

    constructor() {
        /** 本地缓存，避免频繁请求 */
        this.caches = {}; // { sessionId: { items: [], loading: false, fetchedAt: 0 } }
    }

    /*
     * 获取会话队列（带缓存）。
     *
     * force：绕过缓存直接请求服务端。两个消费方依赖它：
     * 1) 切换会话时的全量重渲染（setActiveSession）——此时缓存里是上一个会话
     *    或过期的本会话数据，直接复用会把幽灵计数渲染到新会话；
     * 2) 跨实例场景（桌面版与 dev 同时在线、共享同一批会话目录）：
     *    另一实例 shift/clear 后本实例缓存不会失效，只有强制拉取才能看到真值。
     */
    getQueue(sessionId, force) {
        var self = this;
        var cache = this.caches[sessionId];

        // 飞行中复用：正在拉取的请求落定后就是服务端最新值。force 的语义是
        // 「绕过已落地的过期缓存」，不是「打断在飞的请求」——loading 期间
        // 无论 force 与否都复用同一个 Promise，避免同会话并发重复请求。
        if (cache && cache.loading && cache._inflight) {
            return cache._inflight;
        }

        if (!force && cache && cache.items !== undefined) {
            // TTL 自愈：跨实例共享会话目录时另一实例的 shift/clear 不会使本缓存失效，
            // 陈旧快照最多存活 CACHE_TTL_MS，到期后自动重新拉取。TTL 不参与 loading 竞态，
            // 仅在命中缓存那一刻判定，不会中断进行中的请求。
            if (!cache.fetchedAt || (Date.now() - cache.fetchedAt) < MessageQueue.CACHE_TTL_MS) {
                return Promise.resolve(cache.items);
            }
        }

        cache = cache || { items: [], loading: false, fetchedAt: 0 };
        cache.loading = true;
        var inflight = this._fetchQueue(sessionId).then(function(items) {
            cache.items = items;
            cache.loading = false;
            cache.fetchedAt = Date.now();
            return items;
        });
        cache._inflight = inflight;
        this.caches[sessionId] = cache;

        return inflight;
    };

    /**
     * 从服务端获取队列
     */
    _fetchQueue(sessionId) {
        return $.ajax({
            url: '/web/chat/queue',
            method: 'GET',
            data: { sessionId: sessionId },
            headers: this._getHeaders(sessionId)
        }).then(function(resp) {
            // 后端 Result.succeed() 返回 code:200（非 0）
            if (resp && resp.code === 200 && resp.data) {
                return resp.data.items || [];
            }
            return [];
        });
    };

    /**
     * 添加消息到队列
     */
    add(sessionId, content, imagePaths, filePaths) {
        var self = this;
        imagePaths = imagePaths || [];
        filePaths = filePaths || [];

        var promise = $.ajax({
            url: '/web/chat/queue/add',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                sessionId: sessionId,
                content: content || '',
                imagePaths: imagePaths,
                filePaths: filePaths
            }),
            headers: this._getHeaders(sessionId)
        }).then(function(resp) {
            // 后端 Result.succeed() 返回 code:200（非 0）
            if (resp && resp.code === 200) {
                // 删除缓存，下次 getQueue 时重新拉取
                delete self.caches[sessionId];
                return (resp.data && resp.data.size) || 0;
            }
            return 0;
        });

        return promise;
    };

    /**
     * 获取并移除首条消息
     */
    shift(sessionId) {
        var self = this;
        return $.ajax({
            url: '/web/chat/queue/shift',
            method: 'POST',
            data: { sessionId: sessionId },
            headers: this._getHeaders(sessionId)
        }).then(function(resp) {
            // 后端 Result.succeed() 返回 code:200（非 0）
            if (resp && resp.code === 200 && resp.data && resp.data.item) {
                // 删除缓存，下次 getQueue 时重新拉取
                delete self.caches[sessionId];
                return resp.data.item;
            }
            return null;
        });
    };

    /**
     * 清空队列
     */
    clear(sessionId) {
        var self = this;
        return $.ajax({
            url: '/web/chat/queue/clear',
            method: 'POST',
            data: { sessionId: sessionId },
            headers: this._getHeaders(sessionId)
        }).then(function() {
            // 清除缓存
            delete self.caches[sessionId];
        });
    };

    /**
     * 获取队列长度
     */
    size(sessionId) {
        var self = this;
        return this._fetchQueue(sessionId).then(function(items) {
            return items.length;
        });
    };

    /**
     * 处理队列：逐条取出并执行
     */
    process(sessionId, sendMessageFn, onProgress) {
        var self = this;

        function processNext() {
            return self.shift(sessionId).then(function(item) {
                if (!item) {
                    // 队列为空，结束
                    if (onProgress) {
                        onProgress(null, 0);
                    }
                    return;
                }

                // 获取剩余数量用于进度显示
                return self._fetchQueue(sessionId).then(function(remaining) {
                    if (onProgress) {
                        var preview = item.content ? (item.content.length > 20 ? item.content.substring(0, 20) + '...' : item.content) : '[空内容]';
                        onProgress(preview, remaining.length);
                    }

                    // 构建完整的队列项（包含附件路径）
                    var queueItem = {
                        content: item.content,
                        imagePaths: item.imagePaths || [],
                        filePaths: item.filePaths || [],
                        timestamp: item.timestamp
                    };

                    // 执行发送
                    return sendMessageFn(queueItem).then(function() {
                        // 发送完成后，继续处理下一条
                        return processNext();
                    });
                });
            });
        }

        return processNext();
    };

    /**
     * 获取请求头
     * X-Session-Cwd 取自 getSessionCwd()（code 模式为当前项目根目录），
     * 与 sendMessage 主链路保持一致，确保队列落到与会话相同的目录。
     */
    _getHeaders(sessionId) {
        var headers = {};
        if (sessionId) {
            headers['X-Session-Id'] = sessionId;
        }
        var root = '';
        if (sessionId && typeof window.sessionMap !== 'undefined'
                && window.sessionMap[sessionId] && window.sessionMap[sessionId].projectRoot) {
            root = window.sessionMap[sessionId].projectRoot;
        } else if (typeof sessionMap !== 'undefined' && sessionMap[sessionId] && sessionMap[sessionId].projectRoot) {
            root = sessionMap[sessionId].projectRoot;
        } else if (typeof window.getSessionCwd === 'function') {
            root = window.getSessionCwd();
        }
        if (root) headers['X-Session-Cwd'] = root;
        return headers;
    };
}

// 创建全局实例
window.messageQueue = new MessageQueue();