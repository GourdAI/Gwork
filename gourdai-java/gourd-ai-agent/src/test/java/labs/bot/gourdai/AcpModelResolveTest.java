package labs.bot.gourdai;

import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.portal.acp.AcpLink;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ACP 模型解析回归测试：acpModel 优先、留空回退 defaultModel、都没有返回 null。
 * <p>修复场景：ACP 子进程沿用启动时的旧配置，导致静默回退到 defaultModel，
 * 出现「模型明明已配置且能正常调用，唯独 ACP 报 406/模型不对」。</p>
 */
public class AcpModelResolveTest {
    private static AgentSettings settingsWith(String acpModel, String defaultModel, String... modelNames) {
        AgentSettings settings = new AgentSettings();
        settings.getGeneral().setAcpModel(acpModel);
        settings.setDefaultModel(defaultModel);
        for (String name : modelNames) {
            ModelDo model = new ModelDo();
            model.setName(name);
            model.setModel(name);
            model.setApiUrl("https://api.test.com");
            model.setApiKey("test-key");
            settings.getModels().put(name, model);
        }
        return settings;
    }

    @Test
    public void acpModelTakesPrecedence() {
        AgentSettings settings = settingsWith("GWork-gourdai-2.0", "GWork-claude-haiku",
                "GWork-gourdai-2.0", "GWork-claude-haiku");

        assertEquals("GWork-gourdai-2.0", AcpLink.resolveModelName(settings));
    }

    @Test
    public void fallbackToDefaultModelWhenAcpModelEmpty() {
        AgentSettings settings = settingsWith(null, "GWork-claude-haiku", "GWork-claude-haiku");

        assertEquals("GWork-claude-haiku", AcpLink.resolveModelName(settings));
    }

    @Test
    public void fallbackToDefaultModelWhenAcpModelBlank() {
        AgentSettings settings = settingsWith("  ", "GWork-claude-haiku", "GWork-claude-haiku");

        assertEquals("GWork-claude-haiku", AcpLink.resolveModelName(settings));
    }

    @Test
    public void nullWhenNoModelConfigured() {
        AgentSettings settings = settingsWith(null, null);

        assertNull(AcpLink.resolveModelName(settings));
    }
}
