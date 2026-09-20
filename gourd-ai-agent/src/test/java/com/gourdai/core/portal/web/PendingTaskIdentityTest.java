package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 批次 C1「挂起任务身份校验 + 挂起态 done 标记」的后端契约。
 *
 * <p>背景：后端原本只按 sessionId 取「当前待处理任务」，旧页面/旧卡片的迟到提交会被
 * 静默应用到【另一次调用】上——问答场景表现为答错题，HITL 场景则可能误批准
 * {@code rm -rf} 这类不可逆操作。本测试锁定三件事：</p>
 * <ol>
 *   <li>question_answered 帧能携带 actionId（闭环），且旧两参工厂保留不破坏既有调用方</li>
 *   <li>done 帧的挂起标记 suspended 可序列化、且默认不出现在普通 done 上</li>
 *   <li>受理结果由 boolean 升级为三态 InputResult，身份不匹配是独立于 busy 的拒绝语义</li>
 * </ol>
 *
 * <p>与 {@code AskUserProtocolTest} 互补：那边锁 ask_user 的挂起/恢复运行时语义，
 * 这边锁「提交身份校验」的协议形态与接线。</p>
 */
class PendingTaskIdentityTest {

    // ==================== 1. question_answered 帧携带 actionId ====================

    @Test
    void questionAnsweredCarriesActionIdAndKeepsLegacyFactory() {
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("index", 0);
        answer.put("text", "staging");
        answer.put("skipped", false);
        answer.put("custom", true);
        List<Map<String, Object>> answers = List.of(answer);

        WebChunk withId = WebChunk.ofQuestionAnswered("ask_user", answers, "call-7");
        Assertions.assertEquals("question_answered", withId.getType());
        Assertions.assertEquals("ask_user", withId.getToolName());
        Assertions.assertEquals("call-7", withId.getActionId());
        Assertions.assertEquals(answers, withId.getArgs().get("answers"));

        // 线格式必须带上 actionId，否则前端拿不到身份、只能退回「无条件清卡」的旧行为
        ONode json = ONode.ofJson(ONode.serialize(withId));
        Assertions.assertEquals("question_answered", json.get("type").getString());
        Assertions.assertEquals("call-7", json.get("actionId").getString());
        Assertions.assertEquals("staging",
                json.get("args").get("answers").getArray().get(0).get("text").getString());

        // 旧两参工厂必须保留并委托：既有调用方与旧快照恢复路径不得被破坏
        WebChunk legacy = WebChunk.ofQuestionAnswered("ask_user", answers);
        Assertions.assertEquals("question_answered", legacy.getType());
        Assertions.assertEquals("ask_user", legacy.getToolName());
        Assertions.assertNull(legacy.getActionId(), "不传 actionId 时必须为 null，供前端降级");
        Assertions.assertEquals(answers, legacy.getArgs().get("answers"));
    }

    // ==================== 2. done 帧的挂起标记 ====================

    @Test
    void doneSuspendedFlagIsExplicitAndAbsentOnNormalDone() {
        WebChunk normal = WebChunk.ofDone();
        Assertions.assertEquals("done", normal.getType());
        Assertions.assertNull(normal.getSuspended(),
                "普通 done 不得带挂起标记，否则前端永远不清批次索引（跨轮串组 + 内存滞留）");

        WebChunk suspended = WebChunk.ofDoneSuspended();
        Assertions.assertEquals("done", suspended.getType());
        Assertions.assertEquals(Boolean.TRUE, suspended.getSuspended());
        Assertions.assertNotNull(suspended.getCreatedAt(), "挂起 done 仍是正常 done，时间戳不得缺失");

        ONode json = ONode.ofJson(ONode.serialize(suspended));
        Assertions.assertEquals("done", json.get("type").getString());
        Assertions.assertTrue(json.get("suspended").getBoolean(), "挂起标记必须进线格式，前端才读得到");

        // 反序列化回来仍成立（历史帧回放走同一条路径）
        WebChunk back = ONode.ofJson(ONode.serialize(suspended)).toBean(WebChunk.class);
        Assertions.assertEquals(Boolean.TRUE, back.getSuspended());

        // 旧历史帧没有该键：必须反序列化为 null 而不是报错，前端据此按相位降级判断
        WebChunk legacy = ONode.ofJson("{\"type\":\"done\",\"createdAt\":1}").toBean(WebChunk.class);
        Assertions.assertEquals("done", legacy.getType());
        Assertions.assertNull(legacy.getSuspended(), "旧快照缺字段应为 null，消费方降级按相位判断");
    }

    // ==================== 3. 受理结果三态 ====================

