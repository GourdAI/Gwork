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

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * LoopTask 任务级附件（attachmentPaths / attachmentTypes）序列化与更新测试。
 *
 * <p>覆盖：缺省为空 list（非 null，调用方不必判空）、不可变视图、toONode/fromONode 往返、
 * 空清单不写节点、缺失/损坏节点向后兼容、copyWithUpdate 的「null 沿用 / 非 null 覆盖」语义。</p>
 */
class LoopTaskAttachmentsTest {

    private static LoopTask taskWithAttachments(List<String> paths, List<String> types) {
        return new LoopTask("prompt", 5, null, null, false, null, false,
                null, null, null, null, null, null, null, paths, types);
    }

    // ==================== 构造与归一 ====================

    @Test
    void defaultAttachmentsShouldBeEmptyLists() {
        LoopTask task = new LoopTask("prompt", 5);

        assertNotNull(task.getAttachmentPaths());
        assertNotNull(task.getAttachmentTypes());
        assertTrue(task.getAttachmentPaths().isEmpty());
        assertTrue(task.getAttachmentTypes().isEmpty());
    }

    @Test
    void nullAttachmentsShouldBecomeEmptyLists() {
        LoopTask task = taskWithAttachments(null, null);

        assertTrue(task.getAttachmentPaths().isEmpty());
        assertTrue(task.getAttachmentTypes().isEmpty());
    }

    @Test
    void attachmentGettersShouldReturnImmutableViews() {
        LoopTask task = taskWithAttachments(Arrays.asList("a.png"), Arrays.asList("image"));

        assertThrows(UnsupportedOperationException.class, () -> task.getAttachmentPaths().add("b.png"));
        assertThrows(UnsupportedOperationException.class, () -> task.getAttachmentTypes().add("file"));
    }

    @Test
    void constructionShouldCopyAndDropBlankEntries() {
        List<String> paths = new ArrayList<>(Arrays.asList("a.png", "  ", null, "b.pdf"));
        List<String> types = new ArrayList<>(Arrays.asList("image", "file", "image", "file"));

        LoopTask task = taskWithAttachments(paths, types);

        // 空白/ null 条目被丢弃，顺序保持
        assertEquals(Arrays.asList("a.png", "b.pdf"), task.getAttachmentPaths());
        assertEquals(Arrays.asList("image", "file", "image", "file"), task.getAttachmentTypes());

        // 传入的 list 被复制：之后改它不会影响任务定义（否则「任务记着的附件」会被外部悄悄换掉）
        paths.set(0, "hacked.png");
        assertEquals("a.png", task.getAttachmentPaths().get(0));
    }

    // ==================== 序列化 ====================

    @Test
    void toONodeShouldOmitEmptyAttachments() {
        ONode node = new LoopTask("prompt", 5).toONode();

        assertNull(node.getOrNull("attachmentPaths"));
        assertNull(node.getOrNull("attachmentTypes"));
    }

    @Test
    void roundTripShouldKeepAttachmentsInOrder() {
        LoopTask task = taskWithAttachments(
                Arrays.asList("spec.png", "notes.pdf", "spec-1.png"),
                Arrays.asList("image", "file", "image"));

        // 模拟落盘再读回（LoopScheduler 以 JSON 持久化任务定义）
        ONode parsed = ONode.ofJson(task.toONode().toJson());
        LoopTask restored = LoopTask.fromONode(parsed);

        assertEquals(Arrays.asList("spec.png", "notes.pdf", "spec-1.png"), restored.getAttachmentPaths());
        assertEquals(Arrays.asList("image", "file", "image"), restored.getAttachmentTypes());
        // 身份字段不受附件改造影响
        assertEquals(task.getId(), restored.getId());
        assertEquals(task.getPrompt(), restored.getPrompt());
    }

    @Test
    void fromONodeShouldTolerateMissingAndBrokenAttachments() {
        LoopTask plain = new LoopTask("prompt", 5);

        // 缺失（旧版本任务文件）：向后兼容为空 list
        LoopTask missing = LoopTask.fromONode(plain.toONode());
        assertTrue(missing.getAttachmentPaths().isEmpty());
        assertTrue(missing.getAttachmentTypes().isEmpty());

        // 非数组（脏写入）：视为无附件，不得让任务恢复失败
        ONode notArray = plain.toONode();
        notArray.set("attachmentPaths", "oops");
        assertTrue(LoopTask.fromONode(notArray).getAttachmentPaths().isEmpty());

        // 数组内含空白条目：跳过空白项，保留合法项
        ONode withBlanks = plain.toONode();
        ONode arr = new ONode();
        arr.add("a.png");
        arr.add("");
        arr.add(null);
        withBlanks.set("attachmentPaths", arr);
        assertEquals(Collections.singletonList("a.png"), LoopTask.fromONode(withBlanks).getAttachmentPaths());
    }

    // ==================== copyWithUpdate ====================

    @Test
    void copyWithUpdateShouldKeepAttachmentsWhenNull() {
        LoopTask task = taskWithAttachments(Arrays.asList("a.png"), Arrays.asList("image"));

        // 七参重载：不声明附件 → 沿用原值
        LoopTask updated = task.copyWithUpdate("new prompt", 10, null, null, false, null, false);

        assertEquals(Collections.singletonList("a.png"), updated.getAttachmentPaths());
        assertEquals(Collections.singletonList("image"), updated.getAttachmentTypes());
        assertEquals("new prompt", updated.getPrompt());
    }

    @Test
    void copyWithUpdateLegacyContextOverloadShouldKeepAttachments() {
        LoopTask task = taskWithAttachments(Arrays.asList("a.png"), Arrays.asList("image"));

        // 十四参旧重载（不带附件）：委托时必须传 null 而非空 list，否则会静默清空任务附件
        LoopTask updated = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, null, task.getAccessMode(), null, null);

        assertEquals(Collections.singletonList("a.png"), updated.getAttachmentPaths());
        assertEquals(Collections.singletonList("image"), updated.getAttachmentTypes());
    }

    @Test
    void copyWithUpdateShouldAllowOverridingAndClearingAttachments() {
        LoopTask task = taskWithAttachments(Arrays.asList("a.png"), Arrays.asList("image"));

        LoopTask changed = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, null, task.getAccessMode(), null, null,
                Arrays.asList("b.pdf"), Arrays.asList("file"));
        assertEquals(Collections.singletonList("b.pdf"), changed.getAttachmentPaths());
        assertEquals(Collections.singletonList("file"), changed.getAttachmentTypes());

        // 空 list = 显式清空（区别于 null = 沿用）
        LoopTask cleared = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, null, task.getAccessMode(), null, null,
                Collections.emptyList(), Collections.emptyList());
        assertTrue(cleared.getAttachmentPaths().isEmpty());
        assertTrue(cleared.getAttachmentTypes().isEmpty());
        assertNull(cleared.toONode().getOrNull("attachmentPaths"));
    }

    @Test
    void copyWithUpdateShouldPreserveIdentityAndEnableState() {
        LoopTask task = taskWithAttachments(Arrays.asList("a.png"), Arrays.asList("image"));
        task.setEnabled(false);
        task.setName("nightly");

        LoopTask updated = task.copyWithUpdate("p", 5, null, null, false, null, false,
                null, null, null, null, null, null, null, null, null);

        assertEquals(task.getId(), updated.getId());
        assertEquals(task.getCreatedAt(), updated.getCreatedAt());
        assertEquals(task.getExpireAt(), updated.getExpireAt());
        assertFalse(updated.isEnabled());
        assertEquals(Collections.singletonList("a.png"), updated.getAttachmentPaths());
    }
}
