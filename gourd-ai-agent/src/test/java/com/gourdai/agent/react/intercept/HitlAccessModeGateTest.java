package com.gourdai.agent.react.intercept;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.harness.permission.AccessMode;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 档位闸门接线契约：HITLInterceptor 必须按「会话上下文里的档位」决定弹不弹审批。
 *
 * <p>背景（变异测试实测）：把 onAction 里的档位早退删掉、或把 AgentFactory 的
 * {@code setEnabled(true)} 退回按引擎级全局开关装配拦截器，
 * 全仓既有测试<b>无一变红</b>——因为所有 HITL 测试都绕开了 onAction 的真实分支。
 * 本测试直接驱动 onAction 真链路：默认档 + 危险命令必须挂起，完全访问档必须放行。</p>
 */
class HitlAccessModeGateTest {

    /** 最小 AgentSession 桩：只承载 FlowContext，其余方法不会被 onAction 触达。 */
    private static AgentSession sessionOf(FlowContext ctx) {
        return new AgentSession() {
            @Override
            public void updateSnapshot() {
            }

            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public String getSessionId() {
                return "sess-access-gate";
            }

            @Override
            public List<ChatMessage> getMessages() {
                return List.of();
            }

            @Override
            public List<ChatMessage> getLatestMessages(int windowSize) {
                return List.of();
            }

            @Override
            public void removeLatestMessage(int windowSize) {
            }

            @Override
            public void addMessage(Collection<? extends ChatMessage> messages) {
            }

            @Override
            public boolean isEmpty() {
                return true;
            }

            @Override
            public void clear() {
            }

            @Override
            public Map<String, Object> attrs() {
                return new LinkedHashMap<>();
            }
        };
    }

    private static ReActTrace traceOf(FlowContext ctx, AgentSession session) {
        return new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public AgentSession getSession() {
                return session;
            }
        };
    }

    private static ToolExchanger dangerousBash() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "rm -rf node_modules");
        return new ToolExchanger("bash", args, "call-gate-1");
    }

    private HITLInterceptor interceptor() {
        return new HITLInterceptor().onTool("bash", new com.gourdai.harness.hitl.HitlStrategy());
    }

    @Test
    void defaultModeSuspendsDangerousCommand() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        interceptor().onAction(traceOf(ctx, session), dangerousBash());

        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                "默认档下危险命令必须挂起等待审批，否则默认档的承诺（危险命令需审批）落空");
        Assertions.assertTrue(session.isPending(), "挂起必须把会话置为 pending，前端据此渲染审批卡");
    }

    @Test
    void fullModeReleasesTheSameCommand() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        AgentSession session = sessionOf(ctx);

        interceptor().onAction(traceOf(ctx, session), dangerousBash());

        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "完全访问档下不得再挂起审批，否则用户确认过的放行不生效");
        Assertions.assertFalse(session.isPending());
    }

    @Test
    void dirtyOrMissingModeFailsSafeToSuspend() {
        for (Object dirty : new Object[]{null, "bypassPermissions", "full_access", ""}) {
            FlowContext ctx = FlowContext.of();
            if (dirty != null) {
                ctx.put(AccessMode.CTX_KEY, dirty);
            }
            AgentSession session = sessionOf(ctx);

            interceptor().onAction(traceOf(ctx, session), dangerousBash());

            Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                    "脏值/缺省档位必须回落默认档（挂起审批），绝不能变成放行：" + dirty);
        }
    }

    @Test
    void unregisteredToolIsNeverInterceptedRegardlessOfMode() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        Map<String, Object> args = new LinkedHashMap<>();
        args.put("file_path", "src/a.java");
        interceptor().onAction(traceOf(ctx, session), new ToolExchanger("read", args, "call-gate-2"));

        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "未登记策略的工具（read）不走命令审批，边界由 resolveSafePath 独立保障");
    }
}
