const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ═══════════════════════════════════════════════════════════════════════════
   工具名展示覆盖度契约。

   要守的缺陷（用户实测反馈「工具名称好像没处理」）：后端每注册一个工具，前端
   TOOL_I18N_KEY 就得有一条，否则该工具卡退化成显示裸英文名（resolveToolPresentation
   的 localized 兜底就是 bareToolName 本身）。而工具名散落在几十个 Java 文件的
   @ToolMapping 注解里，靠人工记忆必然漏——本主题两轮实测各漏一批：第一轮漏 16 个
   （skillread/memory_extract/await_tasks/ask_user/now/add_* 等），第二轮自审又发现 3 个
   被提取链本身隐着的 create_plan / update_plan_progress / revise_plan。

   【本测试真正难的部分不是断言，是“提取链要不要把某些注册看得见的”】只认
   name="..." 的提取器天生看不见「省略 name 回退方法名」的注册，于是覆盖断言对那
   类工具恒假绿：界面摆着裸英文名，测试全绿。所以提取器必须同时支持字面量 / 常量 /
   方法名回退三种写法，并用「提取器自检」用例 + 注册名下限断言守住提取链本身。

   所以本测试从 Java 源码反向穷举真实注册名来核对前端表，而不是把名单抄进测试——
   抄名单的测试只能证明「我抄的时候没漏」，新增工具照样漏。
   ═══════════════════════════════════════════════════════════════════════════ */

const moduleRoot = path.resolve(__dirname, '../../..');
const javaRoot = path.join(moduleRoot, 'src/main/java');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const localesDir = path.join(staticRoot, 'locales');

const presentation = require(path.join(staticRoot, 'js', 'app-tool-presentation.js'));

const LOCALES = fs.readdirSync(localesDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();

/* ── Java 侧 @ToolMapping 提取 ─────────────────────────────────────────── */

function walkJava(dir, acc) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walkJava(p, acc);
        else if (f.endsWith('.java')) acc.push(p);
    }
    return acc;
}

/* 代码区间表：只保留「非注释、非字面量」的 [start,end) 片段。
   为什么必须有：@ToolMapping 会原样出现在字符串里（MethodFunctionTool:80 的断言文案
   "@ToolMapping annotation is missing"）和注释里。旧版只认 name="..." 侥幸没炸；一旦加上
   「省略 name 则回退方法名」的规则，这类文本就会被解成假工具名混进注册集合，在报错里冒充漏配。 */
function codeSpans(text) {
    const spans = [];
    let i = 0, seg = 0;
    const flush = () => { if (i > seg) spans.push([seg, i]); };
    while (i < text.length) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            flush(); i += 2; while (i < text.length && text[i] !== '\n') i++; seg = i; continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            flush(); const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; seg = i; continue;
        }
        if (c === '"' && text.startsWith('"""', i)) {   // Java 15+ 文本块
            flush(); const e = text.indexOf('"""', i + 3); i = e < 0 ? text.length : e + 3; seg = i; continue;
        }
        if (c === '"' || c === "'") {
            flush(); const q = c; i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === q) { i++; break; }
                i++;
            }
            seg = i; continue;
        }
        i++;
    }
    flush();
    return spans;
}

function inCode(spans, pos) {
    for (const [a, b] of spans) { if (pos >= a && pos < b) return true; }
    return false;
}

/* 注解省略 name 时的回退：MethodFunctionTool 用 Utils.valueOr(mapping.name(), 方法名)，而
   ToolMapping.name() 的默认值是空串，所以真实注册名 == Java 方法名。PlanTalent 的三个工具
   （create_plan / update_plan_progress / revise_plan）正是这种写法；只认 name= 的旧提取器看不见
   它们，于是「每个注册工具都要有映射」这条断言对它们恒假绿——界面摆着裸英文名，测试却全绿。
   命中的方法声明必须落在代码区间内：注释里抄一行签名不该被当成注册点。 */
