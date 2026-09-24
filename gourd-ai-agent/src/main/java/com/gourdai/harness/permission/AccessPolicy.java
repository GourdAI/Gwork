/*
 * Copyright 2017-2025 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.permission;

/**
 * 访问控制档位 → 具体能力的唯一映射表。
 *
 * <p>存在的理由：档位是「用户看到的一个按钮」，而落到执行层是四件互相独立的事
 * （空间隔离、主目录可达性、内核级沙盒、命令审批）。若让每个消费点自己从
 * {@link AccessMode} 推导，四处推导迟早会各自漂移——典型症状是空间放开了
 * 但审批还在弹，或者反过来。所有消费点一律只问这个类。</p>
 *
 * <p>原「沙盒模式」三个设置项（sandboxMode / sandboxAllowUserHome /
 * sandboxSystemRestrict）已被本档位取代并从设置页移除：前者与本档位的
 * 空间隔离含义完全重叠，后两者是「隔离怎么实现」的细节而非「隔不隔离」，
 * 不应让用户在两个地方配同一件事。默认档的取值刻意与那三项的原默认值
 * （true / true / false）逐一对齐，因此升级不产生任何行为变更。</p>
 *
 * @author oisin
 */
public final class AccessPolicy {

    private AccessPolicy() {
    }

    /**
     * 是否启用空间隔离（限制在工作区与挂载点内）。
     *
     * <p>对 read/write/edit/ls/glob/grep 是硬边界（{@code resolveSafePath} 逐次校验）；
     * 对 bash 在未开启内核级沙盒时只是提示词软约束——这是既有实现的既定边界，
     * 本档位不改变它，真正拦住 bash 越界的是 {@link #isCommandApprovalRequired}。</p>
     */
    public static boolean isSpaceIsolated(AccessMode mode) {
        return !normalize(mode).isFull();
    }

    /**
     * 是否允许访问用户主目录（{@code ~/}）。
     *
     * <p>两档都为 true。默认档也放行是必需的：mvn 读 {@code ~/.m2}、npm 读 {@code ~/.npm}、
     * cargo 读 {@code ~/.cargo}，禁掉会让绝大多数构建命令直接失败，
     * 而「隔离」的本意是防止乱动用户项目，不是让工具链不可用。
     * 真正敏感的 {@code ~/.ssh}、{@code ~/.bashrc} 等由命令审批与
     * {@code enforceFilesystemPolicy} 的敏感文件名单单独兜住。</p>
     */
    public static boolean isUserHomeAllowed(AccessMode mode) {
        return true;
    }

    /**
     * 危险命令是否需要人工审批。
     *
     * <p>这是默认档唯一的强制边界，也是完全访问档真正解除的东西。
     * 判定谁算「危险」见 {@code HitlStrategy}。</p>
     *
     * <p>注意：它放行的是「审批」，不是自保护。杀宿主进程、{@code exit}、
     * 根目录删除由 {@code TerminalSupport.validateCommandNoKill} 硬拦，
     * 不可关闭、不受档位影响。</p>
     */
    public static boolean isCommandApprovalRequired(AccessMode mode) {
        return !normalize(mode).isFull();
    }

    /**
     * 是否启用 OS 内核级沙盒（Seatbelt / bwrap）。
     *
     * <p>内核沙盒是空间隔离的<b>实现手段</b>而非独立能力，因此不单设「档位→内核沙盒」
     * 映射，而是把嵌入方全局开关（{@code HarnessOptions.sandboxSystemRestrict}）与
     * 档位折叠在一起：两者不可能同时成立（都已解除空间隔离了，再把命令关进只读
     * 工作区的沙盒里是自相矛盾），故完全访问档下本方法恒为 false，不受嵌入方开关约束。
     * 消费点一律调本方法，不得自行复制折叠表达式——复制即漂移。</p>
     *
     * @param mode                   会话档位（null 按默认档）
     * @param embedderSystemRestrict 嵌入方全局开关（{@code HarnessOptions.sandboxSystemRestrict}）
     */
    public static boolean isKernelSandboxEnabled(AccessMode mode, boolean embedderSystemRestrict) {
        return isSpaceIsolated(mode) && embedderSystemRestrict;
    }

    private static AccessMode normalize(AccessMode mode) {
        return mode == null ? AccessMode.DEFAULT : mode;
    }
}
