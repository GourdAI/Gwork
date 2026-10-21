package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * 「用户已点完全访问却仍弹审批」的两处<b>接线</b>契约。
 *
 * <p>为什么必须锁源码形态（本仓反复出现的失效形态：逻辑写对了、但没接上）：</p>
 *
 * <ul>
 *   <li>{@code WebController.access_select} 若只写档位、不调 {@code HITL.clearPending}，
 *       那张基于旧档位产生的审批卡会连同 {@code _last_intervened_}/{@code _pending_reason_}
 *       一起随快照持久化，刷新或重开会话还会被回放出来——而它代表的命令在新档位下
 *       本就不需要审批。实测样本 {@code work-mvhqk622}。</li>
 *   <li>{@code WebStreamBuilder} 若不写 {@code ATTR_INHERITED_KEY} 标记，审批门无法区分
 *       「会话值快照」与「Loop 任务级显式覆盖」，只能二选一：要不轮内切档不生效，
 *       要不当任务覆盖被会话值降档。</li>
 * </ul>
 *
 * <p>两条都是「删掉/改掉后行为静默退回旧缺陷」的位置，且被删时其它单元测试
 * 仍会全绿（策略层测试不经过这两个装配点）。</p>
 */
class AccessModeSwitchWiringTest {

    private static String readSource(String relativePath) {
        // surefire 的工作目录可能是仓库根或模块目录，两种都要兼容
        Path p = Paths.get(relativePath);
        if (!Files.exists(p)) {
            p = Paths.get("..").resolve(relativePath).normalize();
        }

        Assertions.assertTrue(Files.exists(p), "找不到源文件：" + p.toAbsolutePath());

        try {
            return Files.readString(p);
        } catch (Exception e) {
            throw new IllegalStateException("读取源文件失败：" + p.toAbsolutePath(), e);
        }
    }

