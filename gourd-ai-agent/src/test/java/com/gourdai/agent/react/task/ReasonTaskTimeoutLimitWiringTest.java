package com.gourdai.agent.react.task;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「超时类失败独立限次」的<b>接线</b>守护。
 *
 * <p>判定逻辑本身由 {@code LlmRetryPolicyTimeoutTest} 以真实行为断言覆盖；本类只解决一个
 * 它覆盖不到的盲区：<b>那段逻辑有没有真的接在 {@code ReasonTask} 的重试链上</b>。
 * 若某次重构把 {@code retryIf(...)} 删掉或改成别的判定，行为测试依旧全绿，
 * 而生产环境会静默退回「34 次重试空转 67.6 分钟」的老路（会话 {@code work-mua28gy6}）。</p>
 *
 * @author oisin
 * @since 4.1
 */
class ReasonTaskTimeoutLimitWiringTest {

    private static final Path REASON_TASK_SOURCE = Paths.get(
            "src/main/java/com/gourdai/agent/react/task/ReasonTask.java");

    @Test
    @DisplayName("callWithRetry 的重试链上确实挂着超时限次判定")
    void timeoutLimitIsWiredIntoRetryChain() throws IOException {
        String source = readSource();

        assertTrue(source.contains("TIMEOUT_FAILURE_LIMIT"),
                "超时限次常量缺失：超时与 429 会重新共用同一个重试预算");
        assertTrue(source.contains(".retryIf("),
                "RetryTask 上未接 retryIf：限次判定不会生效");
        assertTrue(source.contains("LlmRetryPolicy.isTimeoutLike("),
                "retryIf 未使用 isTimeoutLike 判定：会退化为按消息文本或一刀切判断");
    }

    @Test
    @DisplayName("限次取值必须明显小于 maxRetries 的常见配置，否则等于没限")
    void timeoutLimitIsTightEnoughToMatter() throws IOException {
        String source = readSource();

        assertTrue(source.contains("TIMEOUT_FAILURE_LIMIT = 2"),
                "限次应为 2：一次重试覆盖瞬时抖动，连续两次超时即属系统性原因，"
                        + "再试只是让上游把同样的大上下文重新生成一遍");
    }

    @Test
    @DisplayName("非超时错误必须先行放行，不得被限次逻辑误伤")
    void nonTimeoutErrorsAreShortCircuited() throws IOException {
        String source = readSource();

        int predicateAt = source.indexOf(".retryIf(");
        assertTrue(predicateAt > 0, "未找到 retryIf 接线");

        String predicateBody = source.substring(predicateAt,
                Math.min(source.length(), predicateAt + 1200));

        assertTrue(predicateBody.contains("isTimeoutLike(e) == false"),
                "谓词必须先对非超时错误 return true（429/5xx 的既有重试预算不得被削减）");
    }

    private static String readSource() throws IOException {
        assertTrue(Files.exists(REASON_TASK_SOURCE),
                "找不到 ReasonTask 源码（测试须在 gourd-ai-agent 模块目录下运行）: "
                        + REASON_TASK_SOURCE.toAbsolutePath());

        return new String(Files.readAllBytes(REASON_TASK_SOURCE), StandardCharsets.UTF_8);
    }
}
