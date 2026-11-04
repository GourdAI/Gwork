/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.ai.integration;

import com.gourdai.ai.chat.dialect.ChatDialect;
import com.gourdai.ai.chat.dialect.ChatDialectManager;
import org.noear.solon.core.AppContext;
import org.noear.solon.core.Plugin;

/**
 * AI 插件：把容器中注册为 Bean 的自定义方言并入方言管理器。
 *
 * <p>由 {@code META-INF/solon/solon-ai-core.properties} 声明加载。该文件与本类
 * 必须成对存在——properties 指向的类若不存在，插件会静默不加载，表现为
 * 「自定义方言注册后不生效」且无任何报错，极难定位。</p>
 *
 * <p>相比上游原版，这里只保留 ChatDialect 一种：embedding / generate / reranking
 * 三类方言在本次抽离中已整体裁剪（本项目零使用），其 Manager 类不存在。</p>
 *
 * @author noear
 * @since 3.1
 */
public class AiPlugin implements Plugin {
    @Override
    public void start(AppContext context) throws Throwable {
        context.subBeansOfType(ChatDialect.class, bean -> {
            ChatDialectManager.register(bean);
        });
    }
}
