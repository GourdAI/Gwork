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
package com.gourdai.core.portal.web;

import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.UploadedFile;
import org.noear.snack4.ONode;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON 请求体解析（mobile-link v1.1，PROTOCOL.md §4）。
 *
 * <p>设备中转链路的信封 body 是字符串，multipart 过不了桥，因此移动端把附件以
 * {@code attachments:[{name,type,dataBase64}]} 内联在 JSON body 里。Solon 的
 * {@code ctx.param()} 只读 urlencoded 表单/multipart，不读 JSON body——不先经本类
 * 摊平，整条 JSON 输入会被静默当成空表单（sessionId 丢失、input 为空）。</p>
 *
 * <p>解析结果分两部分：标量字段摊成表单参数（供 {@code ctx.param()} 读取），
 * 内联附件解码成 {@link UploadedFile}（内存流包装，走与 multipart 完全相同的
 * {@code WebGate.saveAttachments} 落盘/命名/注入链路）。任何超限或坏 base64
 * 都显式抛 {@link IllegalArgumentException}，由控制器转 400，绝不静默丢附件。</p>
 *
 * <p>仅处理 {@code application/json}（或 body 以 <code>{</code> 开头）的请求；
 * 表单与 multipart 请求原样放行，桌面端行为不变。</p>
 *
 * @author oisin
 */
final class JsonInputBody {

    /** 契约限额（PROTOCOL.md §4）：≤10 条、单条解码后 ≤4MB、合计 ≤9MB。 */
    static final int MAX_COUNT = 10;
    static final int MAX_ITEM_BYTES = 4 * 1024 * 1024;
    static final int MAX_TOTAL_BYTES = 9 * 1024 * 1024;

    /** 摊平后的标量参数（数组字段保留多值，与表单重复键同构）。 */
    final Map<String, List<String>> params = new LinkedHashMap<>();
    /** 内联附件解码产物，顺序与请求一致。 */
    final List<UploadedFile> files = new ArrayList<>();
    /** 与 files 一一对应的类型声明（image / file）。 */
    final List<String> fileTypes = new ArrayList<>();

    private JsonInputBody() {
    }

    /** 是否为需要摊平的 JSON 请求（按声明或内容嗅探，与 Rust 内核 InputPayload 同序）。 */
    static boolean looksLikeJson(Context ctx) {
        String ct = ctx.contentType();
        if (ct != null && ct.contains("application/json")) {
            return true;
        }
        try {
            String body = ctx.body();
            return body != null && body.trim().startsWith("{");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 解析并校验 JSON body。非法输入抛 IllegalArgumentException（→400）。
     * 空 body 合法（恢复路径只带自己的键）。
     */
    static JsonInputBody parse(Context ctx) throws Exception {
        return parseBody(ctx.body());
    }

    /** 纯字符串入口（契约测试用；ctx.body() 读侧与本解析逻辑解耦）。 */
    static JsonInputBody parseBody(String body) {
        JsonInputBody out = new JsonInputBody();
        if (body == null || body.trim().isEmpty()) {
            return out;
        }
        ONode root;
        try {
            root = ONode.ofJson(body);
        } catch (RuntimeException e) {
            // snack4 的解析异常不是 IllegalArgumentException：统一转 400 口径
            throw new IllegalArgumentException("invalid JSON body");
        }
        if (root == null || !root.isObject()) {
            throw new IllegalArgumentException("invalid JSON body");
        }
        for (Map.Entry<String, ONode> entry : root.getObject().entrySet()) {
            String key = entry.getKey();
            ONode v = entry.getValue();
            if (v == null || v.isNull()) continue;
            if ("attachments".equals(key)) {
                out.decodeAttachments(v);
                continue;
            }
            if (v.isArray()) {
                List<String> values = new ArrayList<>();
                for (ONode item : v.getArray()) {
                    if (item != null && !item.isNull()) values.add(item.getString());
                }
                if (!values.isEmpty()) out.params.put(key, values);
            } else if (v.isObject()) {
                // 未知的对象字段：按 JSON 原文透传（questionAnswer 兼容对象形态）
                out.params.put(key, List.of(v.toJson()));
            } else {
                out.params.put(key, List.of(v.getString()));
            }
        }
        return out;
    }

    private void decodeAttachments(ONode arr) {
        if (!arr.isArray()) {
            throw new IllegalArgumentException("attachments must be an array");
        }
        List<ONode> items = arr.getArray();
        if (items.size() > MAX_COUNT) {
            throw new IllegalArgumentException("too many attachments (max " + MAX_COUNT + ")");
        }
        int total = 0;
        for (int i = 0; i < items.size(); i++) {
            ONode item = items.get(i);
            String name = item.get("name").getString();
            String type = item.get("type").getString();
            String b64 = item.get("dataBase64").getString();
            if (name == null || name.trim().isEmpty()) {
                throw new IllegalArgumentException("attachment #" + (i + 1) + " has no name");
            }
            if (b64 == null || b64.isEmpty()) {
                throw new IllegalArgumentException("attachment #" + (i + 1) + " has no data");
            }
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(b64);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("attachment #" + (i + 1) + " is not valid base64");
            }
            if (bytes.length > MAX_ITEM_BYTES) {
                throw new IllegalArgumentException("attachment #" + (i + 1) + " exceeds 4MB");
            }
            total += bytes.length;
            if (total > MAX_TOTAL_BYTES) {
                throw new IllegalArgumentException("attachments exceed 9MB in total");
            }
            // 构造参数序有坑（字节码实证）：三参 (a, stream, b) 把 a 当 contentType；
            // 五参 (contentType, size, stream, name, extension) —— 第 4 参才是文件名。
            // contentType 传空：类型判定交给 saveAttachments 的声明类型+扩展名规则，
            // 与 multipart 通道完全一致。
            String ext = "";
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                ext = name.substring(dot + 1);
            }
            files.add(new UploadedFile("", bytes.length, new ByteArrayInputStream(bytes), name, ext));
            fileTypes.add("image".equals(type) ? "image" : "file");
        }
    }

    /** 单值参数（数组字段取第一个，与 Solon 表单绑定同语义）。 */
    String param(String key) {
        List<String> values = params.get(key);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    /** 多值参数（attachmentPaths / attachmentTypes 等重复键字段）。 */
    String[] paramValues(String key) {
        List<String> values = params.get(key);
        return values == null ? null : values.toArray(new String[0]);
    }

    UploadedFile[] filesArray() {
        return files.isEmpty() ? null : files.toArray(new UploadedFile[0]);
    }

    String[] fileTypesArray() {
        return fileTypes.isEmpty() ? null : fileTypes.toArray(new String[0]);
    }
}