    /**
     * 取一个方法体（从签名行到下一个同级闭合括号），用于只在该方法内做断言。
     *
     * <p>不做「全文搜字符串」：同一个词可能出现在注释、别的端点或 import 里，
     * 那种断言会给出假绿（本仓已有先例：契约测试把缺陷形状锁成正确形状）。</p>
     */
    private static String methodBody(String source, String signature) {
        int start = source.indexOf(signature);
        Assertions.assertTrue(start >= 0, "找不到方法签名：" + signature);

        int brace = source.indexOf('{', start);
        Assertions.assertTrue(brace > 0, "方法签名后没有方法体：" + signature);

        int depth = 0;
        for (int i = brace; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return source.substring(brace, i + 1);
                }
            }
        }

        Assertions.fail("方法体括号不配平：" + signature);
        return null;
    }

    // ===================== 一、切档必须解除挂起审批 =====================

    @Test
    void accessSelectClearsPendingApprovalWhenSwitchingToFull() {
        String source = readSource("src/main/java/com/gourdai/core/portal/web/WebController.java");
        String body = codeOnly(methodBody(source, "public Result access_select("));

        Assertions.assertTrue(body.contains("AccessMode.CTX_KEY"),
                "前置：access_select 必须写会话档位（本次改动的靶点）");
        Assertions.assertTrue(body.contains("HITL.clearPending"),
                "切档必须调用 HITL.clearPending：否则旧档位产生的审批卡会随快照持久化、"
                        + "重开时被回放，而它代表的命令在新档位下本不需审批");
        Assertions.assertTrue(body.contains("isFull"),
                "只能在切到完全访问时清理：在默认档下清掉挂起卡等于静默放行被拦的危险命令");
        Assertions.assertTrue(body.contains("ofHitlReleased") && body.contains("emitToClient"),
                "清挂起后必须广播 hitl_released 释放帧：已落盘的 hitl 帧在重开会话时会被回放"
                        + "重渲染成可点的死卡（后端已无挂起任务，点批准只会 ACTION_MISMATCH"
                        + " → 前端回退 pending → 死循环）；帧随出站落盘后回放也能按序收卡");
    }

    /**
     * 去掉注释后的代码文本。
     *
     * <p><b>为什么需要</b>：变异验证实测（M3）——把 {@code HITL.clearPending(session);}
     * 这行改成注释掉，断言 {@code body.contains("HITL.clearPending")} <b>仍然全绿</b>，
     * 因为注释里的文字也含这个词。这正是本仓反复踩的「存在型断言」假绿；
     * 只查代码可消除注释、文档与变异标记的干扰。</p>
     */
    private static String codeOnly(String text) {
        // 行注释
        String noLine = text.replaceAll("(?m)//[^\\n]*", "");
        // 块注释
        return noLine.replaceAll("(?s)/\\*.*?\\*/", "");
    }

    /** 清理动作本身必须同时清三样东西，漏一样都会留下僵尸态。 */
    @Test
    void clearPendingRemovesTaskPendingFlagAndResidualDecision() {
        String source = readSource("src/main/java/com/gourdai/agent/react/intercept/HITL.java");
        String body = codeOnly(methodBody(source, "public static HITLTask clearPending("));

        Assertions.assertTrue(body.contains("remove(LAST_INTERVENED)"),
                "必须移除挂起任务，否则前端会继续渲染审批卡");
        Assertions.assertTrue(body.contains("DECISION_PREFIX"),
                "必须移除同名工具的残留决策，否则下一张卡一建出来就被当成已批准直接放行");
        Assertions.assertTrue(body.matches("(?s).*session\\.pending\\(\\s*false\\s*,.*"),
                "必须清挂起标志：否则会话永远 isPending=true，后续输入会被当成恢复旧任务");
    }

    // ===================== 二、投影必须区分「继承」与「覆盖」 =====================

    @Test
    void webStreamBuilderMarksProjectionAsInheritedOnlyWithoutLoopOverride() {
        String source = codeOnly(readSource("src/main/java/com/gourdai/core/portal/web/WebStreamBuilder.java"));

        Assertions.assertTrue(source.contains("ATTR_INHERITED_KEY"),
                "WebStreamBuilder 必须写入继承标记：否则审批门无法区分会话快照与 Loop 显式覆盖，"
                        + "轮内切档不会生效（用户刚点完全访问仍被拦）");

        List<String> hits = new ArrayList<>();
        for (String line : source.split("\n")) {
            if (line.contains("ATTR_INHERITED_KEY") && line.contains("toolContextPut")) {
                hits.add(line.trim());
            }
        }

        Assertions.assertEquals(1, hits.size(),
                "继承标记只应有一处写入点（多处写入会互相覆盖，语义不可推断）：" + hits);
        Assertions.assertTrue(hits.get(0).contains("accessModeInherited"),
                "标记值必须来自「是否有本轮 override」的判定，而不是硬编码："
                        + "恒 false 会让轮内切档失效，恒 true 会让 Loop 任务级 full 被会话 default 降档");
    }

    /** Desktop 恢复轮的注入点：同一口径，缺了桌面端仍会「已切 full 还弹审批」。 */
    @Test
    void desktopHitlResumeAlsoMarksInheritedProjection() {
        String source = codeOnly(readSource("src/main/java/com/gourdai/core/portal/desktop/WsGate.java"));

        Assertions.assertTrue(source.contains("ATTR_INHERITED_KEY"),
                "桌面端 /ws 恢复轮与 Web 同口径：漏写继承标记会让桌面端仍按旧档判定");
    }

    /**
     * 审批门必须真的读标记，否则上游写多少标记都没用（典型「写了但没人消费」假绿）。
     */
    @Test
    void hitlInterceptorConsumesTheInheritedFlag() {
        String source = codeOnly(readSource("src/main/java/com/gourdai/agent/react/intercept/HITLInterceptor.java"));

        Assertions.assertTrue(source.contains("ATTR_INHERITED_KEY"),
                "HITLInterceptor.accessModeOf 必须消费继承标记，否则该标记是死代码");
        Assertions.assertTrue(source.contains("isInheritedProjection"),
                "标记解析必须走统一方法，避免各处对 true/\"true\"/空串的口径漂移");
    }
}
