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

import com.gourdai.ai.talents.registry.SkillDir;
import org.noear.snack4.ONode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 技能「展示名」解析 —— 全仓唯一口径。
 *
 * <p><b>WHY 必须抽成单一来源</b>：本地扫描出的技能名是<b>安装目录名</b>，namespace 限定 slug
 * 会落成 {@code _owner_slug}（如 {@code @user_3b5e1511/lawyer-letter5399} →
 * {@code _user_3b5e1511_lawyer-letter5399}）。这个名字对用户不可读，且与市场卡片上的
 * 名字对不上。展示名因此是<b>展示层</b>的事，同一件事有三个消费方：</p>
 * <ol>
 *   <li>技能市场「已安装」列表（{@code WebSettingsController.skillsInstalled}）</li>
 *   <li>任务监控「技能调用」区（{@link SessionToolUsageService} 的统计结果经
 *       {@code WebController.sessionToolUsage} 装饰）</li>
 *   <li>前端 {@code app-skills.js} 的 {@code marketBareSlug}（同口径副本）</li>
 * </ol>
 *
 * <p>2026-10 已发生过的真实缺陷：修好了技能页的展示名，却漏了任务监控——同一个技能在
 * 技能页叫 {@code lawyer-letter5399}、在监控里仍叫 {@code _user_3b5e1511_lawyer-letter5399}。
 * 根因是口径散落各处、每处各算一套。本类把它们收成一个出口，新增消费方只调这里。</p>
 *
 * <p><b>三层口径</b>（与 {@code WebSettingsControllerInstalledDisplayNameTest} 锁定的语义一致）：</p>
 * <ol>
 *   <li>meta 有 {@code displayName}（新装技能，安装时从市场接口落盘）→ 原样返回；</li>
 *   <li>meta 无 displayName 但有限定 slug（旧安装记录）→ 退市场 slug 的裸尾名
 *       （{@code @owner/slug} → {@code slug}），比目录名可读且能与市场卡对上号；</li>
 *   <li>无 meta（手放技能的本地技能）→ 返回 {@code null}，由调用方回退到技能名本身。</li>
 * </ol>
 *
 * <p><b>信任边界</b>：displayName 只来自<b>市场接口</b>（安装时写入
 * {@code .skill-market.json}），绝不读安装包内的自述内容——安装包是第三方内容，
 * 采信包内自述名会让发布者把自己的技能伪装成任意已有技能。</p>
 *
 * @author oisin
 * @see WebSettingsController#writeMarketMeta 写侧（displayName 的唯一来源）
 */
final class SkillDisplayNames {

    /** 市场元数据文件名（由 {@link WebSettingsController#writeMarketMeta} 写入）。 */
    static final String META_FILE = ".skill-market.json";

    private SkillDisplayNames() {
        // 工具类：禁止实例化
    }

    /**
     * 从技能目录解析展示名；算不出返回 {@code null}（调用方回退到技能名）。
     *
     * @param skillDir 技能真实目录（{@link SkillDir#getRealPath()}）
     */
    static String of(Path skillDir) {
        return ofMeta(readMarketMeta(skillDir));
    }

    /**
     * 从已读到的市场元数据解析展示名；无 meta 或无任何可读名返回 {@code null}。
     *
     * <p>供已经读过 meta 的调用方复用（{@code skillsInstalled} 还要取 market/slug/iconUrl），
     * 避免为同一份文件做第二次 IO。</p>
     */
    static String ofMeta(ONode meta) {
        if (meta == null) {
            return null;
        }
        String displayName = text(meta.get("displayName"));
        if (displayName != null) {
            return displayName;
        }
        // 旧安装记录：当时只存 market/slug/icon，没有展示名 —— 退裸尾名
        return marketBareSlug(text(meta.get("slug")));
    }

    /**
     * 全部已安装技能的「技能名 → 展示名」映射（仅收录能算出的项）。
     *
     * <p>键必须是 {@link SkillDir#getName()} —— 它是 {@code skillread} 的 {@code name}
     * 参数值，也是用量账本 {@code skill} 字段落盘的值。三者同源，映射才命中。</p>
     *
     * @param skills 已扫描技能（通常 {@code engine.getSkillsAll()}，含禁用项：禁用技能
     *               仍可能留在历史账本里，名字照样要能读）
     */
    static Map<String, String> ofAll(Collection<SkillDir> skills) {
        Map<String, String> out = new LinkedHashMap<>();
        if (skills == null) {
            return out;
        }
        for (SkillDir skill : skills) {
            if (skill == null || skill.getName() == null) {
                continue;
            }
            String displayName = of(skill.getRealPath());
            if (displayName != null) {
                out.put(skill.getName(), displayName);
            }
        }
        return out;
    }

    /**
     * 市场 slug 的裸尾形态（{@code @owner/slug} → {@code slug}；裸 slug 原样返回）。
     *
     * <p><b>与前端 {@code app-skills.js} 的 {@code marketBareSlug} 严格同口径</b>：
     * 分隔符下标必须 {@code > 1}（而不是 {@code > 0}）。首版前端写的是 {@code > 0}，
     * 对 {@code @/slug} 这种畸形 slug 前端会剥成 {@code slug}、后端却原样返回，
     * 同一个 slug 在两端算出不同展示名。契约见
     * {@code skills-view-contract.test.js} 的「裸尾 slug 口径」用例。</p>
     */
    static String marketBareSlug(String slug) {
        if (slug == null) {
            return null;
        }
        if (slug.startsWith("@") && slug.indexOf('/') > 1) {
            return slug.substring(slug.indexOf('/') + 1);
        }
        return slug;
    }

    /**
     * 读取技能目录的市场元数据（{@code .skill-market.json}），不存在或解析失败返回 {@code null}。
     */
    static ONode readMarketMeta(Path skillDir) {
        if (skillDir == null) {
            return null;
        }
        Path meta = skillDir.resolve(META_FILE);
        if (!Files.isRegularFile(meta)) {
            return null;
        }
        try {
            return ONode.ofJson(new String(Files.readAllBytes(meta), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 节点 → 非空 trim 字符串；节点缺失/null/空白一律返回 {@code null}。
     *
     * <p>不能直接 {@code meta.get(k).getString()}：snack4 对不存在的键的返回形态
     * 是 null node 还是 Java {@code null} 未在项目内约定，两条路径都要挡住。</p>
     */
    private static String text(ONode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        String value = node.getString();
        if (value == null) {
            return null;
        }
        value = value.trim();
        return value.isEmpty() ? null : value;
    }
}