    @Test
    void inputResultSeparatesBusyFromActionMismatch() {
        // busy 与「身份不匹配」是两种完全不同的语义：前者可暂存补发，后者必须报错给用户。
        // 旧 boolean 返回把两者混为一谈，调用方只能一律回 busy，等于静默吞掉错卡提交。
        Assertions.assertEquals(3, WebGate.InputResult.values().length,
                "受理结果应恰为三态：ACCEPTED / BUSY / ACTION_MISMATCH");
        Assertions.assertNotNull(WebGate.InputResult.valueOf("ACCEPTED"));
        Assertions.assertNotNull(WebGate.InputResult.valueOf("BUSY"));
        Assertions.assertNotNull(WebGate.InputResult.valueOf("ACTION_MISMATCH"));
    }

    // ==================== 4. 接线护栏（源码形态断言） ====================

    @Test
    void sourceWiringGuards() throws IOException {
        String gate = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebGate.java");

        // 入口签名链：actionId 必须一路传到受理逻辑
        Assertions.assertTrue(gate.contains("String questionAnswer, String actionId"),
                "onChatInput/doOnChatInput 签名必须携带 actionId");
        // 旧 boolean 重载必须保留（IM/Loop 等既有调用方走它），且以 ACCEPTED 语义收敛
        Assertions.assertTrue(gate.contains("questionAnswer, null) == InputResult.ACCEPTED"),
                "旧 boolean 重载必须保留并委托，既有调用方不受影响");

        // HITL：带了 id 就必须存在挂起任务且完全一致，否则拒绝；校验必须早于 approve/reject
        int hitlIdx = gate.indexOf("// HITL approve/reject handling");
        int askIdx = gate.indexOf("// ask_user 结构化问答恢复处理");
        Assertions.assertTrue(hitlIdx > 0 && askIdx > hitlIdx, "两个恢复分支应保持原有先后顺序");
        String hitlBranch = gate.substring(hitlIdx, askIdx);
        int strictIdx = hitlBranch.indexOf("Assert.isNotEmpty(actionId)");
        int approveIdx = hitlBranch.indexOf("HITL.approve(");
        Assertions.assertTrue(strictIdx > 0 && approveIdx > strictIdx,
                "HITL 身份校验必须早于 approve/reject 执行（误批准不可逆）");
        Assertions.assertTrue(hitlBranch.contains("return InputResult.ACTION_MISMATCH;"),
                "HITL 不匹配必须拒绝，不得静默落到别的调用上");
        Assertions.assertTrue(hitlBranch.contains("hitl decision without actionId for session {}"),
                "不传 actionId 的降级路径必须留警告日志");

        // 问答：确认帧必须回传 actionId；无挂起任务时仍要回帧 + 补 done（卡片不得永久卡死）
        String askBranch = gate.substring(askIdx, gate.indexOf("// Handle file upload", askIdx));
        Assertions.assertTrue(askBranch.contains("answeredActionId"),
                "question_answered 帧必须回传 actionId 形成闭环");
        int answeredIdx = askBranch.indexOf("WebChunk.ofQuestionAnswered(");
        int taskNullIdx = askBranch.indexOf("if (task == null) {", answeredIdx);
        Assertions.assertTrue(answeredIdx > 0 && taskNullIdx > answeredIdx,
                "answered 帧必须无条件下发（早于 task==null 分支），避免卡片永久滞留");
        Assertions.assertTrue(askBranch.indexOf("WebChunk.ofDone()", taskNullIdx) > taskNullIdx,
                "无挂起任务时必须补 done 帧收口");

        // 出站 done：会话挂起时补标记，且不覆盖上游已显式设置的值
        Assertions.assertTrue(gate.contains("if (session.isPending() && line.getSuspended() == null)"),
                "出站 done 必须在会话挂起时补 suspended 标记");

        // 控制器：读取参数 + 三态映射（不匹配必须是明确错误，不能当成功或 busy）
        String controller = readSource("gourd-ai-agent/src/main/java/com/gourdai/core/portal/web/WebController.java");
        Assertions.assertTrue(controller.contains("ctx.param(\"actionId\")"), "控制器必须读取 actionId 参数");
        Assertions.assertTrue(controller.contains("WebGate.InputResult.ACTION_MISMATCH"),
                "控制器必须识别身份不匹配结果");
        Assertions.assertTrue(controller.contains("Result.failure(409,"),
                "身份不匹配必须返回明确错误（409 冲突）");
        Assertions.assertTrue(controller.contains("WebGate.InputResult.BUSY")
                        && controller.contains("return Result.succeed(\"busy\");"),
                "busy 语义必须原样保留");
    }

    // ==================== 工具方法 ====================

    private static String readSource(String relativePath) throws IOException {
        Path path = Paths.get(relativePath);
        if (!Files.exists(path)) {
            // 兼容以模块目录为工作目录运行的场景
            path = Paths.get("..").resolve(relativePath).normalize();
        }
        Assertions.assertTrue(Files.exists(path), "源码文件必须存在: " + relativePath);
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }
}
