'use strict';
/* ===== 技能小卡片（chip）契约 =====
 *
 * 【2026-11-11 codereview 抓出的两个 P0，本文件是它们的回归钉】
 *
 * P0-1：chip 最初寄生在附件区 `.attachments-wrap` 里。那个容器
 *        ① css/app.css 默认 `display:none`，只有 `.has-items` 才显形，而 chip 代码从不加这个类；
 *        ② `renderAttachmentsWrap()` 首行无条件 `wrap.html('')` 全量重建（全仓 10 处调用，
 *           含 foldLongInputToAttachment 内部）。
 *       → chip 既看不见，又会被任意附件操作/超长折叠顺手抹掉，技能静默丢失。
 *       修法：独立容器 #welcomeSkillChips / #chatSkillChips（chat.html）+ `.skill-chips` 自带
 *       显隐（app.css），生死只由 app-history.js 的增删函数决定。
 *
 * P0-2：wire 文本被注入 `/id ` 前缀后，`isCommand = text.trim().charAt(0) === '/'` 恒真，
 *       挂技能的普通请求被当成斜杠命令，撞上「命令需 Tab 排队 / 命令不支持附件」直接 return，
 *       消息发不出去、chip 也不清。修法：判定改用注入前原文 userTyped。
 *
 * 顺带钉住的三处：
 *   - 折叠超长输入时气泡曾变成「[技能名] + 空串」（回显读的是已被清空的 inputEl.value）；
 *   - 回显曾回查旧容器 `#chatAttachmentsWrap .skill-chip`（容器已迁移，查询恒空）；
 *   - automation 页曾自留「以 / 开头且光标前无空格」旧口径 = 用户报的「只能触发一次」。
 *
 * 【方法】不复制实现：chip 生命周期与 findCmdTriggerToken 都从真实源码里切出来，
 * 放进 node:vm + 最小 DOM/jQuery 替身里真跑（仓库无 jsdom，15 个既有测试同此范式）。
 * 断言的是行为（DOM 结果、返回值），不是源码字符串形状；形状锁只用于「容器归属」
 * 这类一旦写错就必然行为错误的结构性约束。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');
const test = require('node:test');

const desktop = path.resolve(__dirname, '..');
const uiRoot = path.join(desktop, 'ui');
const repoRoot = path.resolve(desktop, '..', '..');

const HISTORY = path.join(uiRoot, 'js', 'app-history.js');
const STREAMING = path.join(uiRoot, 'js', 'app-streaming.js');
const AUTOMATION = path.join(uiRoot, 'js', 'app-automation.js');
const CHAT_HTML = path.join(uiRoot, 'chat.html');
const APP_CSS = path.join(uiRoot, 'css', 'app.css');

const HISTORY_SRC = fs.readFileSync(HISTORY, 'utf8');
const STREAMING_SRC = fs.readFileSync(STREAMING, 'utf8');
const AUTOMATION_SRC = fs.readFileSync(AUTOMATION, 'utf8');
const CHAT_HTML_SRC = fs.readFileSync(CHAT_HTML, 'utf8');
const APP_CSS_SRC = fs.readFileSync(APP_CSS, 'utf8');

/* 被测函数跑在 node:vm 里，返回的数组属于子 realm，与主 realm 的 Array 原型不同，
   assert.deepStrictEqual 会因原型不等而假红（值看起来一模一样也判失败）。
   一律先摊平成主 realm 数组再比。 */
const plain = (arr) => Array.prototype.slice.call(arr || []);

/* ---------- 源码切片：按大括号配平取整个函数，不依赖行尾风格 ----------
   （上一轮踩过坑：锚点写 '\n}' 而文件是 CRLF，replace 静默落空、护栏空转。
   配平扫描对 CRLF/LF 都成立，且函数体被改坏时会抛错而不是悄悄返回半截。） */
function sliceFunction(src, signature, label) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, '源码缺少 ' + label + '：签名 ' + signature + ' 未命中');
    const braceOpen = src.indexOf('{', start);
    assert.ok(braceOpen > start, label + ' 未找到函数体起始 {');
    let depth = 0;
    for (let i = braceOpen; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(label + ' 大括号未配平，源码可能已损坏');
}

/* chip 区块：从区块注释到「用 replacement 替换输入框中的触发段」之前，
   含 chipWrapFor / syncSkillChipsVisibility / addSkillChip / getSkillChips /
   getSkillChipIds / clearSkillChips / window 导出 / 删除按钮委托。 */
function sliceChipBlock(src) {
    const BEGIN = '/* ===== 技能小卡片（chip）=====';
    const END = '/* 用 replacement 替换输入框中的触发段';
    const a = src.indexOf(BEGIN);
    const b = src.indexOf(END);
    assert.ok(a >= 0, 'app-history.js 缺少 chip 区块起始注释');
    assert.ok(b > a, 'app-history.js chip 区块结束标记缺失或顺序错乱');
    return src.slice(a, b);
}

/* ---------- 最小 DOM + jQuery 替身 ----------
   只实现 chip 代码真正调到的那几件事，宁可窄也不要假：
   选择器支持 #id / .class / .class[attr="value"]；HTML 串只解析首标签的属性，
   内部结构不建（chip 代码从不查询 svg 内部，建了也是无用功）。 */
