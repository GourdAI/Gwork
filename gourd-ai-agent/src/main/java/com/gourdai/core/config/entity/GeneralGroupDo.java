package com.gourdai.core.config.entity;

import lombok.Getter;
import lombok.Setter;

import java.io.Serializable;

/**
 *
 * @author oisin
 *
 */
@Getter
@Setter
public class GeneralGroupDo implements Serializable {
    //历史窗口大小（压缩时保护最后 N 条消息完整不压 = 拦截器 maxMessages）
    private Integer historyWindowSize;
    //压缩触发比例（1~100）：占用达到「模型 contextLength × 该比例%」时触发压缩
    private Integer compressionRatio;
    //压缩模型
    private String summaryModel;
    //ACP（编码工具接入）使用的模型；留空则回落到 defaultModel
    private String acpModel;
    //ACP 思考深度（推理力度）；off 表示关闭
    private String acpThinkingDepth;

    //启用沙盒模式
    private Boolean sandboxMode;
    //沙盒允许访问用户主目录
    private Boolean sandboxAllowUserHome;
    //沙盒使用系统接口限制
    private Boolean sandboxSystemRestrict;

    //api 重试次数
    private Integer apiRetries;
    //Mcp 重试次数
    private Integer mcpRetries;
    //模型重试次数
    private Integer modelRetries;
    //启用心智记忆（跨会话长期记忆）
    private Boolean memoryEnabled;
    //启用心智记忆隔离（按工作区隔离长期记忆）
    private Boolean memoryIsolation;

    //是否接入 MCP 服务
    private Boolean mcpEnabled;
    //是否接入 OpenAPI 服务
    private Boolean openApiEnabled;
    //启用LSP代码智能（增加上下文消耗，非编码用户建议关闭）
    private Boolean lspEnabled;
    //深色主题
    private Boolean darkMode;
    //界面语言（如 zh-CN, en, ja 等）
    private String locale;

    //------------

    //http 用户代理
    private String userAgent; // "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GWork/1.0 like claude-code; +https://www.gourd-ai.cn/)";

    //最大回合
    private Integer maxTurns; // 20
    //自我反思
    private Boolean autoRethink; //true

    //是否启用人工审核危险操作
    private Boolean hitlEnabled; //false
    //是否启用子代理模式
    private Boolean subagentEnabled; // true

    //内心思考，是否打印
    private Boolean cliThinkPrinted; //true
    //控制台打印是否简化
    private Boolean cliPrintSimplified; //true

    //===================

    //Web 访问认证用户名（登录页用，留空则不启用）
    private String webAuthUser;
    //Web 访问认证密码（登录页用，留空则不启用）
    private String webAuthPass;
}
