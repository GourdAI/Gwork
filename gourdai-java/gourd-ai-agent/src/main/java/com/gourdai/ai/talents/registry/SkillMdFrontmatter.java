package com.gourdai.ai.talents.registry;

import com.gourdai.ai.util.Markdown;
import com.gourdai.ai.util.MarkdownUtil;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * SKILL.md frontmatter 读写工具 — 技能启禁用开关的落盘实现。
 *
 * <p>开关语义：frontmatter 的 {@code enabled: false} 表示禁用，缺省/true 表示启用
 * （与 {@link Markdown#isEnabled()} 口径一致）。写入采用「逐行最小改写」而非
 * 序列化整份元数据：</p>
 * <ul>
 *   <li>已有 {@code enabled} 键 → 只替换该行值，其余行逐字保留；</li>
 *   <li>无 {@code enabled} 键但有 frontmatter → 在结束分隔符前插入一行；</li>
 *   <li>完全没有 frontmatter → 文件头部补 {@code ---\nenabled: x\n---\n} 块。</li>
 * </ul>
 *
 * <p>行尾保持原文件主行尾（CRLF/LF 按多数行判定），不引入混用；不写 BOM。</p>
 *
 * @author oisin
 */
public final class SkillMdFrontmatter {

    private static final String FENCE = "---";
    private static final String KEY = "enabled";

    private SkillMdFrontmatter() {
    }

    /** 定位技能目录下的 SKILL.md（大小写两种命名都接受），不存在返回 null。 */
    public static Path resolveSkillMd(Path skillDir) {
        if (skillDir == null) {
            return null;
        }
        Path md = skillDir.resolve("SKILL.md");
        if (Files.exists(md)) {
            return md;
        }
        md = skillDir.resolve("skill.md");
        return Files.exists(md) ? md : null;
    }

    /**
     * 设置启用开关并落盘。
     *
     * @return true 表示已写入；false 表示找不到 SKILL.md（调用方应视为失败）
     */
    public static boolean setEnabled(Path skillDir, boolean enabled) throws IOException {
        Path md = resolveSkillMd(skillDir);
        if (md == null) {
            return false;
        }

        byte[] raw = Files.readAllBytes(md);
        String text = new String(raw, StandardCharsets.UTF_8);
        // BOM 先剥离、写回时再补回：否则拆行后它粘在首行行首，一旦头部插入
        // enabled 行（无 frontmatter 分支），BOM 就落到文件中部变成乱码字符
        boolean hadBom = text.startsWith("\uFEFF");
        if (hadBom) {
            text = text.substring(1);
        }
        String eol = detectEol(text);
        // 统一按 LF 拆行处理，写回时再还原主行尾，避免混用。
        // CRLF 必须先归一成 LF 再拆：否则每行行尾残留 \r，写回还原 \r\n 时
        // 变成 \r\r\n（双重 CR），整份文件被污染（git 全文件 diff、编辑器告警）。
        String[] lines = text.replace("\r\n", "\n").split("\n", -1);

        int fenceStart = -1;
        int fenceEnd = -1;
        if (lines.length > 0 && lines[0].trim().equals(FENCE)) {
            fenceStart = 0;
            for (int i = 1; i < lines.length; i++) {
                if (lines[i].trim().equals(FENCE)) {
                    fenceEnd = i;
                    break;
                }
            }
        }

        String valueLine = KEY + ": " + enabled;
        String[] out;
        if (fenceStart >= 0 && fenceEnd > fenceStart) {
            int keyLine = -1;
            for (int i = fenceStart + 1; i < fenceEnd; i++) {
                if (frontmatterKey(lines[i]).equals(KEY)) {
                    keyLine = i;
                    break;
                }
            }
            if (keyLine >= 0) {
                out = lines.clone();
                out[keyLine] = valueLine;
            } else {
                out = insertLine(lines, fenceEnd, valueLine);
            }
        } else {
            // 无 frontmatter：头部补一块（不触碰正文）
            out = new String[lines.length + 3];
            out[0] = FENCE;
            out[1] = valueLine;
            out[2] = FENCE;
            System.arraycopy(lines, 0, out, 3, lines.length);
        }

        String joined = String.join("\n", out);
        if (!"\n".equals(eol)) {
            joined = joined.replace("\n", eol);
        }
        if (hadBom) {
            joined = "\uFEFF" + joined;
        }
        Files.write(md, joined.getBytes(StandardCharsets.UTF_8));
        return true;
    }

    /**
     * 提取 frontmatter 行的一级键名（{@code key: value} 的 key 部分）。
     * 非键行（缩进行、注释、空行）返回空串。
     */
    static String frontmatterKey(String line) {
        if (line == null) {
            return "";
        }
        String t = line.trim();
        if (t.isEmpty() || t.startsWith("#") || t.startsWith("-")) {
            return "";
        }
        int colon = t.indexOf(':');
        if (colon <= 0) {
            return "";
        }
        String key = t.substring(0, colon).trim();
        // 键名必须是简单标识符，排除 URL（http://...）之类误判
        if (!key.matches("[A-Za-z0-9_-]+")) {
            return "";
        }
        return key;
    }

    /** 在指定下标处插入一行（保持其余行顺序）。 */
    private static String[] insertLine(String[] lines, int index, String line) {
        String[] out = new String[lines.length + 1];
        System.arraycopy(lines, 0, out, 0, index);
        out[index] = line;
        System.arraycopy(lines, index, out, index + 1, lines.length - index);
        return out;
    }

    /** 主行尾判定：CRLF 行数 >= LF 独有行数 则 CRLF，否则 LF。 */
    static String detectEol(String text) {
        int crlf = 0;
        int lf = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                if (i > 0 && text.charAt(i - 1) == '\r') {
                    crlf++;
                } else {
                    lf++;
                }
            }
        }
        return crlf >= lf && crlf > 0 ? "\r\n" : "\n";
    }

    /**
     * 读取启用状态（缺省 true）。与 {@link Markdown#isEnabled()} 同口径，
     * 但解析失败时按启用处理（与注册表扫描的容错策略一致）。
     */
    public static boolean isEnabled(Path skillDir) {
        Path md = resolveSkillMd(skillDir);
        if (md == null) {
            return true;
        }
        try {
            List<String> lines = Files.readAllLines(md, StandardCharsets.UTF_8);
            Markdown markdown = MarkdownUtil.resolve(lines, true);
            return markdown.isEnabled();
        } catch (Throwable e) {
            return true;
        }
    }
}
