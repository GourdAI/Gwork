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
package com.gourdai;

import org.noear.solon.Solon;
import org.noear.solon.SolonApp;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.config.AgentProperties;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.portal.web.WebAuthFilter;
import com.gourdai.core.portal.web.thinking.ModelProfiles;
import org.noear.solon.core.util.Assert;
import org.noear.solon.scheduling.annotation.EnableScheduling;
import org.noear.solon.web.cors.CrossFilter;
import org.slf4j.bridge.SLF4JBridgeHandler;

import java.net.URL;
import java.util.Map;

/**
 * Cli 应用
 *
 * @author oisin
 * @since 3.9.1
 */
@EnableScheduling
public class App {

    public static void main(String[] args) {
        // 品牌升级：.gourdai → .gwork 一次性目录迁移（必须先于任何配置/会话读取，
        // ACP/CLI 启动器直连 java -jar 不经桌面端 Node，故迁移必须在此收口）
        AgentFlags.migrateLegacyHarnessHome();

        boolean isAcpMode = args.length > 0 && AgentFlags.FLAG_ACP.equals(args[0]);

        // 1. 移除 JUL 默认的控制台处理器
        SLF4JBridgeHandler.removeHandlersForRootLogger();
        // 2. 添加 SLF4J 处理器
        SLF4JBridgeHandler.install();

        // ACP 模式下彻底清理 JUL handler，防止第三方库通过 JUL 向 System.out 输出
        if (isAcpMode) {
            java.util.logging.Logger rootLogger = java.util.logging.Logger.getLogger("");
            rootLogger.setUseParentHandlers(false);
            for (java.util.logging.Handler h : rootLogger.getHandlers().clone()) {
                rootLogger.removeHandler(h);
            }
        }

        AgentProperties agentProps = new AgentProperties();

        // 配置文件日志必须在 Solon 初始化日志插件前确定，且与全局根 override 保持一致。
        System.setProperty("gwork.log.dir", java.nio.file.Paths
                .get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "logs")
                .toString());
        System.setProperty("solon.extend", "!" + AgentFlags.getUserExtensions());

        Solon.start(App.class, args, app -> {
            initAgentProperties(app, agentProps);
        });
    }

    private static void initAgentProperties(SolonApp app, AgentProperties c) throws Exception {
        //加载配置文件

        URL configUrl = AgentFlags.getConfigUrl();

        app.cfg().loadAdd(configUrl);

        //获取命令行运行的当前用户工作区
        app.cfg().getProp("gourdai").bindTo(c);

        //兼容旧的模型配置
        if (c.getChatModel() != null) {
            c.getModels().add(c.getChatModel());
        }

        AgentSettings settings = initAgentSettings(app, c);

        //推入容器
        //app.context().wrapAndPut(AgentProperties.class, c);

        //-----

        app.enableHttp(false); //默认不启用 http

        String flag = app.cfg().argx().flagAt(0);

        if (AgentFlags.FLAG_SERVE.equals(flag)) {
            enabledWeb(app, c, settings);
            enabledAcp(app, c);
            return;
        }

        if (AgentFlags.FLAG_ACP.equals(flag)) {
            enabledAcp(app, c);
            return;
        }

        //默认启动 web
        enabledWeb(app, c, settings);
    }

    private static AgentSettings initAgentSettings(SolonApp app, AgentProperties props) throws Exception {

        AgentSettings agentSettings = AgentSettings.loadFromFile();

        //与 AgentProperties 双向合并
        agentSettings.mergeFrom(props);

        app.context().wrapAndPut(AgentSettings.class, agentSettings);

        // 思考档位：把「按模型名查能力覆写」的通路绑给 thinking 层。
        //
        // 为何必须在此绑定：真正发请求的注入点（WebStreamBuilder / AcpLink / WsGate /
        // TaskTalent）只拿到 ChatModel，而 ChatModel.getConfig() 返回的 ChatConfigReadonly
        // 是个包装器，与 ModelDo 并非同一继承体系，怎么探测都取不到 capabilities。
        // 若不绑定，UI 端点（直接读 ModelDo）与请求路径（读不到）就会各读一套，
        // 表现为「UI 显示覆写已生效，实际请求仍发兜底值」——比完全不支持更具误导性。
        //
        // 注：这里捕获的是 AgentSettings 实例而非某个快照，models 本身是 COW volatile，
        // 故用户在设置页改完配置无需重启即生效。
        ModelProfiles.bind(modelName -> lookupCapabilities(agentSettings, modelName));

        return agentSettings;
    }

    /**
     * 按模型名查能力覆写。
     *
     * <p>配置的 key 是「显示名」（nameOrModel），而请求路径拿到的是「实际模型 id」
     * （{@code ChatConfig.getModel()}），两者常不相等（如用户把 gpt-5.6-sol 命名为「主力模型」）。
     * 故先按 key 直取，再回掉到遍历比对 model / nameOrModel。</p>
     */
    private static Map<String, Object> lookupCapabilities(AgentSettings settings, String modelName) {
        Map<String, ModelDo> models = settings.getModels();
        if (models == null || modelName == null) {
            return null;
        }
        ModelDo hit = models.get(modelName);
        if (hit == null) {
            for (ModelDo m : models.values()) {
                if (modelName.equals(m.getModel()) || modelName.equals(m.getNameOrModel())) {
                    hit = m;
                    break;
                }
            }
        }
        return hit == null ? null : hit.getCapabilities();
    }

    private static void enabledWeb(SolonApp app, AgentProperties c, AgentSettings settings) {
        String port = app.cfg().argx().flagAt(1);

        if ("0".equals(port)) {
            port = findAvailablePort();
        }

        if (Assert.isNotEmpty(port) && Assert.isNumber(port)) {
            // gourdai web 1212 //= gourdai web -server.port=1212
            app.cfg().setProperty("server.port", port);
        }

        app.enableHttp(true);
        app.enableWebSocket(true);
        // Web 访问认证（Basic Auth）：先于跨域过滤器注册，settings 中配置了账号密码才生效
        app.router().filter(new WebAuthFilter(settings));
        // 允许跨域（桌面端前端通过 localhost 访问 CLI 后端）
        app.router().filter(new CrossFilter());
    }

    private static void enabledAcp(SolonApp app, AgentProperties c) {
        //开始控制台日志(web 通讯关闭)
        app.enableHttp(false);
        app.enableWebSocket(false);
    }

    private static String findAvailablePort() {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            return String.valueOf(socket.getLocalPort());
        } catch (Throwable e) {
            // 如果分配失败，返回一个保底的默认端口
            return null;
        }
    }
}