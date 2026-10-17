package com.gourdai.core.portal.web;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.PermissionGroupDo;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.hitl.BashPathGuard;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * settings.json → 引擎 → bash 审批策略 的<b>装配契约</b>。
 *
 * <h3>为什么这一层必须单独测</h3>
 *
 * <p>{@code BashWriteExemptionTest} 直接 {@code new HitlStrategy(dirs)}，
 * {@code BashExemptDirsEngineWiringTest} 用 {@code Builder.bashExemptDirsAdd(dirs)}——
 * 两者都绕过了真实生产链路的<b>最后一环</b>：{@code Configurator} 从 settings 读出来再交给 Builder。</p>
 *
 * <p>实测证据（变异 M16）：把 {@code Configurator} 里那行
 * {@code .bashExemptDirsAdd(settings.getPermission().getBashExemptDirs())} 整行删掉，
 * 上述 53 例<b>全绿</b>。而生产环境走的正是 Configurator 这条路——用户在 settings.json 里
 * 配好豁免目录，值却永远到不了引擎，表现为「配了但还是弹审批」。
 * 这类「编译通过、测试全绿、生产永不生效」是本仓反复出现的失效形态，只能靠锁装配点本身来防。</p>
 *
 * <p>{@code WebSettingsController.permissionSave} 的部分提交语义同理（变异 M17）：
 * 前端只改工具黑名单时不会带 {@code bashExemptDirs} 键，若后端无条件更新，
 * 就会把用户已配的豁免目录静默清空——界面上毫无异常，用户只会觉得「配置自己丢了」。</p>
 */
class BashExemptDirsSettingsWiringTest {

    @TempDir
    Path temp;

    private HarnessEngine newEngine() {
        return HarnessEngine.of(temp.resolve("ws").toString(), temp.resolve("home").toString())
                .sessionProvider(com.gourdai.agent.session.InMemoryAgentSession::of)
                .build();
    }

    private static String readSource(Class<?> clazz) {
        // surefire 的工作目录可能是仓库根或模块目录，两种都要兼容
        String rel = "src/main/java/" + clazz.getName().replace('.', '/') + ".java";
        Path p = Paths.get(rel);
        if (!Files.exists(p)) {
            p = Paths.get("..").resolve(rel).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "找不到源文件：" + p.toAbsolutePath());
        try {
            return Files.readString(p);
        } catch (Exception e) {
            throw new AssertionError("读取源文件失败：" + p, e);
        }
    }

    /**
     * 剥掉注释与字符串字面量，避免「只在注释里提到」被当成正向断言的假绿，
     * 也避免注释里出现的旧写法触发反向断言的误报。
     *
     * <p>状态机必须同时处理文本块（{@code """}）、字符串、字符字面量与两种注释：
     * 否则字符串里的 {@code //} 会被当成行注释，从此处起把整个文件正文吃掉。</p>
     */
    private static String stripCommentsAndLiterals(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);

            if (c == '"' && src.startsWith("\"\"\"", i)) {          // 文本块
                int end = src.indexOf("\"\"\"", i + 3);
                i = end < 0 ? n : end + 3;
                continue;
            }
            if (c == '"') {                                        // 字符串
                i++;
                while (i < n && src.charAt(i) != '"') {
                    i += src.charAt(i) == '\\' ? 2 : 1;
                }
                i++;
                continue;
            }
            if (c == '\'') {                                       // 字符字面量
                i++;
                while (i < n && src.charAt(i) != '\'') {
                    i += src.charAt(i) == '\\' ? 2 : 1;
                }
                i++;
                continue;
            }
            if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {   // 行注释
                while (i < n && src.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {   // 块注释
                int end = src.indexOf("*/", i + 2);
                i = end < 0 ? n : end + 2;
                continue;
            }
            out.append(c);
            i++;
        }
        return out.toString();
    }

    // ==========================================================================
    // 1. Configurator：settings → Builder 的装配（变异 M16 的缺口）
    // ==========================================================================

