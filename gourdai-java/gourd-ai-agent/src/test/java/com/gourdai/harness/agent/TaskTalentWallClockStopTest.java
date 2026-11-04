/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.agent.session.InMemoryAgentSession;
import com.gourdai.harness.HarnessEngine;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 后台子代理「墙钟止损」契约测试：提交后 BACKGROUND_WALL_CLOCK_MINUTES 内未出结果自动停流。
 *
 * <p><b>本轮解决的问题</b>：原有三层超时（await_tasks 等待预算、注册表 TTL、单次模型调用封顶）
 * <b>都不停任务</b>——await 超时只让主代理放弃等待，TTL 只摘回执，单次调用封顶只约束一次模型调用。
 * 多回合子代理的总墙钟没有上界，失控任务会一直烧 token 直到用户手动 Stop。</p>
 *
 * <p><b>测试分层</b>：CAS 语义（取消原因归属的唯一判据）真调 {@code fireWallClockStop}；
 * 接线与取值窗口（45 分钟必须落在「单次调用封顶 25 分钟」与「注册表 TTL 60 分钟」之间）用源码扫描。
 * 定时器本身 45 分钟不可等待，故其接线只能结构性断言——但 CAS 与文案分叉这两个「会烧错钱/误导模型」
 * 的行为点全部真调，不用源码扫描冒充。</p>
 *
 * @author oisin
 */
public class TaskTalentWallClockStopTest {

    private static final String TASK_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/harness/agent/TaskTalent.java";
    private static final String CHAT_DESC_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/ai/chat/ChatRequestDescDefault.java";
    private static final String REASON_TASK_SOURCE_PATH =
            "gourd-ai-agent/src/main/java/com/gourdai/agent/react/task/ReasonTask.java";

    @TempDir
    Path temp;

    // ══════════════════════════════════════════════════════════════
    //  1. 行为：CAS 语义决定「终止原因归属」
    // ══════════════════════════════════════════════════════════════

    /**
     * 墙钟动作必须用 CAS 置取消位，且返回值表达「是否抢到取消位」。
     *
     * <p>这是取消原因分叉的唯一判据：用户 Stop 抢先置位时墙钟必须返回 false（从而报
     * 「用户终止」文案）；若实现退化成 set(true) 或恒返回 true，用户亲手停掉的任务会收到
     * 「请拆分重派」的墙钟文案，模型据此重派一个用户刚停掉的任务。</p>
     */
    @Test
    public void wallClockStopMustUseCasAndReportWhetherItWonTheFlag() {
        TaskTalent talent = newEngine().getTaskTalent();

        AtomicBoolean fresh = new AtomicBoolean(false);
        Assertions.assertTrue(talent.fireWallClockStop("s1", "inv-1", fresh),
                "取消位空闲时墙钟必须抢到并返回 true");
        Assertions.assertTrue(fresh.get(), "抢到取消位后必须真的置位，否则 takeUntil 不会停流");

        Assertions.assertFalse(talent.fireWallClockStop("s1", "inv-1", fresh),
                "重复触发必须返回 false：原因归属只能记一次");

        AtomicBoolean userStopped = new AtomicBoolean(true); // 用户 Stop 已抢先置位
        Assertions.assertFalse(talent.fireWallClockStop("s1", "inv-2", userStopped),
                "用户 Stop 抢先时墙钟必须返回 false，否则取消分支会把用户终止误报成墙钟");
        Assertions.assertTrue(userStopped.get(), "墙钟不得改动既有的取消位状态");
    }

    // ══════════════════════════════════════════════════════════════
    //  2. 接线：detached 分支必须登记墙钟、按 fired 分叉文案、finally 撤定时器
    // ══════════════════════════════════════════════════════════════

