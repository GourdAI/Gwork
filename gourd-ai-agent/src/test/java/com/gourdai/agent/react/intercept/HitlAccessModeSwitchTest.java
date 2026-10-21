package com.gourdai.agent.react.intercept;

import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActOptions;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ToolExchanger;
import com.gourdai.ai.chat.message.ChatMessage;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.permission.AccessMode;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.flow.FlowContext;

import java.lang.reflect.Field;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 「用户已切完全访问，却仍弹审批」的两条回归护栏。
 *
 * <p>2026-10-21 实机取证（会话 {@code work-mvhqk622}）：快照 {@code _access_mode=full}，
 * 却残留 {@code _pending_reason_=「当前为默认权限…」}。根因有两条，本类各锁一条：</p>
 *
 * <ol>
 *   <li><b>轮内切档不生效</b>：{@code toolContext.__accessMode} 在每轮开始时写一次，
 *       而 {@code /web/chat/access/select} 只改会话上下文。审批门若无条件读投影，
 *       正在跑的这一轮里后续命令仍按旧档判定。</li>
 *   <li><b>挂起审批不解除</b>：切到 full 时只写档位，那张基于旧档位产生的审批卡
 *       连同 {@code isPending} 一起留在会话里，刷新/重开还会被回放出来。</li>
 * </ol>
 *
 * <h4>为什么必须同时保留「显式覆盖优先」</h4>
 *
 * <p>Loop 定时任务的任务级档位刻意不写会话上下文（避免污染用户前台选择），只经投影透传；
 * 若为修 (1) 而无条件改读会话，任务级 full 会被会话 default 降档——那是
 * {@code AccessModePerTurnOverrideTest} 锁死的契约。故本类同时断言两条分支都在。</p>
 */
class HitlAccessModeSwitchTest {

    // ===================== 夹具 =====================

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
                return "sess-access-switch";
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

    /** 带 toolContext 投影的 trace：inherited 决定投影是「会话快照」还是「显式覆盖」。 */
    private static ReActTrace traceWithProjection(FlowContext ctx, String projectedMode, Boolean inherited) {
        return traceWithProjection(ctx, projectedMode, inherited, null);
    }

    /** 同上，并可挂载 session（挂起路径会调 session.pending，缺了会 NPE）。 */
    private static ReActTrace traceWithProjection(FlowContext ctx, String projectedMode, Boolean inherited,
                                                  AgentSession session) {
        ReActTrace trace = new ReActTrace() {
            @Override
            public FlowContext getContext() {
                return ctx;
            }

            @Override
            public AgentSession getSession() {
                return session;
            }
        };

        ReActOptions options = new ReActOptions(null);
        if (projectedMode != null) {
            options.getToolContext().put(AccessMode.ATTR_KEY, projectedMode);
        }
        if (inherited != null) {
            options.getToolContext().put(AccessMode.ATTR_INHERITED_KEY, inherited);
        }

        try {
            Field f = ReActTrace.class.getDeclaredField("options");
            f.setAccessible(true);
            f.set(trace, options);
        } catch (Exception e) {
            throw new IllegalStateException("cannot inject options for test", e);
        }

        return trace;
    }

