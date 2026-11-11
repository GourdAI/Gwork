//! System prompt construction for the ReAct agent.
//!
//! Mirrors the Java kernel's ReActSystemPrompt: role definition + tool guidance
//! + environment info + workspace context.

use std::path::Path;

use crate::config::{PermissionSettings, Settings};
use crate::llm::ToolDefinition;

/// Hard ceiling for the system-prompt tool-name roster. The wire `tools` field
/// already carries every name + description + full JSON Schema (~10K tokens);
/// duplicating any of that here would double the per-turn fixed cost. The roster
/// is only a *visibility* safety net, so it lists bare names with a 2 KB cap.
const TOOL_ROSTER_MAX_CHARS: usize = 2048;

/// Compact, token-cheap projection of the SAME `ToolDefinition` list that is
/// sent on the wire (ZCode's "single source of truth" idea, minus the schema).
///
/// Why this exists: every competitor keeps tool visibility in more than one
/// channel — Java writes the tool list into the system prompt, Qoder injects a
/// `[Tool Protocol]` / `## Available Tools` block, ZCode derives both views from
/// one `ModelToolContract`. This kernel used to rely on the wire `tools` field
/// ALONE. When a permission/settings drift made `definitions_async()` return an
/// empty list, `dialect.rs` omitted the `tools` key entirely (`if
/// !req.tools.is_empty()`) and the model could not see a single callable tool —
/// including `skillread`, which the skills summary tells it to use. It then
/// replied with a one-line intent declaration and the loop ended the run.
///
/// Returned text is appended to the system message by the ReAct loop. Names are
/// deduplicated (MCP tools may collide with built-ins) and truncated at
/// [`TOOL_ROSTER_MAX_CHARS`]; the full definitions still go out on the wire.
/// Returns an empty string for `None` (no tools configured at all), letting the
/// caller append [`NO_TOOLS_NOTICE`] instead.
pub fn tool_roster_prompt(tools: Option<&[ToolDefinition]>) -> String {
    let Some(tools) = tools else { return String::new() };
    if tools.is_empty() {
        return String::new();
    }
    let mut names: Vec<&str> = Vec::with_capacity(tools.len());
    for t in tools {
        let n = t.function.name.as_str();
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    if names.is_empty() {
        return String::new();
    }
    // Budget on the joined name list only; the surrounding prose is constant.
    let mut joined = String::new();
    for n in names {
        if !joined.is_empty() {
            joined.push_str(", ");
        }
        if joined.len() + n.len() + 2 > TOOL_ROSTER_MAX_CHARS {
            break;
        }
        joined.push_str(n);
    }
    format!(
        "\n## Available tools (call directly; full parameter schemas are provided in the request)\n\n{}\n",
        joined
    )
}

/// Mirror of Java `ReActSystemPromptCn:135-136`: when no tool can be offered,
/// say so instead of leaving the model to hallucinate a tool call it cannot
/// make ("I'll call todoread first…" → pure text → premature END).
pub const NO_TOOLS_NOTICE: &str = "\n> 注意：当前环境无可用工具，请根据已有信息直接回复，不要声称将要调用工具。\n";

/// Build the system prompt for a ReAct session.
pub fn build_system_prompt(settings: &Settings, workspace: &str) -> String {
    let locale = &settings.general.locale;
    let is_cn = locale.starts_with("zh") || locale.starts_with("cn");

    if is_cn {
        build_cn(workspace)
    } else {
        build_en(workspace)
    }
}

/// The sub-agent roster block, appended after the base system prompt.
///
/// Java builds this in `TaskTalent.getInstruction`, which the talent system only
/// calls when the talent is active — so the roster appears exactly when `task` is
/// callable and never otherwise. Reproducing that condition matters: advertising
/// agents the run cannot delegate to invites the model to call a tool that is not
/// in its tool list, and the resulting "Unknown tool" round-trip costs a turn.
///
/// Returns an empty string when delegation is unavailable, so callers can
/// concatenate unconditionally.
pub fn build_agent_roster(workspace: &Path, permission: &PermissionSettings) -> String {
    // `task` is the entry point; `multitask`/`await_tasks` are useless without it.
    let registry = crate::tools::ToolRegistry::new();
    if !registry.is_allowed("task", permission) {
        return String::new();
    }

    let manager = crate::agents::AgentManager::load(Some(workspace));
    if manager.visible().is_empty() {
        // No agents at all: injecting an empty <available_agents> block would tell
        // the model delegation exists while giving it nothing to delegate to.
        return String::new();
    }

    let mut out = manager.prompt_roster();
    out.push('\n');
    // Delegation discipline. Mirrors Java's `getInstruction` strategy list, minus
    // the items that depend on machinery this kernel does not have yet.
    out.push_str(
        "## 任务分配策略：\n\
         0. **改造门禁**：多文件修改、破坏性变更或多可行路径时，**必须先产出方案经用户确认**，再委派执行类子代理。\n\
         1. **主动拆分 + 并行**：遇到可拆解的复杂任务，优先用 `multitask` 并行派发；互相依赖时才串行用 `task`。\n\
         2. **上下文自足**：子代理无状态，`prompt` 必须包含任务所需的全部背景、要求与预期输出格式。\n\
         3. **后台模式**：除非某子任务的结果是你下一步立即必需的输入，否则设 `background=true`，\
         提交后立即拿到 token 并可继续推进其他工作，之后用 `await_tasks` 收取（可一次传多个 token）。\
         阻塞模式（`background=false`）会把主流程卡到子代理跑完。\n\
         4. **代理选择**：按上面的清单选择 `agent_name`；只读调研用 `explore`，\
         执行命令用 `bash`，制定方案用 `plan`，汇总 git 变更用 `git-summary`，\
         其余（尤其需要写文件）用 `general`。名字写错会得到可用清单，改名重试即可。\n",
    );
    out.push('\n');
    out
}

/// The shell dialect block for the *active* shell, or empty when none is needed.
///
/// Dispatches on [`crate::tools::builtin::shell_kind`] so the prompt always
/// matches the shell the bash tool will actually spawn:
/// - Git Bash (Windows, installed): a compact POSIX block — the model already has
///   a strong POSIX prior, so it only needs the Windows-specific corrections.
/// - PowerShell (Windows fallback, no Git Bash): the full pitfall list.
/// - `sh` (Unix): empty — the model knows POSIX and there is nothing to correct.
///
/// Keeping this in sync with the bash tool's selector is load-bearing: a prompt
/// that says "PowerShell, `&&` unavailable" while the tool runs Git Bash teaches
/// the model to avoid syntax that actually works (and vice versa).
pub fn shell_dialect_rules(is_cn: bool) -> String {
    use crate::tools::builtin::{shell_kind, ShellKind};
    match shell_kind() {
        ShellKind::GitBash => git_bash_dialect_rules(is_cn),
        ShellKind::PowerShell => powershell_dialect_rules(is_cn),
        ShellKind::Sh => String::new(),
    }
}

/// Git Bash dialect guidance — deliberately short. The tool is named `bash` and
/// Git Bash *is* POSIX, so the model's prior is already correct; this block only
/// corrects the Windows-specific assumptions (drive paths, MSYS path conversion,
/// "not WSL", encoding handled by the file tools). A long PowerShell-style list
/// here would waste context for the common case.
pub fn git_bash_dialect_rules(is_cn: bool) -> String {
    let cn: &[&str] = &[
        "## 终端方言",
        "终端是 Git Bash（POSIX），**不是** PowerShell/WSL：`&&`/`||`、管道、`grep`/`sed`/`awk`、heredoc 均可用，按标准 POSIX 写命令即可。",
        "",
        "- 路径用正斜杠；Windows 盘符挂载为 `/c/`、`/d/`（如 `D:\\work` → `/d/work`）。工作目录在多次调用间保持（`cd` 会延续）。",
        "- 不要写 PowerShell cmdlet（`Get-Content`/`Select-String` 等），bash 下不存在；读文件/搜索优先用 `read`/`grep`/`glob` 工具。",
        "- 编码已统一 UTF-8，`read`/`edit`/`grep` 自动处理 BOM 与 GBK，无需 chcp。",
        "- 调用 Windows 原生程序注意 MSYS 路径转换：`cmd //c dir`（双斜杠），避免 `/c` 被当作路径。",
    ];
    let en: &[&str] = &[
        "## Terminal Dialect",
        "The terminal is Git Bash (POSIX), **not** PowerShell/WSL: `&&`/`||`, pipes, `grep`/`sed`/`awk`, and heredocs all work — write standard POSIX commands.",
        "",
        "- Use forward slashes; Windows drives mount as `/c/`, `/d/` (e.g. `D:\\work` → `/d/work`). The working directory persists across calls (`cd` carries over).",
        "- Do not use PowerShell cmdlets (`Get-Content`/`Select-String`, etc.) — they do not exist in bash; prefer the `read`/`grep`/`glob` tools for reading/searching files.",
        "- Encoding is unified to UTF-8; `read`/`edit`/`grep` handle BOM and GBK automatically — no chcp needed.",
        "- When calling native Windows programs, mind MSYS path conversion: `cmd //c dir` (double slash) so `/c` is not treated as a path.",
    ];
    let mut out = (if is_cn { cn } else { en }).join("\n");
    out.push('\n');
    out
}

/// Windows PowerShell 5.1 dialect guidance block (the no-Git-Bash fallback).
///
/// Ported verbatim in content from Java `TerminalTalent.appendShellDialectRules`
/// (PowerShell branch, `core == false` path) plus the one-line characterization
/// from `shellDialectSummary`. Emitted only when Git Bash is absent and the bash
/// tool falls back to `powershell` (5.1).
///
/// `is_cn == true` returns the Chinese block (identical to Java, and the kernel
/// primarily serves Chinese users); `is_cn == false` returns an equivalent
/// English translation covering every point.
///
/// A pure function with no `cfg!(windows)` inside, so it is unit-testable on any
/// platform; the runtime dispatcher [`shell_dialect_rules`] selects it.
pub fn powershell_dialect_rules(is_cn: bool) -> String {
    // The tool is named `bash`, which is itself a strong POSIX prior — Java
    // explicitly states "not bash/sh" because the enum name alone does not
    // correct the model's assumptions.
    let cn: &[&str] = &[
        "## 终端方言",
        "终端是 Windows PowerShell 5.1，**不是** bash/sh，POSIX 命令与语法一律不可用。",
        "",
        "- **PowerShell 方言（必须遵守）**：",
        "  - 命令串联：`&&`/`||` **不可用**（PS 5.1），改用 `;` 或 `if ($LASTEXITCODE -eq 0) { cmd2 }`；注意 `;` 前一步失败不中断。",
        "  - 常用等价速查：`head/tail -n N`→`Select-Object -First/-Last N`；`cat`→`Get-Content`；`grep`→`Select-String`；`find`→`Get-ChildItem -Recurse -Filter`；`which x`→`Get-Command x`；`export A=B`→`$env:A='B'`（读用 `$env:NAME`，不是 `$NAME`）；`pwd`→`Get-Location`；丢弃输出用 `| Out-Null`。",
        "  - Unix 别名陷阱：`ls/rm/cp/mv/ps/cat` 在 PS 中是 cmdlet 别名，**不接受 Unix 短参数**（`ls -la`、`rm -rf dir`、`cp -r a b` 均报错）。等价：`Get-ChildItem -Force`、`Remove-Item -Recurse -Force`、`Copy-Item -Recurse`。",
        "  - `curl`/`wget` 是 Invoke-WebRequest 别名，真 curl 请写 `curl.exe -s <url>`。",
        "  - **禁止写 `2>&1`**：stderr 已自动合并；PS 下多写会注入 NativeCommandError 噪声并使 exit_code 变 1。只丢 stderr 用 `2>$null`。",
        "  - 编码已统一 UTF-8，无需 chcp / `-Encoding UTF8` / `$OutputEncoding`；GBK 文件显式加 `-Encoding Default`。输出仍乱码时多为第三方程序按 ANSI 打印，勿反复调编码，读文件改用 `read`/`grep` 工具。",
        "  - PS 5.1 UTF-8 写入带 BOM，`read`/`edit`/`grep` 工具自动忽略。",
    ];
    let en: &[&str] = &[
        "## Terminal Dialect",
        "The terminal is Windows PowerShell 5.1, **not** bash/sh — POSIX commands and syntax are unavailable.",
        "",
        "- **PowerShell dialect (must comply)**:",
        "  - Chaining: `&&`/`||` are **unavailable** (PS 5.1). Use `;` or `if ($LASTEXITCODE -eq 0) { cmd2 }`; note that `;` does NOT stop after a failing step.",
        "  - Quick equivalents: `head/tail -n N`→`Select-Object -First/-Last N`; `cat`→`Get-Content`; `grep`→`Select-String`; `find`→`Get-ChildItem -Recurse -Filter`; `which x`→`Get-Command x`; `export A=B`→`$env:A='B'` (read it as `$env:NAME`, not `$NAME`); `pwd`→`Get-Location`; discard output with `| Out-Null`.",
        "  - Unix alias traps: `ls/rm/cp/mv/ps/cat` are cmdlet aliases in PS and do **not** accept Unix short flags (`ls -la`, `rm -rf dir`, `cp -r a b` all error out). Equivalents: `Get-ChildItem -Force`, `Remove-Item -Recurse -Force`, `Copy-Item -Recurse`.",
        "  - `curl`/`wget` are aliases of Invoke-WebRequest; for the real curl write `curl.exe -s <url>`.",
        "  - **Never write `2>&1`**: stderr is already merged; adding it under PS injects NativeCommandError noise and turns exit_code into 1. To drop stderr only, use `2>$null`.",
        "  - Encoding is already unified to UTF-8: no chcp / `-Encoding UTF8` / `$OutputEncoding` needed; for GBK files add `-Encoding Default` explicitly. If output is still garbled it is usually a third-party program printing ANSI — do not keep retuning the encoding; read files with the `read`/`grep` tools instead.",
        "  - UTF-8 writes from PS 5.1 carry a BOM; the `read`/`edit`/`grep` tools ignore it automatically.",
    ];
    let mut out = (if is_cn { cn } else { en }).join("\n");
    out.push('\n');
    out
}

fn build_en(workspace: &str) -> String {
    let mut out = format!(r#"You are GWork, a professional autonomous task-solving agent. You follow a rigorous ReAct (Reasoning + Acting) loop.

## Core Rules
1. **Tool Calls**: When you need to act (read/write files, run commands, search), invoke tools directly via function calling.
2. **Result-Oriented**: All conclusions must be grounded in real data returned by tools.
3. **No Fabrication**: Never simulate or fabricate tool execution results.
4. **Natural Completion**: When the task is done, reply directly in natural language. Do not output labels like "Final Answer:".
5. **Ask When Needed**: When you need the user to choose between options or provide critical info you cannot infer, use the `ask_user` tool.

## Environment
- Workspace: {workspace}
- OS: current system (detect via tools if needed)
- You have access to file operations, shell commands, web search, and memory.

## Working Style
- Break complex tasks into steps; use `todowrite` to track progress.
- Read files before editing to confirm current content.
- Run tests/builds after code changes to verify.
- Be concise in explanations, thorough in execution.
"#, workspace = workspace);
    out.push('\n');
    out.push_str(crate::todo::PLANNING_GUIDE_EN);
    let dialect = shell_dialect_rules(false);
    if !dialect.is_empty() {
        out.push('\n');
        out.push_str(&dialect);
    }
    out
}

fn build_cn(workspace: &str) -> String {
    let mut out = format!(r#"你是 GWork，一个专业的自主任务解决智能体。你遵循严谨的 ReAct（推理 + 行动）循环。

## 核心规则
1. **工具调用**：需要行动（读写文件、执行命令、搜索）时，直接通过函数调用触发工具。
2. **结果导向**：所有结论必须基于工具返回的真实数据。
3. **严禁伪造**：禁止模拟或伪造工具执行结果。
4. **自然完成**：任务完成后直接用自然语言回复，无需输出 "Final Answer:" 等标签。
5. **主动提问**：需要用户在方案间选择、或需要无法推断的关键信息时，使用 `ask_user` 工具。

## 环境
- 工作区：{workspace}
- 操作系统：当前系统（需要时用工具探测）
- 你可以访问文件操作、Shell 命令、网络搜索和记忆系统。

## 工作方式
- 复杂任务拆解为步骤，用 `todowrite` 跟踪进度。
- 编辑文件前先读取确认当前内容。
- 代码修改后运行测试/构建验证。
- 解释简洁，执行彻底。
"#, workspace = workspace);
    out.push('\n');
    out.push_str(crate::todo::PLANNING_GUIDE);
    let dialect = shell_dialect_rules(true);
    if !dialect.is_empty() {
        out.push('\n');
        out.push_str(&dialect);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PermissionSettings;

    fn ws() -> std::path::PathBuf {
        // Repo convention: no `tempfile` dependency; pid keeps parallel tests apart.
        let p = std::env::temp_dir().join(format!("gwork-prompt-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// With delegation available the roster must list all five built-ins. Without
    /// it the model has no way to learn which agents exist and picks names from
    /// the tool description's examples alone.
    #[test]
    fn roster_lists_the_builtins_when_task_is_allowed() {
        let out = build_agent_roster(&ws(), &PermissionSettings::default());
        assert!(out.contains("<available_agents>"), "{}", out);
        for name in ["bash", "explore", "plan", "general", "git-summary"] {
            assert!(out.contains(&format!("\"{}\"", name)), "{} missing: {}", name, out);
        }
        assert!(out.contains("任务分配策略"), "strategy block missing: {}", out);
    }

    /// The roster must be suppressed when `task` is not callable. Advertising
    /// agents the run cannot delegate to invites a call to a tool that is not in
    /// the tool list, and the "Unknown tool" round-trip costs a turn.
    #[test]
    fn roster_is_empty_when_task_is_disallowed() {
        let mut p = PermissionSettings::default();
        p.disallowed_tools = vec!["task".to_string()];
        assert_eq!(build_agent_roster(&ws(), &p), "");
    }

    /// Same when the allowlist simply omits `task`.
    #[test]
    fn roster_is_empty_when_task_is_not_in_the_allowlist() {
        let mut p = PermissionSettings::default();
        p.tools = vec!["read".to_string(), "grep".to_string()];
        assert_eq!(build_agent_roster(&ws(), &p), "");
    }

    /// A glob allowlist that covers `task` must still produce the roster — the
    /// check goes through `is_allowed`, so `**` and `task*` both count.
    #[test]
    fn roster_survives_a_glob_allowlist() {
        let mut p = PermissionSettings::default();
        p.tools = vec!["**".to_string()];
        assert!(build_agent_roster(&ws(), &p).contains("<available_agents>"));

        p.tools = vec!["task*".to_string()];
        assert!(
            build_agent_roster(&ws(), &p).contains("<available_agents>"),
            "`task*` must match `task`"
        );
    }

    /// The base prompt must stay free of the roster: it is appended separately so
    /// the two can be gated independently.
    #[test]
    fn base_prompt_does_not_contain_the_roster() {
        let s = Settings::default();
        let out = build_system_prompt(&s, "/ws");
        assert!(!out.contains("<available_agents>"), "{}", out);
        assert!(out.contains("GWork"));
    }

    fn td(name: &str) -> ToolDefinition {
        ToolDefinition::new(name, "description that must NOT be duplicated", serde_json::json!({
            "type": "object",
            "properties": { "x": { "type": "string", "description": "a very long schema" } }
        }))
    }

    /// The roster must be a token-cheap NAME-ONLY projection of the same list
    /// sent on the wire: no descriptions, no JSON Schema, bounded size.
    #[test]
    fn tool_roster_is_names_only_and_budgeted() {
        let defs = vec![td("read"), td("write"), td("skillread"), td("skillsearch")];
        let out = tool_roster_prompt(Some(&defs));
        assert!(out.contains("Available tools"));
        for n in ["read", "write", "skillread", "skillsearch"] {
            assert!(out.contains(n), "missing {n}: {out}");
        }
        assert!(!out.contains("description that must NOT"), "description leaked into prompt");
        assert!(!out.contains("very long schema"), "JSON Schema leaked into prompt");
        assert!(out.len() < TOOL_ROSTER_MAX_CHARS + 200, "roster too large: {}", out.len());

        // Duplicate (e.g. an MCP tool colliding with a built-in) is listed once.
        let dup = vec![td("read"), td("read")];
        assert_eq!(tool_roster_prompt(Some(&dup)).matches("read").count(), 1);

        // Even a pathological tool list stays under the hard ceiling.
        let huge: Vec<_> = (0..2000).map(|i| td(&format!("tool_with_a_long_name_{i}"))).collect();
        assert!(tool_roster_prompt(Some(&huge)).len() <= TOOL_ROSTER_MAX_CHARS + 200);
    }

    /// No tools at all → empty roster, so the caller appends NO_TOOLS_NOTICE
    /// instead of leaving the model to hallucinate a call it cannot make.
    #[test]
    fn tool_roster_empty_states_are_distinct() {
        assert_eq!(tool_roster_prompt(None), "");
        assert_eq!(tool_roster_prompt(Some(&[])), "");
        assert!(NO_TOOLS_NOTICE.contains("无可用工具"));
        assert!(NO_TOOLS_NOTICE.contains("不要声称将要调用工具"));
    }

    /// Locale routing must not drop the roster — it is appended by the caller in
    /// both locales, and the roster text itself is locale-independent.
    #[test]
    fn both_locales_build_a_prompt() {
        let mut s = Settings::default();
        s.general.locale = "zh-CN".into();
        assert!(build_system_prompt(&s, "/ws").contains("核心规则"));
        s.general.locale = "en".into();
        assert!(build_system_prompt(&s, "/ws").contains("Core Rules"));
    }

    /// A user-defined agent in the project must reach the roster, since the caller
    /// resolves the roster against the project root.
    #[test]
    fn roster_includes_project_agents() {
        let root = std::env::temp_dir().join(format!("gwork-prompt-proj-{}", std::process::id()));
        let dir = root.join(".gwork").join("agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("auditor.md"),
            "---\nname: auditor\ndescription: audits things\ntools: [\"read\"]\n---\nYou audit.",
        )
        .unwrap();

        let out = build_agent_roster(&root, &PermissionSettings::default());
        assert!(out.contains("\"auditor\""), "project agent missing: {}", out);
        assert!(out.contains("audits things"), "description missing: {}", out);
        std::fs::remove_dir_all(&root).ok();
    }

    /// The PowerShell fallback block must carry every pitfall the Java prompt
    /// carries — dropping one sends the model back to POSIX syntax and fails.
    #[test]
    fn powershell_dialect_rules_cover_the_pitfalls() {
        let cn = powershell_dialect_rules(true);
        for want in ["PowerShell", "bash/sh", "&&", "Select-Object", "Get-Content", "2>&1", "curl.exe"] {
            assert!(cn.contains(want), "cn block missing {want}: {cn}");
        }
        let en = powershell_dialect_rules(false);
        for want in ["PowerShell", "bash/sh", "&&", "Select-Object", "2>&1"] {
            assert!(en.contains(want), "en block missing {want}: {en}");
        }
    }

    /// The Git Bash block confirms POSIX and the Windows-specific corrections,
    /// and stays shorter than the PowerShell block — the slimming guarantee for
    /// the common case (Git Bash installed).
    #[test]
    fn git_bash_dialect_rules_are_posix_and_compact() {
        let cn = git_bash_dialect_rules(true);
        for want in ["Git Bash", "POSIX", "/c/", "cmd //c"] {
            assert!(cn.contains(want), "cn block missing {want}: {cn}");
        }
        let en = git_bash_dialect_rules(false);
        for want in ["Git Bash", "POSIX", "/c/", "cmd //c"] {
            assert!(en.contains(want), "en block missing {want}: {en}");
        }
        assert!(
            git_bash_dialect_rules(true).len() < powershell_dialect_rules(true).len(),
            "Git Bash block must be cheaper than the PowerShell fallback"
        );
    }

    /// The dispatcher must agree with the bash tool's selector, so the prompt
    /// never describes a shell the tool will not spawn.
    #[test]
    fn shell_dialect_rules_matches_active_shell() {
        use crate::tools::builtin::{shell_kind, ShellKind};
        let out = shell_dialect_rules(false);
        match shell_kind() {
            ShellKind::GitBash => assert!(out.contains("Git Bash"), "{out}"),
            ShellKind::PowerShell => assert!(out.contains("PowerShell"), "{out}"),
            ShellKind::Sh => assert!(out.is_empty(), "Unix needs no dialect block: {out}"),
        }
    }

    /// On Windows both locales must append the *active* shell's dialect block.
    #[cfg(windows)]
    #[test]
    fn windows_prompts_carry_the_active_dialect_block() {
        use crate::tools::builtin::{shell_kind, ShellKind};
        let marker_cn = match shell_kind() {
            ShellKind::GitBash => "Git Bash",
            ShellKind::PowerShell => "PowerShell 方言",
            ShellKind::Sh => unreachable!("Windows never selects sh"),
        };
        let mut s = Settings::default();
        s.general.locale = "zh-CN".into();
        assert!(build_system_prompt(&s, "/ws").contains(marker_cn));
        s.general.locale = "en".into();
        assert!(build_system_prompt(&s, "/ws").contains("Terminal Dialect"));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_prompts_have_no_dialect_block() {
        let mut s = Settings::default();
        s.general.locale = "en".into();
        let out = build_system_prompt(&s, "/ws");
        assert!(!out.contains("PowerShell"));
        assert!(!out.contains("Terminal Dialect"));
    }
}
