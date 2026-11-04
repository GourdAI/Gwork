//! loop_driver — Background scheduler that triggers due loop tasks.
//!
//! Runs a tick loop (every 30s) that checks each enabled, active task and
//! triggers it when its next-run time has arrived. Tracks last-trigger time
//! per task in memory to honor interval/cron spacing.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::AppState;

/// Start the loop scheduler driver. Spawns a background task; returns immediately.
pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        // Track last trigger time per task id
        let last_run: Arc<Mutex<HashMap<String, std::time::Instant>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let mut ticker = interval(Duration::from_secs(30));
        ticker.tick().await; // skip immediate first tick
        loop {
            ticker.tick().await;
            let tasks = {
                let sched = state.loop_scheduler.clone();
                // List all tasks across sessions (use empty session filter = all)
                sched.list_all_global().await
            };
            for task in tasks {
                if !task.enabled || !task.is_active() {
                    continue;
                }
                if task.is_max_iterations_reached() {
                    continue;
                }
                let task_id = task.id.clone();
                let delay = crate::loop_task::LoopScheduler::next_delay(&task);
                let should_run = {
                    let mut lr = last_run.lock().await;
                    match lr.get(&task_id) {
                        Some(last) => last.elapsed() >= delay,
                        // Never seen before: runNow=true triggers immediately;
                        // otherwise record now as the baseline so the first real
                        // run happens after one full interval (Java initialDelay).
                        None => {
                            if task.run_now.unwrap_or(false) {
                                true
                            } else {
                                lr.insert(task_id.clone(), std::time::Instant::now());
                                false
                            }
                        }
                    }
                };
                if !should_run {
                    continue;
                }
                // Record trigger time
                last_run.lock().await.insert(task_id.clone(), std::time::Instant::now());
                // Spawn the run
                let state_clone = state.clone();
                let task_clone = task.clone();
                tokio::spawn(async move {
                    super::loop_runner::execute_loop_task(state_clone, task_id, task_clone).await;
                });
            }
        }
    });
}
