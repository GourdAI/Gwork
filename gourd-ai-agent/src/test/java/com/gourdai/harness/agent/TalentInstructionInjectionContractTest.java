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

import com.gourdai.ai.chat.prompt.Prompt;
import com.gourdai.ai.chat.talent.Talent;
import com.gourdai.ai.chat.talent.TalentUtil;
import com.gourdai.harness.talents.cli.TodoTalent;
import com.gourdai.harness.talents.memory.MemorySolution;
import com.gourdai.harness.talents.memory.MemorySolutionProvider;
import com.gourdai.harness.talents.memory.MemorySearchResult;
import com.gourdai.harness.talents.memory.MemorySearcher;
import com.gourdai.harness.talents.memory.MemoryStorer;
import com.gourdai.harness.talents.memory.MemoryTalent;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Talent 指令注入契约：本轮上下文瘦身改动曾两处「省 token 省到把功能省没了」，
 * 且都发生在没有测试覆盖的路径上，故在此把契约钉死。
 *
 * <p>被守护的两个真实缺陷：</p>
 * <ol>
 *   <li><b>MemoryTalent 改用 onAttach 注入记忆 → 功能静默失效。</b>
 *       ReActAgent.call 的顺序是「先把 prompt.getMessages() 拷进 workingMemory/session
 *       （L224-232），再调 trace.activeTalents() 触发 onAttach（L244）」，而 ReasonTask
 *       组装出站消息只用 ofSystem(systemPromptBuf) + workingMemory.getMessages()（L538-540），
 *       从不重读 originalPrompt。所以 onAttach 里 prompt.addMessage 的那条系统消息
 *       拷贝时已错过，模型永远看不到长期记忆——而全仓没有任何测试覆盖它，966/966 全绿。</li>
 *   <li><b>TodoTalent 用 isSupported() 做按需注入 → 工具直接消失。</b>
 *       TalentUtil.activeTalents 对 isSupported()==false 的才能整体 continue（L46-54），
 *       连 toolAdd 一起跳过。短输入场景下 todowrite/todoread 会从本轮可用工具里消失，
 *       模型想更新清单却发现工具不存在。</li>
 * </ol>
 *
 * @author oisin
 */
public class TalentInstructionInjectionContractTest {

    /**
     * 记忆检索的 fake：固定返回两条，便于断言注入内容。
     *
     * <p>用 4 参构造器（key, content, importance, time）：带 title 的重载是 7/9 参形式，
     * 4 参版会由 MemoryTitles.resolve 从 content 推导标题，无需关心 title 传参。</p>
     */
    private static final class FakeSearcher implements MemorySearcher {
        @Override
        public List<MemorySearchResult> search(String userId, String query, int limit) {
            return Collections.singletonList(new MemorySearchResult(
                    "k_relevant", "相关记忆内容A", 8.0, "2026-09-30 10:00:00"));
        }

        @Override
        public List<MemorySearchResult> getHotMemories(String userId, int limit) {
            return Collections.singletonList(new MemorySearchResult(
                    "k_hot", "热记忆内容B", 9.0, "2026-09-30 11:00:00"));
        }

        @Override
        public void updateIndex(String userId, String key, String fact, int importance, String time) {
        }

        @Override
        public void removeIndex(String userId, String key) {
        }
    }

    private static final class FakeSolution implements MemorySolution {
        @Override
        public MemorySearcher getSearcher() {
            return new FakeSearcher();
        }

        @Override
        public MemoryStorer getStorer() {
            return null;
        }
    }

    private static MemoryTalent newMemoryTalent() {
        return new MemoryTalent(new MemorySolutionProvider() {
            @Override
            public MemorySolution get(String __cwd) {
                return new FakeSolution();
            }
        }).sessionIsolation(false);
    }

