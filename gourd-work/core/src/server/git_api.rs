//! Git HTTP endpoints (via git CLI).
//!
//! ## Two contract rules this module exists to honour
//!
//! **1. Every endpoint resolves an explicit `root`.** The frontend sends the
//! open project's directory as `?root=` (GET) or `root` in the body (POST),
//! because Code mode can point at any registered project while the kernel's own
//! `workspace` is a fixed install-time directory. Ignoring `root` — as an
//! earlier version did — made every git call operate on the kernel workspace,
//! so the panel reported "not a git repository" for a project that was one.
//!
//! **2. POST bodies are read with `FlexBody`, not `Form`.** The frontend sends
//! `Content-Type: application/json` for stage/unstage/commit; axum's `Form`
//! answers those with HTTP 415, which the UI surfaces as a generic "operation
//! failed" alert. See `super::flex_body`.
//!
//! `/web/chat/git/summary` is additionally a **POST** (the frontend posts
//! `sessionId` + `paths`), and it is not a log listing: it asks the session's
//! model to write a commit message from the diff, matching the Java kernel's
//! `GitService.summary`.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;

use super::flex_body::FlexBody;
use super::AppState;
use crate::gitops;

/// Resolve the repository root: an explicit absolute `root` wins, otherwise the
/// kernel workspace. Mirrors `filer_api::effective_root`.
///
/// Takes the workspace path rather than `&AppState` so the rule is unit-testable
/// without constructing the whole application state.
fn effective_root(workspace: &std::path::Path, root: &str) -> std::path::PathBuf {
    let trimmed = root.trim();
    if !trimmed.is_empty() && std::path::Path::new(trimmed).is_absolute() {
        std::path::PathBuf::from(trimmed)
    } else {
        workspace.to_path_buf()
    }
}

#[derive(serde::Deserialize, Default)]
pub struct GitQuery {
    #[serde(default)]
    pub path: String,
    #[serde(rename = "ref", default = "default_ref")]
    pub git_ref: String,
    /// Explicit project root (Code mode). See the module docs.
    #[serde(default)]
    pub root: String,
}

fn default_ref() -> String {
    "HEAD".into()
}

/// GET /web/chat/git/status
pub async fn status(State(state): State<Arc<AppState>>, Query(q): Query<GitQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    Json(gitops::status(&repo))
}

#[derive(serde::Deserialize, Default)]
pub struct GitDiffQuery {
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub root: String,
}

/// GET /web/chat/git/diff
pub async fn diff(State(state): State<Arc<AppState>>, Query(q): Query<GitDiffQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    let path = if q.path.is_empty() { None } else { Some(q.path.as_str()) };
    Json(gitops::diff(&repo, q.staged, path))
}

/// Body for stage / unstage / commit.
///
/// One struct for the family because the Java kernel reads the same handful of
/// keys off a raw JSON object per endpoint. `path` is the single-file form the
/// diff viewer sends; `files` is the multi-select form the commit dialog sends.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct GitBody {
    /// Single file path (stage / unstage).
    #[serde(default)]
    pub path: String,
    /// Commit message.
    #[serde(default)]
    pub message: String,
    /// Files to commit; empty means "everything" (`git add -A`).
    ///
    /// `flex_vec_string` because the frontend posts this as a JSON array, while
    /// a urlencoded caller can only express it comma-separated — and
    /// `serde_urlencoded` cannot build a sequence from repeated keys.
    #[serde(default, deserialize_with = "super::flex_body::flex_vec_string")]
    pub files: Vec<String>,
    /// Explicit project root.
    #[serde(default)]
    pub root: String,
    /// Session whose model selection should write the commit summary.
    #[serde(rename = "sessionId", alias = "session_id", default)]
    pub session_id: String,
    /// Selected paths for summary generation. The frontend sends this as a
    /// **JSON-encoded array string** (`paths=["a","b"]`), so it arrives as a
    /// string and is decoded in the handler.
    #[serde(default)]
    pub paths: String,
}

/// POST /web/chat/git/stage
pub async fn stage(State(state): State<Arc<AppState>>, FlexBody(body): FlexBody<GitBody>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &body.root);
    Json(gitops::stage(&repo, &body.path))
}