function makeDom() {
    let seq = 0;
    const registry = new Map();   // id -> element

    function mkEl(tag) {
        return { __el: true, uid: ++seq, tag, attrs: {}, children: [], parent: null, text: '' };
    }
    function isEl(x) { return !!x && x.__el === true; }

    function parseAttrs(str) {
        const out = {};
        const re = /([\w-]+)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
        return out;
    }
    function fromHtml(html) {
        const m = /^<([\w-]+)((?:\s+[\w-]+="[^"]*")*)/.exec(html);
        const el = mkEl(m ? m[1] : 'span');
        if (m && m[2]) Object.assign(el.attrs, parseAttrs(m[2]));
        el.rawHtml = html;
        return el;
    }

    /* 选择器：单个简单选择器（chip 代码只用这种） */
    function matchOne(el, sel) {
        if (!isEl(el)) return false;
        const attrM = /^\.([\w-]+)\[([\w-]+)="(.*)"\]$/.exec(sel);
        if (attrM) {
            const cls = (' ' + (el.attrs['class'] || '') + ' ').indexOf(' ' + attrM[1] + ' ') >= 0;
            return cls && el.attrs[attrM[2]] === attrM[3];
        }
        if (sel[0] === '#') return el.attrs.id === sel.slice(1) || el.id === sel.slice(1);
        if (sel[0] === '.') {
            const want = sel.slice(1);
            return (' ' + (el.attrs['class'] || '') + ' ').indexOf(' ' + want + ' ') >= 0;
        }
        return el.tag === sel;
    }
    function descendants(el) {
        const out = [];
        (function walk(n) {
            for (const c of n.children) { out.push(c); walk(c); }
        })(el);
        return out;
    }
    function queryAll(sel) {
        const out = [];
        for (const el of registry.values()) if (matchOne(el, sel)) out.push(el);
        for (const el of registry.values()) {
            for (const d of descendants(el)) if (matchOne(d, sel) && out.indexOf(d) < 0) out.push(d);
        }
        return out;
    }

    function detach(el) {
        if (el.parent) {
            const i = el.parent.children.indexOf(el);
            if (i >= 0) el.parent.children.splice(i, 1);
            el.parent = null;
        }
    }
    function childText(el) {
        let s = el.text || '';
        for (const c of el.children) s += childText(c);
        return s;
    }

    /* jQuery-ish 包装器 */
    function J(target) {
        const items = [];
        if (target == null) { /* empty */ }
        else if (Array.isArray(target)) items.push(...target.filter(isEl));
        else if (isEl(target)) items.push(target);
        else if (target && target.__jq) items.push(...target.__items);
        else if (target === DOCUMENT) items.push(DOCUMENT);
        else if (typeof target === 'string') {
            if (target[0] === '<') items.push(fromHtml(target));
            else items.push(...queryAll(target));
        }
        const w = {
            __jq: true, __items: items, length: items.length,
            get 0() { return items[0]; },
            attr(k, v) {
                const el = items[0];
                if (!el) return v === undefined ? undefined : w;
                if (v === undefined) return el.attrs[k];
                el.attrs[k] = String(v);
                if (k === 'id') { el.id = String(v); registry.set(String(v), el); }
                return w;
            },
            text(s) {
                const el = items[0];
                if (!el) return '';
                if (s === undefined) return childText(el);
                el.text = String(s);
                el.children.length = 0;
                return w;
            },
            append(x) {
                const el = items[0];
                if (!el) return w;
                const add = (node) => { detach(node); node.parent = el; el.children.push(node); };
                if (typeof x === 'string') add(fromHtml(x));
                else if (isEl(x)) add(x);
                else if (x && x.__jq) x.__items.forEach(add);
                return w;
            },
            find(sel) {
                const out = [];
                items.forEach((el) => {
                    descendants(el).forEach((d) => { if (matchOne(d, sel)) out.push(d); });
                });
                return J(out);
            },
            each(fn) { items.forEach((el, i) => fn.call(J(el), i, el)); return w; },
            closest(sel) {
                let n = items[0];
                while (n && isEl(n)) { if (matchOne(n, sel)) return J(n); n = n.parent; }
                return J([]);
            },
            parent() { const el = items[0]; return J(el && el.parent ? el.parent : []); },
            remove() { items.forEach(detach); return w; },
            empty() { items.forEach((el) => { el.children.slice().forEach(detach); el.children.length = 0; }); return w; },
            toggleClass(cls, force) {
                items.forEach((el) => {
                    const parts = (el.attrs['class'] || '').split(/\s+/).filter(Boolean);
                    const has = parts.indexOf(cls) >= 0;
                    const want = force === undefined ? !has : !!force;
                    if (want && !has) parts.push(cls);
                    if (!want && has) parts.splice(parts.indexOf(cls), 1);
                    el.attrs['class'] = parts.join(' ');
                });
                return w;
            },
            hasClass(cls) {
                const el = items[0];
                return !!el && (' ' + (el.attrs['class'] || '') + ' ').indexOf(' ' + cls + ' ') >= 0;
            },
            on(evt, sel, fn) {
                DOCUMENT._handlers.push({ evt, sel, fn });
                return w;
            }
        };
        return w;
    }

    const DOCUMENT = { __doc: true, _handlers: [] };

    /* 建好 chat.html 里那两个输入框与四类容器（附件区 + 独立 chip 行） */
    function buildFixture() {
        const ids = ['welcomeInput', 'chatInput',
            'welcomeAttachmentsWrap', 'chatAttachmentsWrap',
            'welcomeSkillChips', 'chatSkillChips'];
        const els = {};
        for (const id of ids) {
            const el = mkEl(id === 'welcomeInput' || id === 'chatInput' ? 'textarea' : 'div');
            el.id = id;
            el.attrs.id = id;
            registry.set(id, el);
            els[id] = el;
        }
        // 输入框替身要有 value/selectionStart（chipWrapFor 靠恒等比较区分宿主）
        els.welcomeInput.value = '';
        els.welcomeInput.selectionStart = 0;
        els.welcomeInput.setSelectionRange = function (a) { this.selectionStart = a; };
        els.chatInput.value = '';
        els.chatInput.selectionStart = 0;
        els.chatInput.setSelectionRange = function (a) { this.selectionStart = a; };
        return els;
    }

    /* 把真实 chip 源码跑起来，返回沙箱句柄 */
    function loadChipCode(srcOverride) {
        const els = buildFixture();
        const sandbox = {
            window: {},                       // 故意不给 window.CSS：走 CSS.escape 缺失的回退分支
            document: DOCUMENT,
            $: J,
            welcomeInput: els.welcomeInput,
            chatInput: els.chatInput,
            autoResize: function () {},
            escapeHtml: function (s) { return String(s); }
        };
        sandbox.window.getSkillChipIds = undefined;
        vm.createContext(sandbox);
        vm.runInContext(sliceChipBlock(srcOverride || HISTORY_SRC), sandbox,
            { filename: 'app-history.js#chip-block' });
        // ids/names 已摊平到主 realm，调用方直接 deepStrictEqual 不会因原型不同假红
        return {
            sandbox, els, J,
            ids: (el) => plain(sandbox.getSkillChipIds(el)),
            names: (el) => plain(sandbox.getSkillChips(el)).map((c) => ({ id: c.id, name: c.name }))
        };
    }

    /* 模拟 renderAttachmentsWrap：附件区首行无条件全量重建（P0-1 的凶手） */
    function rebuildAttachmentsWrap(els) {
        for (const id of ['welcomeAttachmentsWrap', 'chatAttachmentsWrap']) {
            const wrap = J(els[id]);
            wrap.empty();                                  // == wrap.html('')
            wrap.toggleClass('has-items', false);          // pendingFiles.length === 0 分支
        }
    }

    return { J, DOCUMENT, registry, loadChipCode, rebuildAttachmentsWrap, mkEl };
}

/* =====================================================================
 * ① 容器归属：chip 必须住在独立 chip 行，不得回到附件区
 * ===================================================================== */
test('① chip 容器是独立的 .skill-chips 行，不寄生附件区', () => {
    // chat.html 两个输入框各有一行独立容器
    for (const id of ['welcomeSkillChips', 'chatSkillChips']) {
        const re = new RegExp('<div class="skill-chips" id="' + id + '"></div>');
        assert.ok(re.test(CHAT_HTML_SRC), 'chat.html 缺少独立 chip 容器 #' + id);
    }
    // 归属函数指向新容器；一旦有人改回附件区，①/③ 立刻判红
    assert.match(HISTORY_SRC, /return \(inputEl === welcomeInput\) \? '#welcomeSkillChips' : '#chatSkillChips';/,
        'chipWrapFor 必须返回独立 chip 行容器');
    assert.ok(HISTORY_SRC.indexOf("'#welcomeAttachmentsWrap' : '#chatAttachmentsWrap'") < 0,
        'chipWrapFor 不得再把 chip 挂到附件区（P0-1 回归）');
});

test('①b 独立 chip 行自带显隐规则（默认藏、有 chip 才显形）', () => {
    assert.match(APP_CSS_SRC, /\.skill-chips \{ display: none;[^}]*\}/,
        '.skill-chips 必须默认隐藏，否则空行会常年占位');
    assert.match(APP_CSS_SRC, /\.skill-chips\.has-chips \{ display: flex;[^}]*\}/,
        '.skill-chips.has-chips 必须显形为 flex，否则 chip 挂上了也看不见（P0-1 的另一半）');
});