    private static ToolExchanger dangerousBash() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("command", "rm -rf node_modules");
        return new ToolExchanger("bash", args, "call-switch-1");
    }

    private static HITLInterceptor interceptor() {
        return new HITLInterceptor().onTool("bash", new com.gourdai.harness.hitl.HitlStrategy());
    }

    // ===================== 一、轮内切档立即生效 =====================

    /**
     * 核心回归：轮初写入的继承型投影是「默认」，用户在轮内切到 full 后必须立刻放行。
     *
     * <p>这就是用户报障的那条路径——旧实现因投影优先而继续弹审批。</p>
     */
    @Test
    void inTurnSwitchToFullTakesEffectImmediately() {
        FlowContext ctx = FlowContext.of();
        // 轮初快照：默认档（投影 = 会话值）
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());

        AgentSession session = sessionOf(ctx);
        ReActTrace trace = traceWithProjection(ctx, AccessMode.DEFAULT.code(), true, session);

        // 用户在本轮进行中点「完全访问」（/web/chat/access/select 只写会话上下文）
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());

        interceptor().onAction(trace, dangerousBash());

        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "轮内切到完全访问后，后续命令必须立即放行：继承型投影不得覆盖用户的新选择");
        Assertions.assertFalse(session.isPending(), "不得挂起");
    }

    /** 反向：轮内从 full 切回 default 时，继承型投影同样跟随，收紧不被旧 full 拖住。 */
    @Test
    void inTurnSwitchToDefaultTakesEffectImmediately() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());

        AgentSession session = sessionOf(ctx);
        // 轮初投影 = 会话值 full（继承型）；随后用户在本轮内收紧到默认档
        ReActTrace trace = traceWithProjection(ctx, AccessMode.FULL.code(), true, session);
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());

        interceptor().onAction(trace, dangerousBash());

        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                "轮内收紧到默认档后必须恢复审批");
        Assertions.assertTrue(session.isPending());
    }

    /**
     * 契约保护：无继承标记的投影是<b>显式覆盖</b>（Loop 任务级），必须优先于会话档位。
     *
     * <p>这条与 {@code AccessModePerTurnOverrideTest} 同向，此处再锁一次是为了防止
     * 「为了修轮内切换而把整个优先级调反」。</p>
     */
    @Test
    void explicitOverrideStillWinsOverSession() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code()); // 会话存档=默认
        ReActTrace trace = traceWithProjection(ctx, AccessMode.FULL.code(), null); // 无标记=显式覆盖

        AgentSession session = sessionOf(ctx);
        interceptor().onAction(trace, dangerousBash());

        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "任务级完全访问必须放行，不得因会话存档为默认档而回弹审批");
        Assertions.assertFalse(session.isPending());
    }

    /** 显式覆盖为默认档时，即使会话是 full 也必须拦（后台任务不得借用前台的全权）。 */
    @Test
    void explicitDefaultOverrideIsNotEscalatedBySessionFull() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        ReActTrace trace = traceWithProjection(ctx, AccessMode.DEFAULT.code(), false);

        AgentSession session = sessionOf(ctx);
        interceptor().onAction(traceWithProjection(ctx, AccessMode.DEFAULT.code(), false, session), dangerousBash());

        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED),
                "任务级默认档必须压过会话的完全访问，否则定时任务借前台档位越权");
        Assertions.assertTrue(session.isPending());
    }

    // ===================== 二、切 full 时解除挂起审批 =====================

    /** 切换档位必须清掉挂起卡、挂起标志与残留决策。 */
    @Test
    void switchingToFullClearsPendingApproval() {
        FlowContext ctx = FlowContext.of();
        ctx.put(AccessMode.CTX_KEY, AccessMode.DEFAULT.code());
        AgentSession session = sessionOf(ctx);

        // 先制造一次真实挂起（默认档 + 危险命令）
        interceptor().onAction(traceWithProjection(ctx, AccessMode.DEFAULT.code(), true, session), dangerousBash());
        Assertions.assertNotNull(ctx.getAs(HITL.LAST_INTERVENED), "前置条件：默认档下应先挂起");
        Assertions.assertTrue(session.isPending());

        // 用户切到完全访问
        ctx.put(AccessMode.CTX_KEY, AccessMode.FULL.code());
        HITL.clearPending(session);

        Assertions.assertNull(ctx.getAs(HITL.LAST_INTERVENED),
                "切 full 后必须清掉挂起卡，否则它会被快照持久化并在重开时回放");
        Assertions.assertFalse(session.isPending(),
                "挂起标志必须清除，否则会话永远停在等待态，后续输入会被当成恢复旧任务");
        Assertions.assertNull(ctx.getAs(HITL.DECISION_PREFIX + "bash"),
                "残留决策必须一并清除，否则下一张卡一建出来就被当成已批准直接放行");
    }

    /** 无挂起时调用必须是无害的（设置页可能在任意时刻保存档位）。 */
    @Test
    void clearingWithoutPendingIsNoOp() {
        FlowContext ctx = FlowContext.of();
        AgentSession session = sessionOf(ctx);

        HITLTask cleared = HITL.clearPending(session);

        Assertions.assertNull(cleared);
        Assertions.assertFalse(session.isPending());
    }
}