function methodFallback(text, spans, from) {
    const re = /\b(?:public|protected|private)\s+(?:static\s+|final\s+|synchronized\s+|default\s+)*[\w$<>,\[\]\.\?\s]+\s+([\w$]+)\s*\(/g;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text.slice(from, from + 500)))) {
        // 落在注释/字面量里的候选直接跳过，继续找下一个真方法声明：
        // 只判「第一个命中」会把被注释掉的旧签名当成注册名，返回 null 又会漏掉紧随其后的真工具
        if (inCode(spans, from + m.index)) return m[1];
    }
    return null;
}

/* 括号配平扫描。三条硬规则，缺一条就会有工具名在测试里隐身：
   1) 不能用 /@ToolMapping\(([^)]*)\)/：description 里含 ")" 与引号，非贪婪会提前截断，
      把注解后半段（含 name=）切掉，得出「提取不到」的假结果。
   2) 游标只按「注解文字末尾」推进（绝不能跳到括号处）：跳到括号会让紧随其后的真注解
      被整条跳过——上一版正是这样把三处防御互相掩盖成「删掉也全绿」。
   3) 括号必须紧邻注解名（只允许空白）：真注解一定是 @ToolMapping( 或 @ToolMapping 换行接
      方法签名，而字符串/注释里的文本后面跟的是别的内容。据此把假注解挡在门外。 */
function scanToolMapping(text) {
    const found = [];
    const spans = codeSpans(text);
    const AN = '@ToolMapping';
    const stringArgRe = /name\s*=\s*"([^"]+)"/;
    const constArgRe = /name\s*=\s*([A-Z_][A-Z0-9_]*)/;
    let i = 0;
    for (;;) {
        const at = text.indexOf(AN, i);
        if (at < 0) break;
        i = at + AN.length;                       // 规则 2：只推进过注解文字本身
        if (!inCode(spans, at)) continue;         // 注释/字面量里的假注解
        let k = i;
        while (k < text.length && /[ \t\r\n]/.test(text[k])) k++;
        if (text[k] !== '(') {                   // 无参注解：@ToolMapping 直接接方法签名
            const fb0 = methodFallback(text, spans, k);
            if (fb0) found.push({ kind: 'fallback', name: fb0 });
            continue;
        }
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let j = k; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc) { esc = false; continue; }
                if (c === '\\') { esc = true; continue; }
                if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end < 0) break;
        const body = text.slice(k + 1, end);
        const lit = stringArgRe.exec(body);
        if (lit) { found.push({ kind: 'literal', name: lit[1] }); continue; }
        const cst = constArgRe.exec(body);
        if (cst) { found.push({ kind: 'const', name: cst[1] }); continue; }
        const fb = methodFallback(text, spans, end + 1);
        if (fb) found.push({ kind: 'fallback', name: fb });
    }
    return found;
}

function collectJavaStrings(dir) {
    const consts = new Map();   // TOOL_AWAIT_TASKS -> "await_tasks"
    const registered = new Map(); // name -> 文件（用于失败时定位）
    for (const f of walkJava(dir, [])) {
        const t = fs.readFileSync(f, 'utf8');
        const re = /String\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(t))) consts.set(m[1], m[2]);
    }
    for (const f of walkJava(dir, [])) {
        const t = fs.readFileSync(f, 'utf8');
        for (const e of scanToolMapping(t)) {
            // literal/fallback 已是真名；const 要解引用（TOOL_AWAIT_TASKS -> await_tasks）
            const name = (e.kind === 'literal' || e.kind === 'fallback')
                ? e.name : consts.get(e.name);
            if (!name) continue;
            if (!registered.has(name)) registered.set(name, path.basename(f));
        }
    }
    return registered;
}

const registeredTools = collectJavaStrings(javaRoot);
/* ── 契约 1：每个注册工具都必须有本地化映射 ─────────────────────────────── */

