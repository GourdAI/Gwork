package com.gourdai.harness.talents.cli;

import com.gourdai.harness.permission.AccessMode;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 档位 → 空间隔离/主目录/内核沙盒的折叠契约（TerminalTalent 侧）。
 *
 * <p>背景（变异测试实测）：把 {@code spaceIsolated} 里的档位项删掉（退回只看嵌入方开关），
 * 全仓既有测试无一变红——空间隔离的会话级语义此前没有任何测试钉住。
 * 本测试直接调用生产方法本身（同包可见），断言真行为而非源码文本。</p>
 */
class TerminalAccessModeFoldingTest {

    private TerminalTalent talent() {
        TerminalTalent t = new TerminalTalent(null, ShellCommandFactory.detect());
        t.setSandboxEnabled(true);
        t.setSandboxAllowUserHome(true);
        t.setSandboxSystemRestrict(false);
        return t;
    }

    @Test
    void spaceIsolationFollowsSessionModeAndedWithEmbedderSwitch() {
        TerminalTalent t = talent();

        Assertions.assertTrue(t.spaceIsolated(AccessMode.DEFAULT.code()), "默认档必须隔离");
        Assertions.assertFalse(t.spaceIsolated(AccessMode.FULL.code()), "完全访问档必须放行空间");
        Assertions.assertTrue(t.spaceIsolated(null), "缺省档位按默认档保守折算");
        Assertions.assertTrue(t.spaceIsolated("bypassPermissions"), "脏值回落默认档（隔离）");

        // 嵌入方全局兜底收紧：即使会话是默认档，关掉全局开关也应放开（与关系）
        t.setSandboxEnabled(false);
        Assertions.assertFalse(t.spaceIsolated(AccessMode.DEFAULT.code()),
                "嵌入方关闭全局隔离时，默认档也不得强制隔离（与关系，非档位单方面决定）");
    }

    @Test
    void userHomeAllowedInBothModesButRespectsEmbedderSwitch() {
        TerminalTalent t = talent();

        Assertions.assertTrue(t.userHomeAllowed(AccessMode.DEFAULT.code()),
                "默认档必须放行 ~/，否则 mvn/npm 构建全挂");
        Assertions.assertTrue(t.userHomeAllowed(AccessMode.FULL.code()));

        t.setSandboxAllowUserHome(false);
        Assertions.assertFalse(t.userHomeAllowed(AccessMode.DEFAULT.code()),
                "嵌入方显式禁主目录时仍应生效（与关系）");
    }

    @Test
    void kernelSandboxNeverArmedUnderFullMode() {
        TerminalTalent t = talent();
        t.setSandboxSystemRestrict(true);

        Assertions.assertTrue(t.kernelSandboxArmed(AccessMode.DEFAULT.code()),
                "默认档 + 嵌入方开启 = 内核沙盒应就绪");
        Assertions.assertFalse(t.kernelSandboxArmed(AccessMode.FULL.code()),
                "完全访问档下内核沙盒必须关闭：用户解除隔离后不得残留 OS 级限制");
        Assertions.assertTrue(t.kernelSandboxArmed(null), "null 档位按默认档保守折算（嵌入方已开全局开关）");

        t.setSandboxSystemRestrict(false);
        Assertions.assertFalse(t.kernelSandboxArmed(AccessMode.DEFAULT.code()),
                "嵌入方未开全局开关时不得武装内核沙盒");
    }

    // ==================== bash 校验入口：~ 禁令接回（P1-4） ====================

    @Test
    void bashValidationRejectsUserHomePathWhenEmbedderSwitchOff() {
        // 模拟嵌入方关闭开关：getInstruction 向模型承诺「~ 已禁用」，bash 校验必须兑现
        TerminalTalent t = talent();
        t.setSandboxAllowUserHome(false);

        String violation = t.validateCommand("ls ~/.ssh", AccessMode.DEFAULT.code());
        Assertions.assertNotNull(violation, "嵌入方禁用主目录时，含 ~ 的命令必须被拒");
        Assertions.assertTrue(violation.contains("sandboxAllowUserHome"),
                "拒绝文案应指向开关名，模型才能自纠（改用工作区相对路径）");

        // 完全访问档也不得绕过：sandboxAllowUserHome 是嵌入方收紧，与档位无关（与关系）
        Assertions.assertNotNull(t.validateCommand("npm cache ls ~/.npm", AccessMode.FULL.code()),
                "完全访问档不豁免嵌入方开关的 ~ 禁令");

        // 无 ~ 的普通命令不受影响
        Assertions.assertNull(t.validateCommand("ls src/main", AccessMode.DEFAULT.code()),
                "不含 ~ 的命令不应被误拦");
    }

    @Test
    void bashValidationAllowsUserHomePathWhenEmbedderSwitchOn() {
        // 开关开启（默认值）：~ 构建链豁免必须仍然放行，否则 mvn/npm 构建全挂
        TerminalTalent t = talent();
        Assertions.assertNull(t.validateCommand("mvn -o -pl gourd-ai-agent test ~/.m2/settings.xml", AccessMode.DEFAULT.code()),
                "默认开关下 ~ 路径不得被拦（构建链豁免）");

        // 嵌入方关闭沙盒：整体开放，不再收紧 ~（sandboxEnabled 前置语义）
        t.setSandboxEnabled(false);
        t.setSandboxAllowUserHome(false);
        Assertions.assertNull(t.validateCommand("ls ~/", AccessMode.DEFAULT.code()),
                "嵌入方关闭沙盒时不得再拦 ~（整体开放）");
    }
}
