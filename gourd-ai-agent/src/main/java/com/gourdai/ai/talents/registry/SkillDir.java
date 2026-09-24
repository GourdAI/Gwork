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

    public SkillDir(String name, TalentScope scope, Path realPath, String description, String version) {
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
}
