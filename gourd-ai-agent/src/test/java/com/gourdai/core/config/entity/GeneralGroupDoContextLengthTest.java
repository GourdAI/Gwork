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
package com.gourdai.core.config.entity;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import static org.junit.jupiter.api.Assertions.*;

/**
 * GeneralGroupDo.acpContextLength 的持久化链路测试。
 *
 * <p>验证 settings.json 的 general 段（保存走 {@code ONode.fill}、加载走
 * {@code ONode.bindTo}）对 Long 字段的读写支持，确保 ACP 上下文窗口可长期落盘。</p>
 */
class GeneralGroupDoContextLengthTest {
    @Test
    void fillAndBindShouldRoundTripLongContextLength() {
        GeneralGroupDo source = new GeneralGroupDo();
        source.setAcpModel("gpt-test");
        source.setAcpContextLength(512_000L);

        // 保存链路：oNode.getOrNew("general").fill(general)
        ONode root = new ONode();
        root.getOrNew("general").fill(source);

        // 模拟磁盘往返（settings.json 持久化）
        ONode reloaded = ONode.ofJson(root.toJson());

        // 加载链路：oNode.bindTo(settings) 时对 general 子节点的字段绑定
        GeneralGroupDo target = new GeneralGroupDo();
        reloaded.get("general").bindTo(target);

        assertEquals("gpt-test", target.getAcpModel());
        assertEquals(512_000L, target.getAcpContextLength());
    }

    @Test
    void bindShouldTolerateMissingContextLength() {
        GeneralGroupDo source = new GeneralGroupDo();
        ONode root = new ONode();
        root.getOrNew("general").fill(source);

        GeneralGroupDo target = new GeneralGroupDo();
        ONode.ofJson(root.toJson()).get("general").bindTo(target);

        assertNull(target.getAcpContextLength());
    }
}
