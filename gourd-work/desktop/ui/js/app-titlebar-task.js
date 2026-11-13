/* ===== app-titlebar-task.js =====
   标题栏拖拽条左端的「当前任务名」展示（markup 在 index.html 的
   .titlebar-drag-region > #titlebarTask，样式在 app.css）。

   为什么放这里：桌面壳顶条（现 44px，见 app.css 的跨栈契约注释）左端原先整段空白；会话名是用户定位
   「我在哪个任务里」的最强线索，侧栏折叠/窄窗时更是唯一线索。

   【这只是一块标题文字，不是按钮】用户两次要求「前面的圆点不需要」，并明确
   否掉了悬停时的框选观感。因此这里刻意不做任何交互绑定：
   - 无 click / keydown 处理器，无 role="button"，无 tabindex（不可聚焦）；
   - 无状态圆点、无运行态呼吸动画（.running 类已删除）；
   - CSS 侧 pointer-events:none + user-select:none，鼠标压上来即拖窗口。
   想改回可点击前先想清楚代价：它会重新可聚焦（:focus-visible 描边就是用户
   说的「框选」），也会把 chip 从拖拽区摘出去导致标题上拖不动窗口。

   数据真源（不另存副本，避免与侧栏漂移）：
   - 名称：chatHistory 中 sessionId === activeSessionId 的条目 label
     （重命名/首条消息定名都会写回 chatHistory 并经 updateHistoryUI 重绘）；
   - 无活动会话（欢迎页）→ hidden；
   - 有活动会话但**尚未定名**（新会话还没发出第一条消息，侧栏未登记）→ 同样 hidden。
     用户明确要求标题栏不出现「新对话」字样，因此这里【没有任何占位回落文案】：
     宁可不显示，也不拿一个假名字顶在标题栏上。发第一条消息 → ensureChatInHistory
     以首句登记并经 updateHistoryUI 收敛到 render()，真名随即出现。
   - 【覆盖视图开启 → hidden】技能/自动化/远控通道/使用统计/模型配置/记忆这六个
     独立主视图只隐藏 #chatView、不清 activeSessionId（会话仍活着，切回即恢复），
     于是旧口径下标题栏会一直挂着「上一个任务」的名字——用户 2026-11-12 报的
     「切到上面的菜单，头部还有之前任务的标头」。主区已经整个换页，标题却还指着
     一个看不见的会话，属于误导信息，故覆盖视图期间整块隐藏；视图关闭（class 摘除）
     即刻恢复真名。记忆视图的专注模式弹层（.memory-overlay）例外：它盖在 code 模式
     之上、底层会话仍在使用，标题保留。

   刷新触发点（全部是既有汇聚点，不新增事件总线）：
   1) setActiveSession 尾部（app-base.js）——切会话/初始化；
   2) deactivateSession（app-base.js）——activeSessionId 置 null 后必须隐藏；
   3) updateHistoryUI 的 rAF 回调尾部（app-history.js）——列表重绘即名称可能变
      （首条消息定名、重命名、删除、loop 登记）；
   4) i18n:localeChanged（app-i18n.js 派发）——名称真源是 chatHistory.label（非 i18n），
      故该触发点是防御性的：文案口径若将来改回 i18n 派生，不重取就会留着旧语言的字样。
      保留成本为零（render 内部幂等，内容未变不写 DOM）。
   5) 六个覆盖视图节点的 class 属性变化（MutationObserver）——openX/closeX 只改
      视图 class、不派发任何事件，也没有共同汇聚点可挂（六个 open 函数分属六个文件，
      逐个挂钩等于把标题栏逻辑撒进六个模块）；观察 class 是唯一单点收口。
      render 幂等（lastKey 哨兵），观察器空转成本为零。 */
