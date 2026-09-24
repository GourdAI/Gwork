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
 * 会话访问控制档位。
 *
 * <p>这是「一个开关管两件事」的刻意设计：空间边界（能碰哪些目录）与命令闸门
 * （危险命令是否需要人工批准）在用户心智里本就是同一个「放不放心让它动手」的问题，
 * 拆成两个正交开关只会制造「隔离开着但命令随便跑」这类自相矛盾的中间态。
 * 因此档位只有两档，且两项能力同时切换。</p>
 *
 * <p>取值语义见 {@link AccessPolicy}。档位随会话走（存 FlowContext，随快照持久化），
 * 不是全局设置——同一时刻 A 会话可以完全访问而 B 会话保持隔离。</p>
 *
 * @author oisin
 */
public enum AccessMode {
    /**
     * 默认权限：项目空间隔离 + 危险命令需人工审批。
     */
    DEFAULT("default"),

    /**
     * 完全访问：解除空间隔离（可访问工作区外目录）+ 命令直接放行（不再弹审批）。
     */
    FULL("full");

    /**
     * 会话上下文键（权威存储位，随快照持久化）。
     *
     * <p>常量定义在本类而非 HarnessEngine：这两个键要同时被 harness 根包（引擎）与
     * harness.talents.cli（终端工具）引用，而后者引用前者会形成包级环。
     * 放在权限包内则两侧都只向下依赖。</p>
     */
    public static final String CTX_KEY = "_access_mode";

    /**
     * 本轮透传给工具方法的参数名（下划线前缀参数不进入 JSON schema）。
     */
    public static final String ATTR_KEY = "__accessMode";

    /**
     * 构建系统提示词时携带的档位（经 Prompt 属性透传）。
     *
     * <p>与 {@link #ATTR_KEY} 值相同、语义不同：工具执行走 toolContext，而
     * {@code getInstruction} 拿到的只有 Prompt。两处若不同源，会出现
     * 「提示词说严禁绝对路径、实际却已放行」的自相矛盾。
     */
    public static final String PROMPT_ATTR_KEY = "__accessMode";

    private final String code;

    AccessMode(String code) {
        this.code = code;
    }

    /**
     * 对外传输用的码值（前端、快照、接口参数统一用它，不用 enum name）。
     */
    public String code() {
        return code;
    }

    /**
     * 是否为完全访问档。
     */
    public boolean isFull() {
        return this == FULL;
    }

    /**
     * 归一化：无法识别的输入一律回落到 {@link #DEFAULT}。
     *
     * <p>这里必须 fail-safe 而非 fail-fast：档位来自会话快照与前端参数，
     * 历史快照没有该字段、前端传了脏值、或将来新增档位后回滚到旧版本，
     * 都应当退回最严格的一档，绝不能因为解析不出来就放行。</p>
     */
    public static AccessMode normalize(Object value) {
        if (value instanceof AccessMode) {
            return (AccessMode) value;
        }

        if (value == null) {
            return DEFAULT;
        }

        String text = String.valueOf(value).trim();
        if (text.isEmpty()) {
            return DEFAULT;
        }

        for (AccessMode mode : values()) {
            if (mode.code.equalsIgnoreCase(text) || mode.name().equalsIgnoreCase(text)) {
                return mode;
            }
        }

        return DEFAULT;
    }

    /**
     * 是否为合法码值（供接口层做 400 校验用）。
     *
     * <p>与 {@link #normalize(Object)} 的 fail-safe 相反，接口层需要能识别出
     * 「用户传了个不存在的档位」并明确拒绝，否则前端拼错字段会静默退回默认档，
     * 表现为「点了完全访问但没生效」且无任何线索。</p>
     */
    public static boolean isAllowed(String code) {
        if (code == null || code.trim().isEmpty()) {
            return false;
        }

        String text = code.trim();
        for (AccessMode mode : values()) {
            if (mode.code.equalsIgnoreCase(text)) {
                return true;
            }
        }

        return false;
    }
}