/* =====================================================================
 * ② 真跑 chip 生命周期（P0-1 的行为面）
 * ===================================================================== */
test('② 挂卡：展示名可见、真实 id 隐藏、容器显形', () => {
    const { els, sandbox, ids, names } = makeDom().loadChipCode();
    const added = sandbox.addSkillChip(els.chatInput,
        { name: '_user_3b5e1511_lawyer-letter5399', displayName: '律师函生成' });
    assert.strictEqual(added, true, '首次挂卡应成功');

    const $row = sandbox.$(els.chatSkillChips);
    assert.ok($row.hasClass('has-chips'), '有 chip 时容器必须拿到 has-chips，否则 display:none 看不见');

    // 核心诉求：显示技能名、内部藏 id、发送回传 id —— 三者缺一不可
    assert.deepStrictEqual(names(els.chatInput),
        [{ id: '_user_3b5e1511_lawyer-letter5399', name: '律师函生成' }],
        'chip 表面是展示名、内部藏真实 id，两者不得相同');
    assert.deepStrictEqual(ids(els.chatInput), ['_user_3b5e1511_lawyer-letter5399'],
        '发送链路取到的必须是 id');

    const $chip = $row.find('.skill-chip');
    assert.strictEqual($chip.attr('data-skill-id'), '_user_3b5e1511_lawyer-letter5399');
    assert.strictEqual($chip.attr('title'), '_user_3b5e1511_lawyer-letter5399', 'hover 要能看到 id 供核对');
    assert.strictEqual($chip.find('.skill-chip-name').text(), '律师函生成');
});