    /**
     * detached 分支的取消分支必须按 wallClockFired 分叉文案，且不得用「定时器是否 pending」判原因。
     *
     * <p>后者是本轮实测推翻的第一版判据：用户 Stop 走到取消分支时 finally 尚未撤定时器，
     * isCancelled() 同样为 false，会把用户终止误报成墙钟。判据必须是「墙钟动作是否真的执行过」。</p>
     */
    @Test
    public void cancelBranchMustForkMessageOnFiredMarkerNotOnTimerState() throws Exception {
        String taskDo = extractMethod(strippedTaskSource(), "taskDo");

        Assertions.assertTrue(taskDo.contains("scheduleWallClockStop("),
                "detached 分支必须登记墙钟定时器，否则总墙钟仍无上界");
        Assertions.assertTrue(taskDo.contains("wallClockFired.get()"),
                "取消分支必须读 fired 标记做原因分叉");
        Assertions.assertTrue(normalize(taskDo).contains(
                        "wallClockFired.get() ? WALL_CLOCK_MESSAGE : CANCELLED_MESSAGE"),
                "分叉方向必须是 fired→墙钟文案 / 否则→用户终止文案（反了会劝模型重派用户停掉的任务）");
        Assertions.assertFalse(taskDo.contains("wallClock.isCancelled()"),
                "不得用定时器 pending 状态判原因：用户 Stop 路径下它同样 pending，会误报成墙钟");
        // 接线传参：调用点必须把本任务的取消位与 fired 标记成对传入。
        // 只断言方法名会出现弱断言盲区：把实参换成别的 AtomicBoolean 后墙钟永远 CAS 不到
        // 本任务的取消位 = 止损彻底失效，而名字断言仍全绿。（断言在 taskDo 作用域：
        // 调用点在 detached 分支，scheduleWallClockStop 方法体内看不到这串实参。）
        Assertions.assertTrue(taskDo.contains("scheduleWallClockStop(__sessionId, invocationId, cancelFlag, wallClockFired)"),
                "detached 分支必须把本任务的取消位与 fired 标记成对传入：传错任一侧都会让原因分叉读到别处的状态");

        // finally 必须先撤定时器再摘取消位
        int cancelTimer = taskDo.indexOf("wallClock.cancel(false)");
        int unregister = taskDo.indexOf("unregisterCancellable(");
        Assertions.assertTrue(cancelTimer > 0, "finally 必须撤墙钟定时器，否则任务结束后仍会触发误导日志");
        Assertions.assertTrue(unregister > cancelTimer,
                "撤定时器必须先于摘取消位，顺序反了会留下已收尾任务被置 fired 的窗口");
    }

    /**
     * 定时器接线：必须走 RunUtil.timer()、用 BACKGROUND_WALL_CLOCK_MINUTES 延时、
     * 且 CAS 抢到后才置 fired 标记。
     */
    @Test
    public void schedulerMustUseTimerPoolAndMarkFiredOnlyWhenCasWins() throws Exception {
        String src = strippedTaskSource();
        String schedule = extractMethod(src, "scheduleWallClockStop");
        String fire = extractMethod(src, "fireWallClockStop");

        Assertions.assertTrue(schedule.contains("RunUtil.timer()"),
                "墙钟必须走 timer 池：io() 工作池里等待会占死平台线程整个时长");
        Assertions.assertFalse(schedule.contains("RunUtil.io()"), "不得占用并行工作池");
        Assertions.assertFalse(schedule.contains("Thread.sleep"), "不得以 sleep 实现延时");
        Assertions.assertTrue(schedule.contains("BACKGROUND_WALL_CLOCK_MINUTES, TimeUnit.MINUTES"),
                "延时必须取墙钟常量，硬编码分钟数会让取值窗口断言失去锚点");
        Assertions.assertTrue(schedule.contains("firedMarker.set(true)"),
                "CAS 抢到取消位后必须置 fired 标记，否则取消分支永远报用户终止文案");
        // 接线传参：定时器 lambda 必须拿到「本任务的取消位」与「本任务的 fired 标记」。
        // 只断言方法名会出现弱断言盲区：把实参换成别的 AtomicBoolean（如常量/空 flag）后
        // 墙钟永远 CAS 不到本任务的取消位 = 止损彻底失效，而名字断言仍全绿。
        Assertions.assertTrue(schedule.contains("fireWallClockStop(sessionId, invocationId, cancelFlag)"),
                "定时器 lambda 必须作用于本任务的取消位：传错 flag 时墙钟置位与 takeUntil 读的位脱钩，止损静默失效");

        Assertions.assertTrue(fire.contains("compareAndSet(false, true)"),
                "墙钟动作必须 CAS 置位，set(true) 会丢失「是否抢先」这一原因判据");
        Assertions.assertFalse(fire.contains("set(true)"),
                "不得用 set(true)：它会覆盖用户 Stop 的原因归属");
        Assertions.assertFalse(fire.contains("cancel(true)"), "不得中断线程：可能留下写一半的文件");
        Assertions.assertFalse(fire.contains(".interrupt()"), "不得 interrupt 工作线程");
    }