/// POST /web/chat/git/unstage
pub async fn unstage(State(state): State<Arc<AppState>>, FlexBody(body): FlexBody<GitBody>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &body.root);
    Json(gitops::unstage(&repo, &body.path))
}

/// POST /web/chat/git/commit
pub async fn commit(State(state): State<Arc<AppState>>, FlexBody(body): FlexBody<GitBody>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &body.root);
    Json(gitops::commit(&repo, &body.message, &body.files))
}

#[derive(serde::Deserialize, Default)]
pub struct GitSummaryQuery {
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub root: String,
}

/// GET /web/chat/git/log — commit history.
///
/// Registered under both `/log` and the legacy `/summary` GET path so an older
/// frontend build that polled history still works; the **POST** `/summary`
/// (LLM commit message) is a different handler and takes precedence for POST.
pub async fn log(State(state): State<Arc<AppState>>, Query(q): Query<GitSummaryQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    let limit = if q.limit == 0 { 20 } else { q.limit };
    Json(gitops::log(&repo, limit))
}

/// POST /web/chat/git/summary — ask the session's model to write a commit message.
///
/// The frontend posts `sessionId` + `paths` (a JSON-encoded array) and puts
/// `data.summary` straight into the commit-message box, so the response must be
/// a **string** under `summary` — not a commit list.
pub async fn summary(State(state): State<Arc<AppState>>, FlexBody(body): FlexBody<GitBody>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &body.root);

    // `paths` arrives as a JSON-encoded array string from the frontend; accept a
    // bare comma-separated list too so a hand-rolled caller still works.
    let files = decode_paths(&body.paths, &body.files);
    if files.is_empty() {
        return Json(serde_json::json!({"code": 400, "description": "paths is required"}));
    }

    // Resolve the model exactly like a chat turn does: session override >
    // global default. Without a model there is nothing to ask, and inventing a
    // fallback message would put fabricated text in the commit box.
    let model = {
        let settings = state.settings.read().await;
        let from_session = if body.session_id.is_empty() {
            None
        } else {
            let sm = state.session_models.lock().await;
            sm.get(&body.session_id).cloned()
        };
        from_session
            .and_then(|name| settings.get_model(&name).cloned())
            .or_else(|| settings.default_model_config().cloned())
    };
    let Some(model) = model else {
        return Json(serde_json::json!({
            "code": 500,
            "description": "生成摘要失败: no model configured"
        }));
    };

    let (combined_diff, stat_info) = gitops::collect_diff_for_summary(&repo, &files);
    let prompt = format!(
        "请根据以下 Git diff 变更内容，生成提交信息摘要。\n\n变更统计：{}\n\n--- Diff 内容 ---\n{}",
        stat_info, combined_diff
    );

    let client = crate::llm::LlmClient::new(model);
    // The system prompt is load-bearing, not decoration. The Java kernel runs this
    // through a dedicated `git-summary` agent whose prompt fixes the output
    // format and forbids meta-commentary; without an equivalent here the model
    // free-styles. Observed in a live run: the reply was a hallucinated
    // `<tool_call><function=Shell>` block referencing a directory that does not
    // exist on this machine — and the frontend pastes `data.summary` straight
    // into the commit-message box, so that garbage would have been committed.
    //
    // This kernel passes the diff inline and grants no tools (deliberately: a
    // commit-message helper should not get shell access), so the prompt also has
    // to say explicitly that no command can or should be run.
    let messages = vec![
        crate::llm::ChatMessage::system(GIT_SUMMARY_SYSTEM_PROMPT),
        crate::llm::ChatMessage::user(prompt),
    ];

    match client.complete(messages).await {
        Ok(raw) => {
            let summary = gitops::clean_summary(&raw);
            // Refuse to hand a tool-call hallucination to the commit box. Better
            // an explicit failure the user can retry than a fabricated message
            // that lands in the repository history.
            if is_tool_call_hallucination(&summary) {
                return Json(serde_json::json!({
                    "code": 500,
                    "description": "生成摘要失败: 模型返回了工具调用而非提交信息，请重试"
                }));
            }
            if summary.trim().is_empty() {
                return Json(serde_json::json!({
                    "code": 500,
                    "description": "生成摘要失败: 模型返回空内容，请重试"
                }));
            }
            Json(serde_json::json!({
                "code": 200,
                "data": { "summary": summary }
            }))
        }
        Err(e) => Json(serde_json::json!({
            "code": 500,
            "description": format!("生成摘要失败: {}", e)
        })),
    }
}

