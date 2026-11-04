/*
 * Copyright 2017-2026 noear.org and authors
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
package com.gourdai.harness.talents.cli;

import com.gourdai.agent.ContextLengthPolicy;
import com.gourdai.ai.talents.registry.SkillDir;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;

/**
 * 技能清单的体积预算策略。
 *
 * <p><b>为什么需要它</b>：技能清单每轮都被拼进系统提示词，而 description 是技能作者
 * （市场安装的第三方内容）写的。此前既无单条上限也无总量上限，实测一条 10000 字的
 * description 会让单轮提示词凭空多出 10255 字符；装到几十个技能时清单会无界增长，
 * 直接挤占对话上下文。</p>
 *
 * <p><b>对齐业界</b>：Claude Code 给技能清单的预算是「模型上下文窗口的 1%」
 * （{@code skillListingBudgetFraction}，可用 {@code SLASH_COMMAND_TOOL_CHAR_BUDGET}
 * 覆盖为固定字符数），单条 description + when_to_use 合并上限 1536 字符；ZCode 用
 * 固定 20000 字符预算、单条只注入 250 字符摘录；Codex 给 AGENTS.md 32 KiB 总预算。
 * 共同点是<b>都有预算</b>，且超限时<b>保留名字、丢弃描述</b>——名字是模型知道
 * 「这个技能存在」的最低信息，丢了就等于技能不存在。</p>
 *
 * <p><b>超限丢弃顺序</b>：Claude Code 是「从最少调用的技能开始丢」，依赖跨会话的
 * 全局使用频次统计。本仓库没有这份数据（{@code SessionToolUsageService} 只按单个
 * 会话统计，{@code UsageArchiveService} 不含技能维度），故按用户拍板改为
 * <b>先丢最长的</b>：同样的预算下能保住最多技能的路由信息，且完全确定、无需新数据源。</p>
 *
 * @see SkillTalent 清单的渲染方
 * @see ContextLengthPolicy 上下文窗口的取值口径（本类复用其默认值与合法档位）
 */
public final class SkillListingPolicy {
    private static final Logger LOG = LoggerFactory.getLogger(SkillListingPolicy.class);

    /**
     * 清单预算占上下文窗口的百分比，对齐 Claude Code 的 {@code skillListingBudgetFraction}
     * 默认值（1%）。
     *
     * <p>窗口是 token 数而预算是字符数，二者不同量纲——这里刻意沿用 Claude Code 的
     * 口径（它的预算同样是「窗口的 1%」换算成字符），因为该值已在真实产品里验证过
     * 不会把清单挤爆也不会过度吝啬。</p>
     */
    public static final int DEFAULT_BUDGET_FRACTION = 1;

    /** 预算百分比的合法下界：0 或负数会让清单恒为空，等于禁用全部技能。 */
    public static final int MIN_BUDGET_FRACTION = 1;

    /** 预算百分比的合法上界：超过 10% 就失去了「预算」的意义。 */
    public static final int MAX_BUDGET_FRACTION = 10;

    /**
     * 单条 description 上限的合法区间。
     *
     * <p>下界 16：再小就把每条描述都削成只剩省略号，清单退化成纯名字列表，
     * 还不如直接走 LIST 档。上界 8192：再大就失去了上限的意义。</p>
     */
    public static final int MIN_DESC_CHARS = 16;
    public static final int MAX_DESC_CHARS = 8192;

    private SkillListingPolicy() {
    }

    /**
     * 归一化单条 description 上限；null 或越界一律回落 {@code defaultChars}。
     *
     * <p>与 {@link #normalizeFraction} 同理：设置项来自用户可编辑的 JSON，
     * 一个 {@code 0} 不该把所有技能描述削成空。</p>
     */
    public static int normalizeMaxDescChars(Integer raw, int defaultChars) {
        if (raw == null) {
            return defaultChars;
        }
        int v = raw;
        if (v < MIN_DESC_CHARS || v > MAX_DESC_CHARS) {
            return defaultChars;
        }
        return v;
    }

