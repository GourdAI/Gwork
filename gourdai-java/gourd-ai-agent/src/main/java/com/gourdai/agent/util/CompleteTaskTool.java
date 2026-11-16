/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.util;

import com.gourdai.ai.chat.tool.FunctionTool;
import com.gourdai.ai.chat.tool.FunctionToolDesc;

import java.util.Collection;

/**
 * 显式收尾工具（complete_task，契约 §4）
 *
 * <p>模型调用本工具提交面向用户的最终总结并结束本次任务。正常路径由
 * {@link com.gourdai.agent.react.intercept.CompleteTaskInterceptor} 在 onAction 阶段
 * 回填 summary 作为工具结果，{@code ActionTask} 检测到成功结果后置 finalAnswer 并直通 END
 * （等价 finishMarker 显式完成语义，跳过收敛门禁与后台门禁）。此处的函数体仅为兜底：
 * 防御任何未挂拦截器的异常调用路径，原样返回 summary。</p>
 *
 * <p>主代理注册；子代理不注册（子代理最终文本回传父代理的机制不变）。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
public class CompleteTaskTool {
    public static final String TOOL_NAME = "complete_task";

    /**
     * 工具描述（契约 §4.1，双内核逐字一致）。
     */
    public static final String TOOL_DESCRIPTION = "提交面向用户的最终总结并结束本次任务。仅当全部工作完成（或遇到无法自行解决的阻塞需向用户交代）时调用。summary 就是用户看到的最终回答：一次写全（结论、验证结果、遗留事项），调用后不要再输出重复总结。仍有未完成工作、或需要用户选择/确认时不要调用本工具——继续执行或改用 ask_user。";

    /**
     * 入参 Schema（契约 §4.1，双内核逐字一致）。
     */
    public static final String INPUT_SCHEMA =
            "{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\",\"description\":\"最终回答全文（Markdown）\"}},\"required\":[\"summary\"]}";

    /**
     * 系统提示词收尾契约条款（中文，契约 §2.4，双内核逐字一致）。
     *
     * <p>加在「自然完成」规则内或紧随其后；CN/EN 两套模板（function-call 与文本协议）共用。
     * 无条件注入：即使无 complete_task（子代理），收尾去重纪律同样适用。
     * 措辞刻意不点名 ask_user：该条款对子代理同样生效，点名会诱导幻觉调用
     * （子代理工具集已剔除 ask_user）；主会话由 AskUserTool.PROMPT_RULE 条件注入点名。</p>
     */
    public static final String CLOSING_CONTRACT_CN = "**收尾契约**：最终回答一次成型：默认一到两句说明改动与下一步；评审/调查/重大变更可展开（引用、验证结果、风险）。总结输出后不要再重复或追加第二份总结；收尾不带问句——需要用户决策时交由提问工具处理，而不是在正文提问后等待。";

    /**
     * 系统提示词收尾契约条款（英文），与 CN 语义等价。
     */
    public static final String CLOSING_CONTRACT_EN = "**Closing Contract**: Shape the final answer once: by default one or two sentences covering what changed and the next step; reviews/investigations/major changes may expand (references, verification results, risks). After the summary, never repeat it or append a second one; never end with a question — when a user decision is needed, hand it to the question tool instead of asking in prose and waiting.";

    /**
     * 判断当前工具集是否包含 complete_task（用于系统提示词条件注入，
     * 避免向无此工具的子代理推荐幻觉调用——与 AskUserTool.isAvailable 同一教训）。
     *
     * @param tools 当前可用工具集（允许为 null）
     */
    public static boolean isAvailable(Collection<FunctionTool> tools) {
        if (tools == null || tools.isEmpty()) {
            return false;
        }

        for (FunctionTool tool : tools) {
            if (tool != null && TOOL_NAME.equals(tool.name())) {
                return true;
            }
        }

        return false;
    }

    public static FunctionTool getTool() {
        return new FunctionToolDesc(TOOL_NAME)
                .description(TOOL_DESCRIPTION)
                .inputSchema(INPUT_SCHEMA)
                .doHandle((args) -> {
                    // 兜底：正常路径被 CompleteTaskInterceptor 短路，不会执行到这里
                    Object summary = args == null ? null : args.get("summary");
                    return summary == null ? "" : String.valueOf(summary);
                });
    }
}