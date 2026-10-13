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

import org.noear.solon.core.util.Assert;

import java.nio.file.Path;

/**
 * 技能目录（扫描产物）。
 *
 * <p>原位于 {@code com.gourdai.ai.talents.mount}，随挂载点功能移除迁至本包。
 * 变化：{@code mountAlias} / {@code aliasPath} 两个字段被 {@link TalentScope} 取代——
 * 技能发现目录只有「全局区」与「工作区」两处，不再需要挂载别名这层间接。</p>
 *
 * @author noear
 * @since 3.11.0
 */
public class SkillDir {
    private final String name;
    private final TalentScope scope;
    private final Path realPath;
    private final String description;
    private final String version;
    private final boolean enabled;
    private final String whenToUse;

    public SkillDir(String name, TalentScope scope, Path realPath, String description, String version) {
        this(name, scope, realPath, description, version, true);
    }

    public SkillDir(String name, TalentScope scope, Path realPath, String description, String version, boolean enabled) {
        this(name, scope, realPath, description, version, enabled, null);
    }

    public SkillDir(String name, TalentScope scope, Path realPath, String description, String version,
                    boolean enabled, String whenToUse) {
        this.name = name;
        this.scope = scope;
        this.realPath = realPath;

        if (Assert.isEmpty(description)) {
            this.description = "技能规约。";
        } else {
            this.description = description;
        }

        if (version == null) {
            this.version = "";
        } else {
            this.version = version;
        }

        this.enabled = enabled;

        if (whenToUse == null) {
            this.whenToUse = "";
        } else {
            this.whenToUse = whenToUse.trim();
        }
    }

    public String getName() {
        return name;
    }

    /**
     * 归属作用域（全局区 / 工作区）。
     */
    public TalentScope getScope() {
        return scope;
    }

    public Path getRealPath() {
        return realPath;
    }

    public String getDescription() {
        return description;
    }

    public String getVersion() {
        return version;
    }

    /**
     * 是否启用（SKILL.md frontmatter 的 {@code enabled} 字段，缺省 true）。
     *
     * <p>禁用的技能仍会被扫描进注册表（管理视图需要展示并允许重新启用），
     * 但 {@link TalentRegistry#getSkills()} 会将其过滤掉——对模型与
     * {@code /web/chat/hints} 而言等于不存在。</p>
     */
    public boolean isEnabled() {
        return enabled;
    }

    /**
     * 「何时使用」提示 — 来自 SKILL.md frontmatter 的 {@code when_to_use} 或 {@code trigger}。
     *
     * <p>与 {@link #getDescription()} 的区别：description 说明技能<b>做什么</b>，
     * 本字段说明<b>什么情况下该用</b>（触发短语、示例请求）。二者一起构成模型
     * 的路由依据；只有 description 时模型容易漏判。</p>
     *
     * @return 未声明时返回空字符串（不返回 null，调用方可直接拼接）
     */
    public String getWhenToUse() {
        return whenToUse;
    }

    /**
     * 是否声明了「何时使用」提示。
     */
    public boolean hasWhenToUse() {
        return !whenToUse.isEmpty();
    }
}
