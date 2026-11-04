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
package com.gourdai.ai.util;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;

/**
 * 有元数据（YamlFrontmatter）的 markdown 文档
 *
 * @author noear
 * @since 3.9.6
 */
public class Markdown {
    protected final ONode metadata = new ONode(Options.of(Feature.Decode_IgnoreError));
    protected String content = "";

    public ONode getMetadata() {
        return metadata;
    }

    /**
     * @since 3.10.5
     */
    public boolean hasMeta(String name) {
        return metadata.hasKey(name);
    }

    /**
     * @since 3.10.5
     */
    public ONode getMeta(String name) {
        return metadata.get(name);
    }

    public String getName() {
        return metadata.get("name").getString();
    }

    public String getDescription() {
        return metadata.get("description").getString();
    }

    public String getVersion() {
        return metadata.get("version").getString();
    }

    public boolean isEnabled() {
        return metadata.get("enabled").getBoolean(true);
    }

    /**
     * 触发条件（frontmatter 的 {@code trigger} 字段）。
     *
     * <p>非 Agent Skills 标准字段，但社区技能普遍在写。不读它等于把技能作者
     * 明确表述的「什么时候该用我」直接丢掉，模型只能靠 description 反推。</p>
     *
     * @return 未声明时返回 null
     */
    public String getTrigger() {
        return metadata.get("trigger").getString();
    }

    /**
     * 何时使用（frontmatter 的 {@code when_to_use} 字段）。
     *
     * <p>Claude Code 的标准扩展字段，语义与 {@link #getTrigger()} 相同。
     * 两者的优先级裁决请用 {@link #resolveWhenToUse()}，不要直接读本方法。</p>
     *
     * @return 未声明时返回 null
     */
    public String getWhenToUse() {
        return metadata.get("when_to_use").getString();
    }

    /**
     * 裁决后的「何时使用」提示：{@code when_to_use} 优先，缺省回退 {@code trigger}。
     *
     * <p>为何要两个字段都认：{@code when_to_use} 是 Claude Code 生态的标准字段，
     * {@code trigger} 则是社区技能里常见的自定义写法（且不在 Agent Skills 标准的
     * 六个字段内）。只认其中一个，另一批技能的触发声明就会静默失效。</p>
     *
     * @return 两者都未声明时返回 null
     */
    public String resolveWhenToUse() {
        String whenToUse = getWhenToUse();
        if (whenToUse != null && !whenToUse.trim().isEmpty()) {
            return whenToUse.trim();
        }

        String trigger = getTrigger();
        if (trigger != null && !trigger.trim().isEmpty()) {
            return trigger.trim();
        }

        return null;
    }

    public String getContent() {
        return content;
    }
}