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
package com.gourdai.ai.chat.interceptor;

import org.noear.solon.Utils;
import com.gourdai.ai.chat.ChatRequest;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 工具请求
 *
 * @author noear
 * @since 3.3
 */
public class ToolRequest {
    private final ChatRequest request;
    private final Map<String, Object> toolsContext;
    private Map<String, Object> args;

    public ToolRequest(ChatRequest request, Map<String, Object> toolsContext, Map<String, Object> args) {
        //允许拦截器修改参数和上下文集合（不要只读）
        this.request = request;
        this.toolsContext = toolsContext;

        // 安全边界：args 来自模型输出，toolsContext 来自框架注入。以 "__" 开头的键是框架
        // 私有通道（如 __cwd / __accessMode），模型传来的同名键必须全部剔除——否则模型可以
        // 伪造 __accessMode=full 之类直接抬高自己的权限档位。注入方向只有 toolsContext -> args。
        Map<String, Object> safeArgs = stripPrivateArgs(args);

        if (Utils.isEmpty(toolsContext)) {
            this.args = safeArgs;
        } else {
            Map<String, Object> tmp = new LinkedHashMap<>(safeArgs);
            tmp.putAll(toolsContext);
            this.args = tmp;
        }
    }

    /**
     * 剔除模型参数中以 {@code __} 开头的私有键（防御性拷贝，不改原 map）。
     *
     * <p>工具方法签名中的 {@code String __cwd} / {@code String __accessMode} 等尾参只应
     * 由框架的 toolsContext 填充；args 里出现同形键即视为越权注入，直接丢弃。</p>
     */
    private static Map<String, Object> stripPrivateArgs(Map<String, Object> args) {
        if (args == null || args.isEmpty()) {
            return new LinkedHashMap<>();
        }
        Map<String, Object> result = new LinkedHashMap<>(args.size());
        for (Map.Entry<String, Object> entry : args.entrySet()) {
            if (entry.getKey() != null && entry.getKey().startsWith("__")) {
                continue;
            }
            result.put(entry.getKey(), entry.getValue());
        }
        return result;
    }

    /**
     * 获取模型请求
     */
    public ChatRequest getRequest() {
        return request;
    }

    /*
     * 获取工具上下文
     */
    public Map<String, Object> getToolsContext() {
        return toolsContext;
    }

    /**
     * 获取参数
     */
    public Map<String, Object> getArgs() {
        return args;
    }
}