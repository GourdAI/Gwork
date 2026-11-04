package com.gourdai.core.portal.web.market;

import org.noear.solon.core.handle.Result;

import java.nio.file.Path;
import java.util.List;

/**
 * 技能市场接口 — 抽象技能市场的浏览、搜索、安装能力。
 *
 * <p>不同市场（ClawHub、Skills.sh 等）可实现此接口，由 MarketManager 注入管理。</p>
 *
 * @author oisin
 */
public interface Market {
    /**
     * 获取市场名称
     */
     String name() ;

    /**
     * 获取市场描述
     */
    default String description() {
        return "";
    }

    /**
     * 获取热门技能列表（cursor 游标分页）
     * @param cursor 上一页返回的游标；首次加载传 null/空
     * @param limit  每页条数
     */
    Result<MarketPageResult> trending(String cursor, int limit);

    /**
     * 按分类获取热门技能列表。默认忽略分类（市场无分类能力时前端隐藏分类栏）。
     *
     * @param category 市场原生分类 key；null/空 表示全部分类
     */
    default Result<MarketPageResult> trending(String cursor, int limit, String category) {
        return trending(cursor, limit);
    }

    /**
     * 搜索技能（cursor 游标分页）
     * @param cursor 上一页返回的游标；首次加载传 null/空
     * @param limit  每页条数
     */
    Result<MarketPageResult> search(String query, String cursor, int limit);

    /**
     * 按分类搜索技能。默认忽略分类。
     */
    default Result<MarketPageResult> search(String query, String cursor, int limit, String category) {
        return search(query, cursor, limit);
    }

    /**
     * 获取市场支持的分类列表。默认空列表 = 该市场无分类能力。
     */
    default Result<List<MarketCategory>> categories() {
        return Result.succeed(java.util.Collections.emptyList());
    }

    /**
     * 获取技能详情
     */
    Result<MarketDetail> detail(String slug);

    /**
     * 安装技能 — 下载并解压到指定目录
     */
    Result<String> install(String slug, Path skillsDir);

    /**
     * 安装后的本地目录名 — 控制器据此定位落盘目录以写入市场元数据。
     *
     * <p>默认与多数适配器一致：剥离非法字符后的 slug；ModelScope 的
     * {@code @owner/name} 形态需替换分隔符，由其自行覆写。</p>
     *
     * <p><b>namespace 限定 slug</b>（{@code @owner/slug}，用于上游存在不同作者
     * 共用同一公开 slug 的市场，如 skillhub）：把 {@code @} 与 {@code /} 替换为
     * 下划线落盘（{@code @o/s} → {@code _o_s}），使同名技能可并存；裸 slug 仍按
     * 剥离口径落盘，与历史安装目录保持同名（不迁移旧目录）。</p>
     */
    default String installDirName(String slug) {
        if (slug == null) {
            return "";
        }
        // 限定形态判定与 SkillhubMarket.isQualifiedSlug 逐字同口径（@ 起首、
        // / 两侧非空）：两侧口径若漂移，install 剥离后的目录名会与控制器
        // writeMarketMeta 据原始 slug 算出的目录名不一致 → 元数据静默丢失。
        int slash = slug.indexOf('/');
        if (slug.startsWith("@") && slash > 1 && slash < slug.length() - 1) {
            return slug.replaceAll("[@/]", "_");
        }
        return slug.replaceAll("[^a-zA-Z0-9._-]", "");
    }
}
