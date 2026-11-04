package features.ai.harness;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import org.junit.jupiter.api.Test;
import com.gourdai.harness.agent.AgentFactory;

public class AgentFactoryCommandSessionTest {

    @Test
    public void publicToolSetIncludesBashAndBashOutput() throws Exception {
        assertTrue(toolSetContains("TOOL_ALL_PUBLIC", "bash"));
        assertTrue(toolSetContains("TOOL_ALL_PUBLIC", "bash_output"));
    }

    @Test
    public void piToolSetIncludesBashAndBashOutput() throws Exception {
        assertTrue(toolSetContains("TOOL_PI", "bash"));
        assertTrue(toolSetContains("TOOL_PI", "bash_output"));
    }

    @Test
    public void asyncBashToolsRemoved() throws Exception {
        // bash_start/wait/stdin/stop 已彻底删除，统一由 bash 的 run_in_background + bash_output 取代
        for (String set : new String[]{"TOOL_ALL_FULL", "TOOL_ALL_PUBLIC", "TOOL_PI"}) {
            assertFalse(toolSetContains(set, "bash_start"));
            assertFalse(toolSetContains(set, "bash_wait"));
            assertFalse(toolSetContains(set, "bash_stdin"));
            assertFalse(toolSetContains(set, "bash_stop"));
        }
    }

    private static boolean toolSetContains(String fieldName, String toolName) throws Exception {
        Field field = AgentFactory.class.getDeclaredField(fieldName);
        field.setAccessible(true);
        String[] tools = (String[]) field.get(null);
        for (String tool : tools) {
            if (toolName.equals(tool)) {
                return true;
            }
        }
        return false;
    }
}
