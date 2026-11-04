package features.ai.harness;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.harness.agent.TaskTalent;

import java.util.List;
import java.util.Map;

public class JsonSchemaTest {
    /**
     * task / multitask 的入参契约。
     *
     * <p><b>本用例为何必须用 JUnit 断言而不能用 Java {@code assert}：</b>原先两条断言写的是
     * {@code assert "...".equals(schema)}，而 pom 里未给 surefire 配 {@code enableAssertions}/
     * {@code -ea}，JVM 默认关闭断言 → 整条用例<b>恒绿且什么都没验证</b>。后果在本轮真实发生：
     * background 字段被错标为必填，以及 multitask 项里多出一个无意义的 background，
     * 都在「966/966 全绿」下溜过去了。测试基建的隐性失效比断言写错更难发现。</p>
     */
    @Test
    public void case1() {
        TaskTalent taskTalent = new TaskTalent(null);

        FunctionTool functionTool = ((List<FunctionTool>) taskTalent.getToolAry("multitask")).get(0);
        ONode multiSchema = ONode.ofJson(functionTool.inputSchema());
        Assertions.assertEquals("object", multiSchema.get("type").getString());
        Assertions.assertTrue(multiSchema.get("required").getArray().stream()
                .anyMatch(n -> "tasks".equals(n.getString())), "tasks 必须为必填参数");

        ONode item = multiSchema.get("properties").get("tasks").get("items");
        ONode itemProps = item.get("properties");
        Assertions.assertEquals("string", itemProps.get("agent_name").get("type").getString());
        Assertions.assertEquals("string", itemProps.get("prompt").get("type").getString());
        Assertions.assertEquals("string", itemProps.get("description").get("type").getString());
        Assertions.assertEquals("integer", itemProps.get("index").get("type").getString());

        // background 在 multitask 中已支持（O-E 按任务粒度混批），但必须保持可选：
        // 必填会迫使模型每次并行派发都多吐一个无意义字段，与省 token 的主题自相矛盾。
        assertBackgroundIsOptional(item, "multitask.tasks[]");

        functionTool = ((List<FunctionTool>) taskTalent.getToolAry("task")).get(0);
        ONode taskSchema = ONode.ofJson(functionTool.inputSchema());
        ONode taskProps = taskSchema.get("properties");
        Assertions.assertEquals("string", taskProps.get("agent_name").get("type").getString());
        Assertions.assertEquals("string", taskProps.get("prompt").get("type").getString());
        Assertions.assertEquals("string", taskProps.get("description").get("type").getString());
        Assertions.assertTrue(taskSchema.get("required").getArray().stream()
                .anyMatch(n -> "agent_name".equals(n.getString())), "agent_name 必须为必填参数");

        assertBackgroundIsOptional(taskSchema, "task");
    }

    /**
     * 断言 background 为「可选 + boolean + 默认 false」。
     *
     * <p>必填会直接损害上下文成本：这是本次优化的主题就是省 token，却给每次
     * task 调用都强加一个模型并不关心的字段（且字段描述本身也进了 schema）。</p>
     */
    private static void assertBackgroundIsOptional(ONode schemaNode, String where) {
        ONode bg = schemaNode.get("properties").get("background");
        Assertions.assertNotNull(bg, where + " 应暴露 background 参数");
        Assertions.assertEquals("boolean", bg.get("type").getString(), where + " 的 background 应为 boolean");
        Assertions.assertFalse(schemaNode.get("required").getArray().stream()
                        .anyMatch(n -> "background".equals(n.getString())),
                where + " 的 background 必须是可选参数（带 defaultValue 的开关不得进 required）");
    }

