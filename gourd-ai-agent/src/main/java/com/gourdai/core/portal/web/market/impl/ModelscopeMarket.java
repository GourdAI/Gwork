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
 * ModelScope 魔搭市场适配器 — 对接 modelscope.cn OpenAPI 技能广场（技能总量 7 万+）。
 *
 * <p>列表/搜索/详情使用 ModelScope OpenAPI（GET /openapi/v1/skills，服务端真分页：
 * page_number/page_size，响应 data.total 为真实总量）；下载通过技能归档接口
 * www.modelscope.cn/skills/{id}/archive/zip/master，失败时回退 GitHub archive。</p>
 *
 * <p>ModelScope 技能 ID 形如 {@code @anthropics/pdf}（含 @ 与 /，无需 URL 编码）；
 * 安装目录名将其替换为 {@code _anthropics_pdf}。归档 zip 为 GitHub archive 风格
 * （带 {@code *-master-<hash>/} 顶层目录），解压时剥除顶层目录以保证 SKILL.md
 * 直接位于技能目录根下（技能发现要求 {skillDir}/SKILL.md）。</p>
 *
 * @author oisin
 */
public class ModelscopeMarket implements Market {

    private static final Logger LOG = LoggerFactory.getLogger(ModelscopeMarket.class);

    private static final String BASE_URL = "https://modelscope.cn/openapi/v1";
    private static final String SKILLS_PAGE_URL = "https://www.modelscope.cn/skills";
    private static final String USER_AGENT = "GWork/1.0";

    /** 上游 page_size 保守上限（与前端 limit 上限一致） */
    private static final int UPSTREAM_MAX_PAGE_SIZE = 100;

    @Override
    public String name() {
        return "modelscope.cn";
    }