    /**
     * catch 路径（流以 onError 收敛）的收卡文案必须与 runEnd==null 分支同口径分叉，不得无条件 ERROR。
     *
     * <p>takeUntil 截断流后上游可能以 onError（如 CancellationException）而非正常 complete 收敛，
     * 此刻异常只是「取消的形态」；若 catch 无条件报 ERROR，用户 Stop / 墙钟停掉的任务在模型侧
     * 会变成可重试失败并被原样重派——正是取消文案分叉要消灭的症状，只是换了收敛形态复发。</p>
     */
    @Test
    public void catchPathMustForkCancelMessageInsteadOfUnconditionalError() throws Exception {
        String taskDo = extractMethod(strippedTaskSource(), "taskDo");
        String normalized = normalize(taskDo);

        Assertions.assertTrue(normalized.contains(
                        "cancelFlag.get() ? (wallClockFired.get() ? WALL_CLOCK_MESSAGE : CANCELLED_MESSAGE)"),
                "catch 路径必须按取消位与 fired 标记两级分叉收卡文案");
        Assertions.assertFalse(normalized.contains(
                        "emitBackgroundEnd(__sessionId, task, invocationId, false, \"ERROR: \" + describe(e))"),
                "catch 不得无条件报 ERROR：取消形态的异常会被模型当可重试失败原样重派");
    }

    // ══════════════════════════════════════════════════════════════
    //  3. 取值窗口：单次调用封顶 < 墙钟 < 注册表 TTL
    // ══════════════════════════════════════════════════════════════

    /**
     * 墙钟取值必须落在 (单次调用总封顶, 注册表 TTL) 开区间内。
     *
     * <p>下界：小于单次调用封顶（25 分钟）会把一次合法的慢调用误杀；
     * 上界：大于 TTL（60 分钟）时，被墙钟停掉的任务在模型下一轮回来 await 时回执已被驱逐，
     * 只能收到「token 不存在」而拿不到取消文案。</p>
     */
    @Test
    public void wallClockWindowMustSitBetweenCallCapAndRegistryTtl() throws Exception {
        String taskSrc = readSource(TASK_SOURCE_PATH);
        long wall = longConstant(taskSrc, "BACKGROUND_WALL_CLOCK_MINUTES");
        long ttl = longConstant(taskSrc, "BACKGROUND_TTL_MINUTES");
        long streamCap = longConstantIn(readSource(CHAT_DESC_SOURCE_PATH),
                "STREAM_TOTAL_CAP = Duration.ofMinutes");
        long reasonCap = longConstantIn(readSource(REASON_TASK_SOURCE_PATH),
                "STREAM_TOTAL_CAP = Duration.ofMinutes");

        Assertions.assertTrue(wall > streamCap,
                "墙钟(" + wall + "min) 必须大于流层单次调用总封顶(" + streamCap + "min)，否则误杀合法慢调用");
        Assertions.assertTrue(wall > reasonCap,
                "墙钟(" + wall + "min) 必须大于 ReasonTask 单次运行硬兜底(" + reasonCap + "min)，否则一次完整尝试都跑不完");
        Assertions.assertTrue(wall < ttl,
                "墙钟(" + wall + "min) 必须小于注册表 TTL(" + ttl + "min)，否则取消文案随回执一起被驱逐");
    }

    // ══════════════════════════════════════════════════════════════
    //  4. 文案契约：墙钟文案必须引导拆分而非重派，且不带 ERROR 前缀
    // ══════════════════════════════════════════════════════════════

    /**
     * 墙钟文案与用户终止文案必须分叉，且墙钟文案不得带 ERROR 前缀、必须给出「拆分/求助」的出路。
     *
     * <p>带 ERROR 前缀会让模型把「跑太久被停」当作可重试的失败原样重派——而重派同一个跑了
     * 45 分钟的任务大概率再次撞墙，等于把止损省下的 token 再烧一遍。</p>
     */
    @Test
    public void wallClockMessageMustGuideSplitInsteadOfRetry() throws Exception {
        String src = readSource(TASK_SOURCE_PATH);

        String wallBlock = constantBlock(src, "WALL_CLOCK_MESSAGE");
        Assertions.assertTrue(wallBlock.contains("\"CANCELLED:"),
                "墙钟文案必须以 CANCELLED 开头（中性终止），带 ERROR 前缀会诱导模型原样重派");
        Assertions.assertFalse(wallBlock.contains("ERROR:"), "墙钟文案不得含 ERROR 前缀");
        Assertions.assertTrue(wallBlock.contains("请勿原样重派同一任务"),
                "必须显式禁止原样重派：撞墙的任务重派大概率再次撞墙");
        Assertions.assertTrue(wallBlock.contains("拆成更小的子任务"),
                "必须给出可执行的出路（拆分或求助），只说「别重派」模型无从收敛");

        String cancelledBlock = constantBlock(src, "CANCELLED_MESSAGE");
        Assertions.assertTrue(cancelledBlock.contains("用户停止或连接中断"),
                "用户终止文案必须保持原语义，不得被墙钟文案覆盖");
        Assertions.assertFalse(normalize(wallBlock).equals(normalize(cancelledBlock)),
                "两种取消原因必须文案分叉，否则模型无法区分「该拆分」与「用户已停」");
    }

    // ══════════════════════════════════════════════════════════════
    //  脚手架
    // ══════════════════════════════════════════════════════════════

