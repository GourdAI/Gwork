/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.ai.chat.dialect;

import com.gourdai.ai.chat.ChatConfig;
import com.gourdai.ai.llm.dialect.anthropic.AnthropicChatDialect;
import com.gourdai.ai.llm.dialect.gemini.GeminiChatDialect;
import com.gourdai.ai.llm.dialect.gemini.GeminiInteractionsDialect;
import com.gourdai.ai.llm.dialect.ollama.OllamaChatDialect;
import com.gourdai.ai.llm.dialect.openai.OpenaiChatDialect;
import com.gourdai.ai.llm.dialect.openai.OpenaiResponsesDialect;
import org.noear.solon.core.util.RankEntity;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 聊天模型方言管理
 *
 * @author noear
 */
public class ChatDialectManager {
    static final Logger log = LoggerFactory.getLogger(ChatDialectManager.class);

    private static List<RankEntity<ChatDialect>> dialects = new ArrayList<>();
    private static ChatDialect defaultDialect;

    static {
        // 抽离后方言已与 core 同为本模块源码，改用直接 new 替代原来的
        // ClassUtil.tryInstance("全限定名字符串") 反射：
        //  1) 字符串类名不受编译期检查，批量改包名时一旦漏改会静默返回 null，
        //     表现为「编译通过但模型调用时方言丢失」，极难定位；
        //  2) 原反射写法是为了适配「方言作为可选模块单独引入」的场景，本项目已将
        //     所需方言全部内聪，不再存在类缺失的可能。
        // 仅恢复 Ollama 聊天方言；DashScope 仍不注册。
        register(new OpenaiChatDialect());
        register(new OpenaiResponsesDialect());
        register(new GeminiInteractionsDialect());
        register(new GeminiChatDialect());
        register(new AnthropicChatDialect());
        register(new OllamaChatDialect());
    }

    /**
     * 选择聊天方言
     *
     * @param config 聊天配置
     */
    public static ChatDialect select(ChatConfig config) {
        if (config != null) {
            for (RankEntity<ChatDialect> d : dialects) {
                if (d.target.matched(config)) {
                    return d.target;
                }
            }
        }

        return defaultDialect;
    }

    /**
     * 注册聊天方言
     *
     * @param dialect 聊天方言
     */
    public static void register(ChatDialect dialect) {
        register(dialect, 0);
    }

    /**
     * 注册方言
     *
     * @param dialect 聊天方言
     * @param index   顺序位（匹配执行顺序）
     */
    public static void register(ChatDialect dialect, int index) {
        if (dialect != null) {
            dialects.add(new RankEntity<>(dialect, index));
            Collections.sort(dialects);

            if (defaultDialect == null || dialect.isDefault()) {
                defaultDialect = dialect;
            }

            log.debug("Register chat dialect: {}", dialect.getClass());
        }
    }

    /**
     * 注销方言
     *
     * @param dialect 聊天方言
     */
    public static void unregister(ChatDialect dialect) {
        dialects.removeIf(rankEntity -> rankEntity.target == dialect);
    }
}