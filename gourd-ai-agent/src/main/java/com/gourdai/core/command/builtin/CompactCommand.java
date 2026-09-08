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
package com.gourdai.core.command.builtin;

import com.gourdai.harness.command.Command;
import com.gourdai.harness.command.CommandContext;

/**
 * /compact 命令 —— 手动触发上下文压缩。
 *
 * <p>自动压缩只在触达阈值时发生。但用户往往比阈值更早知道
 * 「前面那一大段探索已经没用了」，此时手动压一次可以立刻释放窗口、
 * 并让后续推理聚焦到指定方向上。</p>
 *
 * <p>支持可选的 focus 指令：{@code /compact 只保留数据库迁移相关的结论}，
 * 该指令会透传给摘要模型，使其在压缩时优先保留相关内容。</p>
 *
 * @author oisin
 */
public class CompactCommand implements Command {

    @Override
    public String name() {
        return "compact";
    }

    @Override
    public String description() {
        return "手动压缩上下文（可选 focus 指令，用于指定压缩时优先保留的内容）";
    }

    @Override
    public String[] examples() {
        return new String[]{"/compact", "/compact 只保留数据库迁移相关的结论"};
    }

    @Override
    public void execute(CommandContext ctx) {
        String focus = ctx.getArgsJoined();

        if (focus != null && !focus.trim().isEmpty()) {
            ctx.getEngine().setCompactFocus(focus.trim());
            ctx.println(ctx.color("\033[36m已请求压缩上下文，聚焦：\033[0m" + focus.trim()));
        } else {
            ctx.getEngine().setCompactFocus(null);
            ctx.println(ctx.color("\033[36m已请求压缩上下文\033[0m"));
        }

        // 置位后，下一轮推理开始时压缩拦截器会无视阈值强制执行一次压缩
        ctx.getEngine().requestCompact();
        ctx.println(ctx.color("\033[90m将在下一轮推理开始时生效\033[0m"));
    }
}
