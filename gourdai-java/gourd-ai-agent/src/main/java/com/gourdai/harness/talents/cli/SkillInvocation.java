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

import com.gourdai.ai.talents.registry.SkillDir;

import java.util.Collection;

/**
 * 斜杠技能调用：{@code /<技能名> [补充说明]}。
 *
 * <p><b>为什么存在</b>：技能原先只靠 {@code $技能名} 由前端把符号塞进输入框，
 * 后端没有任何解析——符号连同名字原样发给模型，能不能用上全看模型是否愿意
 * 主动调 {@code skillread}（实测经常不生效）。符号本身也不直观：{@code $}
 * 在中文输入法下要切到英文键盘、视觉上又与命令的 {@code /} 抢注意力。
 * 现在统一收敛到 {@code /}：命中技能即由服务端把 SKILL.md 规约注入本轮
 * Prompt，行为确定，不依赖模型自觉。</p>
 *
 * <p><b>与命令的优先级</b>：调用方必须先查 {@code CommandRegistry}，未命中再走
 * 本类（见 {@code WebGate#isCommand} / {@code WsGate#handleCommand} /
 * {@code CliShell#isCommand}）。{@code /clear}、{@code /model} 这类内建命令
 * 永远优先，不会因为存在同名技能而被改写语义。</p>
 *
 * @author oisin
 */
public final class SkillInvocation {
    /** 唯一触发符。刻意只留一个：多符号并存正是本次要消掉的认知负担。 */
    public static final String TRIGGER = "/";

    /** 用户只输入了 {@code /技能名} 而不带说明时，替模型补的默认指令。 */
    static final String DEFAULT_REQUEST = "（未附加额外说明，请直接按上述技能规约完成任务。）";

    private final String name;
    private final String args;
    private final String prompt;

    private SkillInvocation(String name, String args, String prompt) {
        this.name = name;
        this.args = args;
        this.prompt = prompt;
    }

    /** 技能名（与 {@link SkillDir#getName()} 完全一致，可能含 {@code 分类/} 前缀）。 */
    public String getName() {
        return name;
    }

    /** 触发符之后的补充说明；未填时为空串。 */
    public String getArgs() {
        return args;
    }

    /** 已拼装好的本轮 Prompt（技能规约 + 用户请求）。 */
    public String getPrompt() {
        return prompt;
    }

    /**
     * 解析输入；不是技能调用时返回 {@code null}（调用方据此维持原语义）。
     *
     * @param skills   可用技能（应传已过滤禁用项的集合，见 {@code HarnessEngine#getSkills()}）
     * @param provider 技能内容提供者（负责读 SKILL.md 并渲染为 {@code <skill_content>}）
     * @param input    用户原始输入
     */
    public static SkillInvocation parse(Collection<SkillDir> skills, SkillProvider provider, String input) {
        if (skills == null || skills.isEmpty() || provider == null || input == null) {
            return null;
        }

        String text = input.trim();
        if (!text.startsWith(TRIGGER)) {
            return null;
        }

        // 名字可能含 "/"（分类/技能名 两级组织），所以只按空白切分，
        // 不能对整串再做一次 "/" 拆分，否则两级技能名会被截断。
        String rest = text.substring(TRIGGER.length());
        int splitIdx = indexOfWhitespace(rest);
        String name = splitIdx < 0 ? rest : rest.substring(0, splitIdx);
        if (name.isEmpty()) {
            return null;
        }

        String args = splitIdx < 0 ? "" : rest.substring(splitIdx).trim();

        SkillDir matched = findSkill(skills, name);
        if (matched == null) {
            return null;
        }

        // 以注册表中的真实名字为准（大小写可能与用户输入不同）；
        // 读不到内容时（SKILL.md 缺失）退化为「不是技能调用」，让它照旧当普通输入发给模型。
        String content = provider.readSkill(matched.getName());
        if (content == null || content.trim().isEmpty()) {
            return null;
        }

        return new SkillInvocation(matched.getName(), args, buildPrompt(content, args));
    }

    private static SkillDir findSkill(Collection<SkillDir> skills, String name) {
        for (SkillDir skill : skills) {
            if (skill.getName() != null && skill.getName().equalsIgnoreCase(name)) {
                return skill;
            }
        }
        return null;
    }

    private static int indexOfWhitespace(String text) {
        for (int i = 0; i < text.length(); i++) {
            if (Character.isWhitespace(text.charAt(i))) {
                return i;
            }
        }
        return -1;
    }

    /**
     * 拼装本轮 Prompt。
     *
     * <p>刻意不复用工具调用的原始返回（{@code <skill_content>}）就完事：
     * 模型需要知道「这次是用户显式点名要用这个技能」，否则它可能只把规约当参考、
     * 仍按自己的思路做事；「用户请求」段落则保证补充说明不会在长规约里被淹没。</p>
     */
    private static String buildPrompt(String content, String args) {
        StringBuilder sb = new StringBuilder();
        sb.append("[技能调用] 用户通过 ").append(TRIGGER).append(" 显式指定了技能，请严格按以下规约执行任务。\n");
        // 防重复读取声明（2026-10-21）：系统提示词里 SkillTalent 有一句无条件的
        // 「务必通过 skillread 读取或回顾规约」，与本注入头方向冲突——保守模型会把
        // 同一份 SKILL.md 再读一遍，上下文出现两份全文（最大技能约 29KB）。此处显式
        // 宣告规约已全文在列、勿再读取，与系统提示词的豁免子句互为呼应。
        sb.append("规约全文已随本消息注入，无需再调用 `skillread` / `skilllist` / `skillsearch` 读取本技能。\n\n");
        sb.append(content.trim()).append("\n\n");
        sb.append("## 用户请求\n");
        sb.append(args.isEmpty() ? DEFAULT_REQUEST : args);
        return sb.toString();
    }
}
