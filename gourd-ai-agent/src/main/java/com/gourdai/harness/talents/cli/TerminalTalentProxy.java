package com.gourdai.harness.talents.cli;

import org.noear.solon.ai.chat.prompt.Prompt;
import org.noear.solon.ai.chat.talent.Talent;
import org.noear.solon.ai.chat.talent.TalentMetadata;
import org.noear.solon.ai.chat.tool.FunctionTool;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * TerminalTalent 代理
 *
 * <p>作用是「按需暴露工具子集」：TerminalTalent 自身持有全部终端类工具，
 * 而每个 agent 只应看到 AgentFactory 为其挑选的那几个（如 pi 只给 read/write/edit/bash/bash_output）。
 * 故 {@link #getTools(Prompt)} 必须返回本代理累积的 {@link #toolList}，而不是委托给 TerminalTalent，
 * 否则工具权限控制会整体失效。</p>
 *
 * @author oisin
 */
public class TerminalTalentProxy implements Talent {
    private final TerminalTalent terminalTalent;
    private final List<FunctionTool> toolList = new ArrayList<>();

    public TerminalTalentProxy(TerminalTalent terminalTalent) {
        this.terminalTalent = terminalTalent;
    }

    public boolean isEmpty() {
        return toolList.isEmpty();
    }

    public void addTools(String... names) {
        toolList.addAll(terminalTalent.getToolAry(names));
    }

    @Override
    public String name() {
        return terminalTalent.name();
    }

    @Override
    public String description() {
        return terminalTalent.description();
    }

    @Override
    public TalentMetadata metadata() {
        return terminalTalent.metadata();
    }

    @Override
    public boolean isEnabled() {
        return terminalTalent.isEnabled();
    }

    @Override
    public boolean isSupported(Prompt prompt) {
        return terminalTalent.isSupported(prompt);
    }

    @Override
    public void onAttach(Prompt prompt) {
        terminalTalent.onAttach(prompt);
    }

    @Override
    public String getInstruction(Prompt prompt) {
        return terminalTalent.getInstruction(prompt);
    }

    @Override
    public Collection<FunctionTool> getTools(Prompt prompt) {
        return toolList;
    }
}
