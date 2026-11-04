/* 语言包一致性契约（12 份 locale 的键集必须完全相同，且界面引用得到的键必须齐备）
 *
 * 缺陷机制（2026-11-04 实测；GitHub Actions run 41753013669 的「UI 完整性门禁」
 * 就是红在这一条上，导致 build / kernel-assets / release 三条腿全部 skipped）：
 * gourd-work/desktop/ui/locales/zh-CN.json 与其它 11 份漂移了 20 个键 ——
 *   - 多出 14 个**孤儿键**（settings.general.ui.*、settings.general.features.*、
 *     remote.runtime_pkg_*）。这些开关在 Rust 内核里根本不存在（config/mod.rs 中
 *     subagent / simplified / openapi / lsp / mcp_enabled 全部零命中），settings.html
 *     也没有对应卡片，app-remote.js 早就不再引用 runtimePkg。它们是 Java 版时代的残留，
 *     清理时只动了另外 11 份、zh-CN 被漏掉。
 *   - 少了 6 个**活键**（settings.general.skills.*）。卡片在 settings.html 里真实存在，
 *     app-settings-general.js 绑定 #generalSkillListingBudgetFraction /
 *     #generalSkillListingMaxDescChars，Rust 内核也确实有 skill_listing_budget_fraction。
 *
 * 少的那 6 个是**用户可见缺陷**，不只是 CI 红灯：app-i18n.js 的 getMessage 在键缺失时
 * 返回键名本身（`return typeof val === 'string' ? val : key`），translateDOM 又用这个
 * 返回值覆盖 HTML 里的中文兜底文案。结果中文界面在「技能清单预算」卡片上显示
 * `settings.general.skills.title` 这种裸键，而不是「技能清单预算」。
 *
 * 为什么原有的 CI 断言没提前发现：它比较的是**叶子键的数量**。1244 vs 1236 只是数字差，
 * 而「删一个又加一个」这类键数相等的漂移照样放行。本测试比较**键集本身**，并校验
 * 「界面真的引用得到的键必须在每份语言包都存在」——后者直接对应界面会不会出裸键。
 *
 * ── 引用扫描的口径（review 时逐条实测过，见下）──────────────────────
 * 只扫我们自己写的源（ui/*.html + ui/js/*.js 非压缩文件）。vendored 库
 * （layui / monaco / highlight / *.min.js）自带完全独立的 i18n 命名空间
 * （layer.cancel、laydate.months、table.noData…），误扫会报 103 条假阳性。
 * 引用形态分四类，缺一类就是漏检：
 *   1) 字面量直引：data-i18n* 属性、t('a.b')、i18n('a.b')；
 *   2) 行内字面量：t( 调用的**同一行**上出现的点分字面量（三元/条件参数，如
 *      `t(detailOpen ? 'chat.question_detail_collapse' : 'chat.question_detail_expand')`）；
 *   3) 拼接：t('前缀' + x)。正则只能抓到前缀，必须登记后缀清单逐个校验；
 *      前缀出现在源码却未登记 → 判红，逼后来人补全而不是静默放过；
 *   4) 间接：键藏在常量表里再经变量传给 t()（STATUS_MESSAGE_KEYS、
 *      FETCH_REASON_KEYS、QUESTION_SUBMIT_MODE_KEYS、data-i18n-hitl 取值）。
 *      这类静态扫描看不见调用点，只能登记完整键。
 * 登记为「可选」的族（app.welcome_greeting.0~19）例外：app-bootstrap.js:170 的
 * 消费方**刻意**容忍缺失（`v.indexOf('app.welcome_greeting') !== 0` 才采纳），
 * 12 份语言包目前都没有它，属一致的可选文案；对它只校验「要么 12 份都有、要么都没有」。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui');
const LOCALE_DIR = path.join(UI, 'locales');
const KEY_RX = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;

const readLocale = file => JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, file), 'utf8'));

function flatKeys(obj, pre = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object') out.push(...flatKeys(v, key));
    else out.push(key);
  }
  return out;
}

const localeFiles = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json')).sort();
const keySets = new Map(localeFiles.map(f => [f, new Set(flatKeys(readLocale(f)))]));

// ── 我们自己写的源文件（排除 vendored 与压缩产物）──────────────────
function appSources() {
  const out = [];
  for (const e of fs.readdirSync(UI, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.html')) out.push(path.join(UI, e.name));
  }
  const jsDir = path.join(UI, 'js');
  for (const e of fs.readdirSync(jsDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.min.js')) out.push(path.join(jsDir, e.name));
  }
  return out;
}

const REF_PATTERNS = [
  /data-i18n="([^"]+)"/g,
  /data-i18n-(?:placeholder|title|alt|content|aria-label)="([^"]+)"/g,
  /\bi18n\(\s*'([^']+)'/g,
  /\bt\(\s*'([^']+)'/g,
  /\bt\(\s*"([^"]+)"/g,
];
// 行内字面量：只在该行确实出现 t(/i18n( 调用时，才把行上所有点分字面量当候选键。
// 全行扫描会把 CSS 类名、版本号等点分串当键（实测噪声 10 条里 9 条是真键、1 条是
// `12.01` 这种数字串），所以限定「调用行」+ 排除全数字段。
const CALL_RX = /\b(?:t|i18n)\s*\(/;
const LINE_LITERAL_RX = /'([A-Za-z0-9_.]+)'|"([A-Za-z0-9_.]+)"/g;
const allNumericSegments = k => k.split('.').every(seg => /^\d+$/.test(seg));

// ── 拼接族：前缀 → 全部后缀（必须登记完整，漏登记=漏检）────────────
const CONCAT_FAMILIES = {
  'settings.loop.weekday_': [1, 2, 3, 4, 5, 6, 7],                       // app-automation.js 星期按钮
  'history.thinking.': ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
    .flatMap(c => [c + '.label', c + '.desc']),                          // app-history.js / model-selector.js 思考档位
  'chat.': ['need_auth', 'rejected'],                                    // data-i18n-hitl 取值（app-message.js:4589）
  'settings.providers.': [                                              // FETCH_REASON_KEYS（app-model-settings.js）
    'fetch_invalid_url', 'fetch_not_supported', 'fetch_auth_failed', 'fetch_rate_limited',
    'fetch_upstream_error', 'fetch_bad_status', 'fetch_connect_timeout', 'fetch_read_timeout',
    'fetch_timeout', 'fetch_dns_failed', 'fetch_connect_refused', 'fetch_tls_error',
    'fetch_network_error', 'fetch_invalid_response', 'fetch_unknown',
  ],
  'file_changes.': [                                                    // app-file-changes.js 的 t() 包装器实参 + STATUS_MESSAGE_KEYS
    'collapse_files', 'confirm_reapply_run', 'confirm_undo_file', 'confirm_undo_run',
    'conflict', 'edited_files', 'error_conflict', 'error_detail', 'open', 'operation_failed',
    'possibly_incomplete_detail', 'reapply_run', 'review', 'show_more_files',
    'undo_file', 'undo_run', 'undone',
    'error_not_found', 'error_invalid_request', 'error_partial', 'error_compensated', 'error_generic',
  ],
};
// 可选族：消费方刻意容忍缺失，只校验跨语言包的一致性（全有或全无）
const OPTIONAL_FAMILIES = {
  'app.welcome_greeting.': Array.from({ length: 20 }, (_, i) => String(i)), // app-bootstrap.js:169-170
};

// ── 间接引用：键藏在常量表里、经变量传给 t()，静态看不见调用点 ──────
const INDIRECT_KEYS = [
  'chat.question_skip', 'chat.question_next', 'chat.question_submit',   // QUESTION_SUBMIT_MODE_KEYS
];

function collectRefs() {
  const literal = new Map(); // key -> 文件:行号
  const concatSeen = new Set(); // 源码里实际出现的拼接前缀
  for (const file of appSources()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = path.basename(file) + ':' + (i + 1);
      for (const rx of REF_PATTERNS) {
        for (const m of line.matchAll(rx)) {
          const raw = m[1];
          if (isRegisteredPrefix(raw)) { concatSeen.add(raw); continue; }
          if (!KEY_RX.test(raw)) continue;
          if (!literal.has(raw)) literal.set(raw, where);
        }
      }
      if (CALL_RX.test(line)) {
        for (const m of line.matchAll(LINE_LITERAL_RX)) {
          const raw = m[1] !== undefined ? m[1] : m[2];
          if (isRegisteredPrefix(raw)) { concatSeen.add(raw); continue; }
          if (!KEY_RX.test(raw) || allNumericSegments(raw)) continue;
          if (!literal.has(raw)) literal.set(raw, where);
        }
      }
      for (const prefix of allPrefixes()) {
        if (line.includes("'" + prefix + "' +") || line.includes('"' + prefix + '" +')) concatSeen.add(prefix);
      }
    });
  }
  return { literal, concatSeen };
}
const allPrefixes = () => [...Object.keys(CONCAT_FAMILIES), ...Object.keys(OPTIONAL_FAMILIES)];
const isRegisteredPrefix = raw => allPrefixes().includes(raw);

const refs = collectRefs();

// ── 断言 ──────────────────────────────────────────────────────────

test('语言包必须是 12 份（少一份界面就少一门语言）', () => {
  assert.strictEqual(localeFiles.length, 12, '实际: ' + localeFiles.join(','));
});

test('12 份语言包的键集必须完全一致（不是仅键数一致）', () => {
  const base = keySets.get('en.json');
  const problems = [];
  for (const file of localeFiles) {
    if (file === 'en.json') continue;
    const set = keySets.get(file);
    const missing = [...base].filter(k => !set.has(k));
    const extra = [...set].filter(k => !base.has(k));
    if (missing.length === 0 && extra.length === 0) continue;
    let msg = file + ' 缺 ' + missing.length + ' 键';
    if (missing.length) msg += ' [' + missing.join(', ') + ']';
    msg += '，多 ' + extra.length + ' 键';
    if (extra.length) msg += ' [' + extra.join(', ') + ']';
    problems.push(msg);
  }
  // 失败信息直接列出漂移的具体键名：只有计数就得手动 diff 两份 JSON，
  // 而这条测试存在的全部价值就是省掉那一步。
  assert.deepStrictEqual(problems, [], '\n语言包键集漂移:\n  ' + problems.join('\n  '));
});

test('每份语言包无重复键、无空路径段', () => {
  for (const file of localeFiles) {
    const keys = flatKeys(readLocale(file));
    assert.strictEqual(new Set(keys).size, keys.length, file + ' 存在重复键');
    for (const k of keys) assert.ok(k.split('.').every(seg => seg.length > 0), file + ' 有空路径段: ' + k);
  }
});

test('界面引用得到的每个字面量键必须在全部 12 份语言包存在（否则显示裸键）', () => {
  // 护栏自身也要被钉住：扫描范围一旦被改坏，引用数会暴跌，此时「全部命中」是假绿灯。
  assert.ok(refs.literal.size > 500, '引用键扫描异常（仅 ' + refs.literal.size + ' 个），扫描范围可能被改坏');
  const bad = [];
  for (const [key, where] of refs.literal) {
    const absent = localeFiles.filter(f => !keySets.get(f).has(key));
    if (absent.length) bad.push(key + '  (' + where + ')  缺于 ' + absent.join(','));
  }
  assert.deepStrictEqual(bad, [], '\n以下界面引用键在语言包中不存在:\n  ' + bad.join('\n  '));
});

test('拼接族前缀必须全部登记（新增 t(\'x.\' + y) 要同步补后缀清单）', () => {
  const unregistered = [...refs.concatSeen].filter(p => !allPrefixes().includes(p));
  assert.deepStrictEqual(unregistered, [], '未登记的拼接前缀: ' + unregistered.join(', '));
  // 反向也钉：登记了却不再被源码使用的前缀是死登记，会让清单与实现脱节
  const unused = allPrefixes().filter(p => !refs.concatSeen.has(p));
  assert.deepStrictEqual(unused, [], '登记了但源码已不使用的拼接前缀: ' + unused.join(', '));
});

test('拼接族的全部后缀必须在每份语言包存在', () => {
  const bad = [];
  for (const prefix of Object.keys(CONCAT_FAMILIES)) {
    for (const suffix of CONCAT_FAMILIES[prefix]) {
      const key = prefix + suffix;
      const absent = localeFiles.filter(f => !keySets.get(f).has(key));
      if (absent.length) bad.push(key + ' 缺于 ' + absent.join(','));
    }
  }
  assert.deepStrictEqual(bad, [], '\n拼接键缺失:\n  ' + bad.join('\n  '));
});

test('可选族必须跨语言包一致（全有或全无，半有就是漂移）', () => {
  const bad = [];
  for (const prefix of Object.keys(OPTIONAL_FAMILIES)) {
    for (const suffix of OPTIONAL_FAMILIES[prefix]) {
      const key = prefix + suffix;
      const present = localeFiles.filter(f => keySets.get(f).has(key));
      if (present.length !== 0 && present.length !== localeFiles.length) {
        bad.push(key + ' 只存在于 ' + present.length + '/' + localeFiles.length + ' 份');
      }
    }
  }
  assert.deepStrictEqual(bad, [], '\n可选文案半有半无:\n  ' + bad.join('\n  '));
});

test('间接引用键（常量表经变量传给 t）必须在每份语言包存在', () => {
  const bad = INDIRECT_KEYS.filter(k => localeFiles.some(f => !keySets.get(f).has(k)));
  assert.deepStrictEqual(bad, [], '间接引用键缺失: ' + bad.join(', '));
});

test('已删除的孤儿键不得复活（对应功能在 Rust 内核不存在）', () => {
  // 回归钉：2026-11-04 那次 zh-CN 残留的正是这批键。留在包里，一旦有人新增同名卡片
  // 就会被静默启用一个后端并不存在的开关。
  const forbidden = [
    'remote.runtime_pkg_label', 'remote.runtime_pkg_hint',
    'settings.general.ui.title', 'settings.general.ui.simplified_name', 'settings.general.ui.simplified_desc',
    'settings.general.features.title', 'settings.general.features.subagent_name', 'settings.general.features.subagent_desc',
    'settings.general.features.mcp_name', 'settings.general.features.mcp_desc',
    'settings.general.features.openapi_name', 'settings.general.features.openapi_desc',
    'settings.general.features.lsp_name', 'settings.general.features.lsp_desc',
  ];
  const alive = forbidden.filter(k => localeFiles.some(f => keySets.get(f).has(k)));
  assert.deepStrictEqual(alive, [], '孤儿键复活: ' + alive.join(', '));
});

test('中文/英文界面功能键齐全（技能清单预算卡片）', () => {
  for (const file of ['zh-CN.json', 'zh-TW.json', 'en.json']) {
    const set = keySets.get(file);
    for (const k of ['title', 'budget_fraction', 'budget_fraction_placeholder', 'max_desc_chars', 'max_desc_chars_placeholder', 'hint']) {
      assert.ok(set.has('settings.general.skills.' + k), file + ' 缺 settings.general.skills.' + k);
    }
  }
  assert.match(readLocale('zh-CN.json').settings.general.skills.title, /技能/, 'zh-CN 技能卡片标题应为中文');
});

test('语言包不得含 BOM（fetch().json() 会因 BOM 解析失败）', () => {
  for (const file of localeFiles) {
    const buf = fs.readFileSync(path.join(LOCALE_DIR, file));
    assert.notStrictEqual(buf[0], 0xef, file + ' 含 UTF-8 BOM');
    assert.doesNotThrow(() => JSON.parse(buf.toString('utf8')), file + ' JSON 非法');
  }
});