    /** await_tasks 必须被注册为工具，且三个参数中只有 tokens 必填。 */
    @Test
    public void awaitTasksSchemaShouldExposeOnlyTokensAsRequired() {
        TaskTalent taskTalent = new TaskTalent(null);

        List<FunctionTool> tools = (List<FunctionTool>) taskTalent.getToolAry(TaskTalent.TOOL_AWAIT_TASKS);
        Assertions.assertEquals(1, tools.size(), "await_tasks 应被注册为工具");

        FunctionTool tool = tools.get(0);
        ONode schema = ONode.ofJson(tool.inputSchema());
        ONode props = schema.get("properties");

        Assertions.assertEquals("array", props.get("tokens").get("type").getString());
        Assertions.assertEquals("integer", props.get("max_result_chars").get("type").getString());
        Assertions.assertEquals("integer", props.get("timeout_seconds").get("type").getString());

        List<String> required = schema.get("required").getArray().stream()
                .map(ONode::getString).collect(java.util.stream.Collectors.toList());
        Assertions.assertTrue(required.contains("tokens"), "tokens 必须为必填");
        Assertions.assertFalse(required.contains("max_result_chars"), "max_result_chars 必须可选（否则 0=不限制 的默认值无法生效）");
        Assertions.assertFalse(required.contains("timeout_seconds"), "timeout_seconds 必须可选");
        // 框架注入的下划线参数不得泄到 schema 里
        Assertions.assertNull(props.getOrNull("__sessionId"), "__sessionId 是框架注入参数，不得进 JSON schema");
    }

    @Test
    public void case2() throws Throwable {
        TaskTalent taskTalent = new TaskTalent(null);

        FunctionTool functionTool = ((List<FunctionTool>) taskTalent.getToolAry("multitask")).get(0);


        ONode oNode = ONode.ofJson(json, Feature.Read_AllowUnescapedControlCharacters);

        Map args = oNode.get("function").get("arguments").toBean(Map.class);

        Assertions.assertThrowsExactly(IllegalStateException.class, ()->{
            functionTool.call(args);
        },"__sessionId is required");
    }

