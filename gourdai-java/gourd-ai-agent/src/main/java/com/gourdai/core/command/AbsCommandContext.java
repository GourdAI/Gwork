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
package com.gourdai.core.command;

import com.gourdai.agent.AgentSession;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.command.CommandContext;

import java.util.List;

/**
 * 命令执行上下文基类
 *
 * <p>收敛 CLI 与 Web 两种上下文共有的会话/引擎/入参持有与访问逻辑，
 * 子类只需实现输出介质相关的 {@link #println(String)} 与 {@link #supportsAnsi()}。</p>
 *
 * @author oisin
 * @since 2026.4.28
 */
public abstract class AbsCommandContext implements CommandContext {
    private final AgentSession session;
    private final HarnessEngine agentRuntime;
    private final String rawInput;
    private final String commandName;
    private final List<String> args;
    private final AgentTaskRunner agentTaskRunner;

    /**
     * Agent 任务回调接口
     */
    @FunctionalInterface
    public interface AgentTaskRunner {
        void run(String prompt, String model);
    }

    protected AbsCommandContext(AgentSession session,
                                HarnessEngine agentRuntime,
                                String rawInput, String commandName, List<String> args,
                                AgentTaskRunner agentTaskRunner) {
        this.session = session;
        this.agentRuntime = agentRuntime;
        this.rawInput = rawInput;
        this.commandName = commandName;
        this.args = args;
        this.agentTaskRunner = agentTaskRunner;
    }

    @Override
    public AgentSession getSession() {
        return session;
    }

    @Override
    public HarnessEngine getEngine() {
        return agentRuntime;
    }

    @Override
    public String getRawInput() {
        return rawInput;
    }

    @Override
    public String getCommandName() {
        return commandName;
    }

    @Override
    public List<String> getArgs() {
        return args;
    }

    @Override
    public void runAgentTask(String input, String model) {
        if (agentTaskRunner != null) {
            onAgentTaskStart();
            agentTaskRunner.run(input, model);
        }
    }

    /** Agent 任务实际派发前的钩子（子类可记录状态） */
    protected void onAgentTaskStart() {
        //默认无操作
    }
}
