package com.gourdai.core.portal.web.market.impl;

import org.noear.snack4.ONode;
import com.gourdai.core.portal.web.market.Market;
import com.gourdai.core.portal.web.market.MarketDetail;
import com.gourdai.core.portal.web.market.MarketItem;
import com.gourdai.core.portal.web.market.MarketPageResult;
import org.noear.solon.core.handle.Result;
import org.noear.solon.core.util.Assert;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedInputStream;
import java.net.URLEncoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * SkillHub 市场适配器 — 对接 skillhub.cn（ClawHub 中国本土化镜像）。
 *
 * <p>列表/搜索使用官网"全部技能"真分页端点 GET /api/skills（page/pageSize/keyword/sortBy，
 * 响应含 data.total，技能总量 10 万+）；详情、下载使用 skillhub.cn 自有 API（api.skillhub.cn）。</p>
 *
 * @author oisin
 */
public class SkillhubMarket implements Market {

    private static final Logger LOG = LoggerFactory.getLogger(SkillhubMarket.class);

    private static final String BASE_URL = "https://api.skillhub.cn";
    private static final String USER_AGENT = "GWork/1.0";

    /** 上游 /api/skills 的 pageSize 实测上限（100 可用，200 返回 400） */
    private static final int UPSTREAM_MAX_PAGE_SIZE = 100;

    @Override
    public String name() {
        return "skillhub.cn";
    }

    @Override
    public String description() {
        return "专为中国用户优化的技能社区";
    }

    // ==================== 列表与搜索 ====================

    @Override
    public Result<MarketPageResult> trending(String cursor, int limit) {
        return fetchPaged(null, cursor, limit, "获取热门技能失败: ");
    }

    @Override
    public Result<MarketPageResult> search(String query, String cursor, int limit) {
        if (Assert.isEmpty(query)) {
            return trending(cursor, limit);
        }
        return fetchPaged(query, cursor, limit, "搜索技能失败: ");
    }

    /**
     * 真分页入口 — 对接官网"全部技能"端点 GET /api/skills。
     *
     * <p>该端点支持服务端翻页（page 从 1 起、pageSize 上限 {@link #UPSTREAM_MAX_PAGE_SIZE}）、
     * 关键词搜索（keyword）与排序（sortBy），响应 data.total 为真实总量（10 万+）。
     * cursor 语义 = 上游页码字符串；nextCursor 由真实总量计算，末页返回 null。</p>
     *
     * <p>注：旧的 /api/v1/search 端点忽略所有翻页参数且 limit 上限 100，已弃用。</p>
     */
    private Result<MarketPageResult> fetchPaged(String query, String cursor, int limit, String errPrefix) {
        try {
            int pageSize = (limit > 0 && limit <= UPSTREAM_MAX_PAGE_SIZE) ? limit : 20;
            int page = parsePageFromCursor(cursor);
            boolean isSearch = query != null && !query.isEmpty();

            StringBuilder url = new StringBuilder(BASE_URL).append("/api/skills")
                    .append("?page=").append(page)
                    .append("&pageSize=").append(pageSize)
                    .append("&sortBy=").append(isSearch ? "score" : "downloads");
            if (isSearch) {
                url.append("&keyword=").append(URLEncoder.encode(query, "UTF-8"));
            }

            String body = httpGet(url.toString());
            ONode root = ONode.ofJson(body);

            ONode codeNode = root.get("code");
            if (codeNode != null && !codeNode.isNull() && codeNode.getLong() != 0) {
                ONode msgNode = root.get("message");
                String errorMsg = (msgNode != null && !msgNode.isNull()) ? msgNode.getString() : "upstream error";
                throw new IllegalStateException(errorMsg);
            }

            ONode dataNode = root.get("data");
            long total = (dataNode != null && !dataNode.isNull()) ? getLongValue(dataNode, "total") : 0;
            List<MarketItem> items = parseSkills(dataNode);

            // nextCursor 由真实总量计算：当前页未满总量且本页非空才有下一页，杜绝伪造游标
            boolean hasMore = !items.isEmpty() && (long) page * pageSize < total;
            String nextCursor = hasMore ? String.valueOf(page + 1) : null;
            return Result.succeed(new MarketPageResult(items, nextCursor));
        } catch (Exception e) {
            LOG.warn("SkillhubMarket.fetchPaged error: {}", e.getMessage());
            return Result.failure(errPrefix + e.getMessage());
        }
    }