test('每个 @ToolMapping 注册的工具名都必须在 TOOL_I18N_KEY 中有映射', () => {
    /* 下限必须咬住实测注册数（当前 42 个唯一名）而不是随手写个 30：提取链一旦整体
       失效（换目录、注解改写法、正则失配），registeredTools 会退化成空或极小，下面的
       missing 断言就因「待检查集合变小」而假绿。上限不能写死，否则新增工具得先改测试。 */
    assert.ok(registeredTools.size >= 40,
        `从 Java 只提取到 ${registeredTools.size} 个工具名，提取链本身失效了`
        + '（实测应有 40+）；此时下面的断言会假绿，必须先修提取');
    const missing = [...registeredTools.keys()]
        .filter(n => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n))
        .filter(n => !presentation.TOOL_I18N_KEY[n]);
    assert.deepEqual(missing, [],
        '以下工具已注册但前端无 i18n 映射，其工具卡会显示裸英文名：\n  '
        + missing.map(n => `${n} (${registeredTools.get(n)})`).join('\n  '));
});

/* ── 契约 2：映射表引用的每个 key 在 12 个语言包都存在 ─────────────────── */

test('TOOL_I18N_KEY 引用的每个 chat.tool_* 在全部语言包都存在', () => {
    const keys = [...new Set(Object.values(presentation.TOOL_I18N_KEY))];
    for (const loc of LOCALES) {
        const chat = JSON.parse(fs.readFileSync(path.join(localesDir, loc + '.json'), 'utf8')
            .replace(/^\uFEFF/, '')).chat;
        const missing = keys.filter(k => !(k.replace('chat.', '') in chat));
        assert.deepEqual(missing, [], `${loc}.json 缺少工具显示名：${missing.join(', ')}`);
    }
});

test('工具显示名不得留空串', () => {
    const keys = [...new Set(Object.values(presentation.TOOL_I18N_KEY))];
    for (const loc of LOCALES) {
        const chat = JSON.parse(fs.readFileSync(path.join(localesDir, loc + '.json'), 'utf8')).chat;
        for (const k of keys) {
            const v = chat[k.replace('chat.', '')];
            assert.ok(typeof v === 'string' && v.trim().length > 0, `${loc} 的 ${k} 为空`);
        }
    }
});

/* ── 契约 3：12 个语言包的 tool_* 键集合必须完全一致 ────────────────────── */

test('12 个语言包的 tool_* 键集合完全一致（防只补中英）', () => {
    const sets = {};
    for (const loc of LOCALES) {
        const chat = JSON.parse(fs.readFileSync(path.join(localesDir, loc + '.json'), 'utf8')).chat;
        sets[loc] = Object.keys(chat).filter(k => k.startsWith('tool_')).sort();
    }
    const ref = sets['zh-CN'];
    for (const loc of LOCALES) {
        assert.deepEqual(sets[loc], ref, `${loc} 与 zh-CN 的 tool_* 键集合不一致`);
    }
});

/* ── 契约 4：非中文语言包不得直接留中文 ─────────────────────────────────── */

/* 漏译检查：判据必须是「与 zh-CN 完全同字」而不是「含汉字」。
   首版用 /[\u4e00-\u9fff]/ 判汉字，把 ja 的 20 个正常译名（読み取り/書き込み/検索…）
   全报成未翻译——日文本就使用汉字，这个判据错在把书写系统当成了语言。 */
test('非中文语言包的工具显示名不得照抄中文原值（漏译）', () => {
    const zhLike = ['zh-CN', 'zh-TW'];
    const keys = [...new Set(Object.values(presentation.TOOL_I18N_KEY))];
    const zh = JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN.json'), 'utf8')).chat;
    for (const loc of LOCALES.filter(l => !zhLike.includes(l))) {
        const chat = JSON.parse(fs.readFileSync(path.join(localesDir, loc + '.json'), 'utf8')).chat;
        const bad = keys.filter(k => (chat[k.replace('chat.', '')] || '') === zh[k.replace('chat.', '')]);
        assert.deepEqual(bad, [], `${loc} 的 ${bad.join(', ')} 与 zh-CN 同字，疑为漏翻译`);
    }
});

