/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.compat;

import org.noear.snack4.Feature;
import org.noear.snack4.Options;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 历史落盘数据的「旧包名」反序列化兼容层（过渡类，可整体摘除）。
 *
 * <p><b>背景：</b>消息与会话快照曾以 {@code org.noear.solon.ai.*} 的类名写入 {@code "@type"} 字段；
 * 这些类后来迁移到了 {@code com.gourdai.ai.*}。于是历史数据再被读取时，snack4 按 {@code @type}
 * 里的旧类名去加载，抛 {@code CodecException: Unsupported type, class: org.noear.solon.ai.xxx}，
 * 整份快照/整条消息读取失败（实测日志出现过大量 {@code Load snapshot failed}）。</p>
 *
 * <p><b>为何是「改写 JSON 字符串」而不是「挂 ClassLoader 钩子」：</b>
 * 曾评估过更优雅的零拷贝方案——给 snack4 的 {@link Options} 注入一个会把旧类名翻译成新类名的
 * {@link ClassLoader}，让 JSON 一个字节都不用动。<b>该方案经实测不可行</b>：snack4 的
 * {@code Options.loadClass(String,boolean)} 内部走的是 {@code Class.forName(name, false, cl)}，
 * 而 JVM 会校验「加载器返回的类的名字」必须与「请求的名字」一致；改名后名字对不上，
 * JVM 直接抛 {@code ClassNotFoundException}，钩子对 {@code Class.forName} 这条路径完全失效
 * （仅当外部直接调用 {@code loader.loadClass(name)} 时才生效，snack4 并不走那条路）。
 * 因此这里退回到<b>定点字符串改写</b>：只改 {@code "@type":"..."} 里的类名，绝不做全文替换。</p>
 *
 * <p><b>安全边界（为何不会误伤）：</b>
 * <ul>
 *   <li>只匹配 {@code "@type":"} 紧跟其后的那段类名，正文（用户聊天内容、代码片段、堆栈日志）里
 *       出现同样的类名字符串不会被改写；</li>
 *   <li>改写前必须确认<b>映射后的新类真实存在</b>（{@code Class.forName} 校验并缓存结果）。
 *       找不到就原样保留，让原始错误自然抛出——绝不制造「改写成一个不存在的类」这种更难排查的故障。</li>
 * </ul></p>
 *
 * <p><b>性能：</b>{@link #rewrite(String)} 首先用 {@code indexOf} 快速短路；已迁移（或已自愈回写）的
 * 数据只付一次失败的 {@code indexOf} 代价，不产生任何拷贝与对象分配。</p>
 *
 * <h3>如何确认可以摘除</h3>
 * <p>本类会统计命中次数：首次命中打 INFO（含旧类名），后续打 DEBUG。若运行一段时间后日志中
 * 不再出现本类的 INFO 命中记录、且不再有 {@code Unsupported type, class: org.noear.solon.ai.*}，
 * 即说明历史数据已全部自愈完毕，可以安全摘除。运行期也可调用 {@link #hitCount()} 查看累计命中数。</p>
 *
 * <h3>摘除步骤（共 3 处，删完即彻底退场）</h3>
 * <ol>
 *   <li>删除本类文件：{@code com/gourdai/core/compat/LegacyTypeCompat.java}；</li>
 *   <li>{@code com/gourdai/ai/chat/message/ChatMessage.java} 的 {@code fromJson(String)}：
 *       把 {@code ONode.ofJson(LegacyTypeCompat.rewrite(json), LegacyTypeCompat.readOptions())}
 *       改回 {@code ONode.ofJson(json, Feature.Read_AutoType)}，并删除对应 import；</li>
 *   <li>{@code com/gourdai/agent/session/FileAgentSession.java}：删除 {@code loadSnapshotFile()} 中的
 *       改写与自愈回写逻辑（连同私有方法 {@code rewriteSnapshotFile}）、改回直接
 *       {@code FlowContext.fromJson(json)}，并删除对应 import；</li>
 *   <li>删除测试：{@code com/gourdai/core/compat/LegacyTypeCompatTest.java}。</li>
 * </ol>
 *
 * @author oisin
 * @since 3.9.1
 */
public final class LegacyTypeCompat {
    private static final Logger LOG = LoggerFactory.getLogger(LegacyTypeCompat.class);

    /** snack4 写 @type 时用的键；改写只在该键之后定点发生。 */
    private static final String TYPE_KEY = "\"@type\":\"";

    /**
     * 旧包名前缀 -> 新包名前缀。
     *
     * <p>按<b>前缀</b>而非逐个类名映射：历史数据里到底出现过哪些类无法穷举（实测见过 TextBlock /
     * ToolCall / ToolMessage / AssistantMessage / UserMessage / ImageBlock / PromptImpl 等），
     * 前缀映射可覆盖同批迁移的全部类；映射结果是否可用，交由「目标类存在性校验」兜底。</p>
     */
    private static final Map<String, String> PREFIX_MAPPING = Map.of(
            "org.noear.solon.ai.", "com.gourdai.ai."
    );

    /**
     * 旧类名 -> 改写结果的缓存。
     *
     * <p>值为新类名表示「已验证存在，可改写」；值为 {@code null} 语义无法用
     * ConcurrentHashMap 表达，故用 {@link #NOT_MAPPED} 这一哨兵表示「不可改写」，
     * 避免对同一个类名反复付 {@code Class.forName} 失败的代价（抛异常很贵）。</p>
     */
    private static final Map<String, String> RESOLVE_CACHE = new ConcurrentHashMap<>();

    /** 「该类名不可改写」的哨兵值（不能用 null，ConcurrentHashMap 不接受 null 值）。 */
    private static final String NOT_MAPPED = "\0";

    /** 累计命中次数（仅用于判断本兼容层能否摘除，非业务指标）。 */
    private static final AtomicLong HIT_COUNT = new AtomicLong();

    /**
     * 消息反序列化用的共享只读 Options。
     *
     * <p><b>必须是单例</b>：{@code ChatMessage.fromJson} 是热路径（每条历史消息调一次），
     * 而 {@code ONode.ofJson(json, Feature...)} 的变参重载内部每次都会 new 一个 Options；
     * 复用单例反而比原写法少一次分配。设为 {@code readonly()} 防止被外部意外篡改。</p>
     */
    private static final Options READ_OPTIONS = Options.of(Feature.Read_AutoType).readonly();

    private LegacyTypeCompat() {
    }

    /**
     * 消息反序列化用的共享 Options（含 {@code Read_AutoType}）。
     *
     * @return 全局共享的只读实例
     */
    public static Options readOptions() {
        return READ_OPTIONS;
    }

    /**
     * 累计命中旧包名的次数（供运维判断兼容层是否已可摘除）。
     */
    public static long hitCount() {
        return HIT_COUNT.get();
    }

    /**
     * 把 JSON 中 {@code "@type"} 位置上的旧包名类名改写为新包名。
     *
     * <p>仅改写 {@code "@type":"} 之后紧跟的类名，正文内容原样保留；
     * 映射后的类不存在时不改写，让原始错误自然抛出。</p>
     *
     * @param json 原始 JSON（允许 null）
     * @return 改写后的 JSON；<b>未发生任何改写时返回入参同一个引用</b>
     *         （调用方可用 {@code result != json} 判断是否需要回写磁盘）
     */
    public static String rewrite(String json) {
        if (json == null || json.isEmpty()) {
            return json;
        }

        // 快速短路：已迁移/已自愈的数据只付一次 indexOf，不做任何拷贝与分配
        if (!containsAnyLegacyPrefix(json)) {
            return json;
        }

        StringBuilder buf = null;
        int copied = 0;
        int from = 0;

        while (true) {
            int keyAt = json.indexOf(TYPE_KEY, from);
            if (keyAt < 0) {
                break;
            }
            int valueAt = keyAt + TYPE_KEY.length();
            int endAt = json.indexOf('"', valueAt);
            if (endAt < 0) {
                // JSON 截断/损坏：不猜测，交给解析器报原始错误
                break;
            }

            String oldName = json.substring(valueAt, endAt);
            String newName = resolve(oldName);
            if (newName != null) {
                if (buf == null) {
                    buf = new StringBuilder(json.length());
                }
                buf.append(json, copied, valueAt).append(newName);
                copied = endAt;
                recordHit(oldName);
            }
            from = endAt + 1;
        }

        if (buf == null) {
            return json;
        }
        buf.append(json, copied, json.length());
        return buf.toString();
    }

    /**
     * 该 JSON 是否可能含旧包名（快速短路用）。
     */
    private static boolean containsAnyLegacyPrefix(String json) {
        for (String oldPrefix : PREFIX_MAPPING.keySet()) {
            if (json.indexOf(oldPrefix) >= 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * 解析旧类名对应的新类名。
     *
     * @return 新类名；若不匹配任何旧前缀、或映射后的类不存在，返回 {@code null}（表示不改写）
     */
    private static String resolve(String oldName) {
        String cached = RESOLVE_CACHE.get(oldName);
        if (cached != null) {
            return NOT_MAPPED.equals(cached) ? null : cached;
        }

        String resolved = NOT_MAPPED;
        for (Map.Entry<String, String> entry : PREFIX_MAPPING.entrySet()) {
            String oldPrefix = entry.getKey();
            if (oldName.startsWith(oldPrefix)) {
                String candidate = entry.getValue() + oldName.substring(oldPrefix.length());
                // 必须确认目标类真实存在，否则宁可不改写，让原始错误自然抛出
                if (classExists(candidate)) {
                    resolved = candidate;
                }
                break;
            }
        }

        RESOLVE_CACHE.put(oldName, resolved);
        return NOT_MAPPED.equals(resolved) ? null : resolved;
    }

    /**
     * 目标类是否存在（结果由 {@link #RESOLVE_CACHE} 缓存，此处不重复缓存）。
     */
    private static boolean classExists(String className) {
        try {
            ClassLoader cl = Thread.currentThread().getContextClassLoader();
            if (cl == null) {
                cl = LegacyTypeCompat.class.getClassLoader();
            }
            // initialize=false：只做存在性校验，不触发静态初始化
            Class.forName(className, false, cl);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    /**
     * 记录一次命中：首次打 INFO（便于发现历史数据仍在被读），此后打 DEBUG（避免刷屏）。
     */
    private static void recordHit(String oldName) {
        long n = HIT_COUNT.incrementAndGet();
        if (n == 1) {
            LOG.info("Legacy @type detected, compat rewrite enabled (first hit: {}). "
                    + "When this no longer appears, LegacyTypeCompat can be removed.", oldName);
        } else if (LOG.isDebugEnabled()) {
            LOG.debug("Legacy @type rewritten: {} (total: {})", oldName, n);
        }
    }
}
