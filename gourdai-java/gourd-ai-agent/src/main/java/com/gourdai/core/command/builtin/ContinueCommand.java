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

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.command.Command;
import com.gourdai.harness.command.CommandContext;

/**
 * /continue 命令
 *
 * @author oisin
 * @since 2026.4.28
 */
public class ContinueCommand implements Command {
    @Override
    public String name() {
        return "continue";
    }

    @Override
    public String description() {
        return "继续运行最后一个未完成的任务";
    }

    @Override
    public String[] examples() {
        return new String[]{"/continue"};
    }

    @Override
    public void execute(CommandContext ctx) throws Exception {
        AgentSession session = ctx.getSession();
        HarnessEngine engine = ctx.getEngine();

        // /continue 经 runAgentTask(null,null) 由主 agent 执行（命令行不带 @，三端一致），
        // 故按主 agent 口径解析 trace，与实际执行的 agent 一致。
        ReActTrace trace = engine.resolveTrace(session, null);

        if (engine.canContinue(trace)) {
            // 仅异常中断/用户中断时移除最后一条兜底消息（失败兜底文案或「用户已取消任务.」）；
            // 正常完成时保留真实答复（否则会丢结论、损坏历史）
            engine.prepareResume(trace, session, null, trace.isAbnormal() || trace.isUserInterrupted());
        }

        ctx.runAgentTask(null, null);
    }
}
