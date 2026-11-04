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

import com.gourdai.ai.chat.content.ImageBlock;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.UploadedFile;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * {@link LoopAttachments} 任务级附件存储测试（临时目录，不触碰真实工作区）。
 *
 * <p>覆盖：落盘位置与状态目录口径、同名冲突计数后缀、文件名安全校验（目录穿越 / 保留名 /
 * 隐藏名）、prune 只删非保留项、listMeta 大小、sizesOf 缺失填 -1、resolveRefs 的图片/文件分流、
 * deleteAll 与 normalizeNames。</p>
 */
class LoopAttachmentsStoreTest {

    private static final String TASK_ID = "abc12345";

    private static UploadedFile upload(String name, String content) {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        int dot = name.lastIndexOf('.');
        String ext = dot >= 0 ? name.substring(dot + 1) : "";
        return new UploadedFile("application/octet-stream", bytes.length,
                new ByteArrayInputStream(bytes), name, ext);
    }

    // ==================== 目录与落盘 ====================

    @Test
    void dirShouldLiveUnderTaskStateDir(@TempDir Path workspace) {
        Path dir = LoopAttachments.dir(workspace.toString(), TASK_ID);

        assertEquals(LoopStateManager.getStateDir(workspace.toString(), TASK_ID).resolve("attachments"), dir);
    }

