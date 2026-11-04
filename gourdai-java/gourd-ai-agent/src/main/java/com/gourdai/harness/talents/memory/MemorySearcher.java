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

import java.util.List;

/**
 * 记忆搜索供应商接口
 *
 * @author oisin
 * @since 3.9.4
 */
public interface MemorySearcher {
    /** 语义/模糊搜索 */
    List<MemorySearchResult> search(String userId, String query, int limit);
    /** 获取高价值热记忆（用于画像注入） */
    List<MemorySearchResult> getHotMemories(String userId, int limit);

    /**
     * 列举全部记忆条目（不做重要度过滤），按重要度倒序返回，用于回答“记住了哪些”。
     *
     * <p>默认实现退化为 {@link #getHotMemories(String, int)}（仅 Imp≥5，存在低分条目漏列的局限）；
     * 各实现应覆盖此方法以返回不受重要度阈值限制的全量结果。
     *
     * @since 4.0.0
     */
    default List<MemorySearchResult> listAll(String userId, int limit) {
        return getHotMemories(userId, limit);
    }

    /**
     * 返回指定用户的准确条目数。默认实现通过全量列举兼容旧实现；实现可覆盖为低成本计数。
     */
    default int count(String userId) {
        return listAll(userId, Integer.MAX_VALUE).size();
    }

    /** 同步索引（保留既有五参抽象方法，兼容已有实现类） */
    void updateIndex(String userId, String key, String fact, int importance, String time);

    /**
     * 同步带可读标题的索引。旧实现无需修改即可继续工作；支持标题元数据的实现可覆盖此方法。
     */
    default void updateIndex(String userId, String key, String title, String fact, int importance, String time) {
        updateIndex(userId, key, fact, importance, time);
    }
    /** 移除索引 */
    void removeIndex(String userId, String key);
}