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
   - 无活动会话（欢迎页 / skills / 自动化 / 记忆 / 用量等覆盖视图）→ hidden；
   - 有活动会话但**尚未定名**（新会话还没发出第一条消息，侧栏未登记）→ 同样 hidden。
     用户明确要求标题栏不出现「新对话」字样，因此这里【没有任何占位回落文案】：
     宁可不显示，也不拿一个假名字顶在标题栏上。发第一条消息 → ensureChatInHistory
     以首句登记并经 updateHistoryUI 收敛到 render()，真名随即出现。

   刷新触发点（全部是既有汇聚点，不新增事件总线）：
   1) setActiveSession 尾部（app-base.js）——切会话/初始化；
   2) deactivateSession（app-base.js）——activeSessionId 置 null 后必须隐藏；
   3) updateHistoryUI 的 rAF 回调尾部（app-history.js）——列表重绘即名称可能变
      （首条消息定名、重命名、删除、loop 登记）；
   4) i18n:localeChanged（app-i18n.js 派发）——名称真源是 chatHistory.label（非 i18n），
      故该触发点是防御性的：文案口径若将来改回 i18n 派生，不重取就会留着旧语言的字样。
      保留成本为零（render 内部幂等，内容未变不写 DOM）。 */
(function () {
    'use strict';

    var chip = document.getElementById('titlebarTask');
    var labelEl = document.getElementById('titlebarTaskLabel');
    if (!chip || !labelEl) return; // 骨架缺失静默降级（与 app-titlebar-actions.js 同纪律）

    var lastKey; // undefined=尚未首帧；幂等：内容无变化不写 DOM（updateHistoryUI 每帧 rAF 都会调进来）

    function activeSid() {
        return (typeof activeSessionId !== 'undefined' && activeSessionId) ? activeSessionId : null;
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
        var name = '';
        /* 空态也走统一写路径（哨兵 key）：首帧即把 hidden 归位，不依赖 markup 的
           hidden 属性是否还在——骨架被误改时展示位不会露出空标题。 */
        var key;
        if (!sid) {
            key = '\u0000none';
        } else {
            var entry = currentEntry(sid);
            name = (entry && entry.label) ? entry.label : '';
            key = sid + '\u0001' + name;
        }
        if (key === lastKey) return;
        lastKey = key;
        // 无会话，或有会话但还没定名 → 隐藏整块（不显示任何占位字样）
        if (!sid || !name) {
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
    render();
})();
