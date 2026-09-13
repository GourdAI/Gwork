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
package com.gourdai.agent.react.intercept;

import com.knuddels.jtokkit.api.Encoding;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 分词器惰性初始化的回归护栏。
 *
 * <p>背景：{@link ContextCompressionInterceptor} 被 {@code HarnessEngine} 构造期引用，其 clinit
 * 落在 Solon 启动主线程、HTTP 端口绑定之前。旧实现在 clinit 里用
 * {@code Encodings.newDefaultEncodingRegistry()} 即时构建 BPE 词表（cl100k + o200k 两套，
 * 实测 0.8~1.7s），把整段成本压进冷启动——而它在用户发出第一条消息之前毫无用处。
 * 现在改为 holder 惰 + {@code newLazyEncodingRegistry()}。</p>
 *
 * <p>本类用**结构性断言**而非计时断言：计时断言在 CI 慢机上会飘，结构性断言则稳定地
 * 钉住「静态 Encoding 字段存在即等于把词表构建拖回 clinit」这个唯一失效模式。</p>
 */
class ContextCompressionInterceptorEncodingTest {

    @Test
    @DisplayName("不得存在 static Encoding / EncodingRegistry 字段（否则词表构建会回到 clinit）")
    void noStaticEncodingField() {
        for (Field f : ContextCompressionInterceptor.class.getDeclaredFields()) {
            if (!Modifier.isStatic(f.getModifiers())) {
                continue;
            }
            assertFalse(Encoding.class.isAssignableFrom(f.getType()),
                    "静态 Encoding 字段会让词表构建重新进入 clinit（拖慢冷启动）: " + f);
            assertFalse(f.getType().getName().endsWith("EncodingRegistry"),
                    "静态 EncodingRegistry 字段同样会在 clinit 里构建全部默认编码: " + f);
        }
    }

    @Test
    @DisplayName("首次调用才构建分词器：可用、且多次调用复用同一实例")
    void encodingIsLazyAndCached() throws Exception {
        Method m = ContextCompressionInterceptor.class.getDeclaredMethod("encoding");
        m.setAccessible(true);

        Object first = m.invoke(null);
        assertNotNull(first, "惰性持有者必须能构建出分词器");
        assertTrue(first instanceof Encoding);

        int tokens = ((Encoding) first).countTokens("hello, world");
        assertTrue(tokens > 0, "分词器应能正常计数: " + tokens);

        // holder 惯用法保证只构建一次
        assertSame(first, m.invoke(null), "分词器必须复用同一个实例（holder 只初始化一次）");
    }
}
