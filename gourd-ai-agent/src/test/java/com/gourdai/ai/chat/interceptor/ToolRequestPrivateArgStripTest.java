/*
 * Copyright 2017-2026 noear.org and authors
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

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P1 契约：模型参数中的 {@code __} 前缀私有键必须被剔除。
 *
 * <p>攻击面：工具方法签名里的 {@code String __accessMode} / {@code String __cwd} 尾参由
 * 框架 toolsContext 填充。若模型在工具参数 JSON 里伪造同形键（如 {@code __accessMode=full}），
 * 旧实现的合并方向（args 先放、toolsContext 后覆盖）在 toolsContext <b>缺失该键</b>的场合
 * 会让伪造值直通到工具方法——模型由此抬升自己的权限档位。</p>
 *
 * <p>本测试锁定修复后的契约：注入方向只有 toolsContext -> args，模型侧同名键一律丢弃。</p>
 */
class ToolRequestPrivateArgStripTest {

    private ToolRequest build(Map<String, Object> args, Map<String, Object> toolsContext) {
        // request 在合并逻辑中只做持有，不参与键合并；测试焦点在 args/toolsContext
        return new ToolRequest(null, toolsContext, args);
    }

    @Test
    void modelForgedAccessModeIsStripped() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "ls");
        args.put("__accessMode", "full");          // 模型伪造的档位键
        args.put("__cwd", "C:\\Windows");          // 模型伪造的目录键

        // 框架侧本次只注入 __accessMode（注入方向只有框架 -> args）
        Map<String, Object> ctx = new HashMap<>();
        ctx.put("__accessMode", "default");

        ToolRequest request = build(args, ctx);

        assertEquals("default", request.getArgs().get("__accessMode"), "框架注入值必须胜出");
        assertNull(request.getArgs().get("__cwd"), "未被框架注入的 __ 键必须被剔除");
        assertEquals("ls", request.getArgs().get("command"), "普通参数不受影响");
    }

    @Test
    void privateKeysStrippedEvenWithoutToolsContext() {
        // toolsContext 为空：旧实现会把 args 原样透传，伪造键直达工具
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "src/App.java");
        args.put("__accessMode", "full");

        ToolRequest request = build(args, null);

        assertNull(request.getArgs().get("__accessMode"));
        assertEquals("src/App.java", request.getArgs().get("file_path"));
    }

    @Test
    void normalArgsAndSingleUnderscoreKeysSurvive() {
        // 单下划线前缀不是私有通道（模型可正常传 _internal 之类的业务键）
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("_note", "keep me");
        args.put("x", 1);

        ToolRequest request = build(args, null);

        assertEquals("keep me", request.getArgs().get("_note"));
        assertEquals(1, request.getArgs().get("x"));
        assertFalse(request.getArgs().containsKey("__"));
    }

    @Test
    void toolsContextStillOverridesModelArgs() {
        // 同名普通键：框架注入覆盖模型值（既有语义保持）
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "echo model");

        Map<String, Object> ctx = new HashMap<>();
        ctx.put("command", "echo framework");

        ToolRequest request = build(args, ctx);

        assertEquals("echo framework", request.getArgs().get("command"));
    }

    @Test
    void originalModelArgsMapNotMutated() {
        // stripPrivateArgs 做防御性拷贝：调用方持有的原 map 不能被改
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("__accessMode", "full");
        Map<String, Object> ctx = new HashMap<>();
        ctx.put("__accessMode", "default");

        ToolRequest request = build(args, ctx);

        assertEquals("full", args.get("__accessMode"), "原 map 不应被修改");
        assertEquals("default", request.getArgs().get("__accessMode"));
    }

    @Test
    void nullAndEmptyArgsAreSafe() {
        ToolRequest request = build(null, null);
        assertTrue(request.getArgs().isEmpty());

        ToolRequest request2 = build(new HashMap<>(), null);
        assertTrue(request2.getArgs().isEmpty());
    }
}