    /**
     * 记忆预览必须出现在 getInstruction 的返回值里。
     *
     * <p>这是 P0 缺陷的直接回归护栏：只要有人把注入点从 getInstruction 挪到 onAttach，
     * 本用例立刻变红。断言打在「返回的字符串」而不是「prompt 消息列表」上，
     * 因为前者才是 TalentUtil 真正会拼进 system prompt 的东西。</p>
     */
    @Test
    public void memoryPreviewMustBeInsideGetInstructionReturnValue() {
        MemoryTalent talent = newMemoryTalent();
        Prompt prompt = Prompt.of("帮我看下这个报错");

        String instruction = talent.getInstruction(prompt);

        Assertions.assertNotNull(instruction, "getInstruction 不得返回 null");
        Assertions.assertTrue(instruction.contains("当前核心认知预览"), "必须保留认知预览小节");
        Assertions.assertTrue(instruction.contains("相关记忆内容A"), "语义相关记忆正文必须被注入");
        Assertions.assertTrue(instruction.contains("热记忆内容B"), "热记忆正文必须被注入");
        Assertions.assertTrue(instruction.contains("k_relevant") && instruction.contains("k_hot"),
                "Key 必须随正文一同注入：模型要靠它做 memory_recall/memory_extract 覆盖");
        Assertions.assertFalse(instruction.contains("由 onAttach 动态注入"),
                "不得残留「稍后会注入」这类占位文案：模型会据此以为记忆存在而实际为空");
    }

    /** 无任何记忆时必须给出明确的空态说明，而不是留一个空标题。 */
    @Test
    public void memoryPreviewMustDeclareEmptyStateWhenNoMemories() {
        MemoryTalent talent = new MemoryTalent(new MemorySolutionProvider() {
            @Override
            public MemorySolution get(String __cwd) {
                return new MemorySolution() {
                    @Override
                    public MemorySearcher getSearcher() {
                        return new MemorySearcher() {
                            @Override
                            public List<MemorySearchResult> search(String u, String q, int l) {
                                return Collections.emptyList();
                            }

                            @Override
                            public List<MemorySearchResult> getHotMemories(String u, int l) {
                                return Collections.emptyList();
                            }

                            @Override
                            public void updateIndex(String u, String k, String f, int i, String t) {
                            }

                            @Override
                            public void removeIndex(String u, String k) {
                            }
                        };
                    }

                    @Override
                    public MemoryStorer getStorer() {
                        return null;
                    }
                };
            }
        }).sessionIsolation(false);

        String instruction = talent.getInstruction(Prompt.of("hi"));

        Assertions.assertTrue(instruction.contains("暂无核心认知"),
                "无记忆时必须有空态说明，否则模型不知道是「没有记忆」还是「注入失败」");
    }

    /**
     * 短输入跳过规划指南时，todowrite/todoread 必须仍然挂载。
     *
     * <p>这条守护的是「用 isSupported 做开关」的错误实现。注意断言口径：
     * 工具集合取自 talent 自身（AbsTalent.getToolAry），它不随 isSupported 变化——
     * 真正的丢失发生在 TalentUtil.activeTalents 的 continue 里，所以下一个用例
     * 必须走 TalentUtil 全链路才算数。</p>
     */
    @Test
    public void todoTalentShortInputMustStillKeepToolsMounted() {
        TodoTalent talent = new TodoTalent();
        Prompt prompt = Prompt.of("你好");

        Assertions.assertNull(talent.getInstruction(prompt),
                "短寒暄输入应跳过规划指南以省 token");

        List<String> toolNames = new ArrayList<>();
        talent.getToolAry().forEach(t -> toolNames.add(t.name()));
        Assertions.assertTrue(toolNames.contains(TodoTalent.TOOL_TODOWRITE),
                "跳过指南不得连带卸载 todowrite");
        Assertions.assertTrue(toolNames.contains(TodoTalent.TOOL_TODOREAD),
                "跳过指南不得连带卸载 todoread");
    }

    /** 恢复语义的短输入必须照常注入指南（否则模型在有未完成清单时凭记忆行动）。 */
    @Test
    public void todoTalentResumeKeywordsMustNotSkipInstruction() {
        TodoTalent talent = new TodoTalent();

        for (String input : Arrays.asList("继续", "接着做", "还有吗", "continue", "看下任务")) {
            Assertions.assertNotNull(talent.getInstruction(Prompt.of(input)),
                    "恢复语义短输入不得跳过规划指南: " + input);
        }
    }

    /**
     * 长度阈值必须小到「中文短句任务」不会被误伤。
     *
     * <p>这条用例钉的是首版 SHORT_INPUT_MAX=20 的真实误伤：
     * 「帮我把这个类的注释补齐并跑一遍测试」仅 17 字符，却是一个明确的
     * 「改代码 + 跑验证」多步任务。若有人把阈值改回 20 或更大，本用例会立即变红。</p>
     */
    @Test
    public void todoTalentMustNotSkipInstructionForShortChineseTaskSentences() {
        TodoTalent talent = new TodoTalent();

        String[] taskLikeInputs = {
                "帮我把这个类的注释补齐并跑一遍测试", // 17 字符，首版阈值下被误伤
                "修下这个空指针并补个测试",                 // 12 字符
                "把三个模块都改完并验证",                     // 11 字符
        };
        for (String input : taskLikeInputs) {
            Assertions.assertNotNull(talent.getInstruction(Prompt.of(input)),
                    "短中文任务句不得被当成寒暄而跳过指南（" + input.length() + " 字符）: " + input);
        }
    }

