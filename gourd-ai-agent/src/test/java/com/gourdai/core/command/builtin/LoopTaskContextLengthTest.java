/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.command.builtin;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * LoopTask 任务级上下文窗口（contextLength）序列化与更新测试。
 *
 * <p>覆盖：缺省为 null（跟随全局默认）、非法值归一为 null、toONode/fromONode
 * 往返（含缺失/损坏值兼容）与 copyWithUpdate 保留/覆盖。</p>
 */
class LoopTaskContextLengthTest {
    private static LoopTask taskWithContextLength(Long contextLength) {
        return new LoopTask("prompt", 5, null, null, false, null, false,
                null, null, null, contextLength, null, null);
    }

    @Test
    void defaultContextLengthShouldBeNull() {
        LoopTask task = new LoopTask("prompt", 5);

        assertNull(task.getContextLength());
    }

    @Test
    void invalidContextLengthShouldBeNormalizedToNull() {
        // 非固定选项（300000）一律归一为未设置
        LoopTask task = taskWithContextLength(300_000L);

        assertNull(task.getContextLength());
    }

    @Test
    void toONodeShouldOmitUnsetContextLength() {
        ONode node = new LoopTask("prompt", 5).toONode();

        assertNull(node.getOrNull("contextLength"));
    }

    @Test
    void roundTripShouldKeepContextLength() {
        LoopTask task = taskWithContextLength(512_000L);

        // 模拟落盘再读回（LoopScheduler 以 JSON 持久化任务定义）
        ONode parsed = ONode.ofJson(task.toONode().toJson());
        LoopTask restored = LoopTask.fromONode(parsed);

        assertEquals(512_000L, restored.getContextLength());
    }

    @Test
    void fromONodeShouldTolerateMissingAndBrokenValues() {
        LoopTask plain = new LoopTask("prompt", 5);

        // 缺失：向后兼容为 null
        assertNull(LoopTask.fromONode(plain.toONode()).getContextLength());

        // 损坏（非数值）：视为未设置
        ONode broken = plain.toONode();
        broken.set("contextLength", "oops");
        assertNull(LoopTask.fromONode(broken).getContextLength());

        // 数值但非固定选项：视为未设置
        ONode unsupported = plain.toONode();
        unsupported.set("contextLength", 300_000L);
        assertNull(LoopTask.fromONode(unsupported).getContextLength());
    }

    @Test
    void copyWithUpdateShouldKeepContextLength() {
        LoopTask task = taskWithContextLength(1_000_000L);

        LoopTask updated = task.copyWithUpdate("new prompt", 10, null, null, false, null, false);

        assertEquals(1_000_000L, updated.getContextLength());
    }

    @Test
    void copyWithUpdateShouldAllowOverridingContextLength() {
        LoopTask task = taskWithContextLength(128_000L);

        LoopTask changed = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, 1_000_000L, null, null);
        assertEquals(1_000_000L, changed.getContextLength());

        LoopTask cleared = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, null, null, null);
        assertNull(cleared.getContextLength());
    }
}
