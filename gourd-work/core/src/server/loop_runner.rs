//! loop_runner — Executes a loop task as a full agent run.
//!
//! Called by the scheduler tick and by /web/chat/loop/trigger. Runs the task's
//! effective prompt against the runtime session, captures the final answer,
//! detects [GOAL_ACHIEVED], and records the result.

use std::sync::Arc;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::AppState;
use crate::llm::ChatMessage;
use crate::loop_task::LoopTask;
use crate::protocol::Frame;
use crate::react::{ReActAgent, ReActConfig};

/// Execute one iteration of a loop task.
pub async fn execute_loop_task(state: Arc<AppState>, task_id: String, task: LoopTask) {
    // Prevent re-entrancy
    if !state.loop_scheduler.try_start(&task_id).await {
        return;
    }

    // Resolve runtime session
    let session_id = match state.loop_scheduler.runtime_session_id(&task_id).await {
        Some(sid) => sid,
        None => {
            return;
        }
    };

    // Resolve model
    let settings = state.settings.read().await.clone();
    let model = task
        .model_name
        .as_ref()
        .and_then(|n| settings.get_model(n).cloned())
        .or_else(|| settings.default_model_config().cloned());
    let Some(model) = model else {
        state.loop_scheduler.record_result(&task_id, "No model configured", false).await;
        return;
    };

    let access_mode = task.access_mode.clone().unwrap_or_else(|| "full".into());
    let prompt = crate::loop_task::LoopScheduler::build_effective_prompt(&task);

    // The session's authoritative seq counter. Resolved before the first frame is
    // built, because every frame this function hands to `persist_frame` directly
    // (bypassing the forwarder) must be numbered here.
    let seq_counter = state.seq_for(&session_id).await;

    // Emit a user_input frame so the frontend renders the loop's prompt bubble.
    //
    // Stamped from the session counter **before** it is persisted: this frame goes
    // straight to `persist_frame` rather than through the forwarder below, so it
    // would otherwise land in the stream file with no `eventSeq` at all — the same
    // hole that hid `hitl` / `question` / `agent_start` / `agent_end` from
    // cursor-scoped replay (`session/mod.rs` drops a frame whose seq is `None` in
    // both `After` and `Rounds{before_seq}` modes). A loop prompt bubble would then
    // survive a page refresh but disappear on "load earlier" and on reconnect.
    let user_frame = super::stamp_seq(&seq_counter, Frame::user_input(&session_id, &prompt, "loop"));
    super::persist_frame(&state, &session_id, &user_frame).await;
    super::broadcast_frame(&state, &session_id, user_frame).await;

    // Persist the user message (ownership-routed)
    let store = super::store_for(&state, &session_id);
    let _ = store.append_message(
        &session_id,
        &crate::session::StoredMessage {
            role: "USER".into(),
            content: prompt.clone(),
            blocks: Some(vec![serde_json::json!({
                "@type": "com.gourdai.ai.chat.content.TextBlock",
                "text": prompt,
            })]),
            text: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            metadata: Some(serde_json::json!({"source": "loop", "taskId": task_id})),
        },
    );

    // Build history
    let run_id = format!("loop-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    // Read *after* the prompt frame above has been stamped, so the run continues
    // numbering past it rather than reusing that seq.
    let start_seq = seq_counter.load(std::sync::atomic::Ordering::SeqCst);
    let window = settings.general.history_window_size as usize;
    let mut history = store.to_chat_messages(&session_id, window);
    let system = crate::react::prompt::build_system_prompt(&settings, &state.workspace.to_string_lossy())
        + &crate::react::prompt::build_agent_roster(&state.workspace, &settings.permission);
    history.insert(0, ChatMessage::system(system));

    // Frame channel → broadcast + persist.
    //
    // Same single authoritative numbering point as the interactive run's forwarder
    // (see the long comment in `run_react_session`): every frame is re-stamped here
    // so tool-direct frames (`hitl`, `question`, `agent_start`, `agent_end`) get an
    // `eventSeq` instead of being dropped by cursor-scoped replay, and forwarded
    // sub-agent frames lose their own `start_seq: 0` numbering instead of rewinding
    // this session's sequence.
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();
    let state_fwd = state.clone();
    let sid_fwd = session_id.clone();
    let counter_fwd = seq_counter.clone();
    let fwd = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            // Same single authoritative numbering point as the interactive run:
            // `relay_frame` stamps and persists as one step so their order cannot
            // drift. See the long comment in `run_react_session`.
            //
            // The store is resolved per frame rather than hoisted, matching what
            // `persist_frame` did internally before: session ownership can be
            // established while a run is already streaming, and a store captured at
            // spawn time would then keep writing to the wrong root.
            let frame = super::relay_frame(
                &counter_fwd,
                &super::store_for(&state_fwd, &sid_fwd),
                &sid_fwd,
                frame,
            );
            super::broadcast_frame(&state_fwd, &sid_fwd, frame).await;
        }
    });

    let session_dir = store.session_dir_pub(&session_id);
    let usage_seed = crate::session_usage::sum_usage(
        &session_dir.join(format!("{}.stream.ndjson", crate::session::sanitize_id(&session_id))),
    );
    let context_length = store
        .read_context(&session_id)
        .context_length
        .unwrap_or(settings.general.context_length);
    let config = ReActConfig {
        session_id: session_id.clone(),
        workspace: state.workspace.clone(),
        // Loop sessions are real sessions with their own storage; route
        // per-session artefacts there just like an interactive run does.
        session_dir: Some(session_dir),
        model: model.clone(),
        settings: settings.clone(),
        access_mode,
        max_turns: settings.general.max_turns,
        run_id,
        start_seq,
        hitl_approved: true, // loop tasks run without approval gates
        gate: None,
        change_ledger: Some(state.change_ledger.clone()),
        // Loop tasks are top-level runs.
        subagent_depth: 0,
        root_session_id: session_id.clone(),
        // A loop task carries its own thinking level (`loop_task.thinking_depth`),
        // set when the automation was created rather than per session.
        thinking: task.thinking_depth.clone(),
        context_length,
        turn_start_ms: chrono::Utc::now().timestamp_millis(),
        usage_seed,
        // A scheduled loop task has no `/compact` entry point.
        force_compact: false,
        compact_focus: None,
    };
    let agent = ReActAgent::new(state.registry.clone());
    let cancel = CancellationToken::new();
    let result = agent.run(&config, history, frame_tx, cancel).await;

    // Advance the counter, never rewind it — see the matching comment in
    // `run_react_session`. `result.next_seq` counts only ReAct's own frames and is
    // blind to the forwarded sub-agent frames the forwarder above already numbered
    // out of this same counter, so a bare `store` would rewind it.
    super::advance_counter(&seq_counter, result.next_seq);
    drop(fwd);

    let answer = result.final_answer.clone();
    if !answer.is_empty() {
        let _ = store.append_message(
            &session_id,
            &crate::session::StoredMessage {
                role: "ASSISTANT".into(),
                // Dual-write (see StoredMessage docs): Java readers split
                // between `text` (getText) and `content` (messages endpoint).
                content: answer.clone(),
                text: Some(answer.clone()),
                blocks: None,
                created_at: chrono::Utc::now().timestamp_millis(),
                metadata: Some(serde_json::json!({"source": "loop", "taskId": task_id})),
            },
        );
    }

    // Finish the change ledger run. Same `clean` rule as the interactive path:
    // a loop task that completed or suspended wraps up READY; one that was
    // cancelled, hit the turn ceiling or errored wraps up INCOMPLETE so the UI
    // can warn that the last writes may be untracked.
    let clean = matches!(
        result.stop_reason,
        crate::react::StopReason::Completed
            | crate::react::StopReason::SuspendedQuestion
            | crate::react::StopReason::SuspendedHitl
    );
    if let Some(summary) = state.change_ledger.finish(&session_id, &config.run_id, clean) {
        // Loop runs have no live UI stream in the common case (they are scheduled
        // headless), but the frame is still persisted so the session's history
        // shows the change card on replay — the frontend's replay path consumes
        // `file_changes` through the same handler.
        let frame = crate::protocol::Frame::file_changes(&session_id, &config.run_id, summary)
            .seq(seq_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        crate::server::persist_frame(&state, &session_id, &frame).await;
        crate::server::broadcast_frame(&state, &session_id, frame).await;
    }

    // Detect goal achievement
    let goal_achieved = answer.contains("[GOAL_ACHIEVED]");
    state.loop_scheduler.record_result(&task_id, &answer, goal_achieved).await;

    // Optional channel notification
    if let Some(channel) = &task.channel_notify {
        let notify_text = format!("[Loop] {}\n{}", task.name.as_deref().unwrap_or(&task_id), answer.chars().take(1000).collect::<String>());
        crate::channels::channels_notify(channel, &notify_text);
    }
}
