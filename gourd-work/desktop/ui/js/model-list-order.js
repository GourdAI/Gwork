/* model-list-order.js — preserve /web/chat/models order while inserting adjacent provider headers */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ModelListOrder = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /* 分组键：优先渠道唯一 id（后端 ProviderDo#id / ModelDo#providerId），
       缺失时回退 provider 展示名——与后端 AgentSettings#modelGroupKey 同口径。
       若只按展示名分段，同一渠道内展示名漂移过的模型会多渲染一个标题（用户看到的「重复」）。 */
    function groupKeyOf(model) {
        if (!model) return '';
        var id = model.providerId;
        if (id !== null && id !== undefined && String(id) !== '') return String(id);
        return String(model.provider || '');
    }

    function buildEntries(models) {
        var entries = [];
        var previousKey;
        for (var i = 0; i < (models || []).length; i++) {
            var model = models[i];
            var provider = (model && model.provider) || '';
            var key = groupKeyOf(model);
            if (i === 0 || key !== previousKey) {
                // 标题仍展示 provider 名称；key 只用于「是否同组」判定
                entries.push({ type: 'provider', provider: provider, key: key });
            }
            entries.push({ type: 'model', model: model });
            previousKey = key;
        }
        return entries;
    }

    return { buildEntries: buildEntries, groupKeyOf: groupKeyOf };
});
