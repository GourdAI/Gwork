package com.gourdai.core.config;

import com.gourdai.agent.react.ReActAgent;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.HarnessExtension;
import com.gourdai.harness.agent.AgentDefinition;


/**
 *
 * @author oisin
 *
 */
public class ManagerExtension implements HarnessExtension {
    private final HarnessEngine engine;
    private final AgentSettings settings;
    private final ManagerTalent managerTalent;

    public ManagerExtension(HarnessEngine engine, AgentSettings settings) {
        this.engine = engine;
        this.settings = settings;
        this.managerTalent = new ManagerTalent(engine, settings);
    }

    @Override
    public void configure(String agentName, ReActAgent.Builder agentBuilder) {
        if (AgentDefinition.AGENT_MAIN.equals(agentName)) {
            agentBuilder.defaultTalentAdd(managerTalent);
        }
    }
}
