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

import java.nio.file.Path;

/**
 * 子代理定义文件描述（目录扫描产物，不含解析后的正文）。
 *
 * <p>原位于 {@code com.gourdai.ai.talents.mount}，随挂载点功能移除迁至本包；
 * {@code mountAlias} 字段由 {@link TalentScope} 取代。</p>
 *
 * @author noear
 * @since 3.11.0
 */
public class AgentMd {
    /** 代理名（如 "code-review"，来自文件名去掉 .md 后缀） */
    private final String name;
    /** 归属作用域（全局区 / 工作区） */
    private final TalentScope scope;
    /** .md 文件物理路径 */
    private final Path filePath;

    public AgentMd(String name, TalentScope scope, Path filePath) {
        this.name = name;
        this.scope = scope;
        this.filePath = filePath;
    }

    public String getName() {
        return name;
    }

    /**
     * 归属作用域。
     *
     * <p>{@code AgentDefinition} 用它区分「内置代理」与「扫描到的自定义代理」：
     * 内置代理由 classpath 资源加载、scope 为 {@code null}，自定义代理必有 scope。
     * 刷新时只回收 scope 非空的那些，内置代理不受影响。</p>
     */
    public TalentScope getScope() {
        return scope;
    }

    public Path getFilePath() {
        return filePath;
    }
}