    /**
     * 归一化预算百分比；null 或越界一律回落默认值。
     *
     * <p>与 {@link ContextLengthPolicy#normalize} 同风格：设置项来自用户可编辑的
     * JSON，脏值必须静默回落而不是抛异常——一个写错的配置不该让整个技能库消失。</p>
     */
    public static int normalizeFraction(Integer raw) {
        if (raw == null) {
            return DEFAULT_BUDGET_FRACTION;
        }
        int v = raw;
        if (v < MIN_BUDGET_FRACTION || v > MAX_BUDGET_FRACTION) {
            return DEFAULT_BUDGET_FRACTION;
        }
        return v;
    }

    /**
     * 按上下文窗口算出清单的字符预算。
     *
     * @param contextLength 会话生效的上下文窗口（token）；非法值由
     *                      {@link ContextLengthPolicy#normalize} 回落默认档
     * @param fraction      预算百分比，已经过 {@link #normalizeFraction}
     * @return 字符预算，至少 1（绝不返回 0，否则清单恒空）
     */
    public static int budgetChars(long contextLength, int fraction) {
        long window = ContextLengthPolicy.normalize(contextLength);
        int pct = normalizeFraction(fraction);

        long budget = window * pct / 100L;
        if (budget < 1L) {
            return 1;
        }
        return (int) Math.min(Integer.MAX_VALUE, budget);
    }

    /**
     * 决定哪些技能在清单里<b>保留 description</b>，哪些降级为只列名字。
     *
     * <p>算法：先假设全部保留，若渲染后的总长超预算，就按 description 长度<b>降序</b>
     * 逐个降级（最长的先丢），每丢一个重算总长，直到不超或全部丢完。</p>
     *
     * <p>返回的是「需要降级为只列名字」的技能名集合。刻意返回名字而不是下标：
     * 调用方按名字查，避免与渲染顺序耦合。</p>
     *
     * @param skills        参与渲染的技能（已过滤禁用项）
     * @param budgetChars   字符预算
     * @param measure       测量函数：给定技能与「是否保留描述」，返回该条目的渲染长度。
     *                      由调用方提供，使本类不依赖具体的 XML/Markdown 渲染形态
     * @return 需要丢弃 description 的技能名（保序，按被丢弃的先后）
     */
    public static List<String> selectDropped(Collection<SkillDir> skills,
                                             int budgetChars,
                                             EntryMeasure measure) {
        List<String> dropped = new ArrayList<>();
        if (skills == null || skills.isEmpty()) {
            return dropped;
        }

        List<SkillDir> all = new ArrayList<>(skills);
        int total = 0;
        for (SkillDir s : all) {
            total += measure.lengthOf(s, true);
        }
        if (total <= budgetChars) {
            return dropped;
        }

        // 按 description 长度降序：先丢最长的，同样预算下保住最多技能的路由信息
        List<SkillDir> byDescLen = new ArrayList<>(all);
        byDescLen.sort(Comparator.comparingInt(
                (SkillDir s) -> s.getDescription() == null ? 0 : s.getDescription().length()).reversed());

        for (SkillDir s : byDescLen) {
            if (total <= budgetChars) {
                break;
            }
            int withDesc = measure.lengthOf(s, true);
            int nameOnly = measure.lengthOf(s, false);
            total -= (withDesc - nameOnly);
            dropped.add(s.getName());
        }

        if (!dropped.isEmpty() && LOG.isWarnEnabled()) {
            LOG.warn("Skill listing exceeds budget ({} chars): dropped description of {} skill(s) {}, "
                            + "names are still listed. Raise general.skillListingBudgetFraction "
                            + "or shorten the descriptions.",
                    budgetChars, dropped.size(), dropped);
        }

        return dropped;
    }

    /**
     * 单条清单条目的长度测量。
     *
     * <p>抽成接口而不是在本类里写死渲染：Java 侧清单是
     * {@code <skill name="x">desc</skill>}，Rust 侧是 {@code - **x**: desc}，
     * 形态不同但预算算法应当一致。测量交给渲染方，算法留在本类。</p>
     */
    public interface EntryMeasure {
        /**
         * @param skill         技能
         * @param withDescription true = 含描述的完整条目；false = 只列名字的降级条目
         * @return 该条目渲染后的字符数
         */
        int lengthOf(SkillDir skill, boolean withDescription);
    }
}
