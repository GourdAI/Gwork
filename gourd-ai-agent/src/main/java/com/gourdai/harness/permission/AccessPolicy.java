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
     * 是否启用空间隔离（限制在工作区内）。
     *
     * <p>对 read/write/edit/ls/glob/grep 是硬边界（{@code resolveSafePath} 逐次校验）。</p>
     *
     * <p>对 bash 分两层：<b>与结构化文件工具同级的读写边界</b>由 {@code BashPathGuard} 在 Java 层
     * 强制（经 {@code HitlStrategy} 的路径轴：越界<b>读与写都</b>要求审批，两者都命中时报写）；
     * <b>进程级的完整隔离</b>（连变量拼接路径、被调脚本内部读写都管住）仍需内核级沙盒。</p>
     *
     * <p>旧版本文档曾声称「对 bash 在未开启内核级沙盒时只是提示词软约束」——那是对一个
     * 真实漏洞的描述而非设计意图：当时 bash 只有「杀宿主进程 / {@code exit} / 根目录删除」
     * 三条红线，完全没有路径概念，于是默认权限下 {@code Set-Content D:\其他项目\x.txt}
     * 这类命令可以静默执行成功。现已补上路径轴，但 {@code BashPathGuard} 自身的能力边界
     * （见其类注释「能力边界」一节）仍须由内核沙盒兜底。</p>
     */
    public static boolean isSpaceIsolated(AccessMode mode) {
        return !normalize(mode).isFull();
    }

    /**
     * 是否允许访问用户主目录（{@code ~/}）。
     *
     * <p><b>两档都为 true，且刻意忽略 {@code mode} 入参</b>。保留入参而不删的理由：
     * 本类是「档位 → 能力」的唯一映射表，四项能力必须同形（都吃 mode），
     * 否则将来需要按档区分时会遗漏消费点——而「遗漏」的表现正是静默放行。</p>
     *
     * <p>默认档也放行是必需的：mvn 读 {@code ~/.m2}、npm 读 {@code ~/.npm}、
     * cargo 读 {@code ~/.cargo}，禁掉会让绝大多数构建命令直接失败，
     * 而「隔离」的本意是防止乱动用户项目，不是让工具链不可用。</p>
     *
     * <p><b>本方法不是「主目录可以随便写」的意思。</b>它只回答「档位层是否禁用 ~ 路径」；
     * 真正拦住写 {@code ~/.ssh}、{@code ~/.bashrc}、{@code ~/Documents} 的是两道独立的门：
     * {@code HitlStrategy} 的凭据 / 启动文件名单，以及 {@code BashPathGuard} 的路径轴
     * （家目录不在构建缓存豁免清单内，写它同样算越界）。</p>
     *
     * <p><b>与 {@code TerminalTalent.sandboxAllowUserHome} 的分工（两者都可达，都不是死代码）</b>：
     * 本方法是<b>产品档位</b>决策（恒 true），后者是<b>嵌入方收紧开关</b>
     * （有公开 setter：{@code HarnessEngine.setSandboxAllowUserHome} 与
     * {@code Builder.sandboxAllowUserHome}，默认 true）。两者经
     * {@code TerminalTalent.userHomeAllowed} 折叠为与关系，嵌入方设为 false 时
     * bash 的 ~ 禁令会真的生效。本项目自己不设 false，但不得因此删掉该开关。</p>
     */
    public static boolean isUserHomeAllowed(AccessMode mode) {
        return true;
    }

    /**
     * 危险命令是否需要人工审批。
     *
     * <p>这是默认档的强制边界，也是完全访问档真正解除的东西。判定谁算「危险」见
     * {@code HitlStrategy}，它有两条<b>独立</b>的轴：</p>
     * <ul>
     *   <li><b>形态轴</b>：不可逆的操作（递归删除、提权、关机、下载即执行、
     *       凭据访问、写启动文件）；</li>
     *   <li><b>路径轴</b>：读到 / 写到了工作区之外（{@code BashPathGuard}；读写都拦，
     *       两者都命中时报写）。</li>
     * </ul>
     *
     * <p>两轴独立生效、<b>取更严者</b>：{@code rm -rf ~/.m2/repository} 虽在缓存豁免目录内
     * （路径轴不拦），仍会因递归删除不可逆而要求审批（形态轴拦）。
     * 豁免清单的语义是「不因为<b>越界</b>而弹审批」，不是「不因为<b>危险</b>而弹审批」——
     * 把这条读反就会去给形态轴也加目录豁免，从而把真正不可逆的删除一并放行。</p>
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
