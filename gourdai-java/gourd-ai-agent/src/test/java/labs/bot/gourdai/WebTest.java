package labs.bot.gourdai;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.jsonschema.JsonSchema;
import com.gourdai.App;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentSettings;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 启动 gourdai web 测试界面
 *
 * @author oisin
 */
public class WebTest {
    public static void main(String[] args) throws Exception {
        App.main(new String[]{"web", "debug=1"});

        JsonSchema jsonSchema = JsonSchema.builder()
                .options(Options.of(Feature.Write_PrettyFormat))
                .printVersion(true)
                .enableDefinitions(true)
                .build();

        ONode oNode = jsonSchema.generate(AgentSettings.class);
        String json = oNode.toJson();

        System.out.println("--------------------");
        System.out.println(json);
        System.out.println("--------------------");

        Path path = Paths.get(AgentFlags.getUserHome(), "Downloads", "settings.schema.json").toAbsolutePath();
        Files.write(path, json.getBytes(StandardCharsets.UTF_8));
    }
}
