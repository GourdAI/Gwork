/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 */
package com.gourdai.harness.talents.memory;

/**
 * 记忆标题规范化与旧数据回退工具。
 */
public final class MemoryTitles {
    private static final int MAX_TITLE_LENGTH = 60;

    private MemoryTitles() {
    }

    public static String resolve(String title, String content) {
        String normalized = clean(title);
        if (!normalized.isEmpty()) {
            return truncate(normalized);
        }

        String source = clean(content);
        if (source.isEmpty()) {
            return "未命名记忆";
        }

        int end = firstSentenceEnd(source);
        String fallback = end > 0 ? source.substring(0, end) : source;
        return truncate(fallback);
    }

    private static String clean(String value) {
        if (value == null) {
            return "";
        }
        return value.replaceFirst("^\\s*#{1,6}\\s*", "")
                .replaceFirst("^\\s*\\[(?:Evolved Insight|认知|摘要)]\\s*", "")
                .replaceAll("\\s+", " ")
                .trim();
    }

    private static int firstSentenceEnd(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '。' || c == '！' || c == '？' || c == '!' || c == '?' || c == ';' || c == '；') {
                return i + 1;
            }
            if (c == '.' && (i + 1 == value.length() || Character.isWhitespace(value.charAt(i + 1)))) {
                return i + 1;
            }
        }
        return -1;
    }

    private static String truncate(String value) {
        if (value.length() <= MAX_TITLE_LENGTH) {
            return value;
        }
        return value.substring(0, MAX_TITLE_LENGTH - 1).trim() + "…";
    }
}
