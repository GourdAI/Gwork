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
package com.gourdai.ai.util;

import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.yaml.snakeyaml.Yaml;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 有元数据（YamlFrontmatter）的 markdown 文档工具
 *
 * @author noear
 * @since 3.9.6
 */
public class MarkdownUtil {
    private static final Logger LOG = LoggerFactory.getLogger(MarkdownUtil.class);

    /**
     * 分析有元数据（YamlFrontmatter）的 markdown 文档
     */
    public static Markdown resolve(List<String> markdownLines) {
        return resolve(markdownLines, false);
    }

    /**
     * 分析有元数据（YamlFrontmatter）的 markdown 文档
     *
     * @param onlyFrontmatter 只解析原数据
     */
    public static Markdown resolve(List<String> markdownLines, boolean onlyFrontmatter) {
        Markdown markdown = new Markdown();
        if (Assert.isEmpty(markdownLines)) {
            return markdown;
        }

        // BOM 剥离后再做边界判定：Files.readAllLines 不剥 BOM，带 BOM 的 SKILL.md
        // 首行是 "\uFEFF---"，trim() 后仍不等于 "---" → 整份 frontmatter 被静默丢弃
        // （description/enabled/when_to_use 全丢，且无任何报错）。只剥首行首字符，
        // 不改调用方传入的 list，行下标语义保持不变。
        String firstLine = markdownLines.get(0);
        if (firstLine.startsWith("\uFEFF")) {
            firstLine = firstLine.substring(1);
        }

        int endSeparatorIndex = -1;

        // 1. 尝试寻找 Frontmatter 边界
        // 必须以 --- 开头，且至少有 3 行（---, 内容, ---）
        if (markdownLines.size() > 2 && "---".equals(firstLine.trim())) {
            for (int i = 1; i < markdownLines.size(); i++) {
                if ("---".equals(markdownLines.get(i).trim())) {
                    endSeparatorIndex = i;
                    break;
                }
            }
        }

        // 2. 如果找到了元数据边界，解析它
        if (endSeparatorIndex > 0) {
            // 只有在 endSeparatorIndex > 0 时才说明有有效的 Yaml 块
            List<String> metaLines = markdownLines.subList(1, endSeparatorIndex);
            if (!metaLines.isEmpty()) {
                String metadataStr = String.join("\n", metaLines);
                try {
                    Object loaded = new Yaml().load(metadataStr);
                    if (loaded != null) {
                        markdown.metadata.fill(loaded);
                    }
                } catch (Exception e) {
                    // 降级逐行提取（2026-10-27）：此处原本是空 catch（注释写着「静默处理
                    // 或记录日志」但一行日志都没有），后果远比「描述丢了」严重：
                    // SnakeYAML 是整块解析，一处语法错就让 name/description/version/enabled
                    // 全部丢失。其中 enabled 丢失意味着用户在 UI 上关掉该技能完全无效——
                    // SkillMdFrontmatter.setEnabled 确实把 `enabled: false` 写进了文件，
                    // 但重新扫描时读不出来，回落默认 true，技能照样被注入系统提示词。
                    //
                    // 真实中招样本：agent-browser 的 description 在双引号串内嵌了裸双引号
                    // （`"... Triggers include requests to "open a website", ..."`），
                    // SnakeYAML 抛 ParserException，该技能描述退化成兜底文案「技能规约。」。
                    //
                    // 降级解析不做 YAML 语法校验，只按行取顶层 `key: value`，因此对这类
                    // 「值里含引号」的写法天然免疫。宁可拿到不完美的元数据，也不要全丢。
                    Map<String, String> salvaged = salvageFrontmatter(metaLines);
                    if (!salvaged.isEmpty()) {
                        markdown.metadata.fill(salvaged);
                    }
                    LOG.warn("Frontmatter YAML parse failed, salvaged {} field(s) by line scan: {}",
                            salvaged.size(), e.getMessage());
                }
            }
        }

        // 3. 处理正文 (Content)
        if (!onlyFrontmatter) {
            int contentStartIndex = (endSeparatorIndex > 0) ? endSeparatorIndex + 1 : 0;
            if (contentStartIndex < markdownLines.size()) {
                List<String> contentLines = markdownLines.subList(contentStartIndex, markdownLines.size());
                // 使用 trim() 去掉首尾多余换行
                markdown.content = String.join("\n", contentLines).trim();
            }
        }

        return markdown;
    }

    /**
     * YAML 整块解析失败时的逐行降级提取。
     *
     * <p>只认<b>顶层</b>的 {@code key: value}：缩进行（嵌套 map / 列表项）一律跳过，
     * 否则会把 {@code allowed-tools} 下面的 {@code - Read} 或 {@code metadata.version}
     * 误当成顶层字段。键名限定为标识符字符，这样 {@code url: https://x:8443/v1}
     * 能正确保留冒号后的全部内容，而正文里的散文不会被当成键。</p>
     *
     * <p>值只做「剥成对包裹引号」，不做 YAML 转义还原：降级路径的目标是
     * 「拿到能用的元数据」，而不是复刻一个 YAML 解析器。</p>
     */
    static Map<String, String> salvageFrontmatter(List<String> metaLines) {
        Map<String, String> out = new LinkedHashMap<>();

        for (String line : metaLines) {
            if (line == null) {
                continue;
            }
            // 缩进行 = 嵌套结构，不属于顶层键
            if (line.startsWith(" ") || line.startsWith("\t")) {
                continue;
            }

            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#") || trimmed.startsWith("-")) {
                continue;
            }

            int colon = trimmed.indexOf(':');
            if (colon <= 0) {
                continue;
            }

            String key = trimmed.substring(0, colon).trim();
            if (!isSimpleKey(key)) {
                continue;
            }

            out.put(key, unquote(trimmed.substring(colon + 1).trim()));
        }

        return out;
    }

    /** 键名只允许字母、数字、下划线与连字符（与 Rust 侧 split_yaml_line 同口径）。 */
    private static boolean isSimpleKey(String key) {
        if (key.isEmpty()) {
            return false;
        }
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!ok) {
                return false;
            }
        }
        return true;
    }

    /** 剥掉成对的包裹引号；引号内的内容原样保留（不做转义还原）。 */
    private static String unquote(String value) {
        if (value.length() >= 2) {
            char first = value.charAt(0);
            char last = value.charAt(value.length() - 1);
            if ((first == '"' && last == '"') || (first == '\'' && last == '\'')) {
                return value.substring(1, value.length() - 1);
            }
        }
        return value;
    }

    public static String toMarkdownWithMetadata(Map<String, Object> metadata, String content) {
        StringBuilder buf = new StringBuilder();
        buf.append("---\n");
        for (Map.Entry<String, Object> entry : metadata.entrySet()) {
            if (entry.getValue() != null) {
                buf.append(entry.getKey()).append(": ").append(toYamlValue(entry.getValue())).append("\n");
            }
        }
        buf.append("---\n\n");
        if (content != null) {
            buf.append(content);
        }
        return buf.toString();
    }

    private static String toYamlValue(Object value) {
        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }

        String str = String.valueOf(value);
        return "\"" + str.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n") + "\"";
    }
}