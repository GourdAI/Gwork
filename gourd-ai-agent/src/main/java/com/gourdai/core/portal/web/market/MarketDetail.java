package com.gourdai.core.portal.web.market;

/**
 * 技能详情实体 — 统一封装技能的完整信息。
 *
 * @author oisin
 */
public class MarketDetail {
    private String slug;
    private String displayName;
    private String summary;
    private String description;
    private String ownerHandle;
    private long installs;
    private long stars;
    private String installSlug; // 用于安装时的实际 slug（如 owner/repo/skill-name）
    private String iconUrl;     // 技能图标 URL（市场提供时才有）
    private String category;    // 市场原生分类 key
    private String version;     // 最新版本号
    private java.util.List<String> tags; // 标签（详情弹窗展示）

    public MarketDetail() {
    }

    public MarketDetail slug(String slug) { this.slug = slug; return this; }
    public MarketDetail displayName(String displayName) { this.displayName = displayName; return this; }
    public MarketDetail summary(String summary) { this.summary = summary; return this; }
    public MarketDetail description(String description) { this.description = description; return this; }
    public MarketDetail ownerHandle(String ownerHandle) { this.ownerHandle = ownerHandle; return this; }
    public MarketDetail installs(long installs) { this.installs = installs; return this; }
    public MarketDetail stars(long stars) { this.stars = stars; return this; }
    public MarketDetail installSlug(String installSlug) { this.installSlug = installSlug; return this; }
    public MarketDetail iconUrl(String iconUrl) { this.iconUrl = iconUrl; return this; }
    public MarketDetail category(String category) { this.category = category; return this; }
    public MarketDetail version(String version) { this.version = version; return this; }
    public MarketDetail tags(java.util.List<String> tags) { this.tags = tags; return this; }

    public String getSlug() { return slug; }
    public void setSlug(String slug) { this.slug = slug; }
    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }
    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public String getOwnerHandle() { return ownerHandle; }
    public void setOwnerHandle(String ownerHandle) { this.ownerHandle = ownerHandle; }
    public long getInstalls() { return installs; }
    public void setInstalls(long installs) { this.installs = installs; }
    public long getStars() { return stars; }
    public void setStars(long stars) { this.stars = stars; }
    public String getInstallSlug() { return installSlug; }
    public void setInstallSlug(String installSlug) { this.installSlug = installSlug; }
    public String getIconUrl() { return iconUrl; }
    public void setIconUrl(String iconUrl) { this.iconUrl = iconUrl; }
    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }
    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }
    public java.util.List<String> getTags() { return tags; }
    public void setTags(java.util.List<String> tags) { this.tags = tags; }
}