test('②b displayName 缺失时回退 id，不得显示空名', () => {
    const { els, sandbox, names } = makeDom().loadChipCode();
    sandbox.addSkillChip(els.chatInput, { name: 'pdf-toolkit' });   // 后端没给 displayName
    assert.deepStrictEqual(names(els.chatInput), [{ id: 'pdf-toolkit', name: 'pdf-toolkit' }],
        '无展示名必须回退 id，不得显示空名');
});

test('②c 同一技能不重复挂卡（用户报的「到底生效几个」）', () => {
    const { els, sandbox, ids } = makeDom().loadChipCode();
    const cmd = { name: 'pdf-toolkit', displayName: 'PDF 工具' };
    assert.strictEqual(sandbox.addSkillChip(els.chatInput, cmd), true);
    assert.strictEqual(sandbox.addSkillChip(els.chatInput, cmd), false, '重复挂卡应被拒');
    assert.deepStrictEqual(ids(els.chatInput), ['pdf-toolkit'], '重复触发不得堆出两张卡');
});

test('②d 可挂多个技能，id 按挂载顺序保序', () => {
    const { els, sandbox, ids } = makeDom().loadChipCode();
    sandbox.addSkillChip(els.chatInput, { name: 'a-one', displayName: '甲' });
    sandbox.addSkillChip(els.chatInput, { name: 'b-two', displayName: '乙' });
    assert.deepStrictEqual(ids(els.chatInput), ['a-one', 'b-two'],
        '多技能前缀顺序必须稳定：服务端按序注入规约');
});

test('②e welcome / chat 两个输入框的 chip 互不串台', () => {
    const { els, sandbox, ids } = makeDom().loadChipCode();
    sandbox.addSkillChip(els.welcomeInput, { name: 'w-skill', displayName: '欢迎页技能' });
    assert.deepStrictEqual(ids(els.chatInput), [], '聊天页不得读到欢迎页的 chip');
    assert.deepStrictEqual(ids(els.welcomeInput), ['w-skill']);
});

test('②f 删除按钮：摘卡后容器收回 has-chips（不留空白占位行）', () => {
    const dom = makeDom();
    const { els, sandbox, ids } = dom.loadChipCode();
    sandbox.addSkillChip(els.chatInput, { name: 'a-one', displayName: '甲' });
    sandbox.addSkillChip(els.chatInput, { name: 'b-two', displayName: '乙' });
    assert.ok(sandbox.$(els.chatSkillChips).hasClass('has-chips'));

    // 真跑那条 document 级委托：$(document).on('click', '.skill-chip-x', fn)
    const h = dom.DOCUMENT._handlers.find(x => x.sel === '.skill-chip-x');
    assert.ok(h, 'chip 删除按钮必须走事件委托（DOM 重建后仍能点）');
    const $btn = sandbox.$(els.chatSkillChips).find('.skill-chip-x');
    let stopped = false;
    h.fn.call($btn, { stopPropagation: function () { stopped = true; } });
    assert.ok(stopped, '删除点击必须 stopPropagation，否则会冒泡触发输入框的收起逻辑');

    assert.deepStrictEqual(ids(els.chatInput), ['b-two'], '只该摘掉被点的那张');
    assert.ok(sandbox.$(els.chatSkillChips).hasClass('has-chips'), '还剩一张，容器要继续保持显形');

    h.fn.call(sandbox.$(els.chatSkillChips).find('.skill-chip-x'), { stopPropagation: function () {} });
    assert.deepStrictEqual(ids(els.chatInput), []);
    assert.ok(!sandbox.$(els.chatSkillChips).hasClass('has-chips'),
        '摘空后必须收回 has-chips，否则输入框上方留一条空白行');
});