/// System prompt for commit-message generation, mirroring the output rules of
/// the Java kernel's `git-summary.md` agent definition.
const GIT_SUMMARY_SYSTEM_PROMPT: &str = "\
你是一位版本控制分析专家，任务是根据给定的 Git diff 生成一条提交信息。

重要约束：
- diff 内容已完整提供在用户消息中。你没有被授予任何工具，也无法执行命令；\
不要尝试调用工具、不要输出任何形式的工具调用或函数调用标记、不要要求执行 git 命令。
- 所有结论必须来自给定的 diff 内容，严禁凭文件名臆测改动。

提交信息规范：
- 格式为 `<type>: <description>`，必要时空一行后补充正文。
- type 取值：feat、fix、refactor、docs、test、chore、perf、ci。
- 只输出提交信息本身，不得附加署名、生成工具标记、代码围栏或任何元信息。
- 语言精准克制，严禁使用表情符号。";

/// Detect a reply that is a tool/function call rather than prose.
///
/// Models trained for agent use sometimes emit their call syntax as plain text
/// when no tools are actually offered. Any of these shapes means the generation
/// is unusable as a commit message.
fn is_tool_call_hallucination(text: &str) -> bool {
    const MARKERS: &[&str] = &[
        "<tool_call",
        "<function=",
        "<parameter=",
        "tool_calls\":",
        "```tool_code",
    ];
    MARKERS.iter().any(|m| text.contains(m))
}

/// Decode the `paths` parameter into a file list.
///
/// The frontend sends `paths=JSON.stringify(files)`, i.e. a JSON array encoded
/// as a string. Fall back to `files` (already an array) and then to a
/// comma-separated `paths`, so all three shapes work.
///
/// An **explicitly empty** JSON array (`[]`) means "nothing selected" and falls
/// back to `files` — it must not be re-parsed as the literal comma-separated
/// token `"[]"`, which is what an earlier version did.
fn decode_paths(paths: &str, files: &[String]) -> Vec<String> {
    let trimmed = paths.trim();
    if !trimmed.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            // Valid JSON: an array or a bare string. Either way the JSON parse
            // is authoritative — do not fall through to comma-splitting, or
            // `[]` would become the single token "[]".
            if let Some(arr) = v.as_array() {
                let out: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .filter(|s| !s.trim().is_empty())
                    .collect();
                if !out.is_empty() {
                    return out;
                }
                return files.to_vec();
            }
            if let Some(s) = v.as_str() {
                if !s.trim().is_empty() {
                    return vec![s.to_string()];
                }
            }
            return files.to_vec();
        }
        // Not JSON: treat as a comma-separated list.
        let out: Vec<String> = trimmed
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !out.is_empty() {
            return out;
        }
    }
    files.to_vec()
}

#[derive(serde::Deserialize, Default)]
pub struct GitInitQuery {
    #[serde(rename = "initialCommit", default)]
    pub initial_commit: bool,
    #[serde(default)]
    pub root: String,
}

/// POST /web/chat/git/init
pub async fn init(State(state): State<Arc<AppState>>, Query(q): Query<GitInitQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    Json(gitops::init(&repo, q.initial_commit))
}

/// GET /web/chat/git/remote
pub async fn remote(State(state): State<Arc<AppState>>, Query(q): Query<GitQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    Json(gitops::remote(&repo))
}

