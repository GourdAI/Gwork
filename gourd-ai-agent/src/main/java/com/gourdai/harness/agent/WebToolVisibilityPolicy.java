/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.noear.solon.core.util.Assert;

/**
 * WebGate 对工具生命周期帧的可见性策略。
 *
 * <p>这里不依赖任何具体 portal，保证批次计算与各 Web 投影入口使用同一口径。</p>
 */
public final class WebToolVisibilityPolicy {
    private WebToolVisibilityPolicy() {
    }

    /** 工具是否属于 Web 可见工具（不包含生命周期阶段的特殊语义）。 */
    public static boolean isBaseVisible(String toolName) {
        if (Assert.isEmpty(toolName)) {
            return false;
        }
        return !TaskTalent.TOOL_MULTITASK.equals(toolName)
                && !TaskTalent.TOOL_TASK.equals(toolName)
                && !MemoryTalent.isMemoryTool(toolName);
    }

    /** 是否发送 action_start；todowrite 使用专用面板，只有成功 end 可见。 */
    public static boolean isStartVisible(String toolName) {
        return isBaseVisible(toolName) && !TodoTalent.TOOL_TODOWRITE.equals(toolName);
    }

    /** 是否发送失败 action_end；保持 todowrite 的非对称语义，不发送失败 end。 */
    public static boolean isFailedEndVisible(String toolName) {
        return isBaseVisible(toolName) && !TodoTalent.TOOL_TODOWRITE.equals(toolName);
    }
}