    // ==================== 详情 ====================

    @Override
    public Result<MarketDetail> detail(String slug) {
        if (Assert.isEmpty(slug)) {
            return Result.failure("slug is required");
        }

        try {
            // 使用 skillhub 详情接口: GET /api/v1/skills/{slug}
            String url = BASE_URL + "/api/v1/skills/" + URLEncoder.encode(slug, "UTF-8");
            String body = httpGet(url);
            ONode root = ONode.ofJson(body);

            if (root.hasKey("error")) {
                ONode msgNode = root.get("message");
                String errorMsg = (msgNode != null && !msgNode.isNull()) ? msgNode.getString() : "技能不存在";
                return Result.failure(errorMsg);
            }

            // 解析 skillhub 详情响应
            // 响应结构: { skill: { slug, displayName, summary, summary_zh, stats: { installs, stars, downloads } },
            //             owner: { handle, displayName }, latestVersion: { version } }
            ONode skillNode = root.get("skill");
            if (skillNode == null) {
                return Result.failure("技能不存在: " + slug);
            }

            String resolvedSlug = getStringValue(skillNode, "slug");
            String displayName = getStringValue(skillNode, "displayName");
            String summary = firstNonEmpty(
                    getStringValue(skillNode, "summary_zh"),
                    getStringValue(skillNode, "summary"));

            long installs = 0;
            long stars = 0;
            ONode statsNode = skillNode.get("stats");
            if (statsNode != null) {
                installs = getLongValue(statsNode, "installs");
                stars = getLongValue(statsNode, "stars");
            }

            String ownerHandle = null;
            ONode ownerNode = root.get("owner");
            if (ownerNode != null) {
                ownerHandle = getStringValue(ownerNode, "handle");
            }

            String latestVersion = null;
            ONode versionNode = root.get("latestVersion");
            if (versionNode != null) {
                latestVersion = getStringValue(versionNode, "version");
            }

            MarketDetail detail = new MarketDetail()
                    .slug(resolvedSlug)
                    .displayName(displayName)
                    .summary(summary)
                    .description(summary)
                    .ownerHandle(ownerHandle)
                    .installs(installs)
                    .stars(stars)
                    .installSlug(resolvedSlug);

            return Result.succeed(detail);
        } catch (Exception e) {
            LOG.warn("SkillhubMarket.detail error: {}", e.getMessage());
            return Result.failure("获取技能详情失败: " + e.getMessage());
        }
    }

    // ==================== 安装 ====================

    @Override
    public Result<String> install(String slug, Path skillsDir) {
        if (Assert.isEmpty(slug)) {
            return Result.failure("slug is required");
        }

        slug = slug.replaceAll("[^a-zA-Z0-9._-]", "");
        if (slug.isEmpty()) {
            return Result.failure("Invalid slug");
        }

        try {
            Result<MarketDetail> detailResult = detail(slug);
            if (detailResult.getCode() != 200) {
                return Result.failure("技能不存在: " + detailResult.getDescription());
            }

            String displayName = detailResult.getData().getDisplayName();
            if (displayName == null || displayName.isEmpty()) {
                displayName = slug;
            }

            // 使用 skillhub 自己的下载接口: GET /api/v1/download?slug={slug}
            String downloadUrl = BASE_URL + "/api/v1/download?slug="
                    + URLEncoder.encode(slug, "UTF-8");

            Files.createDirectories(skillsDir);

            Path tempZip = Files.createTempFile("skill-", ".zip");
            try {
                try (HttpResponse httpResp = HttpUtils.http(downloadUrl)
                        .header("User-Agent", USER_AGENT)
                        // 单位：秒（connect/write/read）；技能包下载放宽 read
                        .timeout(10, 10, 120)
                        .exec("GET")) {

                    byte[] zipBytes = httpResp.bodyAsBytes();
                    if (zipBytes == null || zipBytes.length == 0) {
                        return Result.failure("下载技能包失败: 返回内容为空");
                    }
                    Files.write(tempZip, zipBytes);
                }

                if (Files.size(tempZip) == 0) {
                    return Result.failure("下载技能包失败: 文件为空");
                }

                Path targetDir = skillsDir.resolve(slug);
                if (Files.exists(targetDir)) {
                    deleteDirectory(targetDir);
                }

                unzipToDirectory(tempZip, targetDir);

                LOG.info("SkillhubMarket.install: {} -> {}", slug, targetDir);
                return Result.succeed(displayName);
            } finally {
                Files.deleteIfExists(tempZip);
            }

        } catch (Exception e) {
            LOG.warn("SkillhubMarket.install error: {}", e.getMessage(), e);
            return Result.failure("安装失败: " + e.getMessage());
        }
    }

