'use strict';
/* 共享 CSS 断言工具（非 .test.js，`npm run test:js` 的 `node --test test/*.test.js`
   平铺 glob 不会把它当测试执行）。

   【为什么需要它】「尊重 prefers-reduced-motion」这类护栏，光断言 CSS 里存在
   `animation: none` 是测不出真假效的 —— 同特异性下【顺序后者胜】，若停动画的
   规则写在动画声明【之前】，它就是死代码，用户照样看到动效。2026-11-10 登录页
   codereview 实测坐实过这一例（变异掉 theme.css 的全局 !important 兜底后，
   插画仍以 5.2s 无限循环）。

   本模块把「块提取」与「生效性判定」集中实现，供 history-loading / account 两处
   复用，避免各写一份正则、各自失真。 */

/**
 * 提取全部 `@media (prefers-reduced-motion: reduce)` 块（按花括号配平取整块）。
 * 返回 [{ at, body }]，at 为块在源码中的起始下标，便于做顺序比较。
 */
function reducedMotionBlocks(css) {
    const out = [];
    const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        while (i < css.length && depth > 0) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
            i++;
        }
        if (depth !== 0) {
            throw new Error('reduced-motion 块花括号未配平（CSS 语法破损），起始下标 ' + m.index);
        }
        out.push({ at: m.index, body: css.slice(m.index, i) });
    }
    return out;
}

/**
 * 提取所有【顶层平铺】且声明了 animation 的规则。
 * 选择器里的注释先剥掉，避免注释文本被当成选择器的一部分而漏匹配。
 */
function animationDeclarations(css) {
    const out = [];
    const re = /([^{}@/]+?)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        if (!/animation\s*:/.test(m[2])) continue;
        out.push({
            selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, ' ').split(',').map(s => s.trim()),
            body: m[2],
            at: m.index,
        });
    }
    return out;
}

/**
 * 判定：给定选择器的 `animation: none`（在 reduced-motion 语境下）是否【真能生效】。
 * 规则：该选择器在源码中最后一条 animation 声明必须是 `none` —— 否则说明有更靠后的
 * 声明把它反超，none 形同虚设。
 *
 * @returns {string|null} 违规描述；null 表示通过
 */
function findDeadReducedMotion(css, selector) {
    const decls = animationDeclarations(css);
    const hits = decls.filter(d => d.selectors.includes(selector));
    if (hits.length === 0) {
        return selector + ' 的 animation 声明未被解析到（护栏取样失效，请先检查 CSS 是否存在该选择器）';
    }
    const last = hits[hits.length - 1];
    if (!/animation:\s*none/.test(last.body)) {
        return selector + ' 最后一条 animation 声明不是 none，前面的 animation:none 是死代码：'
            + last.body.trim().slice(0, 70);
    }
    return null;
}

module.exports = { reducedMotionBlocks, animationDeclarations, findDeadReducedMotion };
