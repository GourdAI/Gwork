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
package com.gourdai.ai.talents.registry;

/**
 * 技能 / 子代理的归属作用域。
 *
 * <p>取代已移除的「挂载点别名」（原 {@code @global-skills} / {@code @workspace-skills}）。
 * 挂载点那套抽象允许用户把任意目录映射成别名，而技能与子代理的发现目录从来只有
 * 「全局区」与「当前工作区」两处、且全部标记为不可删除的 primary——既然不存在可配置的
 * 第三处，别名就没有承载任何信息，只是让提示词、REST 参数与前端下拉都得围绕一个
 * 用户改不了的字符串打转。这里把它收敛成两个枚举值。</p>
 *
 * <p>同名冲突时 <b>workspace 覆盖 global</b>：项目内的定制理应压过全局默认。
 * 原实现遍历 {@code ConcurrentHashMap} 后 {@code put}，谁覆盖谁取决于哈希顺序，
 * 是不可复现的行为，此处改为确定语义。</p>
 *
 * @author oisin
 * @since 4.1.0
 */
public enum TalentScope {
    /**
     * 全局区（{@code <harnessBase>/.gwork/skills}、{@code .../agents}），跨项目共享。
     */
    GLOBAL("global"),

    /**
     * 当前工作区（{@code <workspace>/.gwork/skills}、{@code .../agents}），仅本项目可见。
     */
    WORKSPACE("workspace");

    private final String code;

    TalentScope(String code) {
        this.code = code;
    }

    /**
     * 对外传输用的码值（REST 参数、前端下拉、JSON 落盘统一用它）。
     */
    public String code() {
        return code;
    }

    /**
     * 按码值解析；无法识别时返回 {@code null}。
     *
     * <p>刻意不做 fail-safe 兜底：调用方（REST 层）需要区分「用户没传」与「用户传了个
     * 不存在的值」，后者应当明确 400，而不是静默装到另一个作用域里去。</p>
     */
    public static TalentScope of(String value) {
        if (value == null) {
            return null;
        }

        String text = value.trim();
        if (text.isEmpty()) {
            return null;
        }

        for (TalentScope scope : values()) {
            if (scope.code.equalsIgnoreCase(text) || scope.name().equalsIgnoreCase(text)) {
                return scope;
            }
        }

        return null;
    }
}
