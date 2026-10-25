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
package com.gourdai.harness.talents.cli;

import com.gourdai.ai.annotation.ToolMapping;
import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.talent.AbsTalent;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.talents.registry.SkillDir;
import com.gourdai.ai.talents.registry.TalentRegistry;
import com.gourdai.harness.talents.cli.impl.RegistrySkillProvider;
import org.noear.solon.annotation.Param;

import java.io.IOException;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 技能管理器
 *
 * 支持三阶段模式自动切换：
 * 1. SUMMARY: 数量 <= listThreshold。展示带描述的技能清单。
 * 2. LIST: 数量 <= searchThreshold。仅展示技能路径索引。
 * 3. SEARCH: 数量 > searchThreshold。强制搜索模式。
 */
public class SkillTalent extends AbsTalent {
    private volatile SkillProvider skillProvider;

    private int listThreshold = 30;
    private int searchThreshold = 100;

    public SkillTalent(TalentRegistry talentRegistry) {
        this.skillProvider = new RegistrySkillProvider(talentRegistry);
    }

    public SkillTalent(SkillProvider skillProvider) {
        this.skillProvider = skillProvider;
    }


    public SkillProvider getSkillProvider() {
        return skillProvider;
    }

    public void setSkillProvider(SkillProvider skillProvider) {
        Objects.requireNonNull(skillProvider, "skillProvider");

        this.skillProvider = skillProvider;
    }

    public SkillTalent listThreshold(int val) {
        this.listThreshold = val;
        return this;
    }

    public SkillTalent searchThreshold(int val) {
        this.searchThreshold = val;
        return this;
    }

    @Override
    public String description() {
        return "技能管理器。支持从全局区与工作区发现并加载技能 (SKILL.md)。";
    }

    @Override
    public String getInstruction(Prompt prompt) {
        Collection<SkillDir> skillList = skillProvider.getSkillAll();
        if (skillList.isEmpty()) return null;

        int total = skillList.size();
        StringBuilder sb = new StringBuilder();

        // 本行是三档共用的前言，因此绝不能绑定具体工具名：
        // skillsearch 只在 >searchThreshold 档才开放（见 getTools），在此处推荐它
        // 会让 SUMMARY / LIST 两档的模型去调一个不存在的工具。
        // 各档自己的「不确定时怎么办」已由下方分档文案分别交代。
        //
        // 【豁免子句的由来（2026-10-21）】斜杠技能调用（/技能名）已由服务端把 SKILL.md
        // 全文注入本轮 user 消息（见 SkillInvocation），而本行无条件要求「务必 skillread」，
        // 两句方向冲突：保守模型会把同一份规约再读一遍，上下文里出现两份全文
        // （最大技能约 29KB，翻倍即数万 token）。故补「已随用户消息注入则直接用、勿重读」，
        // 与注入头里的「勿再 skillread」声明互为呼应，从源头消掉重复读取。
        sb.append("优先使用合适的技能解决问题。**注意：在执行任务中，请务必通过 `skillread` 读取或回顾规约；"
                + "若本轮用户消息已随附该技能的完整规约（斜杠技能调用），则直接使用已注入内容，勿重复读取。**\n\n");

        sb.append("## 技能库执行规约 (当前可用技能: " + total + ")\n");

        if (total <= listThreshold) {
            // --- 档位 1: SUMMARY  ---
            sb.append("### 运行模式: 摘要发现\n");
            sb.append("请审阅下方技能清单。若某个技能匹配当前需求，请调用 `skillread` 获取具体执行规约与工具参数：\n");

            sb.append("<skill_list>\n");
            for (SkillDir s : skillList) {
                sb.append("  <skill name=\"").append(s.getName()).append("\">").append(s.getDescription());
                appendWhenToUse(sb, s);
                sb.append("</skill>\n");
            }
            sb.append("</skill_list>");
        } else if (total <= searchThreshold) {
            // --- 模式 2: LIST ---
            sb.append("### 运行模式: 路径导航\n");
            // 此处必须推荐 skilllist 而非 skillsearch：本档的 getTools 刻意过滤掉了 skillsearch
            // （它只在 >searchThreshold 时才有意义 —— 那时全量清单太大，skilllist 会主动拒绝）。
            // 而 skilllist 在本档可用且一次就能拿回全部描述，是「不确定时」的正确出路。
            // 曾经这里写的是 skillsearch，模型照着调必然得到「工具不存在」。
            sb.append("当前技能较多，仅展示路径索引（没有描述）。请推断功能并调用 `skillread`；若无法判断，先用 `skilllist` 取回带描述的完整清单：\n");

            sb.append("<skill_list>\n");
            for (SkillDir s : skillList) {
                sb.append("  <skill name=\"").append(s.getName()).append("\"");
                if (s.hasWhenToUse()) {
                    // 本档刻意丢了 description 以控体积，但「何时使用」是唯一的路由线索，
                    // 一并丢掉会让模型只能看名字猜功能 —— 保留它，并截到与其他档一致的上限。
                    sb.append(" when_to_use=\"").append(clipWhenToUse(s.getWhenToUse())).append("\"");
                }
                sb.append(" />\n");
            }
            sb.append("</skill_list>");
        } else {
            // --- 模式 3: SEARCH ---
            sb.append("### 运行模式: 动态发现\n");
            sb.append("由于技能库规模较大。**禁止猜测路径**。你必须先通过 `skillsearch` 检索关键字，确认 name 后再调用 `skillread` 读取。\n");
        }

        return sb.toString();
    }

