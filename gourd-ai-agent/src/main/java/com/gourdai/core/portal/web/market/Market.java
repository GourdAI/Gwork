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
     */
    default String installDirName(String slug) {
        if (slug == null) {
            return "";
        }
        return slug.replaceAll("[^a-zA-Z0-9._-]", "");
    }
}
