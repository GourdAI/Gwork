/* model-list-order.js — preserve /web/chat/models order while inserting adjacent provider headers */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ModelListOrder = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    function buildEntries(models) {
        var entries = [];
        var previousProvider;
        for (var i = 0; i < (models || []).length; i++) {
            var model = models[i];
            var provider = (model && model.provider) || '';
            if (i === 0 || provider !== previousProvider) {
                entries.push({ type: 'provider', provider: provider });
            }
            entries.push({ type: 'model', model: model });
            previousProvider = provider;
        }
        return entries;
    }

    return { buildEntries: buildEntries };
});
