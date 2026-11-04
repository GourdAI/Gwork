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
package com.gourdai.harness.talents.memory;

import java.util.Collections;
import java.util.List;

/**
 * 记忆存储供应商接口
 * * 负责底层数据的物理持久化（如 Redis, Database, LocalCache 等）
 *
 * @author oisin
 * @since 3.9.4
 */
public interface MemoryStorer {
    /**
     * 存入记忆条目
     *
     * @param key   完整存储键（包含前缀与会话标识）
     * @param val   序列化后的记忆 JSON 内容
     * @param ttl   存活时间，单位：秒（-1 表示永久存储）
     */
    void put(String userId, String key, String val, int ttl);

    /**
     * 获取记忆条目
     *
     * @param key   存储键
     * @return      序列化内容，若不存在则返回 null
     */
    String get(String userId, String key);

    /**
     * 移除特定记忆
     *
     * @param key   存储键
     */
    void remove(String userId, String key);

    /**
     * 在存储实现自身的一致性边界内批量清空用户记忆。
     *
     * <p>默认返回 {@code null} 表示不支持存储级批量操作，调用方应使用稳定快照逐项删除；
     * 实现不得把默认方法解释为跨存储器与独立搜索器的事务承诺。</p>
     */
    default ClearResult clear(String userId) {
        return null;
    }

    final class ClearResult {
        private final int deleted;
        private final List<String> failed;
        private final int remaining;

        public ClearResult(int deleted, List<String> failed, int remaining) {
            this.deleted = deleted;
            this.failed = failed == null ? Collections.emptyList() : Collections.unmodifiableList(failed);
            this.remaining = remaining;
        }

        public int getDeleted() { return deleted; }
        public List<String> getFailed() { return failed; }
        public int getRemaining() { return remaining; }
    }
}