    // ==================== 内部工具方法 ====================

    /**
     * 将统一接口的 cursor 解析为上游页码（从 1 起）。
     * <p>cursor 由本适配器上一次响应的 nextCursor 生成（=page+1 字符串）。</p>
     */
    private int parsePageFromCursor(String cursor) {
        if (Assert.isEmpty(cursor)) {
            return 1;
        }
        try {
            int page = Integer.parseInt(cursor.trim());
            return page > 0 ? page : 1;
        } catch (NumberFormatException e) {
            return 1;
        }
    }

    private String httpGet(String url) throws Exception {
        return HttpUtils.http(url)
                .header("User-Agent", USER_AGENT)
                // 单位：秒（connect/write/read）
                .timeout(10, 10, 30)
                .get();
    }

    /**
     * 解析 /api/skills 响应的 data.skills 数组。
     *
     * <p>字段与旧 /api/v1/search 不同：显示名为 name（中文）、描述为 description/description_zh、
     * 作者为 ownerName（或 namespace.handle）、下载量为 downloads（installs 多为 0）。</p>
     */
    private List<MarketItem> parseSkills(ONode dataNode) {
        if (dataNode == null || dataNode.isNull()) {
            return Collections.emptyList();
        }
        ONode skillsNode = dataNode.get("skills");
        if (skillsNode == null || !skillsNode.isArray()) {
            return Collections.emptyList();
        }

        List<MarketItem> result = new ArrayList<>();
        for (ONode node : skillsNode.getArray()) {
            String slug = getStringValue(node, "slug");

            long installs = getLongValue(node, "installs");
            long downloads = getLongValue(node, "downloads");

            String owner = getStringValue(node, "ownerName");
            if (owner == null || owner.isEmpty()) {
                ONode nsNode = node.get("namespace");
                if (nsNode != null && !nsNode.isNull()) {
                    owner = getStringValue(nsNode, "handle");
                }
            }

            String desc = firstNonEmpty(
                    getStringValue(node, "description_zh"),
                    getStringValue(node, "description"));

            MarketItem item = new MarketItem()
                    .slug(slug)
                    .name(slug)
                    .displayName(firstNonEmpty(getStringValue(node, "name"), slug))
                    .summary(desc)
                    .description(desc)
                    .ownerHandle(owner)
                    .url(firstNonEmpty(
                            getStringValue(node, "homepage"),
                            "https://skillhub.cn/skills/" + slug))
                    .installs(installs > 0 ? installs : downloads)
                    .stars(getLongValue(node, "stars"));

            result.add(item);
        }
        return result;
    }

    private String getStringValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getString() : null;
    }

    private long getLongValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getLong() : 0;
    }

    /**
     * 返回第一个非空、非空的字符串
     */
    private String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return null;
    }

    private void deleteDirectory(Path dir) throws Exception {
        if (!Files.exists(dir)) return;
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (Exception ignored) {
                    }
                });
    }

    private void unzipToDirectory(Path zipFile, Path targetDir) throws Exception {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(Files.newInputStream(zipFile)));
        try {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path entryPath = targetDir.resolve(entry.getName()).normalize();

                if (!entryPath.startsWith(targetDir.normalize())) {
                    continue;
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    Files.copy(zis, entryPath, StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        } finally {
            zis.close();
        }
    }
}