    /** 纯寒暄确实要跳过（否则这项优化根本没生效）。 */
    @Test
    public void todoTalentMustSkipInstructionForGreetings() {
        TodoTalent talent = new TodoTalent();

        for (String input : Arrays.asList("hi", "你好", "谢谢", "1+1")) {
            Assertions.assertNull(talent.getInstruction(Prompt.of(input)),
                    "纯寒暄应跳过指南以省 token: " + input);
        }
    }

    /**
     * TodoTalent 不得用 isSupported() 做按需注入。
     *
     * <p>走 TalentUtil 全链路验证：isSupported 为 false 时 activeTalents 会整体跳过该才能
     * （含 toolAdd），后果是工具凭空消失。用「指南被跳过但工具仍在」这个组合断言，
     * 正好把两种实现区分开：正确实现（getInstruction 返回 null）通过，
     * 错误实现（isSupported 返回 false）失败。</p>
     */
    @Test
    public void talentUtilMustStillMountTodoToolsWhenInstructionIsSkipped() {
        TodoTalent talent = new TodoTalent();
        Prompt prompt = Prompt.of("你好");

        // 前提：该才能确实处于「跳过指南」的输入下
        Assertions.assertNull(talent.getInstruction(prompt));
        // 而准入检查必须放行，否则 TalentUtil 会连工具一起跳过
        Assertions.assertTrue(talent.isSupported(prompt),
                "TodoTalent 不得用 isSupported 做按需注入：它会让 TalentUtil 整体 continue 掉 toolAdd，"
                        + "短输入场景下 todowrite/todoread 将从本轮可用工具中消失");

        StringBuilder combined = new StringBuilder();
        // 用真实的 ModelOptionsAmend（具体类）+ tool(name) 回读，不自制替身：
        // TalentUtil 遍历的是 options.talents()，自定义子类若不注册 talent 则循环体根本不执行，
        // 用例会在「什么都没验证」的情况下绿灯。toolAdd 签名是 (FunctionTool...) 与 (Collection)，
        // 写成单参形式只会成为重载而非覆盖，同样测不到真实路径。
        com.gourdai.ai.chat.ModelOptionsAmend<?, ?> options =
                new com.gourdai.ai.chat.ModelOptionsAmend<>();
        options.talentAdd(talent);

        TalentUtil.activeTalents(options, prompt, combined);

        Assertions.assertNotNull(options.tool(TodoTalent.TOOL_TODOWRITE),
                "TalentUtil 全链路后 todowrite 必须被挂载");
        Assertions.assertNotNull(options.tool(TodoTalent.TOOL_TODOREAD),
                "TalentUtil 全链路后 todoread 必须被挂载");
        Assertions.assertFalse(combined.toString().contains("任务规划指南"),
                "短输入下指南正文应被省略（这才是要省的 token）");
    }

    /** 反向对照：长输入下指南必须回到 system prompt。 */
    @Test
    public void talentUtilMustInjectTodoInstructionForLongInput() {
        TodoTalent talent = new TodoTalent();
        Prompt prompt = Prompt.of("帮我把这个类的注释补齐，然后跑一遍全量测试并把失败项修掉");

        StringBuilder combined = new StringBuilder();
        com.gourdai.ai.chat.ModelOptionsAmend<?, ?> options =
                new com.gourdai.ai.chat.ModelOptionsAmend<>();
        options.talentAdd(talent);

        TalentUtil.activeTalents(options, prompt, combined);

        Assertions.assertTrue(combined.toString().contains("任务规划指南"),
                "长输入必须注入规划指南，否则模型不知道何时该建计划");
        Assertions.assertNotNull(options.tool(TodoTalent.TOOL_TODOWRITE));
    }

    /** Talent 接口的默认实现不应被无意覆盖成「跳过一切」。 */
    @Test
    public void talentDefaultsMustStayPermissive() {
        Talent bare = new Talent() {
        };
        Assertions.assertTrue(bare.isSupported(Prompt.of("hi")));
        Assertions.assertTrue(bare.isEnabled());
        Assertions.assertNull(bare.getInstruction(Prompt.of("hi")));
    }
}