    private HarnessEngine newEngine() {
        // sessionProvider 必须注入：HarnessEngine.getSession 直接委派给它，不注入则 NPE。
        // 本用例只真调 fireWallClockStop（不触模型），但实例必须经正规构造取得。
        return HarnessEngine.of(temp.toString(), temp.resolve("home").toString())
                .sessionProvider(InMemoryAgentSession::of)
                .build();
    }

    private static String strippedTaskSource() throws Exception {
        return stripJavaComments(readSource(TASK_SOURCE_PATH));
    }

    /**
     * 按「行首返回类型（可带修饰符）」定位方法定义行，再按大括号深度取配对收尾。
     *
     * <p>不能简单找 {@code " name("}：那会先命中调用点。实测 {@code return taskDo(...)} 这种
     * 「行首 return + 调用」形态会被「返回类型 + 空格 + 名字」误匹配（return 也是一个合法标识符），
     * 提取到的却是调用点所在方法的残片，里面根本没有 detached 分支。故用负向前瞻排除 return，
     * 且返回类型字符集排除 {@code )} 与 {@code -}，使 {@code () ->} 形态不匹配。</p>
     */
    private static String extractMethod(String src, String name) {
        Matcher m = Pattern.compile("(?m)^[ \\t]*(?:(?:public|private|protected)\\s+)?(?!return\\b)"
                + "[A-Za-z_][A-Za-z0-9_<>,?\\[\\].]*\\s+" + Pattern.quote(name) + "\\s*\\(").matcher(src);
        Assertions.assertTrue(m.find(), "未找到方法定义: " + name);

        int brace = src.indexOf('{', m.end());
        Assertions.assertTrue(brace >= 0, "方法定义后未找到 '{': " + name);

        int depth = 0;
        for (int i = brace; i < src.length(); i++) {
            char ch = src.charAt(i);
            if (ch == '{') {
                depth++;
            } else if (ch == '}') {
                depth--;
                if (depth == 0) {
                    return src.substring(m.start(), i + 1);
                }
            }
        }
        throw new AssertionError("方法体未配平: " + name);
    }

    /** 取 {@code NAME = ...;} 常量声明块（含字符串字面量拼接），供文案断言使用。 */
    private static String constantBlock(String src, String name) {
        int at = src.indexOf(name + " =");
        Assertions.assertTrue(at >= 0, "未找到常量声明: " + name);
        int end = src.indexOf(';', at);
        Assertions.assertTrue(end > at, "常量声明未找到收尾分号: " + name);
        return src.substring(at, end + 1);
    }

    private static long longConstant(String src, String name) {
        return longConstantIn(src, name + " =");
    }

    private static long longConstantIn(String src, String prefix) {
        // 前缀后到首个数字之间的任何字符（空格、等号、Duration.ofMinutes( 等）一律跳过：
        // 把包装调用写进正则会与「前缀已含包装调用」的传参口径叠加，导致永不匹配。
        Matcher m = Pattern.compile(Pattern.quote(prefix) + "[^0-9]*(\\d+)").matcher(src);
        Assertions.assertTrue(m.find(), "未找到数值常量: " + prefix);
        return Long.parseLong(m.group(1));
    }

    private static String normalize(String s) {
        return s.replaceAll("\\s+", " ");
    }

    /**
     * 去掉 Java 注释后返回正文，供所有源码断言使用。
     *
     * <p>不去注释两头都错：反向断言会被注释里的字样误报红；正向断言会对「只存在于注释里」
     * 的实现假绿。状态机同时处理文本块、字符串、字符字面量与两种注释。</p>
     */
    private static String stripJavaComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            if (c == '"' && src.startsWith("\"\"\"", i)) {
                int end = src.indexOf("\"\"\"", i + 3);
                end = (end < 0) ? n : end + 3;
                out.append(src, i, end);
                i = end;
            } else if (c == '"' || c == '\'') {
                char quote = c;
                out.append(c);
                i++;
                while (i < n) {
                    char d = src.charAt(i);
                    out.append(d);
                    if (d == '\\' && i + 1 < n) {
                        out.append(src.charAt(i + 1));
                        i += 2;
                        continue;
                    }
                    i++;
                    if (d == quote) {
                        break;
                    }
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                while (i < n && src.charAt(i) != '\n') {
                    i++;
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                int end = src.indexOf("*/", i + 2);
                i = (end < 0) ? n : end + 2;
                out.append(' ');
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static String readSource(String relativePath) throws Exception {
        // surefire 的工作目录可能是仓库根也可能是模块目录，两种口径都要能解析
        Path p = Paths.get(relativePath);
        if (!Files.exists(p)) {
            p = Paths.get("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(p), "源文件不存在: " + p.toAbsolutePath());
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }
}