    @Test
    void saveShouldPersistBytesAndReturnNamesWithTypes(@TempDir Path workspace) throws IOException {
        LoopAttachments.Saved saved = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("spec.png", "png-bytes"), upload("notes.pdf", "pdf-bytes")},
                new String[]{"image", "file"});

        assertEquals(Arrays.asList("spec.png", "notes.pdf"), saved.getNames());
        assertEquals(Arrays.asList("image", "file"), saved.getTypes());
        assertEquals(0, saved.getRejected());
        assertEquals(0, saved.getFailed());

        Path root = LoopAttachments.dir(workspace.toString(), TASK_ID);
        assertEquals("png-bytes", new String(Files.readAllBytes(root.resolve("spec.png")), StandardCharsets.UTF_8));
        assertEquals("pdf-bytes", new String(Files.readAllBytes(root.resolve("notes.pdf")), StandardCharsets.UTF_8));
    }

    @Test
    void saveShouldAppendCounterSuffixOnNameCollision(@TempDir Path workspace) throws IOException {
        // 任务附件是长期持久化的：同名必须拿独立名字，覆盖会让「定义里记着的那条附件」悄悄换内容
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "first")}, new String[]{"image"});

        LoopAttachments.Saved second = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "second"), upload("a.png", "third")},
                new String[]{"image", "image"});

        assertEquals(Arrays.asList("a-1.png", "a-2.png"), second.getNames());

        Path root = LoopAttachments.dir(workspace.toString(), TASK_ID);
        assertEquals("first", new String(Files.readAllBytes(root.resolve("a.png")), StandardCharsets.UTF_8));
        assertEquals("second", new String(Files.readAllBytes(root.resolve("a-1.png")), StandardCharsets.UTF_8));
        assertEquals("third", new String(Files.readAllBytes(root.resolve("a-2.png")), StandardCharsets.UTF_8));
    }

    @Test
    void saveShouldKeepCounterSuffixWhenTruncatingLongCollidingNames(@TempDir Path workspace) throws IOException {
        // 2026-10-17 review 实锤缺陷的护栏：sanitize 后恰好顶到长度上限的长名，
        // 冲突时若「先拼后缀再整体截断」会把计数后缀切掉 → 候选名塌缩回已存在原名 →
        // 1000 次探测全命中 → 返回 null → 上传被静默计为 rejected（附件凭空消失）。
        // 正确语义：先按 MAX-suffix-ext 预算截主名，再拼后缀，保证每份字节都拿到独立名字。
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) sb.append('x');
        String longName = sb + ".png"; // 204 字符，sanitize 截为 180

        LoopAttachments.Saved first = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload(longName, "first")}, new String[]{"image"});
        assertEquals(1, first.getNames().size());
        assertEquals(0, first.getRejected());
        String firstName = first.getNames().get(0);
        assertEquals(180, firstName.length());

        LoopAttachments.Saved second = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload(longName, "second")}, new String[]{"image"});
        assertEquals(0, second.getRejected(), "超长同名冲突不得被静默拒绝");
        assertEquals(1, second.getNames().size());
        String secondName = second.getNames().get(0);
        assertNotEquals(firstName, secondName, "冲突必须拿独立名字，不得覆盖");
        assertTrue(secondName.endsWith("-1.png"), "计数后缀必须保留在截断后的名字里，实际: " + secondName);
        assertTrue(secondName.length() <= 180, "截断后总长不得超上限，实际: " + secondName.length());

        Path root = LoopAttachments.dir(workspace.toString(), TASK_ID);
        assertEquals("first", new String(Files.readAllBytes(root.resolve(firstName)), StandardCharsets.UTF_8));
        assertEquals("second", new String(Files.readAllBytes(root.resolve(secondName)), StandardCharsets.UTF_8));
    }

    @Test
    void saveShouldInferFileTypeWhenTypesMissing(@TempDir Path workspace) throws IOException {
        // 类型缺失/越界时按 file 处理：只有前端显式声明 image 才升级为多模态
        LoopAttachments.Saved saved = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "x"), upload("b.pdf", "y")}, null);

        assertEquals(Arrays.asList("file", "file"), saved.getTypes());
    }

    @Test
    void saveWithNoFilesShouldNotCreateDir(@TempDir Path workspace) throws IOException {
        LoopAttachments.Saved saved = LoopAttachments.save(workspace.toString(), TASK_ID, null, null);

        assertTrue(saved.isEmpty());
        assertFalse(Files.exists(LoopAttachments.dir(workspace.toString(), TASK_ID)));
    }

    // ==================== 名称安全校验 ====================

    @Test
    void sanitizeShouldRejectTraversalAndSeparators() {
        assertNull(LoopAttachments.sanitizeName("../etc/passwd"));
        assertNull(LoopAttachments.sanitizeName(".."));
        assertNull(LoopAttachments.sanitizeName("."));
        assertNull(LoopAttachments.sanitizeName("dir/a.png"));
        assertNull(LoopAttachments.sanitizeName("dir\\a.png"));
        assertNull(LoopAttachments.sanitizeName("C:\\Windows\\a.png"));
        assertNull(LoopAttachments.sanitizeName("a\u0000.png"));
        assertNull(LoopAttachments.sanitizeName(""));
        assertNull(LoopAttachments.sanitizeName("   "));
        assertNull(LoopAttachments.sanitizeName(null));
    }

    @Test
    void sanitizeShouldRejectHiddenAndWindowsReservedNames() {
        assertNull(LoopAttachments.sanitizeName(".hidden.png"));
        assertNull(LoopAttachments.sanitizeName("CON"));
        assertNull(LoopAttachments.sanitizeName("con.txt"));
        assertNull(LoopAttachments.sanitizeName("NUL."));
        assertNull(LoopAttachments.sanitizeName("LPT9"));
        assertNull(LoopAttachments.sanitizeName("COM1.log"));
        // 正常名字放行（trim 后原样返回）
        assertEquals("a.png", LoopAttachments.sanitizeName("  a.png  "));
        assertEquals("报告.pdf", LoopAttachments.sanitizeName("报告.pdf"));
    }

    @Test
    void sanitizeShouldTruncateOverlongNameKeepingExtension(@TempDir Path workspace) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 400; i++) {
            sb.append('x');
        }
        String longName = sb + ".png";

        String safe = LoopAttachments.sanitizeName(longName);

        assertNotNull(safe);
        assertTrue(safe.length() <= 180, "name should be truncated, got length " + safe.length());
        assertTrue(safe.endsWith(".png"), "extension should be preserved: " + safe);
    }

    @Test
    void saveShouldRejectUnsafeNamesWithoutFailingBatch(@TempDir Path workspace) throws IOException {
        LoopAttachments.Saved saved = LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("../evil.png", "x"), upload("ok.png", "y")},
                new String[]{"image", "image"});

        assertEquals(Collections.singletonList("ok.png"), saved.getNames());
        assertEquals(1, saved.getRejected());
        // 目录穿越的文件绝不能落在附件目录之外
        assertFalse(Files.exists(workspace.resolve("evil.png")));
        assertTrue(Files.exists(LoopAttachments.dir(workspace.toString(), TASK_ID).resolve("ok.png")));
    }

    @Test
    void resolveShouldRejectUnsafeNames(@TempDir Path workspace) {
        assertNull(LoopAttachments.resolve(workspace.toString(), TASK_ID, "../outside.png"));
        assertNull(LoopAttachments.resolve(workspace.toString(), TASK_ID, "CON"));
        assertNotNull(LoopAttachments.resolve(workspace.toString(), TASK_ID, "a.png"));
    }

    // ==================== 元信息 ====================

    @Test
    void listMetaShouldReturnExistingFileSizes(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "12345"), upload("b.pdf", "abc")},
                new String[]{"image", "file"});

        Map<String, Long> meta = LoopAttachments.listMeta(workspace.toString(), TASK_ID);

        assertEquals(2, meta.size());
        assertEquals(5L, meta.get("a.png"));
        assertEquals(3L, meta.get("b.pdf"));
    }

    @Test
    void listMetaShouldBeEmptyWhenDirMissing(@TempDir Path workspace) {
        assertTrue(LoopAttachments.listMeta(workspace.toString(), TASK_ID).isEmpty());
        assertEquals(0L, LoopAttachments.totalSize(workspace.toString(), TASK_ID));
    }

    @Test
    void sizesOfShouldKeepOrderAndFillMissingWithMinusOne(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "12345")}, new String[]{"image"});

        Map<String, Long> meta = LoopAttachments.listMeta(workspace.toString(), TASK_ID);
        List<Long> sizes = LoopAttachments.sizesOf(meta, Arrays.asList("a.png", "gone.pdf"));

        // sizes 与 paths 同序，读不到的填 -1（跳过会让前端徽标错位）
        assertEquals(Arrays.asList(5L, -1L), sizes);
        assertTrue(LoopAttachments.sizesOf(meta, null).isEmpty());
    }

    // ==================== 注入解析 ====================

    @Test
    void resolveRefsShouldSplitImageBlocksAndFilePaths(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("shot.png", "img-bytes"), upload("notes.pdf", "pdf-bytes")},
                new String[]{"image", "file"});

        List<ImageBlock> images = new ArrayList<>();
        List<String> files = new ArrayList<>();
        LoopAttachments.resolveRefs(workspace.toString(), TASK_ID,
                Arrays.asList("shot.png", "notes.pdf"), Arrays.asList("image", "file"), images, files);

        assertEquals(1, images.size());
        assertEquals(1, files.size());
        // 文件引用必须是绝对路径：AI 拿它去真的读文件，相对路径会随 cwd 漂移
        Path expected = LoopAttachments.dir(workspace.toString(), TASK_ID).resolve("notes.pdf")
                .toAbsolutePath().normalize();
        assertEquals(expected.toString(), files.get(0));
    }

    @Test
    void resolveRefsShouldTreatDeclaredFileAsTextEvenForPng(@TempDir Path workspace) throws IOException {
        // 前端允许把 png 当普通文件引用；按扩展名猜会把它错误升级成多模态图片
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("shot.png", "img-bytes")}, new String[]{"file"});

        List<ImageBlock> images = new ArrayList<>();
        List<String> files = new ArrayList<>();
        LoopAttachments.resolveRefs(workspace.toString(), TASK_ID,
                Collections.singletonList("shot.png"), Collections.singletonList("file"), images, files);

        assertTrue(images.isEmpty());
        assertEquals(1, files.size());
    }

    @Test
    void resolveRefsShouldSkipMissingAndMalformedEntries(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("ok.png", "img-bytes")}, new String[]{"image"});

        List<ImageBlock> images = new ArrayList<>();
        List<String> files = new ArrayList<>();
        // 单条损坏只跳过：定时任务无人值守，不能因一张图读不回来而放弃整轮执行
        LoopAttachments.resolveRefs(workspace.toString(), TASK_ID,
                Arrays.asList("../evil.png", "gone.png", "ok.png"),
                Arrays.asList("image", "image", "image"), images, files);

        assertEquals(1, images.size());
        assertTrue(files.isEmpty());
        assertFalse(Files.exists(workspace.resolve("evil.png")));

        // 空清单/null 直接返回，不抛异常
        images.clear();
        LoopAttachments.resolveRefs(workspace.toString(), TASK_ID, null, null, images, files);
        assertTrue(images.isEmpty());
    }

    @Test
    void imageMimeShouldMapExtensions() {
        assertEquals("image/jpeg", LoopAttachments.imageMime(".jpg"));
        assertEquals("image/jpeg", LoopAttachments.imageMime(".jpeg"));
        assertEquals("image/png", LoopAttachments.imageMime(".png"));
        assertEquals("image/gif", LoopAttachments.imageMime(".gif"));
        assertEquals("image/webp", LoopAttachments.imageMime(".webp"));
        assertEquals("image/bmp", LoopAttachments.imageMime(".bmp"));
        assertEquals("image/svg+xml", LoopAttachments.imageMime(".svg"));
        assertEquals("image/png", LoopAttachments.imageMime(".unknown"));
        assertEquals("image/png", LoopAttachments.imageMime(null));
    }

    // ==================== 清理 ====================

    @Test
    void pruneShouldDeleteOnlyNonKeptFiles(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "1"), upload("b.pdf", "2"), upload("c.png", "3")},
                new String[]{"image", "file", "image"});
        Path root = LoopAttachments.dir(workspace.toString(), TASK_ID);

        LoopAttachments.prune(workspace.toString(), TASK_ID, Arrays.asList("a.png", "c.png"));

        assertTrue(Files.exists(root.resolve("a.png")));
        assertFalse(Files.exists(root.resolve("b.pdf")));
        assertTrue(Files.exists(root.resolve("c.png")));
    }

    @Test
    void pruneShouldIgnoreUnsafeKeepEntriesAndTolerateMissingDir(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "1")}, new String[]{"image"});

        // keep 里的非法名字既不算保留，也不会被拼成路径去删盘
        LoopAttachments.prune(workspace.toString(), TASK_ID, Arrays.asList("../a.png", "CON"));
        assertFalse(Files.exists(LoopAttachments.dir(workspace.toString(), TASK_ID).resolve("a.png")));

        // 目录不存在时静默返回（任务从未上传过附件）
        assertDoesNotThrow(() -> LoopAttachments.prune(workspace.toString(), "no-such-task", null));
    }

    @Test
    void pruneWithNullKeepShouldClearAllFiles(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "1")}, new String[]{"image"});

        LoopAttachments.prune(workspace.toString(), TASK_ID, null);

        assertTrue(LoopAttachments.listMeta(workspace.toString(), TASK_ID).isEmpty());
    }

    @Test
    void deleteAllShouldRemoveAttachmentsDir(@TempDir Path workspace) throws IOException {
        LoopAttachments.save(workspace.toString(), TASK_ID,
                new UploadedFile[]{upload("a.png", "1"), upload("b.pdf", "2")},
                new String[]{"image", "file"});
        Path root = LoopAttachments.dir(workspace.toString(), TASK_ID);
        assertTrue(Files.isDirectory(root));

        LoopAttachments.deleteAll(workspace.toString(), TASK_ID);

        assertFalse(Files.exists(root));
        // 状态目录本身不受影响（history.json 等仍归 LoopStateManager 管）
        assertTrue(Files.isDirectory(LoopStateManager.getStateDir(workspace.toString(), TASK_ID)));
        // 幂等：目录已不存在时不抛异常
        assertDoesNotThrow(() -> LoopAttachments.deleteAll(workspace.toString(), TASK_ID));
    }

    @Test
    void normalizeNamesShouldStripPrefixesDropUnsafeAndDedupe() {
        List<String> out = LoopAttachments.normalizeNames(Arrays.asList(
                "attachments/a.png", "C:\\tmp\\b.pdf", "a.png", "A.PNG", "../evil.png", "", null, "CON"));

        // 取 basename → 校验 → 去重（Windows/远端部署下大小写不可靠，视同名）
        assertEquals(Arrays.asList("a.png", "b.pdf"), out);
        assertTrue(LoopAttachments.normalizeNames(null).isEmpty());
    }

    @Test
    void isImageShouldRequireDeclaredTypeAndKnownExtension() {
        assertTrue(LoopAttachments.isImage(".png", "image"));
        assertTrue(LoopAttachments.isImage(".PNG".toLowerCase(), "image"));
        assertFalse(LoopAttachments.isImage(".png", "file"));
        assertFalse(LoopAttachments.isImage(".png", null));
        assertFalse(LoopAttachments.isImage(".pdf", "image"));
        assertFalse(LoopAttachments.isImage("", "image"));
    }
}
