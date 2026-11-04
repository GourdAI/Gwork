package com.gourdai.ai.mcp;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.McpJsonMapperSupplier;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.ServiceLoader;

/**
 * MCP JSON 实现可用性护栏。
 *
 * <p>背景（真实事故）：mcp-core 只提供 JSON 抽象（McpJsonMapper 接口 + McpJsonMapperSupplier SPI 接口），
 * 实现由 mcp-json-jackson2 通过 META-INF/services 注册。上游 solon-ai-mcp 聚合包被抽离、改为直接依赖
 * mcp-core 后，mcp-json-jackson2 的传递链断裂，而 javac 只认接口、编译照样通过，缺陷一路潜伏到运行期：
 * 每一次 MCP 调用（websearch / codesearch / mcp 网关 / 设置页连接测试）都抛
 * {@code ServiceConfigurationError: No McpJsonMapperSupplier available for creating McpJsonMapper}。
 *
 * <p>这两个用例直接断言运行期事实（SPI 能被发现、Mapper 能被创建），而非检查 pom 文本，
 * 因此无论将来依赖怎么重组，只要实现再次掉出 classpath 就会在测试阶段暴露。
 */
class McpJsonMapperAvailabilityTest {

    @Test
    @DisplayName("classpath 上必须存在 McpJsonMapperSupplier 的 SPI 实现")
    void mcpJsonMapperSupplierIsRegisteredOnClasspath() {
        List<String> suppliers = new ArrayList<>();
        for (McpJsonMapperSupplier supplier : ServiceLoader.load(McpJsonMapperSupplier.class)) {
            suppliers.add(supplier.getClass().getName());
        }

        Assertions.assertFalse(suppliers.isEmpty(),
                "未发现任何 McpJsonMapperSupplier 实现：mcp-json-jackson2 很可能掉出了 classpath，"
                        + "所有 MCP 工具（websearch/codesearch/mcp/openapi）都会在运行期失败");
    }

    @Test
    @DisplayName("McpJsonDefaults.getMapper() 必须能返回可用实例，且可完成一次 JSON 往返")
    void defaultMapperIsResolvableAndUsable() throws Exception {
        // getMapper() 正是 McpClientProvider 与两个自定义 transport 的取用入口，事故现场即此调用。
        McpJsonMapper mapper = Assertions.assertDoesNotThrow(
                McpJsonDefaults::getMapper,
                "McpJsonDefaults.getMapper() 抛错说明 MCP JSON 实现缺失");

        Assertions.assertNotNull(mapper, "McpJsonMapper 不应为 null");

        // 不止“拿得到”，还要真的能用：序列化 + 反序列化往返一次。
        String json = mapper.writeValueAsString(new Probe("gourdai", 42));
        Probe back = mapper.readValue(json, Probe.class);

        Assertions.assertEquals("gourdai", back.getName());
        Assertions.assertEquals(42, back.getValue());
    }

    /** 往返用的简单 POJO（需无参构造 + getter/setter 以适配 Jackson 默认行为）。 */
    public static class Probe {
        private String name;
        private int value;

        public Probe() {
        }

        public Probe(String name, int value) {
            this.name = name;
            this.value = value;
        }

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public int getValue() {
            return value;
        }

        public void setValue(int value) {
            this.value = value;
        }
    }
}