/* ── 契约 5：未知名回退裸名（行为验证，非源码断言） ─────────────────────── */

test('未登记的工具名回退裸名而非空串（MCP/OpenAPI 动态工具）', () => {
    const model = presentation.resolveToolPresentation('mcp__github__list_issues', null, {
        nested: true, translate: () => 'SHOULD_NOT_BE_USED',
    });
    assert.equal(model.displayName, 'mcp__github__list_issues',
        '未知名必须原样可见；返回空串等于界面上什么都没有');
    assert.ok(model.icon && model.icon.indexOf('<svg') === 0, '未知名也必须拿到兜底图标');
});

test('已登记工具名在传入 translate 时返回译文', () => {
    const dict = { 'chat.tool_grep': '搜索' };
    const model = presentation.resolveToolPresentation('grep', null, {
        nested: true, translate: (k) => dict[k],
    });
    assert.equal(model.displayName, '搜索');
});

test('translate 返回 key 本身时视为缺译，回退裸名（防界面上出现 chat.tool_xxx）', () => {
    const model = presentation.resolveToolPresentation('grep', null, {
        nested: true, translate: (k) => k,
    });
    assert.equal(model.displayName, 'grep');
    assert.ok(model.displayName.indexOf('chat.') < 0, '界面绝不能出现 i18n key 串');
});

/* ── 契约 6：提取器自检（每处防御都要有能杀死它的样本） ───────────────────
   为什么这些样本必须存在：字面量剔除、方法名回退、无参注解守卫这三处防御，光看主断言全绿
   说明不了任何问题——变异验证（把任一处改成 no-op）显示测试照样全绿，即「防御代码无人守护」。
   所以下面每一条 negative/positive 都对应一处真实防御，删掉那处防御必然有断言变红。 */