test('②g clearSkillChips 语义与 clearInput 一致：chat 必清、welcome 仅本次源自欢迎页时清', () => {
    const dom = makeDom();
    const { els, sandbox, ids } = dom.loadChipCode();
    sandbox.addSkillChip(els.chatInput, { name: 'c-one', displayName: '聊天技能' });
    sandbox.addSkillChip(els.welcomeInput, { name: 'w-one', displayName: '欢迎技能' });

    sandbox.clearSkillChips(false);   // 会话模式发送：欢迎页草稿要跨页保留
    assert.deepStrictEqual(ids(els.chatInput), []);
    assert.deepStrictEqual(ids(els.welcomeInput), ['w-one'],
        '非欢迎页发送不得清掉欢迎页 chip（与 welcomeInput 草稿同语义）');
    assert.ok(!sandbox.$(els.chatSkillChips).hasClass('has-chips'), '清空后容器要收回 has-chips');

    sandbox.clearSkillChips(true);
    assert.deepStrictEqual(ids(els.welcomeInput), []);
    assert.ok(!sandbox.$(els.welcomeSkillChips).hasClass('has-chips'));
});

/* =====================================================================
 * ③ P0-1 的核心回归钉：附件区重建不得抹掉 chip
 * ===================================================================== */
test('③ 附件区全量重建（renderAttachmentsWrap 的 html("")）不得动 chip', () => {
    const dom = makeDom();
    const { els, sandbox, ids } = dom.loadChipCode();
    sandbox.addSkillChip(els.chatInput, { name: 'pdf-toolkit', displayName: 'PDF 工具' });
    sandbox.addSkillChip(els.welcomeInput, { name: 'w-one', displayName: '欢迎技能' });

    // 复现凶手：附件增删 / 粘贴 / 拖拽 / 超长折叠 都会走到这里（全仓 10 处调用）
    dom.rebuildAttachmentsWrap(els);
    dom.rebuildAttachmentsWrap(els);   // 连续两次，确认不是靠运气

    assert.deepStrictEqual(ids(els.chatInput), ['pdf-toolkit'],
        'chip 被附件区重建抹掉了（P0-1 回归：技能会静默丢失）');
    assert.deepStrictEqual(ids(els.welcomeInput), ['w-one']);
    assert.ok(sandbox.$(els.chatSkillChips).hasClass('has-chips'),
        'chip 还在就必须保持可见，不能出现「id 会发出去但界面看不见」的暗态');
    // 反向确认 chip 确实不在附件区里（否则本用例只是没触发重建）
    assert.strictEqual(sandbox.$(els.chatAttachmentsWrap).find('.skill-chip').length, 0,
        '附件区里不该有任何 chip');
});

/* =====================================================================
 * ④ 发送链路：wire 注入 id、命令判定不被前缀污染、回显人读形态
 * ===================================================================== */
test('④ wire 文本注入 /id 前缀，展示名不参与路由', () => {
    // prefix 由 chip id 拼成，text/rawText 同步前置
    assert.match(STREAMING_SRC, /for \(var ci = 0; ci < chipIds\.length; ci\+\+\) prefix \+= '\/' \+ chipIds\[ci\] \+ ' ';/,
        'prefix 必须是 "/id " 逐段拼接');
    assert.match(STREAMING_SRC, /text = prefix \+ text;\s*\r?\n\s*rawText = prefix \+ rawText;/,
        'text 与 rawText 必须同步前置，否则折叠判定的原文与发送文本不一致');
    // 展示名不得进 wire：回显走 [名称]，wire 只有 id
    assert.ok(STREAMING_SRC.indexOf("prefix += '/' + chips[ck].name") < 0,
        '展示名不得混进 wire 文本（后端只认 id，混进去会静默降级成普通提示词）');
});

test('④b 【P0-2】isCommand 必须基于注入前原文，挂技能的普通请求不得被当命令拦下', () => {
    assert.match(STREAMING_SRC, /var userTyped = text;/,
        '必须在注入 prefix 之前留存用户原文');
    assert.match(STREAMING_SRC, /var isCommand = userTyped && userTyped\.trim\(\)\.charAt\(0\) === '\/';/,
        'isCommand 必须判 userTyped：判 text 会让所有挂 chip 的消息恒为「命令」');
    // 断掉旧写法回流
    assert.ok(STREAMING_SRC.indexOf("var isCommand = text && text.trim().charAt(0) === '/';") < 0,
        'P0-2 回归：不得再用被 prefix 污染的 text 判命令');
    // userTyped 必须在 isBlocked 分支内使用（拦截点就在这一支）
    const blk = STREAMING_SRC.slice(STREAMING_SRC.indexOf('if (isBlocked) {'));
    assert.ok(blk.indexOf('userTyped') >= 0, 'isBlocked 分支必须用 userTyped 判命令');
});

