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
package com.gourdai;

import com.gourdai.core.config.AgentFlags;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CliShell 惰性构造策略的回归护栏。
 *
 * <p>背景：CliShell 的构造会初始化 JLine 终端，而 {@code TerminalBuilder} 要反复 fork 子进程
 * 探测标准流是否接在真实终端上。这段开销发生在 Solon 启动主线程、HTTP 端口绑定之前，
 * 是桌面端（{@code web}）冷启动变慢的直接原因之一，因此除真正需要的模式外一律不构造。</p>
 *
 * <p>本类钉死「哪些 flag 需要」（漏放行 = 运行期 NPE，多放行 = 启动重新变慢），
 * 与 {@link Configurator#init()} 里各分支对 {@code cliShell} 的实际用法一一对应。</p>
 */
class ConfiguratorCliShellTest {

    @Test
    @DisplayName("cli / serve 必须构造（这两条分支真的会用到 cliShell）")
    void interactiveModesNeedCliShell() {
        assertTrue(Configurator.needsInteractiveShell(AgentFlags.FLAG_CLI));
        assertTrue(Configurator.needsInteractiveShell(AgentFlags.FLAG_SERVE));
    }

    @Test
    @DisplayName("web / acp / run 不构造（run 自己另建，web 与 acp 全程不用）")
    void nonInteractiveModesSkipCliShell() {
        assertFalse(Configurator.needsInteractiveShell(AgentFlags.FLAG_WEB));
        assertFalse(Configurator.needsInteractiveShell(AgentFlags.FLAG_ACP));
        assertFalse(Configurator.needsInteractiveShell(AgentFlags.FLAG_RUN));
        assertFalse(Configurator.needsInteractiveShell(AgentFlags.FLAG_VERSION));
    }

    @Test
    @DisplayName("无 flag（默认 web）与未知 flag 一律不构造，且不得抛异常")
    void defaultAndUnknownFlagsSkipCliShell() {
        // 桌面端的实际启动形式是 `web <port>`，裸启动（无 flag）同样是 web 默认路径
        assertFalse(Configurator.needsInteractiveShell(""));
        assertFalse(Configurator.needsInteractiveShell(null));
        assertFalse(Configurator.needsInteractiveShell("some-future-flag"));
    }
}
