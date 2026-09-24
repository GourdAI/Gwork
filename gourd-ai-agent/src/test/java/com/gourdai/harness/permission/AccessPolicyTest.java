package com.gourdai.harness.permission;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 档位 → 具体能力的映射契约。
 *
 * <p>这是「一个按钮管两件事」的落点：空间边界与命令闸门必须同时切换。
 * 若两者漂移（空间放开了但审批还在弹，或反过来），用户看到的档位就与实际行为不符，
 * 因此逐档钉死四元组。</p>
 */
class AccessPolicyTest {

    @Test
    void defaultModeIsIsolatedAndGuarded() {
        Assertions.assertTrue(AccessPolicy.isSpaceIsolated(AccessMode.DEFAULT));
        Assertions.assertTrue(AccessPolicy.isCommandApprovalRequired(AccessMode.DEFAULT));
    }

    @Test
    void fullModeReleasesBothBoundaries() {
        Assertions.assertFalse(AccessPolicy.isSpaceIsolated(AccessMode.FULL));
        Assertions.assertFalse(AccessPolicy.isCommandApprovalRequired(AccessMode.FULL));
    }

    /**
     * 主目录两档都放行。
     *
     * <p>默认档也放行是<b>必需</b>的：mvn 读 ~/.m2、npm 读 ~/.npm、cargo 读 ~/.cargo，
     * 禁掉会让绝大多数构建命令直接失败。而「隔离」的本意是防止乱动用户项目，
     * 不是让工具链不可用；真正敏感的 ~/.ssh 等由命令审批与敏感文件名单兜住。</p>
     */
    @Test
    void userHomeIsAllowedInBothModes() {
        Assertions.assertTrue(AccessPolicy.isUserHomeAllowed(AccessMode.DEFAULT),
                "默认档禁掉 ~/ 会让 mvn/npm 构建全部失败");
        Assertions.assertTrue(AccessPolicy.isUserHomeAllowed(AccessMode.FULL));
    }

    /**
     * null 档位一律按默认档处理（fail-safe），不能因为传了 null 就当成完全访问。
     */
    @Test
    void nullModeFallsBackToStrictBehavior() {
        Assertions.assertTrue(AccessPolicy.isSpaceIsolated(null));
        Assertions.assertTrue(AccessPolicy.isCommandApprovalRequired(null));
    }

    /**
     * 空间隔离与命令审批必须同向：不存在「隔离开着但命令随便跑」的中间态。
     *
     * <p>这一条是防将来有人给某个档位单独放宽其中一项。</p>
     */
    @Test
    void bothBoundariesAlwaysMoveTogether() {
        for (AccessMode mode : AccessMode.values()) {
            Assertions.assertEquals(AccessPolicy.isSpaceIsolated(mode),
                    AccessPolicy.isCommandApprovalRequired(mode),
                    mode + " 档的空间隔离与命令审批必须同向，不得只放开一项");
        }
    }

    /**
     * 内核沙盒是空间隔离的实现手段：完全访问档下恒为 false，不受嵌入方开关约束；
     * 默认档下则完全由嵌入方开关决定。
     *
     * <p>这条锁的是「用户解除隔离后 OS 沙盒不得残留」：若有人把折叠式写成
     * {@code sandboxSystemRestrict && ...} 而漏掉档位项，完全访问档下仍会包装/初始化沙盒。</p>
     */
    @Test
    void kernelSandboxFollowsIsolationAndEmbedderSwitch() {
        Assertions.assertFalse(AccessPolicy.isKernelSandboxEnabled(AccessMode.FULL, true),
                "完全访问档下内核沙盒必须关闭，否则用户解除隔离后仍被 OS 沙盒限制");
        Assertions.assertFalse(AccessPolicy.isKernelSandboxEnabled(AccessMode.FULL, false));
        Assertions.assertTrue(AccessPolicy.isKernelSandboxEnabled(AccessMode.DEFAULT, true));
        Assertions.assertFalse(AccessPolicy.isKernelSandboxEnabled(AccessMode.DEFAULT, false),
                "嵌入方未开全局开关时不得启用内核沙盒");
        Assertions.assertTrue(AccessPolicy.isKernelSandboxEnabled(null, true),
                "null 档位按默认档保守折算");
    }
}