(function () {
    'use strict';

    var chip = document.getElementById('titlebarTask');
    var labelEl = document.getElementById('titlebarTaskLabel');
    if (!chip || !labelEl) return; // 骨架缺失静默降级（与 app-titlebar-actions.js 同纪律）

    /* 独立主视图（覆盖视图）节点 id：与 usage.html/skills.html/automation.html/
       channel.html/model-settings.html/memory.html 六个片段的根节点逐字一致。
       它们的 openX() 都会 $('#chatView').removeClass('active') 并给自己加 .active，
       但都不动 activeSessionId——标题栏必须自己识别这层覆盖。 */
    var OVERLAY_VIEW_IDS = ['skillsView', 'automationView', 'channelView',
        'usageView', 'modelSettingsView', 'memoryView'];

    var lastKey; // undefined=尚未首帧；幂等：内容无变化不写 DOM（updateHistoryUI 每帧 rAF 都会调进来）

    function activeSid() {
        return (typeof activeSessionId !== 'undefined' && activeSessionId) ? activeSessionId : null;
    }

    /* 是否有覆盖视图占据主区。片段由 app-bootstrap.js 在 loadAppScripts 之前注入，
       故本脚本执行时六个节点必然存在（缺失时 getElementById 返回 null，天然跳过）。 */
    function overlayViewOpen() {
        for (var i = 0; i < OVERLAY_VIEW_IDS.length; i++) {
            var el = document.getElementById(OVERLAY_VIEW_IDS[i]);
            if (!el || !el.classList || !el.classList.contains('active')) continue;
            /* 记忆视图双形态：整页视图 vs 专注模式弹层（.memory-overlay）。
               弹层盖在 code 模式之上，底层会话仍是用户正在用的会话，标题不该消失。 */
            if (OVERLAY_VIEW_IDS[i] === 'memoryView' && el.classList.contains('memory-overlay')) continue;
            return true;
        }
        return false;
    }

    function currentEntry(sid) {
        var list = window.chatHistory;
        if (list && list.length) {
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].sessionId === sid) return list[i];
            }
        }
        return null;
    }

    /* 【不要再加 fallbackName / 不要回落「新对话」】用户明确要求标题栏不出现占位字样。
       这条曾被契约测试写成「必须回落 i18n 的新对话」——那个测试追的是我上一轮自己的
       错误结论、不是用户原话（教训见记忆 gourdai_titlebar_pure_text_and_code_review_self_trap）。
       绝不能用 sessionId 兜底：那是 work-xxx 内部键，露在标题栏等于没给信息。 */
    function render() {
        var sid = activeSid();
        var covered = overlayViewOpen();
        var name = '';
        /* 空态也走统一写路径（哨兵 key）：首帧即把 hidden 归位，不依赖 markup 的
           hidden 属性是否还在——骨架被误改时展示位不会露出空标题。 */
        var key;
        if (!sid || covered) {
            key = '\u0000none';
        } else {
            var entry = currentEntry(sid);
            name = (entry && entry.label) ? entry.label : '';
            key = sid + '\u0001' + name;
        }
        if (key === lastKey) return;
        lastKey = key;
        // 无会话 / 被覆盖视图盖住 / 有会话但还没定名 → 隐藏整块（不显示任何占位字样）
        if (!sid || !name || covered) {
            chip.hidden = true;
            labelEl.textContent = '';
            return;
        }
        chip.hidden = false;
        labelEl.textContent = name;
    }

    window.renderTitlebarTask = render;
    // 事件名与 app-i18n.js 派发处逐字一致（document 上的 i18n:localeChanged）
    document.addEventListener('i18n:localeChanged', function () { lastKey = null; render(); });

    /* 覆盖视图开/关的唯一收口：六个 openX/closeX 只改视图 class，不派发事件。
       只观察 class 属性（attributeFilter），回调里的 render 幂等，无变化不写 DOM。
       typeof 守卫：vm 契约测试沙箱不提供 MutationObserver，须静默跳过。 */
    if (typeof MutationObserver !== 'undefined') {
        var mo = new MutationObserver(function () { render(); });
        for (var vi = 0; vi < OVERLAY_VIEW_IDS.length; vi++) {
            var vel = document.getElementById(OVERLAY_VIEW_IDS[vi]);
            if (vel) mo.observe(vel, { attributes: true, attributeFilter: ['class'] });
        }
    }
    render();
})();
