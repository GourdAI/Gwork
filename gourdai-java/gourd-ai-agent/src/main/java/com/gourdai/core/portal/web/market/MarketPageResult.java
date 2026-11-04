package com.gourdai.core.portal.web.market;

import java.util.List;

/**
 * 技能市场分页结果 — cursor 游标分页。
 *
 * <p>部分市场（如 clawhub.ai）的 page/offset 参数会被上游忽略，
 * 仅支持 cursor 游标翻页；本结果对象统一各市场的分页语义：
 * 下一页请求携带本次返回的 {@code nextCursor}，为 null/空表示没有更多数据。</p>
 *
 * @author oisin
 */
public class MarketPageResult {

    /** 当前页的技能列表 */
    private List<MarketItem> items;

    /** 下一页游标；null 或空字符串表示没有更多数据 */
    private String nextCursor;

    /**
     * 适配器是否已自行完成分类过滤（含分页补偿）。
     *
     * <p>为 true 时 {@link com.gourdai.core.portal.web.WebSettingsController} 不再做
     * 通用客户端过滤（避免二次过滤把已补偿的页再砍一刀）；默认 false 表示
     * 返回项未过滤，由控制器按 {@code category} 统一过滤。</p>
     */
    private boolean filtered;

    public MarketPageResult() {
    }

    public MarketPageResult(List<MarketItem> items, String nextCursor) {
        this.items = items;
        this.nextCursor = nextCursor;
    }

    public MarketPageResult(List<MarketItem> items, String nextCursor, boolean filtered) {
        this.items = items;
        this.nextCursor = nextCursor;
        this.filtered = filtered;
    }

    public List<MarketItem> getItems() {
        return items;
    }

    public void setItems(List<MarketItem> items) {
        this.items = items;
    }

    public String getNextCursor() {
        return nextCursor;
    }

    public void setNextCursor(String nextCursor) {
        this.nextCursor = nextCursor;
    }

    public boolean isFiltered() {
        return filtered;
    }

    public void setFiltered(boolean filtered) {
        this.filtered = filtered;
    }
}
