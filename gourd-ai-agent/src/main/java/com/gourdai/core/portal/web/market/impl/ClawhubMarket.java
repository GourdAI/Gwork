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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * ClawHub 市场适配器 — 对接 clawhub.ai API。
 *
 * @author oisin
 */
public class ClawhubMarket implements Market {

    private static final Logger LOG = LoggerFactory.getLogger(ClawhubMarket.class);

    private static final String BASE_URL = "https://clawhub.ai";
    private static final String USER_AGENT = "GWork/1.0";

    @Override
    public String name() {
        return "clawhub.ai";
    }

    @Override
    public String description() {
        return "";
    }

    // ==================== 列表与搜索 ====================

    @Override
    public Result<MarketPageResult> trending(String cursor, int limit) {
        try {
            // 注意：clawhub.ai 的 /api/v1/skills 忽略 page/offset 参数，仅支持 cursor 游标翻页；
            // 且 sort=trending 下响应不返回 nextCursor（无法翻页），故不传 sort（默认最近更新排序）。
            String url = BASE_URL + "/api/v1/skills?limit=" + limit;
            if (!Assert.isEmpty(cursor)) {
                url += "&cursor=" + java.net.URLEncoder.encode(cursor, "UTF-8");
            }
            String body = httpGet(url);
            ONode root = ONode.ofJson(body);

            if (root.hasKey("error")) {
                return Result.failure(root.get("message").getString());
            }

            List<MarketItem> items = parseItems(root);
            String nextCursor = getStringValue(root, "nextCursor");
            return Result.succeed(new MarketPageResult(items, nextCursor));
        } catch (Exception e) {
            LOG.warn("ClawhubMarket.trending error: {}", e.getMessage());
            return Result.failure("获取热门技能失败: " + e.getMessage());
        }
    }

    @Override
    public Result<MarketPageResult> search(String query, String cursor, int limit) {
        if (Assert.isEmpty(query)) {
            return trending(cursor, limit);
        }

        try {
            String url = BASE_URL + "/api/v1/search?q=" + java.net.URLEncoder.encode(query, "UTF-8") + "&limit=" + limit;
            if (!Assert.isEmpty(cursor)) {
                url += "&cursor=" + java.net.URLEncoder.encode(cursor, "UTF-8");
            }
            String body = httpGet(url);
            ONode root = ONode.ofJson(body);

            if (root.hasKey("error")) {
                return Result.failure(root.get("message").getString());
            }

            List<MarketItem> items;
            ONode resultsNode = root.get("results");
            if (resultsNode != null && resultsNode.isArray()) {
                items = parseNodeArray(resultsNode);
            } else {
                items = parseItems(root);
            }
            // clawhub 搜索接口目前不返回游标：nextCursor 为 null，搜索结果仅一页
            String nextCursor = getStringValue(root, "nextCursor");
            return Result.succeed(new MarketPageResult(items, nextCursor));
        } catch (Exception e) {
            LOG.warn("ClawhubMarket.search error: {}", e.getMessage());
            return Result.failure("搜索技能失败: " + e.getMessage());
        }
    }

    // ==================== 详情 ====================

    @Override
    public Result<MarketDetail> detail(String slug) {
        if (Assert.isEmpty(slug)) {
            return Result.failure("slug is required");
        }

        try {
            String url = BASE_URL + "/api/v1/skills/" + java.net.URLEncoder.encode(slug, "UTF-8");
            String body = httpGet(url);
            ONode root = ONode.ofJson(body);

            if (root.hasKey("error")) {
                return Result.failure(root.get("message").getString());
            }

            ONode skillNode = root.get("skill");
            if (skillNode == null || skillNode.isNull()) {
                return Result.failure("技能不存在: " + slug);
            }

            MarketDetail detail = new MarketDetail()
                    .slug(getStringValue(skillNode, "slug"))
                    .displayName(getStringValue(skillNode, "displayName"))
                    .summary(getStringValue(skillNode, "summary"))
                    .description(getStringValue(skillNode, "description"))
                    .ownerHandle(getStringValue(skillNode, "ownerHandle"))
                    .installSlug(getStringValue(skillNode, "slug"));

            ONode statsNode = skillNode.get("stats");
            if (statsNode != null && !statsNode.isNull()) {
                detail.installs(getLongValue(statsNode, "installsCurrent"));
                detail.stars(getLongValue(statsNode, "stars"));
            }

            return Result.succeed(detail);
        } catch (Exception e) {
            LOG.warn("ClawhubMarket.detail error: {}", e.getMessage());
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

            String downloadUrl = BASE_URL + "/api/v1/download?slug="
                    + java.net.URLEncoder.encode(slug, "UTF-8");

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

                LOG.info("ClawhubMarket.install: {} -> {}", slug, targetDir);
                return Result.succeed(displayName);
            } finally {
                Files.deleteIfExists(tempZip);
            }

        } catch (Exception e) {
            LOG.warn("ClawhubMarket.install error: {}", e.getMessage(), e);
            return Result.failure("安装失败: " + e.getMessage());
        }
    }

    // ==================== 内部工具方法 ====================

    private String httpGet(String url) throws Exception {
        return HttpUtils.http(url)
                .header("User-Agent", USER_AGENT)
                // 单位：秒（connect/write/read）
                .timeout(10, 10, 30)
                .get();
    }

    private List<MarketItem> parseItems(ONode root) {
        ONode itemsNode = root.get("items");
        if (itemsNode != null && itemsNode.isArray()) {
            return parseNodeArray(itemsNode);
        }
        return Collections.emptyList();
    }

    private List<MarketItem> parseNodeArray(ONode arrayNode) {
        List<MarketItem> result = new ArrayList<>();
        for (ONode node : arrayNode.getArray()) {
            String slug = getStringValue(node, "slug");
            String apiUrl = getStringValue(node, "url");
            String detailUrl = (apiUrl != null) ? apiUrl : BASE_URL + "/skills/" + slug;

            MarketItem item = new MarketItem()
                    .slug(slug)
                    .name(slug)
                    .displayName(getStringValue(node, "displayName"))
                    .summary(getStringValue(node, "summary"))
                    .description(getStringValue(node, "description"))
                    .ownerHandle(getStringValue(node, "ownerHandle"))
                    .url(detailUrl);

            ONode statsNode = node.get("stats");
            if (statsNode != null && !statsNode.isNull()) {
                item.installs(getLongValue(statsNode, "installsCurrent"));
                item.stars(getLongValue(statsNode, "stars"));
            }

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