test('提取器自检：字面量/常量/方法名回退三种写法都认得，且字符串与注释里的假注解不得混入', () => {
    const sample = [
        // 1) 字面量写法，且 description 里带右括号与引号（考验括号配平）
        '@ToolMapping(name = "real_one", description = "示例：含右括号 ) 与逗号，还有 name = \\\"decoy\\\"")',
        'public void holder() {}',
        // 2) 常量写法（跨行），description 里同样有假 name
        '@ToolMapping(',
        '        name = TOOL_CONST,',
        '        description = "多行描述，内含 name = \\\"another_fake\\\"" )',
        'public void constHolder() {}',
        // 3) 省略 name 的写法：注册名 == Java 方法名（PlanTalent 三个工具正是这种）
        '@ToolMapping(description = "初始化执行计划")',
        'public String create_plan(@Param(name = "steps") List<String> steps) { return ""; }',
        // 4) 无参注解 + 方法签名另起一行（同样是回退写法，不能漏）
        '@ToolMapping',
        'public String standalone_tool(@Param(name = "q") String q) { return ""; }',
        // 5) 字符串字面量里的假注解（MethodFunctionTool:80 的真实形态）
        'class K { static { Assert.notNull(m, "@ToolMapping annotation is missing"); } }',
        // 6) 注释里的假注解
        '// @ToolMapping(name = "doc_only") 仅为文档示例',
        '/* @ToolMapping(description = "块注释里的假注解") public String block_comment_tool() */',
        // 7) 注解合法在代码里，但它下面的方法签名整行被注释掉：回退时必须跳过，
        //    否则会把注释里的方法名当成注册名（这条专门守 methodFallback 内的 inCode 校验）
        '@ToolMapping(description = "注解在代码内")',
        '/* public String commented_out_tool() { return ""; } */',
        'public String after_comment_tool() { return ""; }',
    ].join('\n');
    /* 必须落在系统临时目录：往仓库/测试目录写 .java 会被本测试自身的真实穷举当成源码扫到
       而污染结果，还会在 git 里留下未跟踪垃圾（首版就踩了，已清）。 */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-gap-'));
    try {
        fs.writeFileSync(path.join(dir, 'Sample.java'), sample);
        fs.writeFileSync(path.join(dir, 'Holder.java'),
            'public class Holder {\n    public static final String TOOL_CONST = "const_tool";\n}\n');

        const entries = scanToolMapping(sample);
        const kinds = entries.map(e => e.kind).join(',');
        assert.ok(kinds.includes('literal') && kinds.includes('const') && kinds.includes('fallback'),
            '三种注册写法必须都能识别，实际只得到: ' + kinds);
        const names = entries.map(e => e.name);
        assert.ok(names.includes('real_one'), '字面量名必须取到（括号配平不能被 description 里的 ")" 骗）');
        assert.ok(names.includes('TOOL_CONST'), '常量名要留给解引用环节');
        assert.ok(names.includes('create_plan'),
            '注解省略 name 时必须回退到真实方法名，否则这类工具的漏配在测试里永远隐身');
        assert.ok(names.includes('standalone_tool'),
            '@ToolMapping 无括号直接接方法签名时也要回退到方法名');
        // 假注解绝不能用「解出方法名」的方式混进集合
        assert.ok(!names.includes('annotation') && !names.includes('missing'),
            '字符串字面量里的 @ToolMapping 不得当成注册点');
        assert.ok(!names.includes('doc_only') && !names.includes('block_comment_tool'),
            '行注释/块注释里的 @ToolMapping 不得当成注册点');

        const got = collectJavaStrings(dir);
        assert.ok(got.has('real_one'), '跳行的括号配平扫描必须取到字面量注册名');
        assert.ok(got.has('const_tool'), '常量形式的 name 必须被解引用成真实工具名');
        assert.ok(got.has('create_plan') && got.has('standalone_tool'),
            '方法名回退写法必须进入注册集合');
        assert.ok(!got.has('another_fake') && !got.has('decoy'),
            'description 文本里的 name = "..." 不得混入注册名集合');
        assert.ok(!names.includes('commented_out_tool') && !got.has('commented_out_tool'),
            '方法签名被注释掉时，不得把注释里的方法名当成注册名（守 methodFallback 的 inCode 校验）');
        assert.ok(names.includes('after_comment_tool') && got.has('after_comment_tool'),
            '注释掉的签名之后若紧跟真方法声明，回退必须取到真名（不能直接放弃返回 null）');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/* ── 契约 7：语义不同的注册名不得共用同一显示名 ───────────────────────
   本测试守的不只是「有没有名字」，还有「名字对不对」。后台子代理的进度心跳行
   （「· 制定计划」）唯一的价值就是告知用户此刻在做什么；把 update_plan_progress（推进）
   与 revise_plan（修订）也显示成「制定计划」，比裸英文名更有欺骗性——用户会以为子
   代理在反复开头，而实际在推进或返工。没有这条断言，把它们合回一个 key 测试照样全绿。 */
test('计划族三个动作必须有各自独立的显示 key 与译文', () => {
    const trio = ['create_plan', 'update_plan_progress', 'revise_plan'];
    const keys = trio.map(n => presentation.TOOL_I18N_KEY[n]);
    assert.ok(keys.every(Boolean), '三个计划工具都必须有映射: ' + JSON.stringify(keys));
    assert.equal(new Set(keys).size, 3,
        '制定/推进/修订是三种不同动作，共用 key 会让心跳行谎报进度: ' + JSON.stringify(keys));
    // 12 个语言包里三者的译文也必须互不相同（防某个语言偷懒复制同一串）
    for (const loc of LOCALES) {
        const chat = JSON.parse(fs.readFileSync(path.join(localesDir, loc + '.json'), 'utf8')
            .replace(/^\uFEFF/, '')).chat;
        const labels = keys.map(k => chat[k.replace('chat.', '')]);
        assert.equal(new Set(labels).size, 3,
            loc + ' 的计划族三个显示名彼此相同（' + labels.join('/') + '），心跳行将无法区分动作');
    }
});