package com.gourdai.harness;

import com.gourdai.harness.talents.cli.SkillListingPolicy;
import com.gourdai.harness.talents.cli.SkillTalent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 技能清单预算设置项的<b>接线</b>契约。
 *
 * <p>为什么单独一个测试类：{@code SkillListingInjectionTest} 守的是「给定预算，渲染是否
 * 正确」，而本类守的是「settings.json 里的值能否真的走到渲染层」。后者断裂时的症状是
 * <b>设置页显示已保存、实际毫无效果</b>——比功能缺失更难发现，因为界面一切正常。</p>
 *
 * <p>完整链路：</p>
 * <pre>
 * settings.json → AgentSettings.general → Configurator → HarnessEngine.Builder
 *   → HarnessOptions → 构造时创建 SkillTalent 并 apply
 *   → 运行时 WebSettingsController 保存 → engine.setXxx → skillTalent.xxx
 * </pre>
 *
 * <p>最易断的一环是「构造时 apply」：Builder 只写 options，而 SkillTalent 是构造过程中
 * 新建的实例，若创建后不显式把 options 的值推给它，配置就永远停在 options 里。</p>
 *
 * @author oisin
 */
public class SkillListingSettingsWiringTest {

    @TempDir
    Path tempDir;

    /** HarnessOptions 是包级私有的，只能反射读取。 */
    private static Object optionsOf(HarnessEngine engine) throws Exception {
        Field f = HarnessEngine.class.getDeclaredField("options");
        f.setAccessible(true);
        return f.get(engine);
    }

    private static int readOption(HarnessEngine engine, String getter) throws Exception {
        Class<?> cls = Class.forName("com.gourdai.harness.HarnessOptions");
        Method m = cls.getDeclaredMethod(getter);
        m.setAccessible(true);
        return (Integer) m.invoke(optionsOf(engine));
    }

    private HarnessEngine engineOver(Path workspace) throws Exception {
        // 技能目录留空即可：本测试只关心设置项传递，不关心扫到几个技能
        Files.createDirectories(workspace.resolve(".gwork").resolve("skills"));
        return HarnessEngine.of(workspace.toString(), ".gwork/").build();
    }

    // ========== 构造时 apply ==========

    @Test
    @DisplayName("Builder 设置的两个值必须在构造时应用到 SkillTalent（最易断的一环）")
    void builderValuesReachTheTalent() throws Exception {
        HarnessEngine engine = HarnessEngine.of(tempDir.toString(), ".gwork/")
                .skillListingBudgetFraction(4)
                .skillListingMaxDescChars(300)
                .build();

        SkillTalent talent = engine.getSkillTalent();
        assertNotNull(talent, "engine 未创建 SkillTalent");
        assertEquals(4, talent.getListingBudgetFraction(),
                "预算百分比停在 options 里，没推到 SkillTalent —— settings.json 的值到不了渲染层");
        assertEquals(300, talent.getListingMaxDescChars(),
                "单条上限停在 options 里，没推到 SkillTalent");
    }

    @Test
    @DisplayName("未配置时用规范默认值（1% / 1024）")
    void defaultsMatchTheSpec() throws Exception {
        HarnessEngine engine = engineOver(tempDir);
        SkillTalent talent = engine.getSkillTalent();

        assertEquals(SkillListingPolicy.DEFAULT_BUDGET_FRACTION, talent.getListingBudgetFraction());
        assertEquals(1, talent.getListingBudgetFraction(), "默认应对齐 Claude Code 的 1%");
        assertEquals(1024, talent.getListingMaxDescChars(), "默认应对齐 Agent Skills 规范的 1024");
    }

    // ========== 运行时 setter（设置页保存路径）==========

    @Test
    @DisplayName("设置页保存后：engine.setXxx 必须同时更新 SkillTalent 与 options")
    void runtimeSetterUpdatesBothTalentAndOptions() throws Exception {
        HarnessEngine engine = engineOver(tempDir);
        SkillTalent talent = engine.getSkillTalent();

        engine.setSkillListingBudgetFraction(7);
        engine.setSkillListingMaxDescChars(512);

        // SkillTalent 是本轮提示词的实际消费方
        assertEquals(7, talent.getListingBudgetFraction(), "设置页保存后提示词仍按旧预算渲染");
        assertEquals(512, talent.getListingMaxDescChars(), "设置页保存后仍按旧上限截断");

        // options 是单一真源：新建子代理时从它继承，不同步会让子代理用旧预算
        assertEquals(7, readOption(engine, "getSkillListingBudgetFraction"),
                "options 未同步，子代理会继承旧预算");
        assertEquals(512, readOption(engine, "getSkillListingMaxDescChars"),
                "options 未同步，子代理会继承旧上限");
    }

    @Test
    @DisplayName("setter 传脏值时回落默认，而不是原样存下")
    void runtimeSetterNormalizesDirtyValues() throws Exception {
        HarnessEngine engine = engineOver(tempDir);
        SkillTalent talent = engine.getSkillTalent();

        // 0 会让清单恒空（等于禁用全部技能），必须回落而不是接受
        engine.setSkillListingBudgetFraction(0);
        assertEquals(SkillListingPolicy.DEFAULT_BUDGET_FRACTION, talent.getListingBudgetFraction(),
                "0 被原样接受，会让技能清单恒空");

        engine.setSkillListingBudgetFraction(99);
        assertEquals(SkillListingPolicy.DEFAULT_BUDGET_FRACTION, talent.getListingBudgetFraction(),
                "越界值被原样接受");

        engine.setSkillListingMaxDescChars(0);
        assertEquals(1024, talent.getListingMaxDescChars(),
                "0 会把每条描述削成只剩省略号");

        // null（用户清空输入框）同样回落
        engine.setSkillListingBudgetFraction(null);
        assertEquals(SkillListingPolicy.DEFAULT_BUDGET_FRACTION, talent.getListingBudgetFraction());
    }

    @Test
    @DisplayName("合法边界值被接受（1 与 10 / 16 与 8192）")
    void legalBoundariesAreAccepted() throws Exception {
        HarnessEngine engine = engineOver(tempDir);
        SkillTalent talent = engine.getSkillTalent();

        for (int v : new int[]{1, 5, 10}) {
            engine.setSkillListingBudgetFraction(v);
            assertEquals(v, talent.getListingBudgetFraction(), "合法值 " + v + " 被拒绝");
        }
        for (int v : new int[]{16, 1024, 8192}) {
            engine.setSkillListingMaxDescChars(v);
            assertEquals(v, talent.getListingMaxDescChars(), "合法值 " + v + " 被拒绝");
        }
    }
}
