const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/js/app-model-settings.js'), 'utf8');

// Execute the actual IIFE and handlers with a small DOM/AJAX fixture; no production test exports.
function fixture() {
    const elements = new Map(), handlers = new Map(), requests = [];
    function $(key) {
        if (typeof key === 'object' && key && key.fixtureElement) return key;
        if (!elements.has(key)) {
            const el = { fixtureElement: true, length: 1, value: '', markup: '',
                val(v) { if (arguments.length) { this.value = v; return this; } return this.value; },
                html(v) { if (arguments.length) { this.markup = v; return this; } return this.markup; },
                append(v) { this.markup += v; return this; },
                data(k) { return this[k]; },
                on(event, selector, fn) { handlers.set(String(key) + ':' + event, typeof selector === 'function' ? selector : fn); return this; },
                find(selector) { return $(selector); }, closest() { return this; },
                hasClass() { return false; }, ready() { return this; }
            };
            for (const name of ['show', 'hide', 'toggle', 'empty', 'remove', 'prop', 'attr', 'filter', 'text', 'addClass', 'removeClass', 'focus']) el[name] = function () { return this; };
            elements.set(key, el);
        }
        return elements.get(key);
    }
    $.ajax = request => requests.push(request);
    const context = { window: {}, document: { addEventListener() {} }, $, console,
        GourdI18n: { t: key => key }, setTimeout() {}, clearTimeout() {},
        layui: { form: { render() {}, on(event, fn) { handlers.set(event, fn); } } } };
    const hook = `window.fixture = {
        seed(models, editing) { fetchedModels = models; currentProvider = editing ? {name:'local', enabled:true} : null; },
        bindEvents, renderModelsList, openModelDialog, persistProvider
    };`;
    const end = source.lastIndexOf('})();');
    assert.ok(end > 0);
    vm.runInNewContext(source.slice(0, end) + hook + source.slice(end), context);
    $('#msProviderName').val('local');
    $('#msProviderApiUrl').val('http://127.0.0.1:11434');
    $('input[name="msProviderStandard"]:checked').val('openai');
    context.window.fixture.bindEvents();
    return { $, handlers, requests, api: context.window.fixture };
}

test('row renders Ollama native selected and retains OpenAI alternatives', () => {
    const f = fixture();
    f.api.seed([{ id: 'qwen3', standard: 'ollama' }], true);
    f.api.renderModelsList();
    const html = f.$('#msProviderModelsList').html();
    assert.match(html, /value="ollama" selected>Ollama \(\/api\/chat\)/);
    assert.match(html, /value="openai"/);
    assert.match(html, /value="openai-responses"/);
});

test('row protocol change persists per-model standard without changing provider protocol', () => {
    const f = fixture();
    f.api.seed([{ id: 'qwen3', standard: 'openai' }], true);
    const elem = f.$('row-select'); elem['model-id'] = 'qwen3';
    f.handlers.get('select(msModelStd)')({ elem, value: 'ollama' });
    assert.equal(f.requests[0].url, '/web/settings/providers/update');
    const payload = JSON.parse(f.requests[0].data);
    assert.equal(payload.standard, 'openai');
    assert.equal(payload.models[0].standard, 'ollama');
    f.handlers.get('select(msModelStd)')({ elem, value: 'openai' });
    assert.equal(JSON.parse(f.requests[1].data).models[0].standard, 'openai');
});

test('manual add dialog offers native protocol and saves selected value', () => {
    const f = fixture();
    f.api.seed([], false);
    f.api.openModelDialog(null);
    assert.match(f.$('body').markup, /value="ollama"/);
    f.$('#msManualModelName').val('qwen3');
    f.handlers.get('select(msManualModelStandard)')({ value: 'ollama' });
    f.handlers.get('#msModelAddConfirm:click')();
    f.api.persistProvider();
    assert.equal(f.requests[0].url, '/web/settings/providers/add');
    assert.equal(JSON.parse(f.requests[0].data).models[0].standard, 'ollama');
});
