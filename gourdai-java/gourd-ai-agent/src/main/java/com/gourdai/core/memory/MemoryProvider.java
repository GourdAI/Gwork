package com.gourdai.core.memory;

import com.gourdai.harness.talents.memory.MemorySolution;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import com.gourdai.harness.talents.memory.md.MemorySolutionMdImpl;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;

import java.nio.file.Paths;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class MemoryProvider implements MemorySolutionProvider {
    private Map<String, MemorySolution> cached = new ConcurrentHashMap<>();
    private AgentSettings agentSettings;

    public MemoryProvider(AgentSettings agentSettings) {
        this.agentSettings = agentSettings;
    }

    @Override
    public MemorySolution get(String __cwd) {
        if (agentSettings.getGeneral().getMemoryIsolation() == false) { //关闭隔离：共享记忆落安装目录（不再写用户主目录）
            __cwd = AgentFlags.getHarnessBase();
        }


        return cached.computeIfAbsent(__cwd, k ->
                new MemorySolutionMdImpl(Paths.get(k, AgentFlags.getHarnessMemory())));
    }
}