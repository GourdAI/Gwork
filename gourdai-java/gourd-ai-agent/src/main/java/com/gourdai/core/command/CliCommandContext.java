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

import org.jline.reader.LineReader;
import org.jline.terminal.Terminal;
import com.gourdai.agent.AgentSession;
import com.gourdai.harness.HarnessEngine;

import java.util.List;

/**
 * CLI 命令执行上下文（持有 JLine Terminal/Reader，输出直写终端）
 *
 * @author oisin
 * @since 2026.4.28
 */
public class CliCommandContext extends AbsCommandContext {
    private final Terminal terminal;
    private final LineReader reader;

    public CliCommandContext(AgentSession session, Terminal terminal, LineReader reader,
                             HarnessEngine agentRuntime,
                             String rawInput, String commandName, List<String> args,
                             AgentTaskRunner agentTaskRunner) {
        super(session, agentRuntime, rawInput, commandName, args, agentTaskRunner);
        this.terminal = terminal;
        this.reader = reader;
    }

    @Override
    public boolean supportsAnsi() {
        return true;
    }

    @Override
    public void println(String text) {
        terminal.writer().println(text);
        terminal.flush();
    }
}
