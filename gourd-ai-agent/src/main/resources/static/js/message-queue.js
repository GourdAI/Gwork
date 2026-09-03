/**
 * 消息执行队列 —— 服务端持久化管理
 *
 * 队列数据存储在会话目录下的 queue.json 文件中，
 * 通过 HTTP API 与后端交互，支持服务重启后恢复。
 */
class MessageQueue {
    constructor() {
        /** 本地缓存，避免频繁请求 */
        this.caches = {}; // { sessionId: { items: [], loading: false } }
    }

    /**
     * 获取会话队列（带缓存）
     */
    getQueue(sessionId) {
        var self = this;
        var cache = this.caches[sessionId];

        if (cache && !cache.loading && cache.items !== undefined) {
            return Promise.resolve(cache.items);
        }

        cache = cache || { items: [], loading: false };
        cache.loading = true;
        this.caches[sessionId] = cache;

        return this._fetchQueue(sessionId).then(function(items) {
            cache.items = items;
            cache.loading = false;
            return items;
        });
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
            // 后端 Solon Result.succeed() 返回 code:200（非 0）
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
            // 后端 Solon Result.succeed() 返回 code:200（非 0）
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
            // 后端 Solon Result.succeed() 返回 code:200（非 0）
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