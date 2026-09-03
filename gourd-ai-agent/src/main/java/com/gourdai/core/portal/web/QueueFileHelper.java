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

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 消息队列文件操作工具 —— 管理会话目录下的 {@code queue.json}。
 *
 * <p>队列数据以 NDJSON 友好的 JSON 格式存储在 {@code <sessionDir>/queue.json}，
 * 处理完毕后自动删除文件。使用 {@link ReentrantLock} 保证并发安全。</p>
 *
 * @author Lumina
 * @see WebController
 */
public class QueueFileHelper {
    private static final String QUEUE_FILE = "queue.json";
    private static final ReentrantLock LOCK = new ReentrantLock();

    /**
     * 获取会话的队列文件路径。
     */
    public static File getQueueFile(File sessionDir) {
        return new File(sessionDir, QUEUE_FILE);
    }

    /**
     * 读取队列。文件不存在时返回空列表。
     *
     * @param sessionDir 会话存储目录
     * @return 队列项列表
     */
    public List<ONode> read(File sessionDir) {
        LOCK.lock();
        try {
            File queueFile = getQueueFile(sessionDir);
            if (!queueFile.exists()) {
                return Collections.emptyList();
            }
            String content;
            try {
                content = Files.readString(queueFile.toPath());
            } catch (IOException e) {
                return Collections.emptyList();
            }
            ONode root = ONode.ofJson(content);
            ONode itemsNode = root.get("items");
            if (itemsNode == null || !itemsNode.isArray()) {
                return Collections.emptyList();
            }
            return itemsNode.getArray();
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 向队列追加一条消息。
     *
     * @param sessionDir  会话存储目录
     * @param content     消息文本
     * @param imagePaths  图片附件路径列表（相对于会话目录，如 "uploads/pasted-image-xxx.png"）
     * @param filePaths   文件附件路径列表（相对于会话目录，如 "uploads/attachment-xxx.pdf"）
     * @return 追加后的队列总长度
     */
    public int add(File sessionDir, String content, List<String> imagePaths, List<String> filePaths) {
        return add(sessionDir, content, imagePaths, filePaths, null);
    }

    /**
     * 向队列追加消息；originSteerId 非空时按该 ID 幂等，供 dropped 插话安全降级。
     */
    public int add(File sessionDir, String content, List<String> imagePaths, List<String> filePaths,
                   String originSteerId) {
        LOCK.lock();
        try {
            File queueFile = getQueueFile(sessionDir);
            ONode root;
            List<ONode> existingItems = null;
            if (queueFile.exists()) {
                String contentStr;
                try {
                    contentStr = Files.readString(queueFile.toPath());
                } catch (IOException e) {
                    contentStr = null;
                }
                if (contentStr != null) {
                    root = ONode.ofJson(contentStr);
                    ONode oldItems = root.get("items");
                    if (oldItems != null && oldItems.isArray()) {
                        existingItems = oldItems.getArray();
                    }
                } else {
                    root = new ONode();
                }
            } else {
                root = new ONode();
            }

            // 与 ProjectService 一致的模式：显式创建数组节点
            ONode itemsNode = new ONode().asArray();
            if (existingItems != null) {
                for (ONode item : existingItems) {
                    itemsNode.add(item);
                }
            }
            root.set("items", itemsNode);
            List<ONode> items = itemsNode.getArray();

            if (originSteerId != null && !originSteerId.isEmpty()) {
                for (ONode existing : items) {
                    if (originSteerId.equals(existing.get("originSteerId").getString())) {
                        return items.size();
                    }
                }
            }

            ONode item = new ONode();
            item.set("content", content != null ? content : "");
            item.set("imagePaths", imagePaths != null ? imagePaths : Collections.emptyList());
            item.set("filePaths", filePaths != null ? filePaths : Collections.emptyList());
            item.set("timestamp", System.currentTimeMillis());
            if (originSteerId != null && !originSteerId.isEmpty()) {
                item.set("originSteerId", originSteerId);
            }
            items.add(item);

            // 确保会话目录存在，否则写入会失败
            if (!sessionDir.exists()) {
                sessionDir.mkdirs();
            }

            Files.writeString(queueFile.toPath(), root.toJson());
            return items.size();
        } catch (IOException e) {
            throw new RuntimeException("Failed to write queue file", e);
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 获取并移除队列首条消息（原子操作）。
     *
     * @param sessionDir 会话存储目录
     * @return 首条消息，队列为空时返回 null
     */
    public ONode shift(File sessionDir) {
        LOCK.lock();
        try {
            File queueFile = getQueueFile(sessionDir);
            if (!queueFile.exists()) {
                return null;
            }
            String content;
            try {
                content = Files.readString(queueFile.toPath());
            } catch (IOException e) {
                return null;
            }
            ONode root = ONode.ofJson(content);
            ONode itemsNode = root.get("items");
            if (itemsNode == null || !itemsNode.isArray()) {
                delete(sessionDir);
                return null;
            }
            List<ONode> items = itemsNode.getArray();

            if (items.isEmpty()) {
                delete(sessionDir);
                return null;
            }

            ONode first = items.remove(0);

            if (items.isEmpty()) {
                // 队列空了，直接删除文件
                delete(sessionDir);
            } else {
                Files.writeString(queueFile.toPath(), root.toJson());
            }
            return first;
        } catch (IOException e) {
            throw new RuntimeException("Failed to update queue file", e);
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 清空队列（删除文件）。
     *
     * @param sessionDir 会话存储目录
     */
    public void clear(File sessionDir) {
        LOCK.lock();
        try {
            delete(sessionDir);
        } finally {
            LOCK.unlock();
        }
    }

    /**
     * 删除队列文件（不带锁）。
     */
    private void delete(File sessionDir) {
        File queueFile = getQueueFile(sessionDir);
        if (queueFile.exists()) {
            try {
                Files.delete(queueFile.toPath());
            } catch (IOException ignored) {
                // 文件可能已被删除，忽略
            }
        }
    }
}