/**
 * app-skills.js — 技能管理独立主视图（已安装视图 + 技能市场视图，市场 API 均走后端代理）
 *
 * 由设置浮层的「技能管理」tab 迁移而来（原 app-settings-skill.js）：
 *  - 独立主视图 #skillsView，与自动化视图（app-automation.js）同构；
 *  - 打开时与聊天 / 欢迎 / 自动化视图互斥，侧栏「技能」入口直达。
 *
 * 依赖：layui.js（jQuery）、app-base.js、app-i18n.js（GourdI18n）
 * 协同：app-history.js（commandList / loadCommands）
 *
 * 后端接口：
 *   GET  /web/settings/skills/markets                     — 获取可用市场列表
 *   GET  /web/settings/skills/proxy?action=trending[&cursor=xx]       — 热门技能列表（cursor 游标分页）
 *   GET  /web/settings/skills/proxy?action=search&q=xxx[&cursor=xx]   — 搜索技能（cursor 游标分页）
 *   GET  /web/settings/skills/installed                   — 已安装技能列表（全部挂载池）
 *   POST /web/settings/skills/install  {slug, marketName, mountAlias}  — 安装技能
 *   POST /web/settings/mounts/skills/remove {alias, skillName}         — 卸载技能
 */
(function () {
    'use strict';

    // ==================== 常量 ====================

    var SKILLS_API_BASE = '/web/settings/skills/proxy';

    /** 视图标识：已安装技能（本地数据） / 技能市场（远程代理） */
    var VIEW_INSTALLED = 'installed';
    var VIEW_MARKET = 'market';

    // ==================== DOM 引用 ====================

    var $skillsViewTabs = $('#skillsViewTabs');
    var $skillsMarketWrap = $('#skillsMarketWrap');
    var $skillsMarketSelect = $('#skillsMarketSelect');
    var $skillsSearchInput = $('#skillsSearchInput');
    var $skillsSearchClear = $('#skillsSearchClear');
    var $skillsList = $('#skillsList');
    var $skillsLoading = $('#skillsLoading');
    var $skillsError = $('#skillsError');
    var $skillsStatus = $('#skillsStatus');
    var $skillsSearchBar = $('.skills-search-bar');

    // ==================== 状态 ====================

    var _installedSkillsCache = null;
    var _currentView = VIEW_INSTALLED;  // 当前视图：默认已安装
    var _currentMarketName = '';  // 当前选中的市场名称
    var _mountPoolsCache = null;  // SKILLS 类型挂载缓存 [{alias, path}, ...]
    var _currentQuery = null;     // 当前搜索关键词
    var _nextCursor = null;       // 下一页游标（后端返回）；null 表示从第一页加载
    var _pageLimit = 20;         // 每页条数
    var _hasMore = true;          // 是否还有更多数据
    var _isLoadingMore = false;   // 是否正在加载更多
    var _loadSeq = 0;             // 加载请求序号：仅最新一次请求的响应允许落地，防止旧响应污染新列表
    var _seenSlugs = {};          // 当前列表会话已渲染的 slug 集合：追加加载去重（部分市场 API 忽略 page 参数、恒返回首页）

    // ==================== 工具函数 ====================

    /** HTML 转义（与 app-settings.js 共享同一个闭包作用域不可用，自备一份） */
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ==================== 挂载预加载 ====================

    /** 加载 SKILLS 类型挂载列表（带缓存） */
    function loadMountPools(callback) {
        if (_mountPoolsCache) {
            callback(_mountPoolsCache);
            return;
        }
        $.ajax({
            url: '/web/settings/mounts',
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            var pools = (resp && resp.code === 200 && resp.data) ? resp.data : [];
            _mountPoolsCache = pools.filter(function (p) {
                return p.type === 'SKILLS' || !p.type;
            }).map(function (p) {
                return { alias: p.alias || '', path: p.path || '' };
            });
            if (!_mountPoolsCache.length) {
                _mountPoolsCache = [{ alias: '@skills', path: '' }];
            }
            callback(_mountPoolsCache);
        }).fail(function () {
            _mountPoolsCache = [{ alias: '@skills', path: '' }];
            callback(_mountPoolsCache);
        });
    }

    // ==================== 市场选择器初始化 ====================

    /**
     * 从后端加载可用市场列表并填充下拉框
     */
    function loadMarketOptions() {
        $.ajax({
            url: '/web/settings/skills/markets',
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            var markets = (resp && resp.data) ? resp.data : [];

            var html = '';
            markets.forEach(function (m) {
                var label = escapeHtml(m.name || '');
                html += '<option value="' + escapeAttr(m.name || '') + '">' + label + '</option>';
            });
            $skillsMarketSelect.html(html);

            // 默认选中第一个市场
            _currentMarketName = markets.length ? (markets[0].name || '') : '';
            $skillsMarketSelect.val(_currentMarketName);

            // 渲染 layui 表单
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        }).fail(function () {
            $skillsMarketSelect.html('<option value="">ClawHub</option>');
            _currentMarketName = '';

            // 渲染 layui 表单
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        });
    }


    // ==================== 已安装技能 ====================

    function getInstalledSkills(callback) {
        if (typeof commandList !== 'undefined' && commandList.length > 0) {
            if (!_installedSkillsCache) {
                _installedSkillsCache = {};
                commandList.forEach(function (item) {
                    if (item.type === 'skill') _installedSkillsCache[item.name] = true;
                });
            }
            callback(_installedSkillsCache);
            return;
        }
        $.get('/web/chat/hints', function (resp) {
            _installedSkillsCache = {};
            (resp.data || []).forEach(function (item) {
                if (item.type === 'skill') _installedSkillsCache[item.name] = true;
            });
            callback(_installedSkillsCache);
        }).fail(function () {
            _installedSkillsCache = {};
            callback(_installedSkillsCache);
        });
    }

    // ==================== 数据加载 ====================

    /**
     * 在列表末尾追加底部指示器（先移除已有指示器，避免残留在列表中间）
     * @param {'loading'|'error'|'end'} type - 加载动画 / 失败点击重试 / 已加载全部
     */
    function appendListFooter(type) {
        $('.skills-list-footer').remove();
        var html = '';
        if (type === 'loading') {
            html = '<div class="skills-list-footer loading">'
                + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'
                + '<span>' + GourdI18n.t('settings.skills.loading') + '</span>'
                + '</div>';
        } else if (type === 'error') {
            html = '<div class="skills-list-footer error">' + GourdI18n.t('settings.skills.load_failed_retry') + '</div>';
        } else if (type === 'end') {
            html = '<div class="skills-list-footer end">' + GourdI18n.t('settings.skills.no_more') + '</div>';
        }
        if (html) $skillsList.append(html);
    }

    /**
     * 加载技能列表
     * @param {string|null} query - 搜索关键词，null 时加载热门技能
     * @param {boolean} append  - 是否追加到现有列表（true=加载更多，false=重置）
     */
    function loadSkillsList(query, append) {
        var isAppend = append === true;

        // 已安装视图：本地数据，无分页，追加加载直接忽略
        if (_currentView === VIEW_INSTALLED) {
            if (!isAppend) {
                _loadSeq++;  // 使在途的市场请求失效，防止旧响应回来覆盖已安装列表
                _hasMore = false;
                $('.skills-list-footer').remove();
                loadInstalledSkills(query);
            }
            return;
        }

        if (!isAppend) {
            _nextCursor = null;
            _hasMore = true;
            _seenSlugs = {};  // 新列表会话，重置去重集合
            $skillsList.empty();  // 清空列表（含可能残留的底部指示器）
        }

        if (_isLoadingMore) return; // 防止重复请求
        _isLoadingMore = true;
        var mySeq = ++_loadSeq;     // 本次请求序号，回调内校验是否仍为最新

        if (isAppend) {
            // 追加加载：底部指示器切换为加载动画
            appendListFooter('loading');
        } else {
            $skillsStatus.show();
            $skillsLoading.css('display', 'flex');
            $skillsError.hide();
        }

        var url;
        var marketParam = _currentMarketName ? '&marketName=' + encodeURIComponent(_currentMarketName) : '';
        var cursorParam = (isAppend && _nextCursor) ? '&cursor=' + encodeURIComponent(_nextCursor) : '';
        if (query) {
            url = SKILLS_API_BASE + '?action=search&q=' + encodeURIComponent(query) + '&limit=' + _pageLimit + cursorParam + marketParam;
        } else {
            url = SKILLS_API_BASE + '?action=trending&limit=' + _pageLimit + cursorParam + marketParam;
        }

        $.ajax({
            url: url,
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        })
            .done(function (resp) {
                // 已有更新的请求发出（如用户切市场/搜索），旧响应直接丢弃，避免数据串列表
                if (mySeq !== _loadSeq) return;
                // 请求期间用户可能已切回已安装视图，市场响应不得覆盖已安装列表
                if (_currentView !== VIEW_MARKET) return;
                // 后端返回 Result 包装：{code:200, data:[...], description:""}
                // code !== 200 时为业务错误，展示后端返回的具体提示
                if (resp && resp.code !== undefined && resp.code !== 200) {
                    $skillsLoading.hide();
                    $('.skills-list-footer').remove();
                    var errMsg = (resp.description || GourdI18n.t('settings.save_failed') + GourdI18n.t('app.loading'));
                    $skillsError.text(errMsg).show();
                    if (isAppend) appendListFooter('error'); // 失败时显示点击重试
                    _isLoadingMore = false;
                    return;
                }

                var payload = resp;
                if (resp && resp.code !== undefined && resp.data !== undefined) {
                    payload = resp.data;
                }

                // 后端 Market 适配器统一返回 {items:[...], nextCursor:"..."}（cursor 游标分页）
                var skills = [];
                var nextCursor = null;
                if (payload && payload.items !== undefined) {
                    skills = Array.isArray(payload.items) ? payload.items : [];
                    nextCursor = payload.nextCursor || null;
                } else if (Array.isArray(payload)) {
                    // 兼容旧式数组返回（防御性兜底）：视为单页数据，不再翻页
                    skills = payload;
                    nextCursor = null;
                }

                // 是否还有更多：以后端返回的游标为准（clawhub 等市场会忽略 page 参数，不能再按返回条数推断）
                _hasMore = !!nextCursor && skills.length > 0;
                _nextCursor = nextCursor;

                // 客户端去重保护：skillhub.cn 的 search API 忽略 page/cursor 恒返回首页数据；
                // clawhub 不同作者可能存在同名 slug。追加加载时过滤已渲染条目（键=slug|ownerHandle），
                // 若全部重复则终止无限滚动，避免重复内容无限追加。
                if (isAppend) {
                    skills = skills.filter(function (s) {
                        var key = dedupeKey(s);
                        return !!key && !_seenSlugs[key];
                    });
                    if (skills.length === 0) {
                        _hasMore = false;
                        _nextCursor = null;
                    }
                }
                skills.forEach(function (s) {
                    _seenSlugs[dedupeKey(s)] = true;
                });

                getInstalledSkills(function (installedMap) {
                    // 异步回调期间可能已发起新请求，二次校验序号
                    if (mySeq !== _loadSeq) return;
                    try {
                        renderMarketSkillsList(skills, installedMap, isAppend);

                        // 移除"加载中"提示
                        $('.skills-list-footer').remove();
                        if (!isAppend) {
                            $skillsStatus.hide();
                            $skillsError.hide();  // 重置加载成功，清掉上次残留的错误横幅
                        }

                        // 底部指示器：还有数据→加载动画（等待触底自动加载）；否则→已加载全部
                        if (_hasMore) {
                            appendListFooter('loading');
                        } else if (isAppend) {
                            appendListFooter('end');
                        }
                    } finally {
                        _isLoadingMore = false;  // 无论渲染是否异常，必须释放锁
                    }
                    maybeAutoFill();
                });
            })
            .fail(function (jqXHR, textStatus) {
                if (mySeq !== _loadSeq) return;
                if (_currentView !== VIEW_MARKET) return;
                $('.skills-list-footer').remove();
                if (!isAppend) $skillsLoading.hide();
                if (isAppend) appendListFooter('error'); // 失败时显示点击重试
                var msg;
                if (textStatus === 'timeout') {
                    msg = GourdI18n.t('settings.network_error');
                } else if (jqXHR.status === 0) {
                    msg = GourdI18n.t('settings.network_error');
                } else if (jqXHR.status === 429) {
                    msg = GourdI18n.t('settings.operation_failed');
                } else if (jqXHR.status >= 500) {
                    msg = GourdI18n.t('settings.operation_failed') + '（HTTP ' + jqXHR.status + '）';
                } else {
                    msg = GourdI18n.t('settings.network_error') + '（HTTP ' + (jqXHR.status || '?') + '）';
                }
                $skillsError.text(msg).show();
                _isLoadingMore = false;
            });
    }

    // ==================== 渲染 ====================

    /** 去重键：slug + ownerHandle 组合（clawhub 不同作者可能存在同名 slug，仅按 slug 去重会误删） */
    function dedupeKey(s) {
        var slug = (s && (s.slug || s.name)) || '';
        var owner = (s && (s.ownerHandle || (s.owner && s.owner.handle))) || '';
        return slug ? (slug + '|' + owner) : '';
    }

    function renderMarketSkillsList(skills, installedMap, append) {
        if (!skills || skills.length === 0) {
            if (!append) {
                $skillsList.html(
                    '<div class="skill-empty-state">'
                    + '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5">'
                    + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
                    + '</svg>'
                    + '<div style="font-size:13px;margin-top:12px;">' + GourdI18n.t('common.no_data') + '</div>'
                    + '</div>'
                );
            }
            return;
        }

        var html = '';
        var tInstalled = GourdI18n.t('settings.skills.installed');
        var tInstall = GourdI18n.t('settings.skills.install');
        var tLoading = GourdI18n.t('settings.skills.loading');
        skills.forEach(function (skill) {
            var name = skill.slug || skill.name || '';
            var displayName = skill.displayName || name;
            var desc = skill.summary || skill.description || '';
            var owner = skill.ownerHandle || (skill.owner && skill.owner.handle) || '';

            var installs = skill.installs || (skill.stats && skill.stats.installsCurrent) || 0;
            var stars = skill.stars || (skill.stats && skill.stats.stars) || 0;
            var isInstalled = !!installedMap[name];
            var iconText = displayName ? displayName.substring(0, 2).toUpperCase() : 'SK';
            var shortDesc = desc && desc.length > 60 ? desc.substring(0, 60) + '...' : desc;

            var skillUrl = skill.url || '';

            html += '<div class="skill-item" data-url="' + escapeAttr(skillUrl) + '">'
                + '<div class="skill-item-icon">' + escapeHtml(iconText) + '</div>'
                + '<div class="skill-item-info">'
                + '<div class="skill-item-name" title="' + escapeAttr(name) + '">' + escapeHtml(displayName) + (isInstalled ? '<span class="skill-installed-badge">' + tInstalled + '</span>' : '') + '</div>'
                + (shortDesc ? '<div class="skill-item-desc" title="' + escapeAttr(desc) + '">' + escapeHtml(shortDesc) + '</div>' : '')
                + '<div class="skill-item-meta">'
                + (installs > 0 ? '<span>' + (installs >= 1000 ? (installs / 1000).toFixed(1) + 'k' : installs) + ' ' + tInstall + '</span>' : '')
                + (stars > 0 ? '<span>⭐ ' + (stars >= 1000 ? (stars / 1000).toFixed(1) + 'k' : stars) + '</span>' : '')
                + (owner ? '<span>' + escapeHtml(owner) + '</span>' : '')
                + (skillUrl ? '<span class="skill-item-detail-link" title="' + GourdI18n.t('settings.skills.detail') + '">↗</span>' : '')
                + '</div></div>'
                + '<div class="skill-item-actions">'
                + (isInstalled
                    ? ''
                    : '<div class="skill-install-wrap">'
                    +   '<button class="skill-install-btn" data-slug="' + escapeAttr(name) + '" data-display="' + escapeAttr(displayName) + '" data-market="' + escapeAttr(_currentMarketName) + '" title="' + tInstall + '"><svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>'
                    +   '<div class="skill-install-dropdown" data-slug="' + escapeAttr(name) + '" data-display="' + escapeAttr(displayName) + '" data-market="' + escapeAttr(_currentMarketName) + '">'
                    +     '<div class="skill-install-dropdown-loading">' + tLoading + '</div>'
                    +   '</div>'
                    + '</div>')
                + '</div></div>';
        });

        if (append) {
            $skillsList.append(html);
        } else {
            $skillsList.html(html);
        }
    }

    // ==================== 已安装视图 ====================

    /**
     * 加载并渲染已安装技能列表（本地数据，支持关键词过滤）
     * @param {string|null} query - 过滤关键词，null 时展示全部
     */
    function loadInstalledSkills(query) {
        $skillsStatus.show();
        $skillsLoading.css('display', 'flex');
        $skillsError.hide();

        $.ajax({
            url: '/web/settings/skills/installed',
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        })
        .done(function (resp) {
            // 请求期间用户可能已切回市场视图，旧响应不得覆盖市场列表
            if (_currentView !== VIEW_INSTALLED) return;
            if (resp && resp.code !== undefined && resp.code !== 200) {
                $skillsLoading.hide();
                $skillsError.text(resp.description || GourdI18n.t('settings.operation_failed')).show();
                return;
            }
            var skills = (resp && resp.data) ? resp.data : [];
            if (query) {
                var kw = query.toLowerCase();
                skills = skills.filter(function (s) {
                    return (s.name || '').toLowerCase().indexOf(kw) !== -1
                        || (s.description || '').toLowerCase().indexOf(kw) !== -1;
                });
            }
            try {
                renderInstalledSkillsList(skills);
            } finally {
                $skillsLoading.hide();
                $skillsStatus.hide();
            }
        })
        .fail(function () {
            if (_currentView !== VIEW_INSTALLED) return;
            $skillsLoading.hide();
            $skillsError.text(GourdI18n.t('settings.network_error')).show();
        });
    }

    /** 渲染已安装技能列表（含卸载按钮与所属挂载池标识） */
    function renderInstalledSkillsList(skills) {
        if (!skills || skills.length === 0) {
            $skillsList.html(
                '<div class="skill-empty-state">'
                + '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5">'
                + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
                + '</svg>'
                + '<div style="font-size:13px;margin-top:12px;">' + GourdI18n.t('common.no_data') + '</div>'
                + '</div>'
            );
            return;
        }

        var html = '';
        var tUninstall = GourdI18n.t('settings.skills.uninstall');
        skills.forEach(function (skill) {
            var name = skill.name || '';
            var desc = skill.description || '';
            var mountAlias = skill.mountAlias || '';
            var iconText = name ? name.substring(0, 2).toUpperCase() : 'SK';
            var shortDesc = desc.length > 60 ? desc.substring(0, 60) + '...' : desc;

            html += '<div class="skill-item skill-item-installed">'
                + '<div class="skill-item-icon">' + escapeHtml(iconText) + '</div>'
                + '<div class="skill-item-info">'
                + '<div class="skill-item-name" title="' + escapeAttr(name) + '">' + escapeHtml(name) + '</div>'
                + (shortDesc ? '<div class="skill-item-desc" title="' + escapeAttr(desc) + '">' + escapeHtml(shortDesc) + '</div>' : '')
                + (mountAlias ? '<div class="skill-item-meta"><span>' + escapeHtml(mountAlias) + '</span></div>' : '')
                + '</div>'
                + '<div class="skill-item-actions">'
                + '<button class="skill-uninstall-btn" data-name="' + escapeAttr(name) + '" data-mount="' + escapeAttr(mountAlias) + '" title="' + tUninstall + '">'
                + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
                + '</button>'
                + '</div></div>';
        });
        $skillsList.html(html);
    }

    // 点击卸载按钮 → 确认后删除本地技能目录
    $skillsList.on('click', '.skill-uninstall-btn', function (e) {
        e.stopPropagation();
        var $btn = $(this);
        var name = $btn.attr('data-name') || '';
        var alias = $btn.attr('data-mount') || '';

        layConfirm(GourdI18n.t('settings.skills.uninstall_confirm', [name]), function () {
            $btn.prop('disabled', true).addClass('removing');
            $.ajax({
                url: '/web/settings/mounts/skills/remove',
                method: 'POST',
                data: { alias: alias, skillName: name },
                timeout: 30000,
                dataType: 'json'
            })
            .done(function (resp) {
                var ok = resp && resp.code === 200;
                if (ok) {
                    _installedSkillsCache = null;
                    if (typeof loadCommands === 'function') loadCommands();
                    if (typeof window.showToast === 'function') {
                        window.showToast(GourdI18n.t('app.skills') + '「' + escapeHtml(name) + '」' + GourdI18n.t('settings.loop.deleted') + '！', 'success');
                    }
                    loadInstalledSkills(_currentQuery);
                } else {
                    $btn.prop('disabled', false).removeClass('removing');
                    if (typeof window.showToast === 'function') {
                        window.showToast((resp && resp.description) || GourdI18n.t('settings.operation_failed'), 'error');
                    }
                }
            })
            .fail(function () {
                $btn.prop('disabled', false).removeClass('removing');
                if (typeof window.showToast === 'function') {
                    window.showToast(GourdI18n.t('settings.operation_failed'), 'error');
                }
            });
        });
    });

    // ==================== 视图切换（已安装 / 技能市场） ====================

    /**
     * 切换"已安装"与"技能市场"视图
     * @param {string} view - VIEW_INSTALLED / VIEW_MARKET
     */
    function switchView(view) {
        if (view !== VIEW_INSTALLED && view !== VIEW_MARKET) return;
        if (_currentView === view) return;
        _currentView = view;

        // Tab 高亮
        $skillsViewTabs.find('.skills-view-tab').removeClass('active')
            .filter('[data-view="' + view + '"]').addClass('active');

        // 市场下拉仅在市场视图显示
        if (view === VIEW_MARKET) {
            $skillsMarketWrap.show();
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        } else {
            $skillsMarketWrap.hide();
        }

        // 重置搜索状态并加载对应视图列表
        _currentQuery = null;
        $skillsSearchInput.val('');
        $skillsSearchClear.hide();
        _nextCursor = null;
        _hasMore = true;
        _isLoadingMore = false;
        loadSkillsList(null, false);
    }

    // ==================== 事件绑定 ====================

    // 视图 Tab 切换
    $skillsViewTabs.on('click', '.skills-view-tab', function () {
        switchView($(this).attr('data-view'));
    });

    // 市场切换 - 同时支持原生和 layui 事件
    $skillsMarketSelect.on('change', function () {
        _currentMarketName = $(this).val() || '';
        _installedSkillsCache = null;
        _currentQuery = null;  // 市场切换后回到热门列表，避免触底时误用旧搜索词
        _nextCursor = null;
        _hasMore = true;
        loadSkillsList(null, false);
    });

    // layui 表单监听
    if (typeof layui !== 'undefined' && layui.form) {
        layui.form.on('select(skillsMarketSelect)', function (data) {
            _currentMarketName = data.value || '';
            _installedSkillsCache = null;
            _currentQuery = null;  // 市场切换后回到热门列表，避免触底时误用旧搜索词
            _nextCursor = null;
            _hasMore = true;
            loadSkillsList(null, false);
        });
    }

    // 下拉菜单延时关闭管理（防止鼠标在按钮和下拉之间移动时闪烁）
    var _dropdownCloseTimer = null;

    function openDropdown($wrap) {
        clearTimeout(_dropdownCloseTimer);
        var $dropdown = $wrap.find('.skill-install-dropdown');
        // 已有选项直接显示
        if ($dropdown.find('.skill-install-mount-option').length) {
            $dropdown.addClass('active');
            return;
        }
        loadMountPools(function (pools) {
            var html = '';
            pools.forEach(function (p) {
                html += '<div class="skill-install-mount-option" data-alias="' + escapeAttr(p.alias) + '">'
                    + escapeHtml(p.alias)
                    + '</div>';
            });
            $dropdown.html(html).addClass('active');
        });
    }

    function closeDropdown($wrap) {
        clearTimeout(_dropdownCloseTimer);
        _dropdownCloseTimer = setTimeout(function () {
            $wrap.find('.skill-install-dropdown').removeClass('active');
        }, 150);
    }

    // 鼠标进入按钮区域 → 打开下拉
    $skillsList.on('mouseenter', '.skill-install-wrap', function () {
        openDropdown($(this));
    });

    // 鼠标进入下拉菜单本身 → 取消关闭
    $skillsList.on('mouseenter', '.skill-install-dropdown', function () {
        clearTimeout(_dropdownCloseTimer);
    });

    // 鼠标离开整个 wrap 区域 → 延时关闭下拉
    $skillsList.on('mouseleave', '.skill-install-wrap', function () {
        closeDropdown($(this));
    });

    // 触屏设备降级：点击按钮切换下拉
    $skillsList.on('click', '.skill-install-btn:not(.installed)', function (e) {
        e.stopPropagation();
        var $wrap = $(this).closest('.skill-install-wrap');
        var $dropdown = $wrap.find('.skill-install-dropdown');
        // 关闭其他下拉
        $('.skill-install-dropdown').not($dropdown).removeClass('active');
        // 如果还没填充过选项，先填充
        if (!$dropdown.find('.skill-install-mount-option').length) {
            loadMountPools(function (pools) {
                var html = '';
                pools.forEach(function (p) {
                    html += '<div class="skill-install-mount-option" data-alias="' + escapeAttr(p.alias) + '">'
                        + escapeHtml(p.alias)
                        + '</div>';
                });
                $dropdown.html(html).toggleClass('active');
            });
        } else {
            $dropdown.toggleClass('active');
        }
    });

    // 点击挂载选项，执行安装
    $skillsList.on('click', '.skill-install-mount-option', function (e) {
        e.stopPropagation();
        var $option = $(this);
        var $dropdown = $option.closest('.skill-install-dropdown');
        var slug = $dropdown.attr('data-slug');
        var displayName = $dropdown.attr('data-display') || slug;
        var marketUrl = $dropdown.attr('data-market') || '';
        var mountAlias = $option.attr('data-alias');

        var $btn = $dropdown.closest('.skill-install-wrap').find('.skill-install-btn');

        // 开始安装
        $btn.addClass('installing').html('<svg class="skill-install-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>').prop('disabled', true);
        $dropdown.removeClass('active');

        var postData = { slug: slug, mountAlias: mountAlias };
        if (marketUrl) postData.marketName = marketUrl;

        $.ajax({
            url: '/web/settings/skills/install',
            method: 'POST',
            data: postData,
            timeout: 60000,
            dataType: 'json'
        })
        .done(function (resp) {
            var isSuccess = resp && resp.code === 200 && resp.data;
            if (isSuccess) {
                var skillName = (resp.data || slug) + '';
                var $item = $btn.closest('.skill-item');
                var $nameEl = $item.find('.skill-item-name');
                if (!$nameEl.find('.skill-installed-badge').length) {
                    $nameEl.append('<span class="skill-installed-badge">' + GourdI18n.t('settings.skills.installed') + '</span>');
                }
                $btn.closest('.skill-install-wrap').remove();
                if (!_installedSkillsCache) _installedSkillsCache = {};
                _installedSkillsCache[slug] = true;
                if (typeof loadCommands === 'function') loadCommands();
                if (typeof window.showToast === 'function') {
                    window.showToast(GourdI18n.t('app.skills') + '「' + escapeHtml(skillName) + '」' + GourdI18n.t('settings.loop.created') + '！', 'success');
                }
            } else {
                var msg = (resp && resp.description) ? resp.description : GourdI18n.t('settings.loop.create_failed') + '，' + GourdI18n.t('settings.skills.loading');
                $btn.removeClass('installing').html('<svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>').prop('disabled', false);
                if (typeof window.showToast === 'function') window.showToast(msg, 'error');
            }
        })
        .fail(function (jqXHR) {
            $btn.removeClass('installing').html('<svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>').prop('disabled', false);
            var msg = GourdI18n.t('settings.loop.create_failed') + '，' + GourdI18n.t('settings.skills.loading');
            try {
                var err = JSON.parse(jqXHR.responseText);
                if (err && err.description) msg = err.description;
                else if (err && err.data) msg = err.data;
            } catch (e) {
                if (jqXHR.status) msg = GourdI18n.t('settings.loop.create_failed') + ' (HTTP ' + jqXHR.status + ')';
            }
            if (typeof window.showToast === 'function') window.showToast(msg, 'error');
        });
    });

    // 点击页面其他区域关闭所有下拉
    $(document).on('click', function () {
        $('.skill-install-dropdown').removeClass('active');
    });

    // 点击技能行打开详情页（新窗口）
    $skillsList.on('click', '.skill-item', function () {
        var url = $(this).attr('data-url');
        if (url) {
            window.open(url, '_blank');
        }
    });

    // 搜索输入（按回车键搜索）
    $skillsSearchInput.on('input', function () {
        var val = $(this).val().trim();
        $skillsSearchClear.toggle(val.length > 0);
    }).on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var val = $(this).val().trim();
            _currentQuery = val || null;
            loadSkillsList(_currentQuery, false);
        }
    });

    // 清除搜索
    $skillsSearchClear.on('click', function () {
        $skillsSearchInput.val('').focus();
        $(this).hide();
        _currentQuery = null;
        loadSkillsList(null, false);
    });

    // 底部"加载失败，点击重试"（事件委托；失败不递增页码，重试仍请求原页）
    $skillsList.on('click', '.skills-list-footer.error', function (e) {
        e.stopPropagation();
        loadSkillsList(_currentQuery, true);
    });

    // ==================== 无限滚动：触底自动加载下一页 ====================

    /** 技能主视图当前是否可见（避免隐藏状态下误触发加载） */
    function isSkillsViewActive() {
        return $('#skillsView').hasClass('active');
    }

    /** 触发下一页加载（仅在还有数据、未在加载、视图可见时；下一页游标由 _nextCursor 承载） */
    function tryLoadNextPage() {
        if (!_hasMore || _isLoadingMore) return;
        if (!isSkillsViewActive()) return;
        loadSkillsList(_currentQuery, true);
    }

    // 滚动触底检测：滚动容器接近底部（阈值 120px）时自动加载下一页，rAF 节流
    var _scrollTick = false;
    $('#skillsScroll').on('scroll', function () {
        if (_scrollTick) return;
        _scrollTick = true;
        var el = this;
        requestAnimationFrame(function () {
            _scrollTick = false;
            if (!isSkillsViewActive()) return;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
                tryLoadNextPage();
            }
        });
    });

    /** 内容未撑满容器（无滚动条）时自动补载下一页，保证滚动触底可用 */
    function maybeAutoFill() {
        if (!_hasMore || _isLoadingMore) return;
        if (!isSkillsViewActive()) return;
        var body = document.querySelector('#skillsScroll');
        if (body && body.scrollHeight <= body.clientHeight + 4) {
            loadSkillsList(_currentQuery, true);
        }
    }

    // ==================== 视图入口 ====================

    /** 重置缓存并加载技能列表（进入视图时默认展示已安装） */
    function resetAndLoad() {
        _installedSkillsCache = null;
        _mountPoolsCache = null;
        _nextCursor = null;
        _currentQuery = null;
        _hasMore = true;
        _isLoadingMore = false;  // 重置加载锁，避免上次的锁残留导致无法重新加载
        // 进入时默认展示已安装视图
        _currentView = VIEW_INSTALLED;
        $skillsViewTabs.find('.skills-view-tab').removeClass('active')
            .filter('[data-view="' + VIEW_INSTALLED + '"]').addClass('active');
        $skillsMarketWrap.hide();
        $skillsSearchBar.show();
        $skillsList.show();
        loadMountPools(function () {});
        loadMarketOptions();
        loadSkillsList(null, false);
    }

    /** 打开技能视图（由左侧栏「技能」导航触发） */
    function openSkills() {
        // 与聊天/欢迎/自动化视图互斥：隐藏它们，显示本视图
        if (typeof window.exitCodeMode === 'function' && window.appMode === 'code') {
            window.exitCodeMode();
        }
        if (typeof window.closeAutomation === 'function') window.closeAutomation();
        if (typeof window.closeChannel === 'function') window.closeChannel();
        if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
        if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
        if (typeof window.closeUsage === 'function') window.closeUsage();
        $('#welcomeView').hide();
        $('#chatView').removeClass('active');
        $('#skillsView').addClass('active');
        $('.main-nav-item').removeClass('active');
        $('#skillsNavBtn').addClass('active');

        // 独立视图既不属于 chat 也不属于 welcome，必须让出 inChatMode（与 automation 一致），
        // 否则切回聊天时 #chatView 拿不回 .active（主区停留白屏）
        window.inChatMode = false;

        // 关掉可能打开的设置浮层（浮层为高 z-index 遮罩，会盖住本视图）
        if (typeof window.closeSettings === 'function') window.closeSettings();
        else if ($('#settingsOverlay').is(':visible')) $('#settingsCloseBtn').trigger('click');

        resetAndLoad();
    }

    /** 离开技能视图（切回聊天/欢迎/自动化时由对应切换函数调用） */
    function closeSkills() {
        $('#skillsView').removeClass('active');
        $('#skillsNavBtn').removeClass('active');
    }

    window.openSkills = openSkills;
    window.closeSkills = closeSkills;
    window.isSkillsOpen = function () { return $('#skillsView').hasClass('active'); };

    // 语言切换后重绘当前页（列表内容是动态渲染的，静态翻译无法覆盖）
    document.addEventListener('i18n:localeChanged', function () {
        if ($('#skillsView').hasClass('active')) {
            resetAndLoad();
        }
    });

})();