    /**
     * {@code Configurator} 必须把 settings 里的豁免目录交给 Builder。
     *
     * <p>用源码扫描而非真跑 Configurator：那需要构造完整的 Solon 应用上下文与 settings.json 落盘，
     * 成本与脆弱度都过高。扫描的口径刻意收紧为「同一个 builder 链里同时出现
     * {@code bashExemptDirsAdd} 与 {@code getBashExemptDirs()}」——
     * 只断言方法名存在是不够的：调用了但传的是别的值（例如空列表）同样等于没接。</p>
     */
    @Test
    void configuratorFeedsSettingsExemptDirsIntoBuilder() {
        String body = stripCommentsAndLiterals(readSource(com.gourdai.Configurator.class));

        Assertions.assertTrue(body.contains("bashExemptDirsAdd("),
                "Configurator 必须调用 Builder.bashExemptDirsAdd，否则 settings 里的豁免目录到不了引擎");
        Assertions.assertTrue(body.contains("getBashExemptDirs()"),
                "Configurator 必须从 settings.getPermission() 读取豁免目录，而不是传死值");

        // 关键：两者必须在同一处装配（同一 builder 链上），否则可能是两个互不相干的调用
        Matcher m = Pattern.compile(
                "\\.bashExemptDirsAdd\\(\\s*settings\\.getPermission\\(\\)\\.getBashExemptDirs\\(\\)\\s*\\)")
                .matcher(body);
        Assertions.assertTrue(m.find(),
                "必须把 settings.getPermission().getBashExemptDirs() 直接喂给 bashExemptDirsAdd；"
                        + "拆开写或传中间变量会让这条契约失去意义");

        // 与既有的 tools/disallowedTools 装配同处一个链：确认它是常规装配项而非孤立调用
        Assertions.assertTrue(body.contains(".disallowedToolsAdd(settings.getPermission().getDisallowedTools())"),
                "既有的 disallowedTools 装配点必须仍在（对照：证明扫描确实落在同一 builder 链上）");
    }

    /**
     * Builder 那一项必须真的写进 options，且引擎装配时读的是同一份。
     *
     * <p>这条与上一条互补：上一条锁「Configurator 调了 Builder」，本条锁「Builder → options → 策略」
     * 这一段不断。合起来才覆盖 settings.json 到审批判定的完整路径。</p>
     */
    @Test
    void builderValueReachesTheAssembledStrategy() {
        Path dir = temp.resolve("from-builder");
        HarnessEngine engine = HarnessEngine
                .of(temp.resolve("ws").toString(), temp.resolve("home").toString())
                .sessionProvider(com.gourdai.agent.session.InMemoryAgentSession::of)
                .bashExemptDirsAdd(List.of(dir.toString()))
                .build();

        Assertions.assertEquals(List.of(dir.toString()), engine.getBashExemptDirs(),
                "Builder 传入的豁免目录必须落到 options 并可回显");
        Assertions.assertNotNull(engine.getHitlInterceptor(),
                "引擎必须装配出 HITL 拦截器（豁免配置的最终消费者）");
    }

    // ==========================================================================
    // 2. permissionSave 的部分提交语义（变异 M17 的缺口）
    // ==========================================================================

    @Test
    void saveWithoutTheKeyPreservesExistingExemptDirs() throws Exception {
        HarnessEngine engine = newEngine();
        AgentSettings settings = new AgentSettings();
        WebSettingsController controller = new WebSettingsController(engine, settings, null);

        Path kept = temp.resolve("kept-dir");
        Files.createDirectories(kept);
        settings.getPermission().getBashExemptDirs().add(kept.toString());
        engine.bashExemptDirsReset(List.of(kept.toString()));

        // 前端只改工具黑名单：请求体里根本没有 bashExemptDirs 这个键
        controller.permissionSave("{\"tools\":[\"**\"],\"disallowedTools\":[\"webfetch\"]}");

        Assertions.assertEquals(List.of(kept.toString()),
                        settings.getPermission().getBashExemptDirs(),
                "不带该键的保存必须保留已配置的豁免目录，否则用户改一次工具开关就会丢掉豁免配置");
        Assertions.assertEquals(List.of(kept.toString()), engine.getBashExemptDirs(),
                "引擎侧同样必须保留");
        Assertions.assertTrue(settings.getPermission().getDisallowedTools().contains("webfetch"),
                "对照组：工具黑名单本次提交必须照常生效");
    }

    @Test
    void saveWithEmptyArrayReallyClearsThem() throws Exception {
        HarnessEngine engine = newEngine();
        AgentSettings settings = new AgentSettings();
        WebSettingsController controller = new WebSettingsController(engine, settings, null);

        Path gone = temp.resolve("gone-dir");
        Files.createDirectories(gone);
        settings.getPermission().getBashExemptDirs().add(gone.toString());
        engine.bashExemptDirsReset(List.of(gone.toString()));

        // 用户在设置页删光所有行后保存：必须带上空数组，且必须真的删掉
        controller.permissionSave("{\"tools\":[\"**\"],\"disallowedTools\":[],\"bashExemptDirs\":[]}");

        Assertions.assertTrue(settings.getPermission().getBashExemptDirs().isEmpty(),
                "显式提交空数组必须清空配置（否则用户无法删除已有豁免）");
        Assertions.assertTrue(engine.getBashExemptDirs().isEmpty(), "引擎侧必须同步清空");
    }

