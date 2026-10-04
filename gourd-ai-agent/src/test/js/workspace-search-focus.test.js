/* 工作区搜索框焦点守卫契约测试
 * 背景（2026-09-29 实机复现）：app-streaming.js 的「Click to focus」委托在点击
 * composer 托盘内任意非 button 元素时把焦点抢回聊天输入框，工作区下拉的搜索框
 * （INPUT）不在豁免名单 → 点击搜索框瞬间焦点被夺走，键盘永远打不进字。
 * 修复：两处 click 委托的豁免名单追加 .workspace-selector。
 * 本测试钉死该豁免与搜索委托链路，防止回归。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../../main/resources/static/js');
const streaming = fs.readFileSync(path.join(ROOT, 'app-streaming.js'), 'utf8');
const workspace = fs.readFileSync(path.join(ROOT, 'app-workspace.js'), 'utf8');

function handlerBlock(src, anchor) {
    const i = src.indexOf(anchor);
    assert.ok(i >= 0, 'anchor not found: ' + anchor);
    return src.slice(i, i + 400);
}

test('welcome-input-box click 委托豁免 workspace-selector', () => {
    const block = handlerBlock(streaming, "$('.welcome-input-box').on('click'");
    assert.match(block, /closest\('\.workspace-selector'\)/, 'welcome 点击委托必须豁免工作区下拉');
    assert.match(block, /welcomeInput\.focus\(\)/);
});

test('input-box click 委托豁免 workspace-selector', () => {
    const block = handlerBlock(streaming, "$('.input-box').on('click'");
    assert.match(block, /closest\('\.workspace-selector'\)/, '会话态点击委托必须豁免工作区下拉');
    assert.match(block, /chatInput\.focus\(\)/);
});

test('既有豁免名单未被破坏（button/loop-panel/history-panel/todo-float-panel）', () => {
    const block = handlerBlock(streaming, "$('.input-box').on('click'");
    for (const sel of ['button', '.loop-panel', '.history-panel', '.todo-float-panel']) {
        assert.ok(block.includes("closest('" + sel + "')"), '豁免名单缺失 ' + sel);
    }
});

test('app-workspace.js 搜索 input 委托与 keydown 拦截仍在', () => {
    assert.match(workspace, /document\.addEventListener\('input'/);
    assert.match(workspace, /classList\.contains\('workspace-search-input'\)/);
    assert.match(workspace, /document\.addEventListener\('keydown'/);
    assert.match(workspace, /renderFilteredList\(dd, dd\._fullList, keyword\)/);
});
