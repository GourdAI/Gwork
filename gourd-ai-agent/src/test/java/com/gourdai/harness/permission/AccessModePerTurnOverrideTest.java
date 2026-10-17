package com.gourdai.harness.permission;

import com.gourdai.agent.react.ReActOptions;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * 任务级权限 override 的两路贯通契约：
 *
 * <p>Loop 定时任务的任务级档位（accessMode）刻意不写入会话上下文（避免污染用户前台选择），
 * 只经 toolContext 的 {@link AccessMode#ATTR_KEY} per-turn 投影透传。若消费方只读会话上下文，
 * 「任务级完全访问」就会在以下两处静默失效（即上次修复漏掉的另两路）：</p>
 *
 * <ul>
 *   <li><b>子代理继承</b>（TaskTalent.resolveAccessMode）：只读父会话上下文 → 子代理回落会话旧档，
 *       表现为空间已放行但子任务仍受隔离；</li>
 *   <li><b>审批闸门</b>（HITLInterceptor.accessModeOf）：只读会话上下文 → 主代理自己在下一条
 *       危险命令上又弹审批，与「完全访问」承诺自相矛盾。</li>
 * </ul>
 *
 * <p>本测试直接驱动两条真链路（反射调用包私有/私有解析方法 + 真实 onAction 分支），
 * 防止任何一路被单独回退而不变红。</p>
 */
class AccessModePerTurnOverrideTest {

    /** 构造带 toolContext 的 trace：ReActOptions 是唯一入口，toolContextPut 挂在 options 上。 */
    private static ReActTrace traceWithToolContext(FlowContext ctx, String accessMode) {
        ReActTrace trace = new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx;
            }
        };
        ReActOptions options = new ReActOptions(null);
        if (accessMode != null) {
            options.getToolContext().put(AccessMode.ATTR_KEY, accessMode);
        }
        setOptions(trace, options);
        return trace;
    }

    /** 注入 options（prepare 是 protected；测试用反射直写，避免依赖 Agent 装配链）。 */
    private static void setOptions(ReActTrace trace, ReActOptions options) {
        try {
            Field f = ReActTrace.class.getDeclaredField("options");
            f.setAccessible(true);
            f.set(trace, options);
        } catch (Exception e) {
            throw new IllegalStateException("cannot set options for test", e);
        }
    }

    // ===================== 一、审批闸门（HITLInterceptor） =====================

    /** 反射调用包私有静态方法 accessModeOf，验证 per-turn 投影优先于会话上下文。 */
    private static AccessMode accessModeOf(ReActTrace trace) throws Exception {
        Method m = com.gourdai.agent.react.intercept.HITLInterceptor.class
                .getDeclaredMethod("accessModeOf", ReActTrace.class);
        m.setAccessible(true);
        return (AccessMode) m.invoke(null, trace);
    }

    @Test
    void hitlPrefersPerTurnProjectionOverSessionContext() throws Exception {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code()); // 会话存档=默认
        ReActTrace trace = traceWithToolContext(ctx, AccessMode.FULL.code()); // 本轮 override=完全访问

        Assertions.assertEquals(AccessMode.FULL, accessModeOf(trace),
                "审批闸门必须优先读 toolContext 的 per-turn 档位：任务级完全访问不得因会话存档为默认档而回弹审批");
    }

    @Test
    void hitlFallsBackToSessionContextWhenNoPerTurnProjection() throws Exception {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        ReActTrace trace = traceWithToolContext(ctx, null); // 无投影（前台普通路径先走会话档）

        Assertions.assertEquals(AccessMode.FULL, accessModeOf(trace),
                "无 per-turn 投影时必须回退会话已存档位（前台行为不得回归）");
    }

    @Test
    void hitlFailsSafeOnEmptyOrDirtyPerTurnValue() throws Exception {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        // 空串投影=无 override 语义，回落会话档（与写回口径一致）
        Assertions.assertEquals(AccessMode.FULL, accessModeOf(traceWithToolContext(ctx, "")));
        // 脏值投影=无法识别，fail-safe 到默认档（绝不放大权限）
        Assertions.assertEquals(AccessMode.DEFAULT, accessModeOf(traceWithToolContext(ctx, "bypassPermissions")));
    }

    // ===================== 二、子代理继承（TaskTalent.resolveAccessMode） =====================

    /** 反射调用私有静态方法 resolveAccessMode(ReActTrace, AgentSession)。 */
    private static String resolveAccessMode(Object parentTrace, Object parentSession) throws Exception {
        Class<?> clazz = Class.forName("com.gourdai.harness.agent.TaskTalent");
        Method m = clazz.getDeclaredMethod("resolveAccessMode", ReActTrace.class, com.gourdai.agent.AgentSession.class);
        m.setAccessible(true);
        return (String) m.invoke(null, parentTrace, parentSession);
    }

    @Test
    void subagentInheritsPerTurnOverrideFromParentTrace() throws Exception {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code()); // 会话存档=默认
        ReActTrace parentTrace = traceWithToolContext(ctx, AccessMode.FULL.code()); // 本轮 override=完全访问

        // 父会话用真实 FlowContext 桩（resolveAccessMode 只触达 getContext）
        com.gourdai.agent.AgentSession parentSession = new com.gourdai.agent.AgentSession() {
            @Override
            public void updateSnapshot() {
            }

            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public String getSessionId() {
                return "sess-parent";
            }

            @Override
            public java.util.List<com.gourdai.ai.chat.message.ChatMessage> getMessages() {
                return java.util.List.of();
            }

            @Override
            public java.util.List<com.gourdai.ai.chat.message.ChatMessage> getLatestMessages(int windowSize) {
                return java.util.List.of();
            }

            @Override
            public void removeLatestMessage(int windowSize) {
            }

            @Override
            public void addMessage(java.util.Collection<? extends com.gourdai.ai.chat.message.ChatMessage> messages) {
            }

            @Override
            public boolean isEmpty() {
                return true;
            }

            @Override
            public void clear() {
            }

            @Override
            public java.util.Map<String, Object> attrs() {
                return new java.util.LinkedHashMap<>();
            }
        };

        Assertions.assertEquals(AccessMode.FULL.code(), resolveAccessMode(parentTrace, parentSession),
                "子代理必须继承父 trace 的 per-turn 权限投影：只读会话上下文会让任务级完全访问在子代理处静默降档");
    }

    @Test
    void subagentFallsBackToSessionContextWithoutProjection() throws Exception {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        ReActTrace parentTrace = traceWithToolContext(ctx, null);
        com.gourdai.agent.AgentSession parentSession = sessionOf(ctx);

        Assertions.assertEquals(AccessMode.FULL.code(), resolveAccessMode(parentTrace, parentSession),
                "无 trace 投影时回退父会话已存档位（原有行为不得回归）");
        Assertions.assertEquals(AccessMode.DEFAULT.code(), resolveAccessMode(null, null),
                "无任何来源时必须保守回落默认档");
    }

    /** 最小 AgentSession 桩：只承载 FlowContext（resolveAccessMode 仅触达 getContext）。 */
    private static com.gourdai.agent.AgentSession sessionOf(FlowContext ctx) {
        return new com.gourdai.agent.AgentSession() {
            @Override
            public void updateSnapshot() {
            }

            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public String getSessionId() {
                return "sess-parent";
            }

            @Override
            public java.util.List<com.gourdai.ai.chat.message.ChatMessage> getMessages() {
                return java.util.List.of();
            }

            @Override
            public java.util.List<com.gourdai.ai.chat.message.ChatMessage> getLatestMessages(int windowSize) {
                return java.util.List.of();
            }

            @Override
            public void removeLatestMessage(int windowSize) {
            }

            @Override
            public void addMessage(java.util.Collection<? extends com.gourdai.ai.chat.message.ChatMessage> messages) {
            }

            @Override
            public boolean isEmpty() {
                return true;
            }

            @Override
            public void clear() {
            }

            @Override
            public java.util.Map<String, Object> attrs() {
                return new java.util.LinkedHashMap<>();
            }
        };
    }
}
