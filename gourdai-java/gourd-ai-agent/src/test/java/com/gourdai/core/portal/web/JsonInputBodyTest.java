package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.UploadedFile;

import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * mobile-link v1.1 契约测试 —— /web/chat/input 的 JSON body + 内联 base64 附件。
 *
 * <p>设备中转链路的信封 body 是字符串，multipart 上不了桥；移动端以 JSON 提交
 * （attachments:[{name,type,dataBase64}]）。Solon 的 param() 不读 JSON body，
 * 必须经 {@link JsonInputBody} 摊平。本测试锁死：</p>
 * <ul>
 *   <li>标量/数组字段摊平语义（attachmentPaths 多值与表单重复键同构）；</li>
 *   <li>内联附件解码成 UploadedFile，字节与声明类型逐一正确；</li>
 *   <li>限额（≤10 条 / 单条 ≤4MB / 合计 ≤9MB）与坏 base64 显式 400，绝不静默丢；</li>
 *   <li>空 body / 无 attachments 的旧形态零回归。</li>
 * </ul>
 *
 * <p>限额常量与 Rust 内核 server/mod.rs::decode_inline_attachments、移动端
 * utils/attach-picker.ts 三方同值（PROTOCOL.md §4），任何一端漂移都会在此暴露。</p>
 */
public class JsonInputBodyTest {

    private static String b64(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static byte[] readAll(UploadedFile file) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = file.getContent().read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    @Test
    public void testScalarsAndArraysFlatten() {
        JsonInputBody body = JsonInputBody.parseBody(
            "{\"sessionId\":\"work-1\",\"input\":\"看图\",\"accessMode\":\"full\","
                + "\"attachmentPaths\":[\"uploads/a.png\",\"uploads/b.txt\"]}");
        Assertions.assertEquals("work-1", body.param("sessionId"));
        Assertions.assertEquals("看图", body.param("input"));
        Assertions.assertEquals("full", body.param("accessMode"));
        Assertions.assertArrayEquals(new String[]{"uploads/a.png", "uploads/b.txt"}, body.paramValues("attachmentPaths"));
        Assertions.assertNull(body.param("missing"));
        Assertions.assertNull(body.paramValues("missing"));
        Assertions.assertNull(body.filesArray());
    }

    @Test
    public void testInlineAttachmentsDecodeIntoUploadedFiles() throws Exception {
        byte[] png = new byte[]{(byte) 0x89, 'P', 'N', 'G'};
        byte[] txt = "hello".getBytes();
        JsonInputBody body = JsonInputBody.parseBody(
            "{\"input\":\"x\",\"attachments\":["
                + "{\"name\":\"a.png\",\"type\":\"image\",\"dataBase64\":\"" + b64(png) + "\"},"
                + "{\"name\":\"b.txt\",\"type\":\"file\",\"dataBase64\":\"" + b64(txt) + "\"}]}");
        UploadedFile[] files = body.filesArray();
        Assertions.assertNotNull(files);
        Assertions.assertEquals(2, files.length);
        Assertions.assertEquals("a.png", files[0].getName());
        Assertions.assertArrayEquals(png, readAll(files[0]));
        Assertions.assertArrayEquals(txt, readAll(files[1]));
        Assertions.assertArrayEquals(new String[]{"image", "file"}, body.fileTypesArray());
        // 未知声明类型回落 file（与 multipart 通道一致）
        JsonInputBody odd = JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"c.bin\",\"type\":\"video\",\"dataBase64\":\"eA==\"}]}");
        Assertions.assertArrayEquals(new String[]{"file"}, odd.fileTypesArray());
    }

    @Test
    public void testEmptyAndPlainBodiesAreNoop() {
        Assertions.assertNull(JsonInputBody.parseBody(null).param("input"));
        Assertions.assertNull(JsonInputBody.parseBody("  ").filesArray());
        Assertions.assertNull(JsonInputBody.parseBody("{\"input\":\"hi\"}").filesArray());
    }

    @Test
    public void testBadInputRejectedExplicitly() {
        // 坏 base64 / 缺名 / 缺数据 / 非数组：全部 IllegalArgumentException（→400），绝不静默丢附件
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"a\",\"type\":\"file\",\"dataBase64\":\"!!!\"}]}"));
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"\",\"type\":\"file\",\"dataBase64\":\"eA==\"}]}"));
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"a\",\"type\":\"file\",\"dataBase64\":\"\"}]}"));
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":{\"name\":\"a\"}}"));
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody("not json"));
    }

    @Test
    public void testCountAndSizeBudgets() {
        // 条数上限 10
        StringBuilder many = new StringBuilder("{\"attachments\":[");
        for (int i = 0; i < 11; i++) {
            if (i > 0) many.append(',');
            many.append("{\"name\":\"f").append(i).append("\",\"type\":\"file\",\"dataBase64\":\"eA==\"}");
        }
        many.append("]}");
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(many.toString()));

        // 单条超 4MB
        byte[] big = new byte[JsonInputBody.MAX_ITEM_BYTES + 1];
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"big\",\"type\":\"file\",\"dataBase64\":\"" + b64(big) + "\"}]}"));

        // 合计超 9MB（三条各自合法）
        byte[] chunk = new byte[4 * 1024 * 1024];
        String c = b64(chunk);
        Assertions.assertThrows(IllegalArgumentException.class, () -> JsonInputBody.parseBody(
            "{\"attachments\":["
                + "{\"name\":\"a\",\"type\":\"file\",\"dataBase64\":\"" + c + "\"},"
                + "{\"name\":\"b\",\"type\":\"file\",\"dataBase64\":\"" + c + "\"},"
                + "{\"name\":\"c\",\"type\":\"file\",\"dataBase64\":\"" + c + "\"}]}"));

        // 恰好单条上限合法
        byte[] ok = new byte[JsonInputBody.MAX_ITEM_BYTES];
        Assertions.assertNotNull(JsonInputBody.parseBody(
            "{\"attachments\":[{\"name\":\"ok\",\"type\":\"file\",\"dataBase64\":\"" + b64(ok) + "\"}]}").filesArray());
    }

    @Test
    public void testContractConstantsMatchProtocol() {
        // PROTOCOL.md §4 三方同值：改这里必须同步 Rust decode_inline_attachments 与 attach-picker.ts
        Assertions.assertEquals(10, JsonInputBody.MAX_COUNT);
        Assertions.assertEquals(4 * 1024 * 1024, JsonInputBody.MAX_ITEM_BYTES);
        Assertions.assertEquals(9 * 1024 * 1024, JsonInputBody.MAX_TOTAL_BYTES);
    }
}