test('④c 气泡回显：用捕获快照 + 去前缀正文，不查 DOM、不留空气泡', () => {
    // P2：回显曾回查旧容器 '#chatAttachmentsWrap .skill-chip'（容器迁移后恒空）
    assert.ok(STREAMING_SRC.indexOf("AttachmentsWrap .skill-chip") < 0,
        '回显不得再查附件区里的 .skill-chip（容器已迁到独立 chip 行，该查询恒空）');
    assert.ok(STREAMING_SRC.indexOf("$chips.each") < 0, '回显不得再二次遍历 DOM 取展示名');
    // 展示名取自函数开头捕获的 chips 快照
    assert.match(STREAMING_SRC, /var chips = \(inputEl && typeof getSkillChips === 'function'\) \? getSkillChips\(inputEl\) : \[\];/,
        '必须在链路开头一次性捕获 chips（id + 展示名），避免两处查 DOM 之间被重渲染打散');
    assert.match(STREAMING_SRC, /for \(var ck = 0; ck < chips\.length; ck\+\+\) shown \+= '\[' \+ chips\[ck\]\.name \+ '\] ';/,
        '回显必须用 chip 展示名');
    // P2：折叠分支已清空 inputEl.value，正文只能从 text 去掉 prefix 取
    assert.match(STREAMING_SRC, /displayText = shown \+ text\.substring\(prefix\.length\);/,
        '正文必须取 text 去前缀；取 inputEl.value 在折叠分支会得到空串 → 气泡只剩技能名');
    assert.ok(STREAMING_SRC.indexOf("displayText = shown + (inputEl ? inputEl.value.trim() : '')") < 0,
        'P2 回归：不得再用已被折叠清空的 inputEl.value 拼回显');
});

test('④d 折叠超长输入后仍补回 /id 前缀，技能不静默失效', () => {
    const folded = STREAMING_SRC.slice(STREAMING_SRC.indexOf('if (folded === true) {'));
    assert.match(folded, /if \(chipIds\.length > 0\) text = prefix \+ text;/,
        '折叠替换文本后必须补回技能前缀，否则 chip 还挂在界面上、技能却没发出去');
});

/* =====================================================================
 * ⑤ 触发判定：用户报的「只能触发一次」
 * ===================================================================== */
test('⑤ findCmdTriggerToken 真跑：任意位置可反复触发', () => {
    const src = sliceFunction(HISTORY_SRC, 'function findCmdTriggerToken(inputEl) {', 'findCmdTriggerToken');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.find = findCmdTriggerToken;', sandbox, { filename: 'findCmdTriggerToken' });
    const raw = sandbox.find;
    /* 返回值是子 realm 的对象，原型与主 realm 不同，deepStrictEqual 会假红
       （值一模一样也判失败）。在主 realm 重建后再比。 */
    const tok = (value, cursor) => {
        const t = raw(cursor === undefined ? { value } : { value, selectionStart: cursor });
        return t == null ? null : { start: t.start, end: t.end, trigger: t.trigger };
    };

    // 中文场景：文字后紧接打 /（不加空格）也必须触发。中文不按空格分词，
    // 只认「token 以 / 开头」会让这条永远不成立 → 用户报的「只能触发一次」的一半。
    assert.deepStrictEqual(tok('帮我写/', 4), { start: 3, end: 4, trigger: '/' },
        '中文字后紧接的 / 必须触发');
    // 旧实现的死穴：选中技能后文本被清干净，再打 / 必须能再次唤出面板
    assert.deepStrictEqual(tok('/pdf', 4), { start: 0, end: 4, trigger: '/' }, '行首 / 照常触发');
    // 第二次、第三次触发：模拟「挂完一个技能继续打 /」
    assert.deepStrictEqual(tok('写份报告 /', 6), { start: 5, end: 6, trigger: '/' },
        '空白后的 / 独立成段，必须触发');
    // 「+ → 技能」按钮在已有文字后插入 /，随后每敲一个字都要靠兜底扫描续住面板
    assert.deepStrictEqual(tok('帮我写/pd', 6), { start: 3, end: 6, trigger: '/' },
        '按钮插入触发符后继续输入，面板不得立刻收起（否则无法筛选）');
    // 技能名可含 /（两级组织）→ 整段命中，不得被名字内部的 / 截断
    assert.deepStrictEqual(tok('/design/lanhu', 13), { start: 0, end: 13, trigger: '/' },
        '两级组织技能名必须整段命中，否则回填会算错前缀位置');
    // @ 子代理同口径
    assert.deepStrictEqual(tok('请 @agent 做', 8), { start: 2, end: 8, trigger: '@' });
    assert.deepStrictEqual(tok('请@agent', 6), { start: 1, end: 6, trigger: '@' },
        '中文字后紧接的 @ 同样必须触发');
    // 不得误判：路径、URL、词内 / 都不是触发段（兜底扫描的护栏）
    assert.strictEqual(tok('见 a/b 目录', 8), null, '词内 / 不得误触发');
    assert.strictEqual(tok('http://x.com', 12), null, 'URL 里的 / 不得误触发');
    assert.strictEqual(tok('改 src/main', 10), null, '文件路径不得误触发');
    // 光标在 token 之前：没有可替换段
    assert.strictEqual(tok('/pdf', 0), null, '光标在触发符之前不该算触发段');
    assert.strictEqual(tok('', 0), null);
    // selectionStart 缺失（非 textarea 宿主）退化为「按末尾算」
    assert.deepStrictEqual(tok('末尾 /ab'), { start: 3, end: 6, trigger: '/' });
});