    @Override
    public String description() {
        return "魔搭社区技能广场";
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
     * 真分页入口 — 对接 GET /openapi/v1/skills。
     *
     * <p>page_number 从 1 起；cursor 语义 = 上游页码字符串，nextCursor 由响应
     * data.total 计算，末页返回 null。trending 按 downloads 排序，search 走
     * 上游默认相关度排序。</p>
     */
    private Result<MarketPageResult> fetchPaged(String query, String cursor, int limit, String errPrefix) {
        try {
            int pageSize = (limit > 0 && limit <= UPSTREAM_MAX_PAGE_SIZE) ? limit : 20;
            int page = parsePageFromCursor(cursor);
            boolean isSearch = query != null && !query.isEmpty();

            StringBuilder url = new StringBuilder(BASE_URL).append("/skills")
                    .append("?page_number=").append(page)
                    .append("&page_size=").append(pageSize);
            if (isSearch) {
                url.append("&search=").append(URLEncoder.encode(query, "UTF-8"));
            } else {
                url.append("&sort=downloads");
            }

            String body = httpGet(url.toString());
            ONode root = ONode.ofJson(body);

            if (!isSuccess(root)) {
                return Result.failure(errPrefix + upstreamError(root));
            }

            ONode dataNode = root.get("data");
            List<MarketItem> items = parseSkills(dataNode);
            long total = getLongValue(dataNode, "total");

            boolean hasMore = !items.isEmpty() && (long) page * pageSize < total;
            String nextCursor = hasMore ? String.valueOf(page + 1) : null;
            return Result.succeed(new MarketPageResult(items, nextCursor));
        } catch (Exception e) {
            LOG.warn("ModelscopeMarket.fetchPaged error: {}", e.getMessage());
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
            ONode data = fetchSkillNode(slug);
            if (data == null) {
                return Result.failure("技能不存在: " + slug);
            }

            String skillId = getStringValue(data, "id");
            String displayName = firstNonEmpty(getStringValue(data, "display_name"), skillId);

            MarketDetail detail = new MarketDetail()
                    .slug(skillId)
                    .displayName(displayName)
                    .summary(preferZhDescription(data))
                    .description(preferZhDescription(data))
                    .ownerHandle(getStringValue(data, "developer"))
                    .installs(getLongValue(data, "downloads"))
                    .stars(getLongValue(data, "view_count"))
                    .installSlug(skillId);

            return Result.succeed(detail);
        } catch (Exception e) {
            LOG.warn("ModelscopeMarket.detail error: {}", e.getMessage());
            return Result.failure("获取技能详情失败: " + e.getMessage());
        }
    }

    // ==================== 安装 ====================

    @Override
    public Result<String> install(String slug, Path skillsDir) {
        if (Assert.isEmpty(slug)) {
            return Result.failure("slug is required");
        }

        // 保留 @ 和 / 用于 ModelScope 技能 ID
        String safeSlug = slug.replaceAll("[^a-zA-Z0-9@._/-]", "");
        if (safeSlug.isEmpty()) {
            return Result.failure("Invalid slug");
        }

        try {
            ONode data = fetchSkillNode(safeSlug);
            if (data == null) {
                return Result.failure("技能不存在: " + safeSlug);
            }

            String displayName = firstNonEmpty(getStringValue(data, "display_name"), safeSlug);

            // 主下载: www.modelscope.cn/skills/{id}/archive/zip/master（仅支持 GET）
            String downloadUrl = SKILLS_PAGE_URL + "/" + safeSlug + "/archive/zip/master";
            // 备用: GitHub archive（source_url 为 GitHub 仓库时）
            String fallbackUrl = buildGitHubFallbackUrl(getStringValue(data, "source_url"));

            Files.createDirectories(skillsDir);

            Path tempZip = Files.createTempFile("skill-", ".zip");
            try {
                byte[] zipBytes = tryDownload(downloadUrl);

                if (zipBytes == null && fallbackUrl != null) {
                    LOG.warn("ModelscopeMarket.install: 主下载失败，尝试 GitHub 回退: {}", fallbackUrl);
                    zipBytes = tryDownload(fallbackUrl);
                }

                if (zipBytes == null || zipBytes.length == 0) {
                    return Result.failure("下载技能包失败: 所有下载源均不可用");
                }

                Files.write(tempZip, zipBytes);

                // @ / 替换为 _ 作为目录名: @anthropics/pdf -> _anthropics_pdf
                String dirName = safeSlug.replaceAll("[@/]", "_");
                Path targetDir = skillsDir.resolve(dirName);
                if (Files.exists(targetDir)) {
                    deleteDirectory(targetDir);
                }

                // 剥除 GitHub archive 风格的顶层目录，保证 SKILL.md 落在技能目录根下
                unzipStrippingRoot(tempZip, targetDir);

                LOG.info("ModelscopeMarket.install: {} -> {}", safeSlug, targetDir);
                return Result.succeed(displayName);
            } finally {
                Files.deleteIfExists(tempZip);
            }

        } catch (Exception e) {
            LOG.warn("ModelscopeMarket.install error: {}", e.getMessage(), e);
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

    /**
     * 获取技能详情原始 data 节点；技能不存在或上游失败时返回 null。
     * <p>详情与安装共用，避免一次安装两次详情 HTTP 调用。</p>
     */
    private ONode fetchSkillNode(String slug) throws Exception {
        // ModelScope 技能 ID 格式: @author/skill_name，@ 与 / 无需 URL 编码
        String body = httpGet(BASE_URL + "/skills/" + slug);
        ONode root = ONode.ofJson(body);
        if (!isSuccess(root)) {
            return null;
        }
        ONode data = root.get("data");
        return (data == null || data.isNull()) ? null : data;
    }

    /** success 判定（缺失字段视为失败，避免 NPE） */
    private boolean isSuccess(ONode root) {
        ONode successNode = root.get("success");
        return successNode != null && !successNode.isNull() && successNode.getBoolean();
    }

    /** 提取上游错误信息（message 字段，缺失时给通用文案） */
    private String upstreamError(ONode root) {
        String msg = getStringValue(root, "message");
        return (msg != null && !msg.isEmpty()) ? msg : "upstream error";
    }

    /** 将统一接口的 cursor 解析为上游页码（从 1 起） */
    int parsePageFromCursor(String cursor) {
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

    /**
     * 解析 /skills 响应的 data.skills 数组。
     * <p>响应结构: { success, data: { skills: [...], total, page_number, page_size } }。
     * 描述取 locales.zh.description 优先（中文本地化），无则用 description。</p>
     */
    List<MarketItem> parseSkills(ONode dataNode) {
        if (dataNode == null || dataNode.isNull()) {
            return Collections.emptyList();
        }
        ONode skillsNode = dataNode.get("skills");
        if (skillsNode == null || !skillsNode.isArray()) {
            return Collections.emptyList();
        }

        List<MarketItem> result = new ArrayList<>();
        for (ONode node : skillsNode.getArray()) {
            String skillId = getStringValue(node, "id");
            if (skillId == null || skillId.isEmpty()) {
                continue;
            }

            String description = preferZhDescription(node);
            String sourceUrl = getStringValue(node, "source_url");
            String detailUrl = (sourceUrl != null && !sourceUrl.isEmpty())
                    ? sourceUrl
                    : SKILLS_PAGE_URL + "/" + skillId;

            result.add(new MarketItem()
                    .slug(skillId)
                    .name(skillId)
                    .displayName(firstNonEmpty(getStringValue(node, "display_name"), skillId))
                    .summary(description)
                    .description(description)
                    .ownerHandle(getStringValue(node, "developer"))
                    .url(detailUrl)
                    .installs(getLongValue(node, "downloads"))
                    .stars(getLongValue(node, "view_count")));
        }
        return result;
    }

    /** 描述取值：locales.zh.description 优先，缺失时回退 description */
    private String preferZhDescription(ONode node) {
        ONode locales = node.get("locales");
        if (locales != null && !locales.isNull()) {
            ONode zh = locales.get("zh");
            if (zh != null && !zh.isNull()) {
                String zhDesc = getStringValue(zh, "description");
                if (zhDesc != null && !zhDesc.isEmpty()) {
                    return zhDesc;
                }
            }
        }
        return getStringValue(node, "description");
    }

    /**
     * 从 source_url 构建 GitHub 下载回退 URL。
     *
     * <p>支持格式：
     * <ul>
     *   <li>https://github.com/owner/repo</li>
     *   <li>https://github.com/owner/repo.git</li>
     *   <li>https://github.com/owner/repo/tree/branch</li>
     * </ul></p>
     */
    String buildGitHubFallbackUrl(String sourceUrl) {
        if (sourceUrl == null || sourceUrl.isEmpty()) {
            return null;
        }

        if (!sourceUrl.startsWith("https://github.com/") && !sourceUrl.startsWith("https://www.github.com/")) {
            return null;
        }

        try {
            java.net.URL url = new java.net.URL(sourceUrl);
            String path = url.getPath();
            if (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (path.endsWith(".git")) {
                path = path.substring(0, path.length() - 4);
            }

            String[] parts = path.split("/");
            if (parts.length >= 2) {
                String owner = parts[0];
                String repo = parts[1];
                String branch = "HEAD";
                if (parts.length >= 4 && "tree".equals(parts[2])) {
                    branch = parts[3];
                }
                return "https://github.com/" + owner + "/" + repo + "/archive/refs/heads/" + branch + ".zip";
            }
        } catch (Exception e) {
            LOG.warn("buildGitHubFallbackUrl failed: {}", e.getMessage());
        }

        return null;
    }

    /**
     * 尝试从指定 URL 下载 zip 包，失败时返回 null 而非抛异常。
     */
    private byte[] tryDownload(String url) {
        try {
            try (HttpResponse resp = HttpUtils.http(url)
                    .header("User-Agent", USER_AGENT)
                    // 单位：秒（connect/write/read）；技能包下载放宽 read
                    .timeout(10, 10, 120)
                    .exec("GET")) {
                int code = resp.code();
                if (code < 200 || code >= 300) {
                    LOG.warn("tryDownload: HTTP {} for {}", code, url);
                    return null;
                }
                byte[] bytes = resp.bodyAsBytes();
                return (bytes == null || bytes.length == 0) ? null : bytes;
            }
        } catch (Exception e) {
            LOG.warn("tryDownload failed: {} - {}", url, e.getMessage());
            return null;
        }
    }

    /**
     * 解压 zip 到目标目录，剥除唯一的顶层目录（GitHub archive 风格）。
     *
     * <p>判定条件：所有条目都位于同一个顶层目录下（且顶层不是 "."）才剥；
     * 顶层目录不唯一、或 zip 根级直接有文件（正常技能包结构）时不剥，
     * 按原样解压。</p>
     */
    void unzipStrippingRoot(Path zipFile, Path targetDir) throws Exception {
        Path normalizedTarget = targetDir.toAbsolutePath().normalize();

        // 第一遍：扫描判定是否剥顶层
        String rootPrefix = null;
        boolean strip = true;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(Files.newInputStream(zipFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.startsWith("__MACOSX") || name.contains("/__MACOSX")) {
                    continue;
                }
                int slash = name.indexOf('/');
                if (slash < 0) {
                    // 根级直接是文件，不是 archive 风格，不剥
                    strip = false;
                    break;
                }
                String top = name.substring(0, slash);
                if (".".equals(top)) {
                    strip = false;
                    break;
                }
                if (rootPrefix == null) {
                    rootPrefix = top;
                } else if (!rootPrefix.equals(top)) {
                    // 顶层目录不唯一，不剥
                    strip = false;
                    break;
                }
                zis.closeEntry();
            }
        }

        // 第二遍：解压
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(Files.newInputStream(zipFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.startsWith("__MACOSX") || name.contains("/__MACOSX")) {
                    continue;
                }
                if (strip && rootPrefix != null) {
                    if (name.equals(rootPrefix + "/")) {
                        continue; // 顶层目录条目本身跳过
                    }
                    if (name.startsWith(rootPrefix + "/")) {
                        name = name.substring(rootPrefix.length() + 1);
                    } else {
                        continue; // 不在顶层目录下的条目（理论不会出现）跳过
                    }
                }
                if (name.isEmpty()) {
                    continue;
                }

                Path entryPath = normalizedTarget.resolve(name).normalize();
                if (!entryPath.startsWith(normalizedTarget)) {
                    continue; // zip-slip 防护
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    Files.copy(zis, entryPath, StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        }
    }

    private String getStringValue(ONode node, String key) {
        if (node == null) {
            return null;
        }
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getString() : null;
    }

    private long getLongValue(ONode node, String key) {
        if (node == null) {
            return 0;
        }
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getLong() : 0;
    }

    /** 返回第一个非空字符串 */
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
}
