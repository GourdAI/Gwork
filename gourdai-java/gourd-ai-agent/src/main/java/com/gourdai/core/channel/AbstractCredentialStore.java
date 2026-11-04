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
package com.gourdai.core.channel;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 渠道凭据持久化存储基类
 *
 * <p>将 sessionId -&gt; 绑定凭据（{@code T}）的映射以 JSON 落盘到本地文件，
 * 确保重启后已绑定的第三方通道（飞书/钉钉/微信等）自动恢复。</p>
 *
 * <p>各平台仅通过三个抽象点定制：存储文件名、日志标签、以及单条绑定的序列化/反序列化，
 * 共用的文件读写与遍历骨架收敛于此，消除三份复制粘贴。</p>
 *
 * @param <T> 平台绑定类型（如 {@code FeishuLink.FeishuBinding}）
 * @author oisin
 */
public abstract class AbstractCredentialStore<T> {
    protected final Logger log = LoggerFactory.getLogger(getClass());

    private final Path storePath;

    protected AbstractCredentialStore(Path storeDir, String storeFile) {
        this.storePath = storeDir.resolve(storeFile).toAbsolutePath();
    }

    /** 存储文件的日志标签（如 {@code FeishuStore}），用于日志前缀 {@code [XxxStore]} */
    protected abstract String logTag();

    /**
     * 从 JSON 节点反序列化单条绑定。
     *
     * @return 有效绑定；若该条目无效（缺少主键字段）应返回 {@code null} 以跳过
     */
    protected abstract T fromNode(ONode node);

    /** 将单条绑定序列化到 JSON 节点 */
    protected abstract void toNode(ONode node, T binding);

    /**
     * 加载所有已保存的绑定凭据
     */
    public Map<String, T> load() {
        File file = storePath.toFile();
        if (!file.exists()) {
            log.debug("[{}] No credential file found at {}", logTag(), storePath);
            return Collections.emptyMap();
        }

        try {
            String content = new String(Files.readAllBytes(storePath));
            ONode root = ONode.ofJson(content);

            Map<String, T> result = new LinkedHashMap<>();

            if (root.isObject()) {
                for (Map.Entry<String, ONode> entry : root.getObject().entrySet()) {
                    T binding = fromNode(entry.getValue());
                    if (binding != null) {
                        result.put(entry.getKey(), binding);
                    }
                }
            }

            log.info("[{}] Loaded {} bindings from {}", logTag(), result.size(), storePath);
            return result;
        } catch (Exception e) {
            log.warn("[{}] Failed to load credentials from {}: {}", logTag(), storePath, e.toString());
            return Collections.emptyMap();
        }
    }

    /**
     * 保存所有绑定凭据到文件（为空则删除文件）
     */
    public void save(Map<String, T> bindings) {
        if (bindings == null || bindings.isEmpty()) {
            File file = storePath.toFile();
            if (file.exists()) {
                file.delete();
            }
            return;
        }

        try {
            Files.createDirectories(storePath.getParent());

            ONode root = new ONode(Options.of(Feature.Write_PrettyFormat));
            for (Map.Entry<String, T> entry : bindings.entrySet()) {
                ONode node = new ONode();
                toNode(node, entry.getValue());
                root.set(entry.getKey(), node);
            }

            Files.write(storePath, root.toJson().getBytes());
            log.debug("[{}] Saved {} bindings to {}", logTag(), bindings.size(), storePath);
        } catch (IOException e) {
            log.error("[{}] Failed to save credentials to {}: {}", logTag(), storePath, e.toString());
        }
    }
}