test('⑤b 聊天页与 automation 页共用同一触发判定，不再各写一份', () => {
    // 导出面
    assert.match(HISTORY_SRC, /findToken: findCmdTriggerToken,/,
        'GourdCmdComplete 必须导出 findToken，供外部宿主复用');
    // 聊天页
    const h = sliceFunction(HISTORY_SRC, 'function handleInputForCommands(e) {', 'handleInputForCommands');
    assert.match(h, /var token = findCmdTriggerToken\(inputEl\);/,
        '聊天页 input 必须走 findCmdTriggerToken');
    assert.ok(h.indexOf("val.indexOf('/') === 0") < 0, '聊天页不得残留「必须行首」旧口径');
    // automation 页：曾自留旧口径 = 用户报障的行为在这一页一点没修
    const a = sliceFunction(AUTOMATION_SRC, 'function autoCmdCompleteOnInput() {', 'autoCmdCompleteOnInput');
    assert.match(a, /window\.GourdCmdComplete\.findToken\(inputEl\)/,
        'automation 页必须复用 findToken（两份判定必然漂移）');
    assert.ok(a.indexOf("val.indexOf('/') === 0") < 0,
        'automation 页不得残留「以 / 开头且光标前无空格」旧口径（技能只能触发一次的病根）');
    assert.ok(a.indexOf("inputEl.value.substring(token.start, token.end)") >= 0,
        'automation 页必须把触发段（含触发符）整段交给 show');
    // 注释不得再谎称「口径同 app-history.js handleInputForCommands」而实现各写一套
    assert.ok(AUTOMATION_SRC.indexOf('不在此另写一份') >= 0,
        'automation 页注释必须写明「复用同一函数」，避免注释与实现分叉');
});

test('⑤c 面板展示名 + id 小标签：主视觉是可读名，id 只作核对', () => {
    const show = sliceFunction(HISTORY_SRC, 'function showCmdComplete(inputEl, completeEl, prefix) {', 'showCmdComplete');
    assert.match(show, /var display = \(cmd\.type === 'skill' && cmd\.displayName\) \? cmd\.displayName : cmd\.name;/,
        '技能行主视觉必须是 displayName，缺失回退 id');
    assert.match(show, /escapeHtml\(trigger \+ display\)/, '渲染出去的是展示名，不是 id');
    assert.match(show, /class="cmd-id-tag"/, 'id 小标签仍要在，供用户核对到底选了哪个技能');
    // 过滤必须同时吃 id 与展示名：面板改成中文名后，只按 id 过滤会让中文输入永远筛不中
    assert.match(show, /display\.toLowerCase\(\)\.indexOf\(query\) === 0/,
        '过滤必须同时匹配展示名，否则中文输入筛不出任何技能');
    assert.match(show, /var query = prefix\.substring\(1\)\.toLowerCase\(\);/,
        'show 自己剥触发符：调用方传整段 token 才对得上');
});