    @Override
    public Collection<FunctionTool> getTools(Prompt prompt) {
        Collection<SkillDir> skillList = skillProvider.getSkillAll();
        if (skillList.isEmpty()) return null;

        int total = skillList.size();

        if (total <= listThreshold) {
            // 少量时，直接 read 即可，不需要 search 和 list 干扰
            return getToolAry().stream().filter(t -> t.name().equals("skillread")
                    || t.name().equals("skillrefresh")).collect(Collectors.toList());
        }

        if (total <= searchThreshold) {
            // 中等规模，保留所有（read, list, refresh），但不强制 search
            return getToolAry().stream().filter(t -> !t.name().equals("skillsearch")).collect(Collectors.toList());
        }

        // 大规模，强制搜索（全量工具开放）
        return getToolAry();
    }

    @ToolMapping(name = "skilllist", description = "列出本地所有可用的技能清单。")
    public String skilllist() {
        Collection<SkillDir> skillList = skillProvider.getSkillAll();
        if (skillList.isEmpty()) {
            return "当前没有可用的技能。";
        }

        if (skillList.size() > searchThreshold) {
            return String.format("Error: 当前技能库规模较大 (%d)，禁止全量列出。请使用 `skillsearch` 配合关键字定位。", skillList.size());
        }

        StringBuilder sb = new StringBuilder("可用技能列表：\n");

        sb.append("<skill_list>\n");
        for (SkillDir s : skillList) {
            sb.append("  <skill name=\"").append(s.getName()).append("\">").append(s.getDescription());
            appendWhenToUse(sb, s);
            sb.append("</skill>\n");
        }
        sb.append("</skill_list>");

        return sb.toString();
    }

    @ToolMapping(name = "skillsearch", description = "在本地技能库中搜索关键字。支持空格分隔多个词。")
    public String skillsearch(@Param("query") String query) {
        Collection<SkillDir> matches = skillProvider.searchSkill(query);

        if (matches.isEmpty()) return "未找到匹配技能。";

        StringBuilder sb = new StringBuilder("<skill_list>\n");
        for (SkillDir s : matches) {
            sb.append("  <skill name=\"").append(s.getName()).append("\">").append(s.getDescription());
            appendWhenToUse(sb, s);
            sb.append("</skill>\n");
        }
        sb.append("</skill_list>");

        return sb.toString();
    }

    @ToolMapping(name = "skillread", description = "读取本地技能详细说明书。在选定技能后、开始执行具体任务前，必须调用此工具以获取具体的环境要求、参数规约及可用文件别名。")
    public String skillread(@Param(value = "name", description = "技能的唯一路径标识（例如：'deep-research'）") String name, String __cwd) throws IOException {
        // 从内存 Map 查找逻辑路径
        String content = skillProvider.readSkill(name);

        if (content != null) {
            return content;
        }

        return "Error: " + name + " 不是有效的技能目录 (缺少 SKILL.md)";
    }

    @ToolMapping(name = "skillrefresh", description = "重新扫描技能目录，更新技能列表。")
    public String skillrefresh() {
        skillProvider.refresh();
        return "技能库已刷新，当前可用技能数：" + skillProvider.getSkillCount();
    }

    // --- 「何时使用」提示的渲染 ---

    /**
     * 进入清单的「何时使用」字符上限。
     *
     * <p>对齐 Agent Skills 生态：Pi 与 Zcode 都把 description 上限设在 1024，
     * Claude Code 则把 description + when_to_use 合并后截到 1536。本字段是
     * 附加在 description 之外的路由线索，取同一量级的一半即可：足以放下几个
     * 触发短语，又不至于让一个写了几千字触发条件的技能把每轮提示词撑大。</p>
     */
    static final int WHEN_TO_USE_MAX_CHARS = 512;

    /**
     * 有声明就追加 {@code [何时使用: ...]} 片段；未声明则什么都不加。
     *
     * <p>刻意不写成独立 XML 属性：本方法的三个调用点都是
     * {@code <skill name="x">描述</skill>} 这种「描述在元素体内」的形态，
     * 追加到体内比改成属性对现有提示词结构扰动更小。</p>
     */
    private static void appendWhenToUse(StringBuilder sb, SkillDir skill) {
        if (!skill.hasWhenToUse()) {
            return;
        }

        sb.append(" [何时使用: ").append(clipWhenToUse(skill.getWhenToUse())).append("]");
    }

    /**
     * 截断 + XML 转义。
     *
     * <p>截断是兵家必争之地：该文本是用户数据（技能作者写的），不截就等于把
     * 提示词体积交给外部文件控制。转义则是因为它要落进 XML 属性值，
     * 描述里的 {@code "} 或 {@code <} 会直接产出畸形标签。</p>
     */
    private static String clipWhenToUse(String raw) {
        String text = raw.trim().replaceAll("\\s+", " ");

        if (text.length() > WHEN_TO_USE_MAX_CHARS) {
            text = text.substring(0, WHEN_TO_USE_MAX_CHARS - 1) + "…";
        }

        return text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}