    String json = "{\"id\":\"tool-f52c8e347ee54c86860ce093090d2bc6\",\"type\":\"function\",\"function\":{\"name\":\"multitask\",\"arguments\":{\"tasks\":\"[{\\\"index\\\": 1, \\\"agent_name\\\": \\\"backend-dev\\\", \\\"description\\\": \\\"开发权限管理后端系统\\\", \\\"prompt\\\": \\\"你是 demo1-web 权限管理系统的后端开发工程师。请基于已有的架构设计文档完成整个后端开发。\\n\\n## 已完成的设计文档\\n- 架构设计: demo1-web/backend/docs/architecture.md\\n- 数据库设计: demo1-web/backend/docs/database.md\\n- API设计: demo1-web/backend/docs/api.md\\n\\n## 技术要求 (严格遵守!)\\n### 框架: Solon v3.10.1 (不是 Spring!)\\n必须使用 Solon 框架，严禁使用任何 Spring 注解和依赖!\\n\\n### Solon 注解对照表:\\n| Spring | Solon |\\n|--------|-------|\\n| @SpringBootApplication | @SolonMain |\\n| @RestController | @Controller |\\n| @RequestMapping | @Mapping |\\n| @GetMapping | @Get |\\n| @PostMapping | @Post |\\n| @PutMapping | @Put |\\n| @DeleteMapping | @Delete |\\n| @Autowired | @Inject |\\n| @Service | @Component |\\n| @Repository | @Component |\\n| @Value | @Inject(\\\\\\\"${key}\\\\\\\") |\\n| @Configuration | @Configuration |\\n| @Bean | @Bean |\\n\\n### 项目配置:\\n- pom.xml 父 POM: org.noear:solon-parent:3.0.10 (或 3.0.10-M1)\\n- Solon 版本: 3.10.1 对应的依赖版本\\n- Java 版本: 8\\n- 数据库: H2 内存数据库\\n- ORM: MyBatis-Flex\\n\\n## 开发任务\\n\\n### 1. 创建项目结构\\n```\\ndemo1-web/backend/\\n├── pom.xml\\n├── src/main/java/com/demo/\\n│   ├── App.java (启动类，用 @SolonMain)\\n│   ├── controller/\\n│   ├── service/\\n│   ├── mapper/\\n│   ├── entity/\\n│   ├── dto/\\n│   ├── config/\\n│   ├── common/\\n│   └── exception/\\n├── src/main/resources/\\n│   ├── app.yml (注意: 不是 application.yml!)\\n│   └── schema.sql\\n└── src/test/\\n```\\n\\n### 2. 实现核心模块\\n- 用户管理 (UserController, UserService, UserMapper)\\n- 角色管理 (RoleController, RoleService, RoleMapper)\\n- 权限管理 (PermissionController, PermissionService, PermissionMapper)\\n- 菜单管理 (MenuController, MenuService, MenuMapper)\\n- 认证授权 (AuthController, AuthService, JwtUtil)\\n\\n### 3. 数据库初始化\\n- 创建 schema.sql 初始化脚本\\n- 包含默认管理员账号: admin/123456\\n\\n### 4. 实现细节\\n- 统一响应格式: Result<T>\\n- 密码 BCrypt 加密\\n- JWT Token 认证\\n- 跨域配置\\n- 全局异常处理\\n\\n### 5. 启动验证\\n- 使用 Solon.start(App.class, args) 启动\\n- 默认端口: 8080\\n\\n## 重要提醒\\n1. 所有注解必须使用 Solon 的，不能用 Spring 的\\n2. 配置文件名是 app.yml，不是 application.yml\\n3. 启动类用 @SolonMain 注解\\n4. 确保项目可以正常编译运行\\n\\n请完成所有后端代码开发，确保项目结构完整、代码规范、可以编译运行。\\\"}, {\\\"index\\\": 2, \\\"agent_name\\\": \\\"frontend-dev\\\", \\\"description\\\": \\\"开发权限管理前端界面\\\", \\\"prompt\\\": \\\"你是 demo1-web 权限管理系统的前端开发工程师。请基于已有的架构设计文档完成整个前端开发。\\n\\n## 已完成的设计文档\\n- 架构设计: demo1-web/backend/docs/architecture.md\\n- API设计: demo1-web/backend/docs/api.md\\n\\n## 技术要求\\n- 框架: Vue 3 (Composition API + script setup)\\n- 构建: Vite\\n- UI: Element Plus\\n- 状态: Pinia\\n- 路由: Vue Router 4\\n- HTTP: Axios\\n- 样式: SCSS\\n\\n## 开发任务\\n\\n### 1. 创建项目结构\\n```\\ndemo1-web/frontend/\\n├── package.json\\n├── vite.config.js\\n├── index.html\\n├── src/\\n│   ├── main.js\\n│   ├── App.vue\\n│   ├── api/\\n│   │   ├── auth.js\\n│   │   ├── user.js\\n│   │   ├── role.js\\n│   │   ├── permission.js\\n│   │   └── menu.js\\n│   ├── views/\\n│   │   ├── Login.vue\\n│   │   ├── Layout.vue\\n│   │   ├── Home.vue\\n│   │   ├── user/\\n│   │   │   └── UserList.vue\\n│   │   ├── role/\\n│   │   │   └── RoleList.vue\\n│   │   ├── permission/\\n│   │   │   └── PermList.vue\\n│   │   └── menu/\\n│   │       └── MenuList.vue\\n│   ├── components/\\n│   │   └── layout/\\n│   │       ├── Sidebar.vue\\n│   │       └── Header.vue\\n│   ├── stores/\\n│   │   ├── user.js\\n│   │   └── menu.js\\n│   ├── router/\\n│   │   └── index.js\\n│   ├── utils/\\n│   │   ├── request.js\\n│   │   └── auth.js\\n│   └── styles/\\n│       ├── variables.scss\\n│       └── global.scss\\n└── public/\\n```\\n\\n### 2. 实现核心功能\\n- 登录页面 (账号密码登录)\\n- 主布局 (左侧菜单 + 顶部导航 + 内容区)\\n- 用户管理 (列表、新增、编辑、删除、分配角色)\\n- 角色管理 (列表、新增、编辑、删除、分配权限)\\n- 权限管理 (树形结构、增删改查)\\n- 菜单管理 (树形结构、增删改查)\\n\\n### 3. 界面设计要求\\n- 整体风格: 清爽、现代、简约\\n- 配色: 主色调蓝色系 (#409EFF)\\n- 布局: 经典后台管理布局\\n- 交互: 友好提示、加载状态\\n\\n### 4. API 对接\\n- 后端地址: http://localhost:8080/api\\n- 请求拦截: 自动添加 Authorization 头\\n- 响应拦截: 统一错误处理\\n- Token 存储: localStorage\\n\\n### 5. 默认账号\\n- 用户名: admin\\n- 密码: 123456\\n\\n## 开发要求\\n1. 使用 Composition API 和 script setup 语法\\n2. 组件命名 PascalCase\\n3. API 请求统一管理\\n4. 表单验证完整\\n5. 代码整洁规范\\n\\n请完成所有前端代码开发，确保项目结构完整、界面美观、功能完整。\\\"}]\"}}}";
}