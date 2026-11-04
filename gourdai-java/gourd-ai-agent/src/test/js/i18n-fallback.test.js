const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-i18n.js'),
    'utf8'
).replace(/^\uFEFF/, '');

function createI18n(fetchImpl) {
    const attrs = {};
    const context = {
        console: { error() {}, warn() {}, log() {} },
        fetch: fetchImpl,
        navigator: { language: 'en' },
        localStorage: { getItem() { return null; }, setItem() {} },
        CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
        document: {
            readyState: 'loading',
            documentElement: { setAttribute(key, value) { attrs[key] = value; } },
            querySelectorAll() { return []; },
            addEventListener() {},
            dispatchEvent() {}
        },
        window: {}
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'app-i18n.js' });
    return { api: context.window.GourdI18n, attrs };
}

function okJson(data) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

test('en 404 后绑定 zh-CN fallback 给当前 locale 并正常 ready', async () => {
    const calls = [];
    const { api, attrs } = createI18n((url) => {
        calls.push(url);
        return url.endsWith('/en.json')
            ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
            : okJson({ hello: '你好' });
    });
    let ready = 0;
    api.whenReady(() => ready++);
    await api.setLocale('en');

    assert.deepEqual(calls, ['/locales/en.json', '/locales/zh-CN.json']);
    assert.equal(api.getLocale(), 'en');
    assert.equal(api.t('hello'), '你好');
    assert.equal(attrs.lang, 'en');
    assert.equal(ready, 1);
});

test('目标语言网络异常后仍可使用成功的中文 fallback', async () => {
    const { api } = createI18n((url) => url.endsWith('/en.json')
        ? Promise.reject(new Error('network down'))
        : okJson({ hello: '备用中文' }));
    await api.setLocale('en');
    assert.equal(api.t('hello'), '备用中文');
});

test('目标语言与 zh-CN 均失败时不错误触发 ready 且不循环', async () => {
    let calls = 0;
    const { api } = createI18n(() => {
        calls++;
        return Promise.reject(new Error('offline'));
    });
    let ready = 0;
    api.whenReady(() => ready++);
    const result = await api.setLocale('en');

    assert.equal(result, null);
    assert.equal(calls, 2);
    assert.equal(ready, 0);
    assert.equal(api.t('hello'), 'hello');
});