    @Test
    void savePersistsAndNormalizesEntries() throws Exception {
        HarnessEngine engine = newEngine();
        AgentSettings settings = new AgentSettings();
        WebSettingsController controller = new WebSettingsController(engine, settings, null);

        Path dir = temp.resolve("saved-dir");
        Files.createDirectories(dir);

        // 带空格、重复项、空串：后端应与前端一样归一，避免脏值进 settings.json
        String body = "{\"tools\":[\"**\"],\"disallowedTools\":[],\"bashExemptDirs\":"
                + "[\"  " + escape(dir.toString()) + "  \",\"" + escape(dir.toString()) + "\",\"\"]}";
        controller.permissionSave(body);

        Assertions.assertEquals(List.of(dir.toString()), settings.getPermission().getBashExemptDirs(),
                "重复与空白条目应被归一（否则 settings.json 里会存进重复行）");
        Assertions.assertEquals(List.of(dir.toString()), engine.getBashExemptDirs(),
                "保存后必须热更新到引擎，无需重启");
    }

    @Test
    void nonArrayOrMissingFieldIsIgnoredWithoutError() throws Exception {
        HarnessEngine engine = newEngine();
        AgentSettings settings = new AgentSettings();
        WebSettingsController controller = new WebSettingsController(engine, settings, null);

        Path kept = temp.resolve("kept2");
        Files.createDirectories(kept);
        settings.getPermission().getBashExemptDirs().add(kept.toString());

        // 脏输入：类型不对。必须忽略而不是抛 500，也不得清空既有配置
        Assertions.assertDoesNotThrow(() ->
                controller.permissionSave("{\"disallowedTools\":[],\"bashExemptDirs\":\"not-an-array\"}"));
        Assertions.assertEquals(List.of(kept.toString()), settings.getPermission().getBashExemptDirs(),
                "类型不符时必须原样保留，不得清空");
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // ==========================================================================
    // 3. settings 实体的持久化契约
    // ==========================================================================

    /**
     * 字段必须能被 JSON 序列化读写（settings.json 的存与取都依赖它）。
     *
     * <p>这条针对变异 M18 那类改动：把字段改成 {@code transient} 或删掉 getter，
     * 都会让配置无法落盘 / 无法回显。用行为断言（读写往返）而不是断言注解形态，
     * 因为 Lombok 生成的 getter 形态不该成为契约。</p>
     */
    @Test
    void exemptDirsFieldSurvivesSettingsSerialization() {
        AgentSettings settings = new AgentSettings();
        PermissionGroupDo perm = settings.getPermission();

        Assertions.assertNotNull(perm.getBashExemptDirs(), "getter 必须存在且返回非 null（前端回显依赖它）");
        Assertions.assertTrue(perm.getBashExemptDirs().isEmpty(), "默认应为空：不得给所有用户预置豁免目录");

        perm.getBashExemptDirs().addAll(Arrays.asList("D:\\build-out", "~/my-cache"));

        // 走真实的 JSON 快照往返。注意 permission 属于<b>全局</b>配置：
        // AgentSettings#getGlobalJson 里是 oNode.getOrNew("permission").fill(permission)，
        // 而 getLocalJson 只管 models/mcpServers/apiServers/lspServers/providers 这几组按 scope 分层的配置。
        // 用错快照方法会拿到不含 permission 的 JSON，断言就会假失败（首轮实测正是如此）。
        String json = settings.getGlobalJson(false);
        Assertions.assertNotNull(json);
        Assertions.assertTrue(json.contains("bashExemptDirs"),
                "字段必须出现在持久化 JSON 里，否则重启后配置丢失");
        Assertions.assertTrue(json.contains("build-out"), "条目内容必须被序列化");

        AgentSettings restored = org.noear.snack4.ONode.deserialize(json, AgentSettings.class);
        Assertions.assertEquals(Arrays.asList("D:\\build-out", "~/my-cache"),
                        restored.getPermission().getBashExemptDirs(),
                "反序列化必须还原条目，否则用户重启后配置静默丢失");
    }

    /**
     * 展开口径必须与 {@code BashPathGuard} 内部一致。
     *
     * <p>settings 里存的是<b>字面量</b>（{@code ~/my-cache}），解析发生在判定时。
     * 若 settings 侧自己展开一份、判定时再展开一份，两处口径必然漂移——
     * 漂移的表现正是「配了 ~ 但没生效」。故断言展开逻辑只有一个来源。</p>
     */
    @Test
    void tildeEntryIsExpandedByTheGuardNotBySettings() {
        AgentSettings settings = new AgentSettings();
        settings.getPermission().getBashExemptDirs().add("~/my-cache");

        // settings 侧保持字面量原样（不提前展开）
        Assertions.assertEquals("~/my-cache", settings.getPermission().getBashExemptDirs().get(0),
                "settings 应保存用户输入的字面量，展开交给判定层，避免两处口径漂移");

        // 判定层负责展开
        List<Path> resolved = BashPathGuard.resolveExemptDirs(settings.getPermission().getBashExemptDirs());
        Assertions.assertEquals(1, resolved.size());
        Assertions.assertEquals(Paths.get(System.getProperty("user.home"), "my-cache").toAbsolutePath().normalize(),
                resolved.get(0),
                "resolveExemptDirs 必须把 ~ 展开成与命令里 ~ 相同的路径，否则豁免永不命中");
    }
}
