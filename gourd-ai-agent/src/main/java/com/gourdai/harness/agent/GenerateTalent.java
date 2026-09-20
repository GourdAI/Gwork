/*
 * Copyright 2017-2025 noear.org and authors
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

import com.gourdai.ai.annotation.ToolMapping;
import com.gourdai.ai.chat.talent.AbsTalent;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.core.config.AgentFlags;
import org.noear.solon.annotation.Param;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 *
 * @author oisin
 *
 */
public class GenerateTalent extends AbsTalent {
    private static final Logger LOG = LoggerFactory.getLogger(GenerateTalent.class);

    /** 上限兼顾 Windows MAX_PATH 与 agentMap 膨胀 */
    private static final int MAX_NAME_LENGTH = 64;

    /** Win32 保留设备名：即便带扩展名（NUL.md）仍被解析为设备，且与所在目录无关 */
    private static final Pattern WIN_RESERVED_NAME =
            Pattern.compile("^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", Pattern.CASE_INSENSITIVE);

    private HarnessEngine engine;

    public GenerateTalent(HarnessEngine engine) {
        this.engine = engine;
    }


    @ToolMapping(name = "generate",
            description = "动态构建一个具备特定专家知识和工具权限的子代理。用于将复杂大任务拆解给垂直领域的‘虚拟专家’执行。\n" +
                    "- 只有当‘当前可用代理列表’中无匹配项时，才允许调用此工具。\n" +
                    "- 创建前应查阅相关知识库和技能，以确保 systemPrompt 的专业性。")
    public String generate(
            @Param(name = "name", description = "子代理的唯一英文标识符（如 code_reviewer）") String name,
            @Param(name = "description", description = "对该代理职能的精炼描述，便于主代理后续识别和调用") String description,
            @Param(name = "systemPrompt", description = "核心指令集。需包含角色身份、技能范畴、输出格式规范及负面约束（避免废话）") String systemPrompt,
            @Param(name = "tools", required = false, description = "赋予子代理的工具权限（严禁全选，仅勾选任务相关项）。从给定列表中选择：\n" +
                    "- `read`，读取文件完整内容\n" +
                    "- `write`，写入文件完整内容\n" +
                    "- `edit`，修改文件内容（包括：read,write,edit）\n" +
                    "- `glob`，使用模式匹配\n" +
                    "- `grep`，基于正则表达式的全文检索\n" +
                    "- `list`，列出目录内容\n" +
                    "- `bash`，运行 Shell 命令\n" +
                    "- `skill`，调用预定义的技能模块\n" +
                    "- `lsp`，深度代码理解\n" +
                    "- `code`，编码指导模块\n" +
                    "- `todo`，任务清单管理\n" +
                    "- `webfetch`，直接抓取特定网页内容\n" +
                    "- `websearch`，互联网通用搜索\n" +
                    "- `codesearch`，互联网代码仓库搜索\n" +
                    "- `pi`，核心操作能力包（包括：read,write,edit,bash）\n" +
                    "- `task`，允许其进一步开启下级代理(递归分发)\n" +
                    "- `*`，全量授权") List<String> tools,
            @Param(name = "skills", description = "子代理具备的特定专家能力标识列表", required = false) List<String> skills,
            @Param(name = "saveToFile", description = "是否持久化。如果是通用的、可复用的专家角色，建议设为 true；如果是临时任务助手，设为 false。", defaultValue = "false", required = false) Boolean saveToFile,
            String __cwd
    ) {
        if (name == null) {
            return "ERROR: name 不能为空。";
        }

        //归一化：内存 key 与落盘文件名必须一一对应。Windows/NTFS 路径不区分大小写，
        //若放任 General 与 general 并存，saveToFile 会静默覆盖另一个的定义文件
        name = name.trim().toLowerCase(Locale.ROOT);

        if (name.matches("^[a-zA-Z0-9_-]+$") == false || name.length() > MAX_NAME_LENGTH) {
            return "ERROR: name 标识符不合法，仅允许英文字符、数字、下划线或中划线，且长度不超过 "
                    + MAX_NAME_LENGTH + "。";
        }

        //Windows 保留设备名：NUL.md 的写入会被静默丢弃却仍回报成功，COM1.md 可能阻塞。本产品有 Windows 桌面端
        if (WIN_RESERVED_NAME.matcher(name).matches()) {
            return "ERROR: name 使用了系统保留名称，请改用其它标识符。";
        }

        if (tools == null || tools.isEmpty()) {
            //AgentFactory:83 用 isNotEmpty(tools) 门控整个工具装配块，为空会造出一个零工具的废代理
            return "ERROR: 必须至少指定一个工具（tools），否则子代理没有任何执行能力。";
        }

        try {
            //模板缺失属于部署异常，需给出可执行的提示，而不是抛出 'Agent not found: general'
            if (engine.getAgentManager().hasAgent(AgentDefinition.AGENT_GENERAL) == false) {
                LOG.error("创建子代理失败: 模板代理 '{}' 缺失（内置定义资源未加载）", AgentDefinition.AGENT_GENERAL);
                return "ERROR: 创建子代理失败，内置模板代理 '" + AgentDefinition.AGENT_GENERAL
                        + "' 未加载，请勿重试本工具，改由自己直接完成任务。";
            }

            //一律不允许覆盖已存在的代理（含内置、已缓存与挂载代理）。
            //新定义是从 general 复制的，覆盖会把目标原有的 tools 白名单与 disallowedTools
            //换成模型自填的宽松权限，构成权限抹除与代理身份劫持；且 copy() 不带 mountAlias，
            //覆盖后 clearCustomAgents/removeByMountAlias 都回收不掉，进程内无法恢复
            if (engine.getAgentManager().hasAgent(name)) {
                return "ERROR: 子代理 '" + name + "' 已存在，不可覆盖，请改用其它标识符。";
            }

            AgentDefinition definition = engine.getAgentManager()
                    .getAgent(AgentDefinition.AGENT_GENERAL)
                    .copy();

            definition.setSystemPrompt(systemPrompt);

            definition.getMetadata().setName(name);
            definition.getMetadata().setDescription(description);
            definition.getMetadata().setEnabled(true);

            definition.getMetadata().setTools(tools);
            definition.getMetadata().setSkills(skills);

            boolean shouldSave = saveToFile != null && saveToFile;

            if (shouldSave) {
                Path agentsDir = Paths.get(__cwd, AgentFlags.getHarnessHome(), "agents");
                if (!Files.exists(agentsDir)) {
                    Files.createDirectories(agentsDir);
                }
                Path agentFile = agentsDir.resolve(name + ".md");

                try (BufferedWriter writer = new BufferedWriter(
                        new OutputStreamWriter(
                                Files.newOutputStream(agentFile.toFile().toPath()),
                                StandardCharsets.UTF_8))) {
                    writer.write(definition.toMarkdown());
                }

                if (LOG.isDebugEnabled()) {
                    LOG.debug("Agent 定义已保存到: {}", agentFile);
                }
            }

            //此处已确认不存在同名代理，addAgentIfAbsent 与 addAgent 等价；
            //用 addAgentIfAbsent 保留“绝不覆盖”的语义，避免日后有人改动上面的判断后静默失守
            engine.getAgentManager().addAgentIfAbsent(definition);

            return "[OK] 子代理创建成功！\n\n" +
                    String.format("**标识**: %s\n", name) +
                    String.format("**描述**: %s\n", description) +
                    //SingleTaskOp 的 agent_name/prompt/description 三个参数均为必填，示例必须给全，
                    //否则模型照抄后会漏传 description，落进 ActionTask 的 schema 错误分支
                    String.format("\n现在可以使用 `task(agent_name=\"%s\", description=\"...\", prompt=\"...\")` 来调用。", name);

        } catch (Throwable e) {
            //详细信息只进日志：IOException 的 message 在 Windows 上是宿主绝对路径，
            //直接回灌会把它送进模型上下文并发往模型服务商
            LOG.error("创建子代理失败: name={}, error={}", name, e.getMessage(), e);
            return "ERROR: 创建子代理失败（" + e.getClass().getSimpleName() + "），详情见服务端日志。";
        }
    }
}