test('⑤d 回填符号取现算的 token.trigger，不取缓存的 cmdTrigger', () => {
    const apply = sliceFunction(HISTORY_SRC, 'function applyCmdSelection(inputEl, completeEl) {', 'applyCmdSelection');
    assert.match(apply, /replaceCmdToken\(inputEl, token, token\.trigger \+ cmd\.name\);/,
        '回填必须用 token.trigger（现算）');
    assert.ok(apply.indexOf("replaceCmdToken(inputEl, token, (cmdTrigger || '/') + cmd.name)") < 0,
        '不得用缓存 cmdTrigger：面板开着时移动光标不触发 input，缓存值会把 @候选以 / 插入');
    // chip 只属于聊天页两个输入框；automation 的 prompt 存在表单里，发送不经 sendMessage
    assert.match(apply, /var useChip = \(inputEl === welcomeInput \|\| inputEl === chatInput\);/,
        'chip 形态必须按宿主判定，外部宿主仍走文本回填');
    assert.match(apply, /if \(cmd\.type === 'skill' && useChip\) \{/, '技能 + 聊天页才走 chip');
});

/* =====================================================================
 * ⑥ 后端 displayName 双内核同口径（前端展示名的唯一来源）
 * ===================================================================== */
test('⑥ 双内核 hints 都下发 displayName，且只信市场元数据', () => {
    const java = path.join(repoRoot, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'java',
        'com', 'gourdai', 'core', 'portal', 'web', 'WebController.java');
    const javaSrc = fs.readFileSync(java, 'utf8');
    assert.match(javaSrc, /String displayName = SkillDisplayNames\.of\(skill\.getRealPath\(\)\);/,
        'Java hints 必须走 SkillDisplayNames 单一出口（与市场卡、任务监控同源）');
    assert.match(javaSrc, /item\.put\("displayName", displayName\.trim\(\)\);/,
        'Java hints 必须把 displayName 放进响应');
    // 展示名只作展示：路由键仍是 name
    assert.match(javaSrc, /item\.put\("name", skill\.getName\(\)\);/,
        'name（路由键）不得被展示名替换');

    const rs = fs.readFileSync(path.join(repoRoot, 'gourd-work', 'core', 'src', 'server', 'mod.rs'), 'utf8');
    const rows = sliceFunction(rs, 'fn skill_hint_rows(registry: &crate::skills::SkillRegistry) -> Vec<serde_json::Value> {',
        'skill_hint_rows');
    assert.match(rows, /crate::skills::display_name_of\(skill\.market\.as_ref\(\)\)/,
        'Rust 必须走 display_name_of(market)，不得读 SKILL.md 自述名（信任边界）');
    assert.match(rows, /row\["displayName"\] = serde_json::json!\(dn\);/, 'Rust hints 必须下发 displayName');
    assert.match(rows, /"name": skill\.name,/, 'Rust 路由键同样保持 name');
    // 禁用技能仍不得进面板：展示名改造不得顺带放松这道过滤
    assert.match(rows, /registry\.load_enabled\(\)/,
        'hints 必须用 load_enabled，改用 load_all 会让「关闭」开关看起来失效');
});

/* =====================================================================
 * ⑦ 真变异对照：把 P0-1 改回附件区，①/③ 必须判红
 *    （不复用本文件的手写断言，spawn 子进程真跑一遍）
 * ===================================================================== */
/* 子进程里跳过本用例：变异对照会改写磁盘源码，套娃执行会互相污染（还原时序打架）。 */
const IN_MUTATION_CHILD = process.env.SKILL_CHIP_MUTATION_CHILD === '1';

test('⑦ 真变异对照：chip 退回附件区时护栏必须判红', { skip: IN_MUTATION_CHILD }, () => {
    const ANCHOR = "return (inputEl === welcomeInput) ? '#welcomeSkillChips' : '#chatSkillChips';";
    const MUTANT = "return (inputEl === welcomeInput) ? '#welcomeAttachmentsWrap' : '#chatAttachmentsWrap';";
    const original = fs.readFileSync(HISTORY, 'utf8');
    assert.ok(original.indexOf(ANCHOR) >= 0, '变异锚点缺失：chipWrapFor 已被改写，本用例需同步更新');
    let mutated = false;
    try {
        fs.writeFileSync(HISTORY, original.replace(ANCHOR, MUTANT), 'utf8');
        mutated = true;
        /* 真跑独立 node 子进程执行整份护栏（不复用本进程内已读入的 HISTORY_SRC）。
           必须从子进程 env 里删掉 NODE_TEST_CONTEXT：node:test 会在测试进程里设这个
           变量，子进程继承后 runner 判定「递归调用」直接跳过运行文件，产出的只有一句
           Warning 而非 TAP —— 于是「护栏判红」退化成「护栏什么都没跑」也报绿。 */
        const childEnv = Object.assign({}, process.env, { SKILL_CHIP_MUTATION_CHILD: '1' });
        delete childEnv.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath,
            ['--test', '--test-reporter', 'tap', path.join(__dirname, 'skill-chip-contract.test.js')],
            { encoding: 'utf8', cwd: desktop, env: childEnv, timeout: 120000 });
        const out = (r.stdout || '') + (r.stderr || '');
        /* 先确认子进程真的跑了用例：pattern 写错 / 文件没被发现时，一个用例不跑也会
           退出码 0，「护栏判红」就成了空话（本用例第一版正是这样空转的）。
           ⚠ 汇总行在 Windows 下是 "# pass 20\r\n"：JS 正则的 $ 不认 \r 前的位置，
           写 (\d+)$ 会永远失配（踩过同款 CRLF 坑），故只锚行首不锚行尾。 */
        const mPass = /^# pass (\d+)/m.exec(out);
        const mFail = /^# fail (\d+)/m.exec(out);
        assert.ok(mPass && mFail, '子进程未产出 TAP 汇总，无法判定护栏是否真跑：\n' + out.slice(0, 800));
        const nPass = Number(mPass[1]);
        const nFail = Number(mFail[1]);
        assert.ok(nPass + nFail > 0, '子进程一个用例都没跑（空跑），护栏等于不存在');
        assert.ok(nFail > 0,
            '把 chip 挂回附件区后护栏仍全绿（fail=0）—— 护栏空转，等于没有护栏');
        // 判红的必须是「容器归属 / chip 存活」这两类，而不是无关用例碰巧失败
        assert.ok(/^not ok .*chip 容器是独立的/m.test(out)
                || /^not ok .*附件区全量重建/m.test(out),
            '判红用例未命中 P0-1 的两条核心断言，护栏没锁在该锁的地方：\n' + out.slice(0, 800));
    } finally {
        if (mutated) fs.writeFileSync(HISTORY, original, 'utf8');   // 无条件还原
        assert.strictEqual(fs.readFileSync(HISTORY, 'utf8'), original, '变异后必须逐字还原源文件');
    }
});

/* =====================================================================
 * ⑧ 行尾/编码：修复不得引入回归（既有契约同口径）
 * ===================================================================== */
test('⑧ 被改动的文件保持 CRLF 且无 BOM', () => {
    for (const f of [HISTORY, STREAMING, AUTOMATION, CHAT_HTML, APP_CSS]) {
        const buf = fs.readFileSync(f);
        assert.notStrictEqual(buf[0], 0xEF, path.basename(f) + ' 不得带 BOM');
        const s = buf.toString('utf8');
        const lf = (s.match(/(?<!\r)\n/g) || []).length;
        assert.strictEqual(lf, 0, path.basename(f) + ' 混入了裸 LF（原文件是 CRLF）');
    }
});
