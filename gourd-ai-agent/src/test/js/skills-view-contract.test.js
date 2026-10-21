/**
 * 契约测试：技能管理视图重构（2026-10）— 市场标签页 / 卡片 / 详情弹窗 / 全局安装 / 启禁用。
 *
 * 背景：用户反馈旧技能页「好丑」且交互割裂（安装要选全局/项目、外部卡片只能跳官网、
 * 无图标、已安装不能禁用）。重构契约如下，全部从源码派生断言：
 *  1) 视图骨架：市场标签页 + 分类筛选栏 + 详情弹窗 + 已安装入口/返回条；旧 layui 市场下拉移除；
 *  2) 安装统一全局区：install 请求体不含 scope，作用域下拉整体删除；
 *  3) 图标：市场图标经后端代理 /web/settings/skills/icon 加载，失败自毁露出首字母底；
 *  4) 启禁用：已安装卡片带 .skill-toggle 开关，走 /skills/toggle 改写 frontmatter；
 *  5) 详情弹窗：/skills/detail 拉取 + 弹窗内安装按钮；
 *  6) 分类筛选：/skills/categories + proxy 的 category 参数；
 *  7) 12 个语言包新增键齐全；
 *  8) 卡片网格与弹窗样式存在，且实心底不写死白字（dark-theme 门禁同族要求）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const html = readStatic('skills.html');
const js = readStatic('js', 'app-skills.js');
const css = readStatic('css', 'skills.css');

const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'el', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi'];

test('视图骨架：标签页/分类栏/详情弹窗齐全，旧市场下拉与冗余入口已移除', () => {
    ['skillsViewTabs', 'skillsCategoryBar', 'skillDetailOverlay',
        'skillsList', 'skillsSearchInput', 'skillDetailInstallBtn'].forEach((id) => {
        assert.ok(html.includes('id="' + id + '"'), 'skills.html 缺少 #' + id);
    });
    assert.ok(!html.includes('skillsMarketSelect'), '旧 layui 市场下拉必须移除（改为标签页）');
    assert.ok(!html.includes('skills-view-tab active" data-view="installed"'), '默认激活态由 JS 渲染，HTML 不预置');
    /* 已安装入口按钮与返回条必须保持移除：两者与「已安装」标签页功能完全重复，
     * 且返回条独占一行会把头部撑成两行（Playwright 实测 104px，右侧约 1200px 整行空白）。 */
    assert.ok(!html.includes('skillsInstalledBtn'), '右上角「已安装」入口按钮不得回归（与标签页重复）');
    assert.ok(!html.includes('skillsBackBtn'), '返回按钮不得回归（标签页始终可见，无需返回）');
    assert.ok(!js.includes('skillsInstalledBtn'), 'JS 不得残留已删除入口按钮的引用');
    assert.ok(!js.includes('_lastMarketView'), '返回目标死变量不得残留（返回条删除后零消费者）');
});

