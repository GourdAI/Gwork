/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.talents.cli;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Windows 父 shell 探测的回归护栏。
 *
 * <p>背景：原实现只走「外挂 PowerShell + WMI 全机进程枚举」，实测 ≈2.0s（超时上限 4s），
 * 且整段在 Solon 启动主线程上同步执行——探测不结束，HTTP 端口就不会绑定。现在优先走
 * {@link ShellCommandFactory#ancestorCommandsFast()}（反射调 {@code ProcessHandle}，
 * 零 fork），慢路径仅作兜底。</p>
 */
class ShellCommandFactoryProbeTest {

    @Test
    @DisplayName("能识别快路径实际喂进来的数据形状：Windows 完整映像路径")
    void recognisesFullImagePaths() {
        // 快路径 command() 返回的就是这种小写完整路径，慢路径的 ExecutablePath 同形
        assertEquals("powershell", ShellCommandFactory.shellNameOfCommand(
                "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe"));
        assertEquals("pwsh", ShellCommandFactory.shellNameOfCommand(
                "c:\\program files\\powershell\\7\\pwsh.exe"));
        assertEquals("cmd", ShellCommandFactory.shellNameOfCommand(
                "c:\\windows\\system32\\cmd.exe"));
        // 祖先链里的普通进程不应被误判成 shell
        assertNull(ShellCommandFactory.shellNameOfCommand("c:\\windows\\explorer.exe"));
        assertNull(ShellCommandFactory.shellNameOfCommand("d:\\apps\\gwork\\gourd-ai-tauri.exe"));
    }

    @Test
    @DisplayName("快路径要么返回 null（交回慢路径），要么返回非空列表 —— 绝不返回空列表")
    void fastPathNeverReturnsEmptyList() {
        List<String> found = ShellCommandFactory.ancestorCommandsFast();

        // 空列表会被上游 probeWindowsParentShellName() 当成「祖先链里确实没有 shell」
        // 而直接把结果定稿为默认 PowerShell 方言，等于把一次读取失败误判成结论。
        if (found != null) {
            assertFalse(found.isEmpty(), "空列表会被误判为「确实没有 shell」");
            for (String path : found) {
                // 上游 shellNameOfCommand 的 contains 判定依赖全部小写
                assertEquals(path.toLowerCase(java.util.Locale.ROOT), path,
                        "快路径必须返回小写映像路径: " + path);
                assertNotNull(path);
            }
        }
    }

    @Test
    @DisplayName("快路径在 Java 8 / 受限环境下静默降级：不向外抛异常")
    void fastPathNeverThrows() {
        // Java 8 无 java.lang.ProcessHandle，反射会抛 ClassNotFoundException；安全策略拦截同理。
        // 必须被吞掉并回退慢路径 —— 任何异常泄漏到 detect() 都会让整个启动直接失败。
        //
        // 注意：这里用 assertDoesNotThrow 而不是对返回值做断言 —— 返回值「null 或非空」两种都合法
        // （取决于本机能否读进程表），唯一必须钉死的是「无论如何都不炸」。
        assertDoesNotThrow(() -> {
            List<String> found = ShellCommandFactory.ancestorCommandsFast();
            if (found != null) {
                assertFalse(found.isEmpty());
            }
        });
    }

    /**
     * 关键回归护栏：**若操作系统允许读取父进程映像路径，快路径就必须真的读出东西**。
     *
     * <p>这条测试专门钉死一个极易复发、且症状极不明显的坑：{@code ProcessHandle.parent()} 与
     * {@code ProcessHandle.Info.command()} 返回的都是 {@code Optional}，漏解包不会抛异常，只会让
     * 判定恒为「取不到」→ 静默回退到 2 秒级的 PowerShell 慢路径，表现为「代码改了但一点没变快」。
     * 本人第一版就是这么写的，靠这段采样堆栈才发现。</p>
     *
     * <p>沙箱/受限完整性级别下 OpenProcess 会被拒（本机在 Bash 沙箱里就是如此），此时前提不成立，
     * 用 {@link org.junit.jupiter.api.Assumptions#assumeTrue} 跳过而不是误报失败。</p>
     */
    @Test
    @DisplayName("父进程映像路径可读时，快路径不得返回 null（防 Optional 漏解包导致的静默降级）")
    void fastPathReadsImagePathWhenPermitted() {
        assumeTrue(parentImagePathReadable(), "当前环境不允许读取父进程映像路径，跳过");

        List<String> found = ShellCommandFactory.ancestorCommandsFast();

        assertNotNull(found,
                "父进程映像路径明明可读，快路径却返回 null —— 多半是 Optional 没有解包");
        assertFalse(found.isEmpty());
    }

    /** 直接问操作系统：当前进程的父进程映像路径读得到吗？（JDK 9+ 才有 ProcessHandle） */
    private static boolean parentImagePathReadable() {
        try {
            Class<?> handleType = Class.forName("java.lang.ProcessHandle");
            Class<?> infoType = Class.forName("java.lang.ProcessHandle$Info");
            Object self = handleType.getMethod("current").invoke(null);
            Object parentOpt = handleType.getMethod("parent").invoke(self);
            if (!(Boolean) Optional.class.getMethod("isPresent").invoke(parentOpt)) {
                return false;
            }
            Object parent = Optional.class.getMethod("get").invoke(parentOpt);
            Object info = handleType.getMethod("info").invoke(parent);
            Object commandOpt = infoType.getMethod("command").invoke(info);
            return (Boolean) Optional.class.getMethod("isPresent").invoke(commandOpt);
        } catch (Throwable e) {
            return false;
        }
    }
}
