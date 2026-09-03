<div align="center">

# GWork

**Your AI Agent, Living on Your Desktop.**

一个真正能干活的开源桌面智能体 —— 给它一个目标，它还你一份结果。

基于 [Solon AI](https://github.com/opensolon/solon-ai) 构建 · 纯 Java · 100% 开源

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Java](https://img.shields.io/badge/Java-8%20~%2026-orange.svg)](#)
[![Solon AI](https://img.shields.io/badge/Built%20with-Solon%20AI-9cf.svg)](https://solon.noear.org/)
[![Version](https://img.shields.io/badge/v2026.6.21-Latest-brightgreen.svg)](#)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20鸿蒙-lightgrey.svg)](#)

**Desktop 桌面端 · Web 网页端 · CLI 命令行 · ACP 编辑器接入 · 微信/企微/飞书远程控制**

[中文](README.zh.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md) | [Italiano](README.it.md) | [Русский](README.ru.md) | [العربية](README.ar.md) | [Português (BR)](README.br.md) | [ไทย](README.th.md) | [Tiếng Việt](README.vi.md) | [Polski](README.pl.md) | [বাংলা](README.bn.md) | [Bosanski](README.bs.md) | [Dansk](README.da.md) | [Ελληνικά](README.gr.md) | [Norsk](README.no.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md)

</div>

---

## 🚀 什么是 GWork？

GWork 不是又一个聊天机器人，而是一套完整的 **桌面智能体操作系统（Agent OS）**。

你下达一个目标，它会自主**规划任务 → 拆解步骤 → 读写文件 → 执行命令 → 联网检索 → 调用工具与模型 → 持续迭代**，直到把事情真正做完。从写周报、做 PPT、调研分析，到开发一个完整的项目 —— 它都能胜任。

> 💡 **一句话体验它的能力：**
> *"帮我设计一个 agent team（设计案存为 demo-dis.md），用 Solon + Java 17 开发一个经典权限管理系统，前端用 Vue3，界面要简洁好看。"*
> —— 它会自己出设计文档、建项目、写前后端代码、跑起来给你看。

---

## ✨ 核心能力一览

| | 能力 | 说明 |
|---|---|---|
| 🧠 | **多协议 AI 接入** | OpenAI / Anthropic / Gemini / DeepSeek / Ollama 等，一个配置自由切换，模型零锁定 |
| 🛠️ | **Skills 技能市场** | 一键安装 Clawhub / Skillhub / SkillsSh 技能，能力无限扩展 |
| 🔌 | **MCP 协议** | 原生支持 MCP Server（stdio / SSE / Streamable），接入整个 MCP 生态 |
| 🧬 | **长短期记忆** | 工作空间 + 全局双层记忆域，跨会话记住你的偏好、决策与项目上下文 |
| 🛡️ | **沙箱隔离** | 高危命令与不可信代码在沙箱中执行，权限细粒度可控，安全兜底 |
| 🌐 | **OpenAPI 网关** | 导入 OpenAPI 3.0 / Swagger 2.0 规范，智能体直接调用你的业务接口 |
| 🤝 | **ACP 连接** | 标准 Agent Client Protocol，接入 Zed / VS Code 等编辑器当智能体引擎 |
| 📱 | **远程控制** | 微信 / 企业微信 / 飞书 / 钉钉扫码绑定，人在外面，活在家里干 |
| 💬 | **复杂办公任务** | 联网调研 → 分析归纳 → 生成报告 / PPT / 文档，一条龙自动化 |
| 💻 | **编码任务** | 仓库级读写、Git Diff、内置终端、LSP 深度代码理解、多子代理并行 |

---

## 🏗️ 基于 Solon AI 构建

GWork 的智能体内核完全构建于 [Solon AI](https://github.com/opensolon/solon-ai) 生态之上，纯 Java 实现，兼容毕昇 JDK（华为）与鸿蒙 PC 环境：

```
┌─────────────────────────────────────────────────────────┐
│                      接入层（Interfaces）                 │
│   Desktop 桌面端 · Web UI · CLI · ACP · 微信/企微/飞书/钉钉  │
├─────────────────────────────────────────────────────────┤
│                     智能体层（Agent Core）                │
│        ReAct 推理循环 · 多 Agent Team · 任务规划追踪        │
├─────────────────────────────────────────────────────────┤
│                     能力层（Tools）                       │
│  Skills 技能 · MCP · OpenAPI 网关 · LSP · 记忆 · Web 工具   │
├─────────────────────────────────────────────────────────┤
│                     安全层（Safety）                      │
│          solon-ai-sandbox 沙箱 · 权限控制 · HITL 人工确认   │
├─────────────────────────────────────────────────────────┤
│                     引擎层（Solon AI）                    │
│   多协议模型适配 · 流式对话 · 函数调用 · solon-flow 编排      │
└─────────────────────────────────────────────────────────┘
```

---

## 🧠 一个会思考、会长记性的智能体

### 多协议 AI 接入，模型零锁定

内置多种主流 AI 接口协议适配，`config.yml` 一行配置即可接入任意模型服务，随模型迭代自由切换，成本与能力完全由你掌控。

### Skills 技能市场：能力即插即用

浏览并一键安装社区技能（Clawhub / Skillhub / SkillsSh）：做 PPT、生成图表、操作浏览器、处理 PDF…… 也可以自己写技能发布，让智能体越用越强。

### MCP：接入整个工具生态

原生支持 MCP（Model Context Protocol）三种传输方式，任何 MCP Server 都能成为它的手和脚。

### 记忆系统：它真的记得你

工作空间记忆 + 全局记忆双层架构，自动提取偏好、纠正教训与项目上下文，跨会话持续生效 —— 不用每次重复交代背景。

### 沙箱隔离：大胆用，也放心用

基于 `solon-ai-sandbox`，不可信代码与高危操作在隔离环境中执行；配合细粒度权限控制与 HITL（人工确认）机制，关键动作永远先问你。

### OpenAPI 接口网关：把业务系统交给它

导入 OpenAPI 3.0 / Swagger 2.0 规范文档，智能体即可理解并直接调用你的内部接口 —— 查数据、发审批、操作业务系统，动动嘴就行。

---

## 📱 随时随地指挥它

### ACP 连接

支持标准 ACP（Agent Client Protocol），可作为智能体引擎接入 **Zed、VS Code** 等编辑器，在熟悉的编码环境里直接指挥它。

### 远程控制：微信 / 企微 / 飞书 / 钉钉

在桌面端扫码绑定 IM 账号后，**人不在电脑前，也能给智能体派活**：

- 📩 微信 / 企业微信 / 飞书 / 钉钉里直接发消息下达任务
- 🔗 会话路由自动识别来源渠道，多端消息互不干扰
- ⚡ 出门在外，地铁上发一句"把昨天的数据整理成日报"，回家结果已经躺在那里

### 三种本地交互形态

| 形态 | 场景 | 启动方式 |
|---|---|---|
| 🖥️ **Desktop 桌面端** | 日常全能工作台，双工作区（Chat + Code）、Git Diff、内置终端 | 一键安装包（Win/macOS/Linux） |
| 🌐 **Web 网页端** | 浏览器访问，局域网共享 | `gourdai web 0` |
| ⌨️ **CLI 命令行** | 极客最爱，脚本集成 | `gourdai` |

---

## 💪 它能帮你干什么？

**办公场景** 📊
- 联网调研某个行业/技术，自动生成分析报告与 PPT
- 批量整理文档、表格、会议纪要
- 定时任务：日报周报、数据巡检、消息推送

**开发场景** 💻
- 仓库级代码理解、重构与 Bug 修复（LSP 深度语义分析）
- 从设计文档到前后端代码，端到端交付完整项目
- 多子代理并行：架构设计、编码、测试分工协作

**自动化场景** ⚙️
- 调用 OpenAPI 操作业务系统
- 浏览器自动化、网页信息抓取
- 通过 IM 远程触发，构建 7×24 小时无人值守工作流

---

## ⚡ 快速开始

试试这些任务（由简到难）：

```
你好
用网络分析下 AI MCP 协议，然后生成个 PPT
帮我设计一个 agent team（设计案存为 demo-dis.md），开发一个 solon + java17 的经典权限管理系统（demo-web），前端用 vue3，界面要简洁好看
```