test('头部固定：顶栏与分类栏在滚动容器之外，滚动时不随列表移动', () => {
    const headOpen = html.indexOf('id="skillsHead"');
    const scrollOpen = html.indexOf('id="skillsScroll"');
    const topbarIdx = html.indexOf('id="skillsViewTabs"');
    const catIdx = html.indexOf('id="skillsCategoryBar"');
    assert.ok(headOpen !== -1, '必须存在 #skillsHead 固定头部容器');
    assert.ok(headOpen < topbarIdx && topbarIdx < scrollOpen, '顶栏必须在滚动容器之外');
    assert.ok(headOpen < catIdx && catIdx < scrollOpen, '分类栏必须在滚动容器之外');
    assert.match(css, /\.skills-head \{ flex-shrink: 0;/, '头部不得参与伸缩（固定）');
    assert.match(css, /\.skills-scroll \{ flex: 1; overflow-y: auto;/, '滚动必须只发生在列表容器');
});

test('桌面壳拖拽区：头部自身承担拖拽，不双重补偿，且让开原生窗口控件', () => {
    // 桌面壳下 .main-area 的 .titlebar-drag-region 占位 36px，chat/code 视图有内容盖住，
    // skills 视图此前被整体压下，顶部多出一条空白带。契约（Playwright 实测驱动）：
    //  - strip 隐藏（display:none，不再占位），头部自身承担拖拽；
    //  - 严禁 margin-top:-36px 双重补偿（实测会把 head 顶到 y=-36 被裁掉）；
    //  - 头部内边距 padding-top >= 36px，让开 Electron titleBarOverlay 的原生窗口按钮。
    assert.match(css, /body\.is-electron \.skills-head \{ -webkit-app-region: drag; \}/,
        '桌面壳下头部自身承担拖拽');
    assert.ok(!/body\.is-electron \.skills-head \{[^}]*margin-top:\s*-36px/.test(css),
        '严禁 margin-top:-36px 双重补偿（strip 已 display:none 不占位，负 margin 会把头部顶出容器）');
    assert.match(css, /body\.is-electron \.main-area:has\(> \.skills-view\.active\) > \.titlebar-drag-region \{ display: none; \}/,
        '冗余的占位 strip 必须隐藏（避免双 36px 叠加）');
    assert.ok(!/body\.is-electron \.main-area > \.titlebar-drag-region \{/.test(css),
        'strip 隐藏必须门控在 skills 视图激活时：全局隐藏会把 chat/code 的 36px 标题条一并移除，内容顶到窗口顶（用户报障回归）');
    // padding-top 必须 >= 36px 才能让开原生窗口控件（titleBarOverlay height:36）
    const pt = css.match(/body\.is-electron \.skills-head \.skills-inner \{ padding-top:\s*(\d+)px; \}/);
    assert.ok(pt, '桌面壳下头部必须补回 padding-top 让开原生窗口控件');
    assert.ok(parseInt(pt[1], 10) >= 36,
        'padding-top 必须 >= 36px（否则顶栏被 Electron 原生窗口按钮遮挡），实际 ' + pt[1]);
    // 分类栏/标签栏需按住拖动平移，必须整体 no-drag，否则桌面壳下拖它会拖窗
    assert.match(css, /body\.is-electron \.skills-category-bar,\s*\n?body\.is-electron \.skills-view-tabs \{ -webkit-app-region: no-drag; \}/,
        '分类栏/标签栏必须整体豁免拖拽（否则拖它平移会变成拖动窗口）');
});

test('头部通栏：不再 max-width 限宽居中（消除宽屏右侧大间隔）', () => {
    // Playwright 实测：max-width:1080px 使 1638px 视口下「已安装」按钮距右缘 164.5px，
    // 而用户参考图同宽仅 24px → 感知为「头部右侧有间隔」。改为通栏。
    assert.match(css, /\.skills-inner \{ width: 100%; \}/, '内容容器必须通栏');
    assert.ok(!/\.skills-inner \{[^}]*max-width:\s*\d+px/.test(css),
        '.skills-inner 不得再限宽居中（会在宽屏两侧留大片空白）');
});

test('分类栏可鼠标横滚：箭头 + 滚轮转换 + 拖拽平移 + 溢出线索（四管齐下）', () => {
    // 根因：原生 overflow-x 只认 deltaX/shift+wheel，鼠标滚轮 deltaY 不横滚（实测 scrollLeft 恒 0），
    // 滚动条又隐藏 → 鼠标用户无路可走。契约：
    assert.match(js, /el\.scrollLeft = next;/, '必须把滚轮 deltaY 转成横向 scrollLeft');
    assert.match(js, /el\.scrollLeft = drag\.left - dx;/, '必须支持按住拖拽平移');
    assert.match(js, /Math\.abs\(dx\) < 4/, '拖拽必须有 4px 阈值区分点击');
    assert.match(js, /suppressClick/, '拖拽后必须抑制 click（避免误选中拖拽终点下的 chip）');
    assert.match(js, /suppressClick = true;/, '拖拽置位必须真实存在（不能只留变量名）');

    /* ---- 左右切换箭头（用户明确要求的主入口）---- */
    assert.match(html, /class="skills-hscroll-nav prev"/, '分类栏必须有左箭头');
    assert.match(html, /class="skills-hscroll-nav next"/, '分类栏必须有右箭头');
    assert.match(js, /function bindHScrollNav\(/, '必须有箭头绑定函数');
    assert.match(js, /prev\.addEventListener\('click'/, '左箭头必须绑点击');
    assert.match(js, /next\.addEventListener\('click'/, '右箭头必须绑点击');
    // 步长按可见宽度算，不写死像素（宽窄屏都要「一屏一屏」翻，写死值在窄屏会一次翻到底）
    assert.match(js, /el\.clientWidth \* 0\.8/, '箭头步长必须按可见宽度比例计算');
    // 禁用态与溢出态必须同源同步，否则会出现「箭头可点但已到头」或「到头仍亮着」
    assert.match(js, /prev\.disabled = !canLeft;/, '左箭头禁用态必须由溢出同步驱动');
    assert.match(js, /next\.disabled = !canRight;/, '右箭头禁用态必须由溢出同步驱动');
    assert.match(css, /\.skills-hscroll-nav:disabled/, '箭头必须有禁用态样式');
    /* 不溢出时箭头必须完全不占位：否则两个灰色禁用箭头常年占着布局宽度、把 chips 挤窄。
     * 断言「默认 display:none + has-overflow 才 flex」这一对，只查其一都拦不住回归。 */
    assert.match(css, /\.skills-hscroll-nav \{ display: none;/, '箭头默认不得占位');
    assert.match(css, /\.skills-hscroll-wrap\.has-overflow \.skills-hscroll-nav \{ display: flex; \}/, '仅溢出时箭头才出现');
    assert.match(js, /wrap\.classList\.toggle\('has-overflow', overflow\);/, 'JS 必须同步 has-overflow 溢出态');

    /* ---- 渐隐线索：挂在【不滚动的 viewport】上 ----
     * 挂在 overflow 元素自身会随内容一起滚走，挂在 wrap 上又会被箭头盖住。
     * 左右两向都要有（此前只有右缘，向左滚回去后没有任何提示）。 */
    assert.match(html, /class="skills-hscroll-viewport"/, '必须有 viewport 承载渐隐');
    assert.match(css, /\.can-scroll-right \.skills-hscroll-viewport::after/, '右缘渐隐必须挂 viewport');
    assert.match(css, /\.can-scroll-left \.skills-hscroll-viewport::before/, '左缘渐隐必须挂 viewport');
    assert.match(js, /wrap\.classList\.toggle\('can-scroll-left', canLeft\);/, '必须同步左渐隐态');
    assert.match(js, /wrap\.classList\.toggle\('can-scroll-right', canRight\);/, '必须同步右渐隐态');

    // 滚动条必须完全不占位（否则分类栏高度突增、与顶栏错位）
    assert.match(css, /\.skills-hscroll \{[^}]*scrollbar-width: none/, '横向滚动条不得占位（避免高度突增错位）');
    // chips 不得被 flex 压缩（否则文字挤成重叠而非触发溢出）
    assert.match(css, /\.skills-category-chip \{[^}]*flex-shrink: 0;/, 'chips 必须 flex-shrink:0');
    /* ⚠ 源码字符串断言只能证明「写了」，证明不了「跑起来对」：
     * 变异验证实测「删掉 suppressClick = true 赋值」这类改动靠词存在断言抓不到，
     * 运行时行为（箭头点击真能滚、到头真能禁用）由 Playwright 实测兼住。 */
    assert.match(html, /id="skillsCategoryBarWrap"/, '分类栏必须有外层 wrap 承载箭头与渐隐');
    assert.match(html, /class="skills-category-bar skills-hscroll"/, '分类栏 chips 宿主必须带 skills-hscroll');
});

test('字号基线：与全站 13px 基线对齐，不得出现超大标题/正文', () => {
    // 全站 body 基线 14px、次级文字 13px（app.css / automation.css 口径）
    assert.match(css, /\.skills-view-tab \{[^}]*font-size: 13px;/, '视图 Tab 13px');
    assert.match(css, /\.skills-category-chip \{[^}]*font-size: 13px;/, '分类 chip 13px');
    assert.match(css, /\.skill-card-name \{[^}]*font-size: 13px;/, '卡片标题 13px');
    assert.match(css, /\.skill-card-desc \{[^}]*font-size: 12px;/, '卡片描述 12px');
    assert.match(css, /\.skill-detail-name \{[^}]*font-size: 16px;/, '弹窗标题 16px（原 19px 过大）');
    /* 文字类选择器不得超过 16px。清单不含 .skills-installed-title：
     * 该返回条已随「头部收敛为单行」整体删除（见头部单行契约），
     * 把它留在正则里会让条数断言随删除而漂移，是脆弱护栏。 */
    const textRules = css.match(/\.(?:skill-card-name|skill-detail-name|skill-detail-body|skill-detail-tag|skill-detail-stat|skills-tab-count)\s*\{[^}]*\}/g) || [];
    assert.ok(textRules.length >= 5, '文字类规则应至少 5 条，实际 ' + textRules.length);
    textRules.forEach((rule) => {
        const m = rule.match(/font-size:\s*(\d+)px/);
        if (m) assert.ok(parseInt(m[1], 10) <= 16, '文字类字号不得超过 16px: ' + rule);
    });
});

test('安装统一全局区：请求体不含 scope，作用域下拉组件整体删除', () => {
    assert.ok(!js.includes('skill-install-scope-option'), '作用域下拉选项不得残留');
    assert.ok(!js.includes('scope_global'), '作用域文案引用不得残留');
    assert.match(js, /data:\s*\{\s*slug:\s*slug,\s*marketName:\s*marketName\s*\}/,
        'install 请求体必须只含 slug+marketName（统一全局区）');
});

test('图标走后端代理且加载失败自毁露出首字母底', () => {
    assert.match(js, /\/web\/settings\/skills\/icon\?url=/, '图标必须经后端代理（前端不直连图床）');
    assert.match(js, /onerror="this\.remove\(\)"/, '图标加载失败必须自毁，露出首字母占位');
    assert.match(css, /\.skill-card-icon img \{ position: absolute;/, '图标 img 必须叠在字母底之上');
});

test('已安装判定：回退候选按 slug 形态隔离，限定卡不得回退裸尾名', () => {
    /* 上游实测 skillhub 存在不同作者共用同一公开 slug 的记录（dev-expert 两条）。
     * 旧实现 candidates 无条件含裸 slug：装过任一同名技能后，所有同 slug 卡片
     * 连带误亮「已安装」。契约：限定形态（@owner/s）候选只含限定 slug 与其
     * 目录名形态（@ / → _），不得含裸尾；裸形态候选不得含限定目录名形态。 */
    const fnStart = js.indexOf('function findInstalledForMarket');
    assert.ok(fnStart !== -1, 'findInstalledForMarket 必须存在');
    const fn = js.slice(fnStart, js.indexOf('\n    }', fnStart));
    assert.match(fn, /charAt\(0\) === '@'/, '必须按 @ 起首区分限定形态');
    const qualifiedBranch = fn.slice(fn.indexOf("charAt(0) === '@'"), fn.indexOf('} else {'));
    // 源码形态：String(slug).replace(/[@/]/g, '_') —— 用字符串匹配，
    // 避免正则字面量内未转义斜杠提前闭合正则的语法坑
    assert.ok(qualifiedBranch.includes("replace(/[@/]/g, '_')"), '限定候选须含目录名形态（@ 与 / → _）');
    // 限定分支不得含裸尾剥离候选（[^a-zA-Z0-9._-] 剥离后即裸尾名，
    // 装过任一同名技能后所有同 slug 卡片会连带误亮「已安装」）
    assert.ok(!qualifiedBranch.includes('[^a-zA-Z0-9._-]'),
        '限定分支不得含裸尾剥离候选（同 slug 卡片会连带误亮已安装）');
});

test('已安装卡片：启禁用开关 + 悬浮卸载按钮', () => {
    assert.match(js, /class="skill-toggle/, '已安装卡片必须渲染开关');
    assert.match(js, /\/web\/settings\/skills\/toggle/, '开关必须走 toggle 端点');
    assert.match(js, /data-enabled=/, '开关态必须由 data-enabled 承载');
    assert.match(css, /\.skill-toggle\.on \{ background: var\(--color-success\); \}/, '开启态用 success 令牌');
    assert.match(css, /\.skill-card-installed:hover \.skill-uninstall-btn \{ display: flex; \}/, '卸载按钮仅悬浮出现');
});

test('详情弹窗：detail 端点 + 弹窗内安装 + ESC/遮罩关闭', () => {
    assert.match(js, /\/web\/settings\/skills\/detail\?slug=/, '弹窗必须拉 detail 端点');
    assert.match(js, /skillDetailInstallBtn/, '弹窗内必须有安装按钮');
    assert.match(js, /e\.key === 'Escape'/, 'ESC 必须能关弹窗');
});

test('分类筛选：categories 端点 + proxy category 参数 + chips 渲染', () => {
    assert.match(js, /\/web\/settings\/skills\/categories\?marketName=/, '分类栏数据源');
    assert.match(js, /&category=/, '列表请求必须携带 category');
    assert.match(js, /skills-category-chip/, '分类 chips 必须渲染');
});

test('市场标签页：三个市场都有友好展示名', () => {
    ['skillhub.cn', 'clawhub.ai', 'modelscope.cn'].forEach((m) => {
        assert.ok(js.includes("'" + m + "':"), 'MARKET_LABELS 缺少 ' + m);
    });
});

test('12 个语言包新增键齐全（含安装成功动词、无作用域死键）', () => {
    const KEYS = ['category_all', 'downloads', 'stars', 'version', 'enable', 'disable', 'source_local', 'installed_ok'];
    LOCALES.forEach((loc) => {
        const json = JSON.parse(readStatic('locales', loc + '.json'));
        const skills = json.settings && json.settings.skills;
        assert.ok(skills, loc + ' 缺 settings.skills 块');
        KEYS.forEach((k) => {
            assert.ok(typeof skills[k] === 'string' && skills[k].length > 0,
                loc + ' 缺 settings.skills.' + k);
        });
        // 作用域选择已移除：skills 块内的 scope_* 是死键（general 块同名键仍在用，不在此限）
        assert.ok(!('scope_global' in skills), loc + ' skills 块残留死键 scope_global');
        assert.ok(!('scope_workspace' in skills), loc + ' skills 块残留死键 scope_workspace');
    });
    // toast 必须用技能域动词，不得借 loop.created（「已创建」语义错配）
    assert.match(js, /settings\.skills\.installed_ok/, '安装成功 toast 必须用 installed_ok');
    assert.ok(!/settings\.loop\.created/.test(js), 'app-skills.js 不得再借 loop.created 当安装动词');
});

test('markets 端点失败不得留白屏：渲染骨架 + 错误条可点击重试', () => {
    assert.match(js, /_marketsLoadFailed\s*=\s*true/, 'markets 失败必须置标记');
    assert.match(js, /\$skillsError\.on\('click'/, '顶部错误条必须可点击重试');
    assert.match(js, /if \(_marketsLoadFailed\) \{/, '重试入口必须受标记守卫（避免误触列表级错误条）');
});

test('样式：卡片网格 + 弹窗浮层 + 实底不写死白字', () => {
    assert.match(css, /\.skills-list \{ display: grid;/, '列表必须是卡片网格');
    assert.match(css, /\.skill-detail-overlay \{ position: fixed;/, '弹窗必须是全屏浮层');
    // dark-theme 同族门禁：accent 实底的前景必须是 --accent-contrast，不得 #fff/white
    const accentSolid = css.match(/[^{}]*\{[^{}]*background:\s*var\(--accent\);[^{}]*\}/g) || [];
    accentSolid.forEach((rule) => {
        assert.match(rule, /color:\s*var\(--accent-contrast\)/, 'accent 实底必须配 --accent-contrast: ' + rule);
        assert.ok(!/color:\s*(#fff\b|#ffffff\b|white\b)/i.test(rule), 'accent 实底禁止白字: ' + rule);
    });
    assert.ok(accentSolid.length >= 2, '应至少覆盖卡片 + 按钮与弹窗安装按钮两处 accent 实底');
});


test('头部单行：已安装视图不得多出独占一行的返回条', () => {
    /* 用户反馈「头部和右侧栏目中间有空隙」。Playwright 实测根因不是 padding 写错：
     * 已安装视图下头部渲染出【两行】——顶栏标签行(31px) + 返回条行(30px)，
     * 头部总高 104px，而返回条内容仅约 100px 宽，右侧约 1200px 整行空白。
     * 契约：返回条容器/标题/按钮三者一律不得存在，数量徽标内嵌到「已安装」标签里。 */
    assert.ok(!html.includes('skills-installed-head'), '不得有独占一行的返回条容器');
    assert.ok(!html.includes('skills-back-btn'), '不得有返回按钮');
    assert.ok(!css.includes('.skills-installed-head'), '返回条样式必须一并清除（留着就是死代码）');
    assert.ok(!css.includes('.skills-back-btn'), '返回按钮样式必须一并清除');
    assert.ok(!js.includes('skillsInstalledHead'), 'JS 不得再 toggle 返回条');
    // 数量徽标必须内嵌标签，否则删了返回条就丢了「已安装几个」的信息
    assert.match(js, /skills-tab-count/, '已安装数量徽标必须内嵌到标签内');
    assert.match(css, /\.skills-tab-count \{[^}]*font-size: 11px/, '徽标 11px（次要信息，不得抢视觉权重）');
    assert.match(css, /\.skills-tab-count:empty \{ display: none; \}/, '无技能时徽标不得留空壳');
});

test('顶栏无中间空洞：标签组不撑满，搜索框吸收剩余宽度', () => {
    /* 第二处「空隙」：Playwright 实测 .skills-tabs-wrap 被 flex:1 撑到 951.9px，
     * 而 4 个标签内容仅约 352px → 标签与右侧搜索框之间约 600px 纯空洞。
     * 修法：标签组按内容宽（flex:0 1 auto），搜索框 flex:1 吃掉剩余宽度。 */
    assert.match(css, /\.skills-tabs-wrap \{ flex: 0 1 auto;/, '标签组不得 flex:1 撑满（会留下约 600px 空洞）');
    assert.match(css, /\.skills-topbar-actions \{[^}]*flex: 1 1 auto/, '右侧操作区必须吸收剩余宽度');
    assert.match(css, /\.skills-search-input-wrap \{[^}]*flex: 1 1 auto/, '搜索框必须伸展填满（不留空洞）');
    assert.ok(!/\.skills-search-input-wrap \{[^}]*width:\s*220px/.test(css),
        '搜索框不得再写死 220px（写死宽度会让右侧留白）');
});

test('静态资源不得强缓存：否则改完前端刷新无效、重启服务也无效', () => {
    /* 用户「重启 web 服务几次一点没修改」的制度性根因：
     * solon 静态资源默认 Cache-Control: max-age=600（10 分钟强缓存），仅 debug 模式才自动为 0。
     * 重启服务不会清浏览器已有的强缓存 → 改多少遍都看不到。设 0 改走协商缓存
     * （Last-Modified + 304），刷新即生效，304 响应体极小、代价可忽略。 */
    const yml = fs.readFileSync(path.resolve(__dirname, '../../main/resources/app.yml'), 'utf8');
    assert.match(yml, /^solon\.staticfiles\.cacheMaxAge:\s*0\s*$/m,
        '必须显式关闭静态资源强缓存（框架默认 600s 会让前端改动刷新不可见）');
});

test('头部底色与主区同源：不得用 --bg-body（交界色带回归护栏）', () => {
    /* 用户多轮反馈「技能头左侧/交接处有问题」的取证结论（Playwright 逐像素扫描）：
     * 修复前暗色主题下侧栏右缘（x=285）背景由 #17171A 突变为 #131315 —— .skills-head
     * 用了 --bg-body(#131315)，而 resize handle、列表区、automation/chat 等所有其它视图
     * 顶栏均为 --bg-main(#17171A)，交界处形成一条 123px 高的竖向色带（技能页独有）。
     * 亮色主题同理：#fafafa vs #ffffff 的灰带。
     * 契约：头部底色与左右渐隐渐变全部走 --bg-main；任何 background 声明不得引用 --bg-body。 */
    assert.match(css, /\.skills-head \{[^}]*background: var\(--bg-main\)/,
        '头部底色必须用 --bg-main（与主区/其它视图同源）');
    assert.match(css, /linear-gradient\(to right, transparent, var\(--bg-main\) 78%\)/,
        '右缘渐隐渐变必须用 --bg-main（渐隐色与底色同源）');
    assert.match(css, /linear-gradient\(to left, transparent, var\(--bg-main\) 78%\)/,
        '左缘渐隐渐变必须用 --bg-main');
    assert.ok(!/background:[^;]*var\(--bg-body\)/.test(css),
        '任何 background 声明都不得引用 --bg-body（暗色 #131315 与主区 #17171A 不同 → 交界色带）');
});

test('头部下边框左端补齐：resize handle 缺口必须补住且不被裁回', () => {
    /* 用户反馈「这条线左侧还有点空、没连到一起，右侧却连到一起」（截图 2x 像素扫描）：
     * 布局是 [.sidebar|1px 右边框][.sidebar-resize-handle 5px][.main-area]，
     * .skills-head 的 border-bottom 从主区左缘才起画 → 左侧恰断 5px（= handle 宽），
     * 右端直达窗口边 → 视觉上「只断左边」。修复 = 左下角贴线伪元素补满缺口，
     * 且 .skills-view 必须放行盒外绘制（overflow:clip + margin）；回退 overflow:hidden 会裁掉它。
     * 浏览器实测：修复后缺口行像素 536..572 连续同色（修复前 538..547 为白色缺口）。 */
    const appCss = readStatic('css', 'app.css');
    const hw = appCss.match(/\.sidebar-resize-handle \{[^}]*?width:\s*(\d+)px;/);
    assert.ok(hw, 'app.css 缺 .sidebar-resize-handle 宽度（补齐线的宽度基准）');
    const handleWidth = parseInt(hw[1], 10);
    const hz = appCss.match(/\.sidebar-resize-handle \{[^}]*?z-index:\s*(\d+);/);
    assert.ok(hz, 'app.css 缺 .sidebar-resize-handle 的 z-index（层叠基准）');
    const handleZ = parseInt(hz[1], 10);

    assert.match(css, /\.skills-head \{[^}]*position: relative;/,
        '头部必须建立定位参照（补齐线以它为绝对定位基准）');
    const before = css.match(/\.skills-head::before \{[^}]*\}/);
    assert.ok(before, '必须存在 .skills-head::before 补齐线（缺失则 handle 上方缺口还原）');
    const b = before[0];
    assert.match(b, new RegExp('left: -' + handleWidth + 'px'), '补齐线必须左移 handle 宽度 ' + handleWidth + 'px');
    assert.match(b, new RegExp('width: ' + handleWidth + 'px'), '补齐线宽度必须等于 handle 宽度 ' + handleWidth + 'px');
    assert.match(b, /bottom: -1px/, '补齐线必须与下边框同一行（bottom:-1px 压住 1px border 行）');
    assert.match(b, /height: 1px/, '补齐线厚度必须与 1px 下边框一致');
    assert.match(b, /background: var\(--border-color\)/, '补齐线颜色必须与下边框同源 --border-color');
    assert.match(b, /pointer-events: none/, '补齐线不得吃指针事件（否则挡住 handle 拖拽）');
    const pz = b.match(/z-index:\s*(\d+)/);
    assert.ok(pz, '补齐线必须有 z-index（否则被 handle 底色盖住）');
    assert.ok(parseInt(pz[1], 10) > handleZ,
        '补齐线 z-index 必须高于 handle 的 ' + handleZ + '（实测 handle 底色会盖住低层）');

    assert.match(css, /\.skills-view \{[^}]*overflow: clip;/, '视图容器必须用 overflow:clip 放行盒外绘制');
    const cm = css.match(/\.skills-view \{[^}]*overflow-clip-margin:\s*(\d+)px;/);
    assert.ok(cm, '必须设置 overflow-clip-margin（缺省 0 仍会裁掉盒外补齐线）');
    assert.ok(parseInt(cm[1], 10) >= handleWidth, '盒外绘制余量必须 >= handle 宽度（低于则补齐线被裁回）');
    assert.ok(!/\.skills-view \{[^}]*overflow: hidden;/.test(css), '不得回退 overflow:hidden（会把盒外补齐线裁掉）');
});