/// GET /web/chat/git/file-content
pub async fn file_content(State(state): State<Arc<AppState>>, Query(q): Query<GitQuery>) -> Json<serde_json::Value> {
    let repo = effective_root(&state.workspace, &q.root);
    Json(gitops::file_content(&repo, &q.path, &q.git_ref))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_decodes_the_frontend_json_array_string() {
        let got = decode_paths(r#"["a.rs","b.rs"]"#, &[]);
        assert_eq!(got, vec!["a.rs".to_string(), "b.rs".to_string()]);
    }

    #[test]
    fn paths_decodes_a_single_json_string() {
        assert_eq!(decode_paths(r#""only.rs""#, &[]), vec!["only.rs".to_string()]);
    }

    #[test]
    fn paths_falls_back_to_comma_separated() {
        assert_eq!(
            decode_paths("a.rs, b.rs ,c.rs", &[]),
            vec!["a.rs".to_string(), "b.rs".to_string(), "c.rs".to_string()]
        );
    }

    #[test]
    fn paths_falls_back_to_the_files_array_when_empty() {
        let files = vec!["x.rs".to_string()];
        assert_eq!(decode_paths("", &files), files);
        assert_eq!(decode_paths("   ", &files), files);
        assert_eq!(decode_paths("[]", &files), files, "empty JSON array is not a selection");
    }

    #[test]
    fn paths_drops_blank_entries() {
        assert_eq!(decode_paths(r#"["a.rs","","  "]"#, &[]), vec!["a.rs".to_string()]);
    }

    #[test]
    fn paths_prefers_the_explicit_param_over_files() {
        let got = decode_paths(r#"["from-paths.rs"]"#, &["from-files.rs".to_string()]);
        assert_eq!(got, vec!["from-paths.rs".to_string()]);
    }

    #[test]
    fn root_resolution_requires_an_absolute_path() {
        let ws = std::path::Path::new("D:\\kernel\\workspace");
        // Absolute wins.
        assert_eq!(
            effective_root(ws, "D:\\work\\project"),
            std::path::PathBuf::from("D:\\work\\project")
        );
        // Relative or empty falls back to the kernel workspace — accepting a
        // relative root would resolve it against the process CWD, which is
        // wherever the desktop shell happened to be launched from.
        assert_eq!(effective_root(ws, ""), std::path::PathBuf::from("D:\\kernel\\workspace"));
        assert_eq!(
            effective_root(ws, "relative/path"),
            std::path::PathBuf::from("D:\\kernel\\workspace")
        );
    }

    /// A POSIX-style absolute root must also be honoured (macOS/Linux builds).
    #[test]
    #[cfg(unix)]
    fn root_resolution_accepts_posix_absolute_path() {
        let ws = std::path::Path::new("/kernel/workspace");
        assert_eq!(effective_root(ws, "/home/user/proj"), std::path::PathBuf::from("/home/user/proj"));
    }

    // ── tool-call hallucination guard ─────────────────────────────────────
    //
    // The frontend pastes `data.summary` straight into the commit-message box,
    // so a model reply that is really a tool call must be rejected rather than
    // committed. This was observed live (a `<function=Shell>` block referencing
    // a directory that does not exist here), not hypothesized.

    #[test]
    fn detects_the_observed_tool_call_hallucination() {
        let observed = "<tool_call>\n<function=Shell>\n<parameter=Command>\ncd D:/Projects/Qoder>\n</parameter>\n</function>\n</tool_call>";
        assert!(is_tool_call_hallucination(observed), "the live-observed shape must be caught");
    }

    #[test]
    fn detects_each_tool_call_marker_independently() {
        for m in ["<tool_call", "<function=", "<parameter=", "tool_calls\":", "```tool_code"] {
            assert!(is_tool_call_hallucination(&format!("prefix {} suffix", m)), "marker {:?} not caught", m);
        }
    }

    #[test]
    fn a_normal_commit_message_is_not_flagged() {
        for ok in [
            "fix: 修复会话标题恒为 New Session 的缺陷",
            "feat: add FlexBody extractor\n\nAccepts JSON, urlencoded and multipart bodies.",
            "refactor(git): route every endpoint through an explicit root",
        ] {
            assert!(!is_tool_call_hallucination(ok), "false positive on {:?}", ok);
        }
    }

    /// The system prompt must actually forbid tool calls and pin the output
    /// format; without those clauses the model free-styles (the observed bug).
    #[test]
    fn system_prompt_forbids_tool_calls_and_pins_format() {
        let p = GIT_SUMMARY_SYSTEM_PROMPT;
        assert!(p.contains("没有被授予任何工具"), "must state no tools are available");
        assert!(p.contains("不要尝试调用工具"), "must forbid attempting tool calls");
        assert!(p.contains("<type>: <description>"), "must pin the commit-message format");
        assert!(p.contains("只输出提交信息本身"), "must forbid meta-commentary");
    }
}
