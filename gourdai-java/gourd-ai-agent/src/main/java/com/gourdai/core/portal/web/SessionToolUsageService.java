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

import com.gourdai.harness.talents.memory.MemoryTalent;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 会话工具用量统计 —— 从 {@code <sessionDir>/<sid>.messages.ndjson} 统计记忆与技能的调用情况。
 *
 * <p><b>WHY 单独成类</b>：任务监控面板需要回答「这一轮 AI 有没有真的用上记忆/技能」，
 * 而这份事实只存在于会话消息文件里（工具调用声明落在 assistant 消息的 {@code toolCalls} 上）。
 * {@link WebController#messages} 已有一份「逐行读 ndjson → ONode → 取字段」的读取路径，
 * 但它只取 role/content/createdAt；把统计逻辑塞进控制器会让端点方法膨胀且无法单测。
 * 因此纯逻辑抽到本类：控制器只负责解析 sessionDir，本类只负责读文件与聚合，
 * 二者可独立验证（见 SessionToolUsageTest）。</p>
 *
 * <p><b>数据源优先级（2026-10 修复）</b>：{@code <sid>.usage.ndjson} 用量账本（写侧在可见性
 * 过滤前逐次追写，全量工具事实）&gt; {@code <sid>.stream.ndjson} 的 action_start 帧（老会话无账本，
 * 技能可统计；记忆工具本就不进 stream，如实为空）&gt; {@code <sid>.messages.ndjson} 的 toolCalls
 * （兼容既有落盘形态与单测夹具）。三者只取其一，绝不混读以免重复计数。</p>
 *
 * <p><b>只读、无状态</b>：不持有任何字段，不写盘、不联网；全部为静态纯函数，天然线程安全。
 * 任何解析失败都降级为计数（{@code degradedLines}）而不抛出——监控面板拿不到统计时显示
 * 空态即可，绝不该把整个请求打成 500。</p>
 *
 * @author oisin
 * @see WebController Web 端点 {@code /web/chat/session/tool-usage}
 */
public final class SessionToolUsageService {
    private static final Logger LOG = LoggerFactory.getLogger(SessionToolUsageService.class);

    /**
     * 记忆写入工具名。判定「记忆是否被更新」只认它，而不是 {@code memory_*} 全集：
     * memory_search / memory_recall 只读不写，把它们算成「已更新记忆」会让面板显示
     * 「AI 沉淀了新认知」而实际什么都没落盘。
     */
    private static final String MEMORY_EXTRACT_TOOL = "memory_extract";

    /**
     * 技能相关工具名全集。
     *
     * <p>WHY 用字面量：{@code SkillTalent} 只在 {@code @ToolMapping(name = "...")} 注解里声明
     * 这些名字，没有对外暴露常量；为避免跨模块新增 public 常量（会扩大改动面），此处按注解值
     * 同步维护。四个名字覆盖「读规约 / 搜技能 / 列清单 / 刷新目录」全部技能动作。</p>
     */
    private static final Set<String> SKILL_TOOLS = new LinkedHashSet<>(List.of(
            "skillread", "skillsearch", "skilllist", "skillrefresh"));

    /** skillread/skillsearch 取不到技能名时的占位：仍要如实计数，不能把调用记录丢掉。 */
    private static final String UNKNOWN_SKILL = "(unknown)";

    private SessionToolUsageService() {
        // 工具类：禁止实例化
    }

    /**
     * 单次统计的可变累加器。
     *
     * <p>WHY 用局部对象而不是静态字段：统计会在多个 HTTP 请求线程上并发跑，
     * 任何跨请求共享的可变计数都会串台。累加器随 {@link #usage} 调用栈创建、方法返回即丢弃。</p>
     */
    private static final class Counters {
        /** 识别到的工具调用总条数（含非记忆非技能的普通工具）。 */
        private int toolCallCount;
        /** 无法解析而被跳过的行数。 */
        private int degradedLines;
        /** memory_* 调用总次数。 */
        private int memoryTotal;
        /** memory_extract 调用次数，决定 memory.updated。 */
        private int memoryExtract;
        /** 出现过的 memory_* 工具名（去重、保序）。 */
        private final Set<String> memoryNames = new LinkedHashSet<>();
        /** 技能名 → (工具名 → 次数)。保序，使输出顺序与首次出现顺序一致。 */
        private final Map<String, Map<String, Integer>> skillGroups = new LinkedHashMap<>();
    }

    /** 用量账本文件名后缀（与 {@link SessionStreamStore#USAGE_SUFFIX} 同值，避免反向依赖）。 */
    private static final String USAGE_SUFFIX = ".usage.ndjson";
    /** 流式事件文件名后缀（老会话回退数据源）。 */
    private static final String STREAM_SUFFIX = ".stream.ndjson";
    /** 会话消息文件名后缀（末位兼容数据源）。 */
    private static final String MESSAGES_SUFFIX = ".messages.ndjson";

    /**
     * 统计一个会话的工具用量（单目录便捷重载）。
     */
    public static Map<String, Object> usage(File sessionDir, String sessionId) {
        return usage(sessionDir == null ? List.of() : List.of(sessionDir), sessionId);
    }

    /**
     * 统计一个会话的工具用量。
     *
     * @param sessionDirs 候选会话目录（按优先级排序，通常为 [标准目录, 历史落点]）；
     *                    账本/流/消息三类文件各自取第一个命中的目录，只读其一不混读
     * @param sessionId   会话 ID，用于拼出各数据源文件名
     * @return LinkedHashMap{sessionId, exists, memory{updated,extractCount,totalCount,names},
     *         skills[{name,toolName,count}], skillCount, toolCallCount, degradedLines}；
     *         三类文件都不存在时回结构化空态（exists=false），绝不抛异常
     */
    public static Map<String, Object> usage(List<File> sessionDirs, String sessionId) {
        return usage(sessionDirs, sessionId, null);
    }

    /**
     * 统计一个会话的工具用量，并给技能行补上展示名。
     *
     * <p><b>WHY 展示名在服务层补而不是控制器补</b>：技能行的字段骨架必须只有一处
     * （{@link #result}）——空态与正常态共用同一份结构，前端才不用对每个字段做
     * undefined 判定。若让控制器在返回后往行里塞字段，行的形状就有了两个来源。</p>
     *
     * <p><b>WHY 由调用方传映射而不是本类读磁盘</b>：本类是「只读、无状态、纯函数」
     * （见类注释），读技能目录会引入对 {@code TalentRegistry} 的依赖与 IO 抖动。
     * 展示名口径统一在 {@link SkillDisplayNames}，调用方取一次映射传进来即可。</p>
     *
     * @param skillDisplayNames 技能名 → 展示名（{@link SkillDisplayNames#ofAll} 的产物）；
     *                          null 或未命中时不产生 displayName 字段，前端回退技能名
     */
    public static Map<String, Object> usage(List<File> sessionDirs, String sessionId,
                                            Map<String, String> skillDisplayNames) {
        Counters counters = new Counters();
        boolean exists = false;
        if (sessionId != null && !sessionId.isEmpty()) {
            File ledger = firstExisting(sessionDirs, sessionId + USAGE_SUFFIX);
            File stream = firstExisting(sessionDirs, sessionId + STREAM_SUFFIX);
            File messages = firstExisting(sessionDirs, sessionId + MESSAGES_SUFFIX);
            if (ledger != null) {
                exists = true;
                readLedger(ledger, counters);
            } else if (stream != null) {
                exists = true;
                readStreamFallback(stream, counters);
            } else if (messages != null) {
                exists = true;
                readUsage(messages, counters);
            }
        }
        return result(sessionId, exists, counters, skillDisplayNames);
    }

    /** 在候选目录中按序查找第一个存在的目标文件；全不存在返回 null。 */
    private static File firstExisting(List<File> dirs, String fileName) {
        if (dirs == null) return null;
        for (File dir : dirs) {
            if (dir == null) continue;
            File file = new File(dir, fileName);
            if (file.exists()) return file;
        }
        return null;
    }

    /**
     * 读用量账本：每行一条 {@code {tool,ok,at,actionId?,agent?,skill?}}。
     *
     * <p>账本行不是消息对象（无 role），降级判定独立于消息口径：解析不出对象或缺 tool 字段
     * 才计 degraded；追写中的半行会被宽容解析为缺 tool 的对象，同样计入 degraded——
     * 账本行极短（约 90 字节）且写完即 flush，半行窗口几乎不存在，宁可如实标记。</p>
     */
    private static void readLedger(File ledgerFile, Counters counters) {
        forEachLine(ledgerFile, line -> {
            ONode node;
            try {
                node = ONode.ofJson(line);
            } catch (Throwable e) {
                throw new IllegalArgumentException("not a json object", e);
            }
            if (node == null || !node.isObject()) {
                throw new IllegalArgumentException("not a json object");
            }
            String tool = textOf(node.getOrNull("tool"));
            if (tool == null) {
                throw new IllegalArgumentException("ledger line without tool");
            }
            String skill = textOf(node.getOrNull("skill"));
            accumulateTool(tool, skill != null ? skill : fallbackSkillName(tool), counters);
        }, counters);
    }

    /**
     * 老会话回退：扫 stream 的 action_start 帧取 toolName 与 args。
     *
     * <p>非 action_start 行与解析失败的行一律静默跳过（stream 由多种帧组成，
     * 半行/异构行属常态，计 degraded 只会制造噪音）；记忆工具本就不进 stream，
     * 老会话的「记忆是否更新」如实为空，不伪造。</p>
     */
    private static void readStreamFallback(File streamFile, Counters counters) {
        forEachLine(streamFile, line -> {
            ONode node;
            try {
                node = ONode.ofJson(line);
            } catch (Throwable e) {
                return;
            }
            if (node == null || !node.isObject()) return;
            if (!"action_start".equals(textOf(node.getOrNull("type")))) return;
            String tool = textOf(node.getOrNull("toolName"));
            if (tool == null) return;
            accumulateTool(tool, skillNameOfArgsNode(node.getOrNull("args"), tool), counters);
        }, counters);
    }

    /** 逐行读取回调式处理：行级异常计入 degradedLines 并继续（与既有 readUsage 同纪律）。 */
    private static void forEachLine(File file, java.util.function.Consumer<String> handler, Counters counters) {
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), "UTF-8"))) {
            String line;
            while ((line = br.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                try {
                    handler.accept(line);
                } catch (Throwable e) {
                    counters.degradedLines++;
                    LOG.debug("[Web] tool usage skipped unparsable line: {}", e.getMessage());
                }
            }
        } catch (Throwable e) {
            counters.degradedLines++;
            LOG.warn("[Web] tool usage read failed for {}: {}", file.getName(), e.getMessage());
        }
    }

    /**
     * 逐行读取并聚合。
     *
     * <p>与 {@link WebController#messages} 同款读取方式：BufferedReader + UTF-8 + 逐行 trim + 跳空行。
     * 复用同一口径是刻意的——两处若解析方式分叉，面板统计会与历史回放对不上账。</p>
     *
     * <p>行级异常只累加 {@code degradedLines} 并继续：ndjson 的最后一行可能正被引擎追写
     * （半行 JSON），若因此整批失败，面板在会话运行期间会一直拿不到任何统计。</p>
     */
    private static void readUsage(File msgFile, Counters counters) {
        forEachLine(msgFile, line -> accumulateLine(line, counters), counters);
    }

    /**
     * 统计单行消息里的工具调用（只认消息对象的 {@code toolCalls} 数组）。
     *
     * <p><b>降级判定口径</b>：一行算「不可统计」当且仅当它不是一条消息——即无法解析为
     * JSON <b>对象</b>，或解析出来但缺 {@code role} 字段（消息的必备字段，见 {@code ChatMessage}）。
     * 这两种情况抛 {@link IllegalArgumentException}，由 {@link #readUsage} 计入 {@code degradedLines}。
     * 刻意不依赖 {@code ONode.ofJson} 对畸形输入是「抛异常」还是「返回 null」：
     * 两者都归到同一条降级路径，统计口径才不会随 snack4 版本漂移。</p>
     *
     * <p><b>截断行不算 degraded</b>（snack4 4.0.54 实测）：正在被引擎追写的半行
     * （如 {@code {"role":"ASSISTANT",}）会被宽容解析成含 role 的对象。它确实是一条消息的开头，
     * 只是还没写出 toolCalls，按「本行无工具调用」跳过即可——把它计入 degradedLines 会让面板
     * 在会话运行期间恒定显示「数据不完整」，而下一次读取它就完整了。</p>
     */
    private static void accumulateLine(String line, Counters counters) {
        ONode node;
        try {
            node = ONode.ofJson(line);
        } catch (Throwable e) {
            throw new IllegalArgumentException("not a json object", e);
        }
        // 数组/标量行同样算畸形：ndjson 每行必须是一个消息对象
        if (node == null || !node.isObject()) {
            throw new IllegalArgumentException("not a json object");
        }
        if (textOf(node.getOrNull("role")) == null) {
            throw new IllegalArgumentException("message without role");
        }
        ONode toolCalls = node.getOrNull("toolCalls");
        if (toolCalls == null || !toolCalls.isArray()) return;

        for (ONode call : toolCalls.getArray()) {
            if (call == null) continue;
            String name = textOf(call.getOrNull("name"));
            if (name == null) continue;
            accumulateTool(name, skillNameOf(call, name), counters);
        }
    }

    /**
     * 记一条工具调用事实（三个数据源共用）：计数 + 记忆/技能分组。
     *
     * @param toolName  工具注册名
     * @param skillName 技能标识（仅技能工具有意义；调用方负责兜底占位）
     */
    private static void accumulateTool(String toolName, String skillName, Counters counters) {
        counters.toolCallCount++;
        if (MemoryTalent.isMemoryTool(toolName)) {
            counters.memoryTotal++;
            counters.memoryNames.add(toolName);
            if (MEMORY_EXTRACT_TOOL.equals(toolName)) {
                counters.memoryExtract++;
            }
        } else if (SKILL_TOOLS.contains(toolName)) {
            counters.skillGroups.computeIfAbsent(skillName, k -> new LinkedHashMap<>())
                    .merge(toolName, 1, Integer::sum);
        }
    }

    /** 取不到技能名时的兜底：skillread/skillsearch 用占位符，无参工具用工具名本身。 */
    private static String fallbackSkillName(String toolName) {
        return ("skillread".equals(toolName) || "skillsearch".equals(toolName)) ? UNKNOWN_SKILL : toolName;
    }

    /**
     * 写侧（用量账本）取技能标识：仅技能工具返回非 null，其余工具返回 null（账本不写 skill 字段）；
     * 事件 args 是 Map 形态，只认 name/query/skill 三键。
     *
     * <p>供 {@code WebStreamBuilder} 在落账本行时填入 skill 字段；取不到时兜底占位，
     * 与读侧口径完全一致（同一事实不得两处各算一套）。</p>
     */
    public static String skillNameOrNull(Map<String, Object> args, String toolName) {
        if (toolName == null || !SKILL_TOOLS.contains(toolName)) return null;
        if (args != null) {
            String value = firstNonEmpty(asText(args.get("name")), asText(args.get("query")), asText(args.get("skill")));
            if (value != null) return value;
        }
        return fallbackSkillName(toolName);
    }

    /** Map 值 → 非空 trim 字符串；非字符串或空白返回 null。 */
    private static String asText(Object value) {
        if (value == null) return null;
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    /** stream 回退源：从 action_start 帧的 args 对象取技能标识。 */
    private static String skillNameOfArgsNode(ONode args, String toolName) {
        if (args != null && args.isObject()) {
            String value = firstNonEmpty(textOf(args.getOrNull("name")),
                    textOf(args.getOrNull("query")),
                    textOf(args.getOrNull("skill")));
            if (value != null) return value;
        }
        return fallbackSkillName(toolName);
    }

    /**
     * 从技能工具调用的参数里取技能名。
     *
     * <p>只有 {@code skillread}（参数 name）与 {@code skillsearch}（参数 query）带技能标识；
     * {@code skilllist}/{@code skillrefresh} 无参，直接用工具名聚合。
     * 取不到时退回占位值，保证「调用过技能」这一事实不因参数缺失而丢失。</p>
     *
     * <p>参数字段有两种落盘形态（见 {@code ToolCall}）：{@code arguments} 字典与
     * {@code argumentsStr} 原始 JSON 串——不同模型通道只写其中一种，故两者都要试。</p>
     */
    private static String skillNameOf(ONode call, String toolName) {
        String fromMap = firstNonEmpty(textOf(nested(call, "arguments", "name")),
                textOf(nested(call, "arguments", "query")),
                textOf(nested(call, "arguments", "skill")));
        if (fromMap != null) return fromMap;

        ONode argumentsStr = call.getOrNull("argumentsStr");
        String raw = argumentsStr == null ? null : argumentsStr.getString();
        if (raw != null && !raw.trim().isEmpty()) {
            try {
                ONode parsed = ONode.ofJson(raw.trim());
                String value = firstNonEmpty(textOf(parsed == null ? null : parsed.getOrNull("name")),
                        textOf(parsed == null ? null : parsed.getOrNull("query")),
                        textOf(parsed == null ? null : parsed.getOrNull("skill")));
                if (value != null) return value;
            } catch (Throwable e) {
                // 参数串不是合法 JSON（被截断或模型给了纯文本）：退回占位/工具名
                LOG.debug("[Web] skill arguments unparsable for {}: {}", toolName, e.getMessage());
            }
        }
        return ("skillread".equals(toolName) || "skillsearch".equals(toolName)) ? UNKNOWN_SKILL : toolName;
    }

    /** 取 {@code object.key} 子节点；任一层缺失返回 null。 */
    private static ONode nested(ONode object, String key, String child) {
        if (object == null) return null;
        ONode inner = object.getOrNull(key);
        if (inner == null || !inner.isObject()) return null;
        return inner.getOrNull(child);
    }

    /** 节点 → 非空 trim 字符串；null/空白返回 null。 */
    private static String textOf(ONode node) {
        if (node == null || node.isNull()) return null;
        String text = node.getString();
        if (text == null) return null;
        text = text.trim();
        return text.isEmpty() ? null : text;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return null;
        for (String v : values) {
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    /**
     * 组装响应。单独抽出是为了让「文件不存在」与「正常统计」共用同一份字段骨架——
     * 空态也必须字段齐备，否则前端要对每个字段做 undefined 判定。
     */
    private static Map<String, Object> result(String sessionId, boolean exists, Counters counters,
                                              Map<String, String> skillDisplayNames) {
        Map<String, Object> memory = new LinkedHashMap<>();
        memory.put("updated", counters.memoryExtract > 0);
        memory.put("extractCount", counters.memoryExtract);
        memory.put("totalCount", counters.memoryTotal);
        memory.put("names", new ArrayList<>(counters.memoryNames));

        List<Map<String, Object>> skills = new ArrayList<>();
        for (Map.Entry<String, Map<String, Integer>> skill : counters.skillGroups.entrySet()) {
            for (Map.Entry<String, Integer> tool : skill.getValue().entrySet()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("name", skill.getKey());
                row.put("toolName", tool.getKey());
                row.put("count", tool.getValue());
                /* 展示名：技能页显示什么，监控就显示什么。两地各算一套已出过真实缺陷
                 * （技能页修好、监控仍显示 _owner_slug 目录名）。
                 * name 保持目录名不动——它是 skillread 的定位键与账本落盘值。 */
                String displayName = skillDisplayNames == null ? null : skillDisplayNames.get(skill.getKey());
                if (displayName != null && !displayName.trim().isEmpty()) {
                    row.put("displayName", displayName.trim());
                }
                skills.add(row);
            }
        }
        // 按次数降序、同数按技能名升序：面板直接渲染，无需前端再排序
        skills.sort(java.util.Comparator
                .comparingInt((Map<String, Object> r) -> -((Number) r.get("count")).intValue())
                .thenComparing(r -> String.valueOf(r.get("name"))));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", sessionId);
        out.put("exists", exists);
        out.put("memory", memory);
        out.put("skills", skills);
        out.put("skillCount", skills.stream().mapToInt(r -> ((Number) r.get("count")).intValue()).sum());
        out.put("toolCallCount", counters.toolCallCount);
        out.put("degradedLines", counters.degradedLines);
        return out;
    }
}
