//! 官方模型源凭据与模型列表缓存：**只内存、不落盘、不进 WebView**。
//!
//! 桌面 Tauri 壳与 `server::serve` 跑在同一进程（见跨模块契约
//! `.gwork/PLAN-official-model-key.md` B 节）。壳登录成功后直接调用
//! [`set`] 把用户自己的普通 48 位模型 key 与一次性拉取的 `/v1/models`
//! 列表写入这里；登出调用 [`clear`]。core 不主动发网络请求，也不把这个
//! 结构体序列化到 `settings.json`、日志或任何 HTTP 响应体。
//!
//! 不变量：
//! - [`OfficialCredential`] **没有** `Serialize`/`Deserialize`，因此不能被
//!   `Json(...)`、`serde_json::to_string(&settings)` 之类的路径带出去；
//! - 这个模块不读写磁盘，`key` 只经 [`key`] 返回给同进程的
//!   `LlmClient::with_retries` 注入请求头；
//! - HTTP 端点只能使用 `is_ready` / `models` 与不含凭据的快照字段，
//!   且必须经过手工白名单构造响应（见 `server::official_api`）。
//!
//! ## 失效闭环（2026-11 codereview 补强）
//! 服务端可以在桌面进程毫不知情的情况下改变这把 key：用户删/禁用/重置
//! token、额度耗尽、管理员改状态、换账号登录、同账号重登。`LlmClient`
//! 拿到 401/403 时调 [`report_auth_failure`]，这里会：
//!   1. 把快照标记为 stale（**不清空**，避免当前 run 与 UI 抖动成「请先登录」）；
//!   2. 触发壳注册的 [`set_refresh_hook`] 回调，由壳异步强制重新取一次 key
//!      并 [`set`] 回来（core 自身绝不发网络请求）；
//!   3. 用 10 秒节流避免同一波重试风暴里 spawn 一堆重取任务。
//! 模型调用重试循环每次都会重读 [`key`]，重取成功后下一次 attempt 就用新
//! key 重建请求头，实现「当前 run 内自愈」。
//!
//! [`generation`] / [`set_if`] 防止 in-flight 的旧会话 prime 在用户切换账号
//! 或登出后把旧凭据写回：任何 `set`/`clear` 都推进代际，prime 结束前用
//! `set_if(开始时代际)` 复核。
//!
//! 明确登出 / 会话被服务端判定 terminal 仍走 [`clear`]（立即清空、推进代际）。

use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 虚拟服务商条目的固定名称。C 节要求 providers 读写端点统一识别它。
pub const OFFICIAL_PROVIDER_NAME: &str = "GWork 官方";

/// 竞速探测的候选站点：同一套 new-api 实例的多站点反代（实测两站的
/// `/api/status` 返回同一个 `start_time` / `system_name` / `setup`）。
/// 用户口径：「模型调用的 API 地址和别的 API 地址只有后缀名是不同的」——
/// 同一 host 下账号链路走 `{host}/api/...`，模型链路走 `{host}/v1/...`。
pub const OFFICIAL_HOST_CN: &str = "https://www.gourd-ai.cn";
pub const OFFICIAL_HOST_INTL: &str = "https://www.gourdwork.com";
pub const OFFICIAL_HOSTS: &[&str] = &[OFFICIAL_HOST_CN, OFFICIAL_HOST_INTL];
/// 探测前 / 两个站点都探测失败时的回落 host。
pub const DEFAULT_OFFICIAL_HOST: &str = OFFICIAL_HOST_INTL;
/// 默认站的 relay base（带 `/v1`），即未探测/探测失败时 [`base_url`] 的值。
/// 保留为常量主要是给单测当「默认期望值」以及给不关心选路的调用方一个
/// 稳定字面量；生产链路一律用运行时 [`base_url`] / [`host`]，不要用它。
pub const OFFICIAL_BASE_URL: &str = "https://www.gourdwork.com/v1";

/// 【运行时选中站点】由桌面壳在启动竞速探测成功后写入。
///
/// 之所以不是编译期常量：站点是「按当前网络环境选最优」的，模型调用
/// (`LlmClient`) 必须把 key 发到**当次选中**的那个 host。这个值决定凭据的
/// 目的地，因此 [`set_selected_host`] 只接受 [`OFFICIAL_HOSTS`] 白名单里的
/// https 地址，任意写入会被拒，杜绝「改写配置把用户 key 发到第三方」。
static SELECTED_HOST: OnceLock<RwLock<String>> = OnceLock::new();

fn host_slot() -> &'static RwLock<String> {
    SELECTED_HOST.get_or_init(|| RwLock::new(DEFAULT_OFFICIAL_HOST.to_string()))
}

/// 壳在竞速探测胜出后调用。返回 false 表示非白名单地址（拒绝写入）。
pub fn set_selected_host(host: &str) -> bool {
    let h = host.trim().trim_end_matches('/');
    if !OFFICIAL_HOSTS.iter().any(|candidate| *candidate == h) {
        return false;
    }
    match host_slot().write() {
        Ok(mut guard) => *guard = h.to_string(),
        Err(poisoned) => *poisoned.into_inner() = h.to_string(),
    }
    true
}

/// 当前选中的 host（无 `/v1`）；未探测/探测失败时回落默认站。
pub fn host() -> String {
    match host_slot().read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// 模型 relay 的 base（带 `/v1`）。`Dialect::OpenAiChat` 会据此拼出
/// `{host}/v1/chat/completions`；账号侧的 `/v1/models` 由桌面壳用
/// [`host`] + 自己的后缀拼接，两处各拼一次，**不会**出现 `/v1/v1/...`。
/// 官方源不是可配置自定义地址（契约 C/D 节）。
pub fn base_url() -> String {
    format!("{}/v1", host().trim_end_matches('/'))
}

/// 两次 auth failure 触发重取之间的最小间隔（秒）。重取本身要发网络请求，
/// 不加节流的话一次 401 的 modelRetries 重试（最多 10 次 × 并发 run）会
/// 瞬间 spawn 出成片的重取任务。
const FAILURE_REFRESH_THROTTLE_SECS: u64 = 10;

/// 连续「重取后 key 没变」达到此值即熔断，停止自动重取。
///
/// 【codereview 修复】401 并不总是「用户 key 失效」：admin relay 在**上游渠道**
/// 没有可用 key 时同样回 401（`service/relay_error_test.go:109` 的
/// `ErrorCodeChannelNoAvailableKey` + `http.StatusUnauthorized`），账号被封时
/// `TokenAuth` 也回 401。这些情况重取 `/api/user/self/model-key` 只会拿回
/// **同一把本来就合格**的 key，永远治不好。
///
/// 而 `set()` 会把节流时间戳清零（新 key 到位后必须允许下一次真实失效立即
/// 触发重取），于是「401 → 重取 → key 没变 → 节流清零 → 下一次 401 → 重取」
/// 变成一个**没有上限**的循环：单次 run 的每个 attempt 都会打两个后台请求
/// （其中 `ensureUserModelKey` 还带事务与行锁），并发 run 下直接压垮 admin。
///
/// 判据用「key 是否真的换了」而非计数时间窗：token 被删/禁用/额度归零时
/// `ensureUserModelKey` 会新建一把，key 必然变化 → 计数归零 → 自愈继续有效；
/// 只有服务端坚持返回同一把 key（说明它认为这把 key 没问题）才熔断。
const UNCHANGED_REFRESH_CIRCUIT_LIMIT: u32 = 2;

/// `/v1/models` 的单个条目。仅 `id` / `owned_by` 是非敏感展示字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficialModel {
    pub id: String,
    pub owned_by: String,
}

/// 登录后由壳写入的进程内快照。
///
/// 故意不派生序列化 trait，也**不派生 `Debug`**：一条 `{:?}` 日志就足以
/// 把 key 打印出去。模型调用只通过 [`key`] 取凭据，零网络开销。
#[derive(Clone)]
pub struct OfficialCredential {
    /// 用户自己 `tokens` 表里的裸 48 位 base62 key（不带 `sk-`）。
    pub key: String,
    pub base_url: String,
    pub user_id: i64,
    pub username: String,
    pub models: Vec<OfficialModel>,
}

/// 进程级状态。除凭据本身外还带代际、stale 标记与上报节流时间戳。
struct OfficialState {
    credential: Option<OfficialCredential>,
    /// 每次 `set`/`clear` 递增，供 in-flight prime 用 `set_if` 复核。
    generation: u64,
    /// 最近一次模型调用被判定为鉴权失败（key 可能已失效）。
    stale: bool,
    last_failure_report: u64,
    /// 「重取后 key 没变」的连续次数，实现自动重取的熔断。
    /// 见 [`UNCHANGED_REFRESH_CIRCUIT_LIMIT`]。
    unchanged_refreshes: u32,
}

/// 壳注册的「强制重新取 key」回调。必须是 `Fn()`（同步）：真正的网络请求
/// 由回调内部 `async_runtime::spawn` 发起，core 不引入任何异步运行时依赖。
type RefreshHook = Arc<dyn Fn() + Send + Sync + 'static>;

static STATE: OnceLock<RwLock<OfficialState>> = OnceLock::new();
static REFRESH_HOOK: OnceLock<RwLock<Option<RefreshHook>>> = OnceLock::new();

fn slot() -> &'static RwLock<OfficialState> {
    STATE.get_or_init(|| {
        RwLock::new(OfficialState {
            credential: None,
            generation: 0,
            stale: false,
            last_failure_report: 0,
            unchanged_refreshes: 0,
        })
    })
}

/// 写入快照的共用实现：推进代际、清 stale，并维护「重取后 key 没变」的
/// 熔断计数。key 变化（token 被删/禁用/额度归零后新建）说明这次重取确实
/// 拿到了新凭据，计数归零；key 没变说明服务端认为它本来就好使，累加计数。
/// `clear()` 之后 credential 为 None，视为全新登录，计数同样归零。
fn apply_credential(guard: &mut OfficialState, c: OfficialCredential) {
    let unchanged = guard
        .credential
        .as_ref()
        .map(|old| !old.key.is_empty() && old.key == c.key)
        .unwrap_or(false);
    guard.unchanged_refreshes = if unchanged {
        guard.unchanged_refreshes.saturating_add(1)
    } else {
        0
    };
    guard.generation = guard.generation.wrapping_add(1);
    guard.credential = Some(c);
    guard.stale = false;
    // 新 key 到位后允许下一次真实失效立即触发重取，不被旧节流窗口吞掉。
    guard.last_failure_report = 0;
}

fn hook_slot() -> &'static RwLock<Option<RefreshHook>> {
    REFRESH_HOOK.get_or_init(|| RwLock::new(None))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 桌面壳在 `install()` 时注册一次：模型调用遇到 401/403 时由本模块回调，
/// 壳负责异步重新拉 `/api/user/self/model-key` + `/v1/models` 并 `set` 回来。
/// 生产环境只调用一次；测试可重复覆盖。
pub fn set_refresh_hook(hook: RefreshHook) {
    match hook_slot().write() {
        Ok(mut guard) => *guard = Some(hook),
        Err(poisoned) => *poisoned.into_inner() = Some(hook),
    }
}

/// 写入/替换整份内存快照。壳登录/重取成功后调用；重复 set 是覆盖语义，
/// 同时清掉 stale 并推进代际。
pub fn set(c: OfficialCredential) {
    match slot().write() {
        Ok(mut guard) => apply_credential(&mut guard, c),
        // 别的线程在持写锁期间 panic 不应让后续登录永久失效。
        Err(poisoned) => apply_credential(&mut poisoned.into_inner(), c),
    }
}

/// 条件写入：仅当代际仍等于 `expected` 时才写。
///
/// 壳的 prime 是「读会话 → await 网络 → await /v1/models → 写」的长流程；
/// 期间用户可能已经切换账号、登出、或另一路 prime 先写成功。用开始时的
/// 代际复核，避免过期流程把旧账号凭据覆盖回来。
pub fn set_if(expected: u64, c: OfficialCredential) -> bool {
    match slot().write() {
        Ok(mut guard) => {
            if guard.generation != expected {
                return false;
            }
            apply_credential(&mut guard, c);
            true
        }
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            if guard.generation != expected {
                return false;
            }
            apply_credential(&mut guard, c);
            true
        }
    }
}

/// 取一份克隆快照；未登录返回 `None`。返回的是副本，调用方持有它不会
/// 阻塞后续 `set`/`clear`。注意快照含 key：生产调用方只应用来核对用户身份，
/// 不要打印/序列化/放进 HTTP 响应。
pub fn get() -> Option<OfficialCredential> {
    match slot().read() {
        Ok(guard) => guard.credential.clone(),
        Err(poisoned) => poisoned.into_inner().credential.clone(),
    }
}

/// 登出 / 会话被撤销时清空。推进代际以作废所有 in-flight prime，
/// 并复位熔断计数：新登录应当重新获得完整的自愈机会。
pub fn clear() {
    match slot().write() {
        Ok(mut guard) => {
            guard.generation = guard.generation.wrapping_add(1);
            guard.credential = None;
            guard.stale = false;
            guard.unchanged_refreshes = 0;
        }
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            guard.generation = guard.generation.wrapping_add(1);
            guard.credential = None;
            guard.stale = false;
            guard.unchanged_refreshes = 0;
        }
    }
}

/// 当前代际，供 prime 开始时记录、结束前 `set_if` 复核。
pub fn generation() -> u64 {
    match slot().read() {
        Ok(guard) => guard.generation,
        Err(poisoned) => poisoned.into_inner().generation,
    }
}

/// 最近一次模型调用是否判定过 key 失效（壳据此决定强制重取）。
pub fn is_stale() -> bool {
    match slot().read() {
        Ok(guard) => guard.stale,
        Err(poisoned) => poisoned.into_inner().stale,
    }
}

/// 模型调用拿到 401/403（疑似 key 失效）时上报。
///
/// 只标记 stale + 节流触发壳的重取回调，**不清空**凭据：清空会让正在重试
/// 的 run 与 UI 立刻抖成「请先登录」，而保留一把已判失效的 key 没有额外
/// 安全损失（它本来就调不通了）。重取成功后 `set` 会清 stale 并换上新 key。
///
/// 【熔断】连续 [`UNCHANGED_REFRESH_CIRCUIT_LIMIT`] 次重取都拿回同一把 key，
/// 就停止自动触发回调：说明服务端认为这把 key 本来就好使，401 的真因在上游
/// 渠道（relay 对「渠道无可用 key」同样回 401）或账号被封，重取治不好，
/// 继续自动重取只会变成无上限的后台压力。此时仍保留 stale 标记，用户点
/// 「刷新」或重新登录（走 `clear()` 复位计数）依然能强制重取一次。
pub fn report_auth_failure() {
    let now = now_secs();
    let should_fire = {
        match slot().write() {
            Ok(mut guard) => decide_refresh(&mut guard, now),
            Err(poisoned) => decide_refresh(&mut poisoned.into_inner(), now),
        }
    };
    if should_fire {
        let hook = match hook_slot().read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(h) = hook {
            h();
        }
    }
}

/// 熔断已打开（自动重取已停止，需要用户手动刷新或重新登录）。
pub fn refresh_circuit_open() -> bool {
    match slot().read() {
        Ok(guard) => guard.unchanged_refreshes >= UNCHANGED_REFRESH_CIRCUIT_LIMIT,
        Err(poisoned) => {
            poisoned.into_inner().unchanged_refreshes >= UNCHANGED_REFRESH_CIRCUIT_LIMIT
        }
    }
}

/// 节流 + 熔断判定。持写锁调用；返回是否应当触发壳的重取回调。
fn decide_refresh(guard: &mut OfficialState, now: u64) -> bool {
    // 无论本次是否触发回调，都把快照标记为「可疑」：壳后续的 prime 看到
    // stale 会强制重取，不会命中缓存跳过。这样即便 hook 那一路 prime 因
    // 时序/网络没跑成，仍有兜底自愈机会。
    guard.stale = true;
    if guard.unchanged_refreshes >= UNCHANGED_REFRESH_CIRCUIT_LIMIT {
        return false;
    }
    let elapsed = now.saturating_sub(guard.last_failure_report);
    if elapsed < FAILURE_REFRESH_THROTTLE_SECS {
        return false;
    }
    guard.last_failure_report = now;
    true
}

/// 模型调用唯一取 key 的入口。空白 key 视为未登录。
/// 返回进程内存里的**裸** key（不带 `sk-`）；只有 [`bearer_key`] 才用于上线路。
pub fn key() -> Option<String> {
    get().and_then(|c| {
        if c.key.trim().is_empty() {
            None
        } else {
            Some(c.key)
        }
    })
}

/// 实际放进 `Authorization: Bearer` / `x-api-key` 的凭据形态。
///
/// 上线形态统一为 `sk-<48 位>`：relay 与 `/v1/models` 探测都接受它，
/// admin 后台的令牌列表也按这个形态展示。
///
/// 【codereview 更正】内存里存的**始终是裸 key**：admin 的
/// `token.GetFullKey()` 实测就是 `return token.Key`（`model/token.go:80`），
/// 并不带 `sk-` 前缀 —— 早前一版注释把它记成「`sk-<48 位>`」是错的，
/// `controller/user_model_key.go` 里的 `TrimPrefix(key, "sk-")` 因此是防御性
/// 死代码（无害，但说明那个认知偏差已经扩散到了 Go 侧）。
///
/// 历史实现里模型调用发裸 key、探测发 `sk-` key，虽然 relay 会
/// `TrimPrefix("sk-")` 因而都能通过，但**两种形态会让按 `sk-` 前缀扫描
/// 日志/响应体的护栏漏报**。统一到本函数，脱敏与审计才有单一基准。
pub fn bearer_key() -> Option<String> {
    key().map(|k| {
        if k.starts_with("sk-") {
            k
        } else {
            format!("sk-{}", k)
        }
    })
}

/// 是否已缓存可用凭据。HTTP 只读端点与虚拟 provider 只暴露这个布尔值。
pub fn is_ready() -> bool {
    key().is_some()
}

/// 内存里的官方模型列表快照；未登录返回空数组。
pub fn models() -> Vec<OfficialModel> {
    get().map(|c| c.models).unwrap_or_default()
}

/// 不含凭据的状态字段（供 HTTP 端点使用）。`baseUrl` 在已登录时取壳写入
/// 的 relay 地址，未登录时回落固定常量；任何情况下都不返回 key。
/// 不含凭据的状态字段（供 HTTP 端点使用）。`baseUrl` 一律取运行时选中站点
/// 的 relay base（编译期默认站 + 竞速探测结果），任何情况下都不返回 key；
/// 壳写入的 `c.base_url` 只作内部记录，绝不透出给 WebView —— 否则一个被
/// 改写过的配置就能诱导 UI 把凭据发到第三方 host。
pub fn status() -> (bool, String, usize, String) {
    let base_url = base_url();
    match get() {
        Some(c) => (
            !c.key.trim().is_empty(),
            c.username,
            c.models.len(),
            base_url,
        ),
        None => (false, String::new(), 0, base_url),
    }
}

/// 同一 crate 的单测共用它串行化对这个进程级全局的读写，避免并行测试
/// 互相 clear 掉别人的 fixture。生产构建不含此符号。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 单测把运行时选中站点复位到默认站，避免跨测试漂移（生产不受影响）。
#[cfg(test)]
pub(crate) fn reset_host_for_test() {
    let _ = set_selected_host(DEFAULT_OFFICIAL_HOST);
}

#[cfg(test)]
fn fixture(key: &str) -> OfficialCredential {
    OfficialCredential {
        key: key.to_string(),
        base_url: OFFICIAL_BASE_URL.to_string(),
        user_id: 42,
        username: "alice".to_string(),
        models: vec![OfficialModel {
            id: "gpt-official".to_string(),
            owned_by: "gwork".to_string(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 竞速选中的 host 决定进程内存里的用户 key 发往哪里：白名单之外一律拒绝。
    #[test]
    fn selected_host_is_allowlisted_and_drives_base_url() {
        let _guard = test_lock();
        reset_host_for_test();
        assert_eq!(host(), DEFAULT_OFFICIAL_HOST);
        assert_eq!(base_url(), OFFICIAL_BASE_URL);
        assert!(set_selected_host(OFFICIAL_HOST_CN));
        assert_eq!(host(), OFFICIAL_HOST_CN);
        assert_eq!(base_url(), format!("{}/v1", OFFICIAL_HOST_CN));
        // 尾斜杠归一化后仍须命中白名单。
        assert!(set_selected_host(&format!("{}/", OFFICIAL_HOST_INTL)));
        assert_eq!(host(), OFFICIAL_HOST_INTL);
        // 任意第三方 / http 明文 / 子域伪装都必须被拒，且不改变当前选中值。
        for evil in [
            "https://attacker.example",
            "http://www.gourd-ai.cn",
            "https://www.gourd-ai.cn.evil.com",
            "https://api.gourdwork.com",
        ] {
            assert!(!set_selected_host(evil), "must reject {evil}");
            assert_eq!(host(), OFFICIAL_HOST_INTL, "rejected host must not leak in");
        }
        // 账号 /api 与模型 /v1 只差后缀，绝不出现 /v1/v1。
        assert!(!base_url().contains("/v1/v1"));
        reset_host_for_test();
    }

    /// 同一凭据形态：裸 key、sk-key、Bearer 都得能被脱敏/审计统一识别。
    #[test]
    fn bearer_key_is_the_single_wire_form() {
        let _guard = test_lock();
        clear();
        set(fixture("abcdef0123456789"));
        assert_eq!(key().as_deref(), Some("abcdef0123456789"));
        assert_eq!(bearer_key().as_deref(), Some("sk-abcdef0123456789"));
        // 已经带前缀的历史数据不重复加。
        set(fixture("sk-abcdef0123456789"));
        assert_eq!(bearer_key().as_deref(), Some("sk-abcdef0123456789"));
        clear();
    }

    #[test]
    fn official_set_get_clear_roundtrip() {
        let _guard = test_lock();
        clear();
        assert!(get().is_none());
        assert!(key().is_none());
        assert!(!is_ready());
        assert!(models().is_empty());

        set(fixture("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN"));
        let c = get().expect("snapshot must survive in process memory");
        assert_eq!(c.user_id, 42);
        assert_eq!(c.username, "alice");
        assert_eq!(c.base_url, OFFICIAL_BASE_URL);
        assert_eq!(c.models.len(), 1);
        assert_eq!(c.models[0].id, "gpt-official");
        assert_eq!(key().as_deref(), Some("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN"));
        assert!(is_ready());
        assert_eq!(models().len(), 1);
        assert_eq!(status(), (true, "alice".to_string(), 1, base_url()));

        clear();
        assert!(get().is_none());
        assert!(key().is_none());
        assert!(!is_ready());
        assert!(models().is_empty());
    }

    #[test]
    fn official_key_is_none_when_unset() {
        let _guard = test_lock();
        clear();
        assert!(key().is_none(), "no credential in memory means no key");
        assert_eq!(status().0, false);
    }

    #[test]
    fn official_blank_key_is_not_ready() {
        let _guard = test_lock();
        set(fixture("   "));
        assert!(key().is_none());
        assert!(!is_ready());
        clear();
    }

    #[test]
    fn official_concurrent_set_does_not_panic() {
        let _guard = test_lock();
        clear();
        let mut handles = Vec::new();
        for i in 0..8 {
            handles.push(std::thread::spawn(move || {
                let mut c = fixture(&format!("concurrent-key-{i}"));
                c.user_id = i as i64;
                set(c);
                let _ = get();
                let _ = key();
                let _ = models();
            }));
        }
        for h in handles {
            h.join().expect("concurrent set must not panic");
        }
        assert!(is_ready(), "one of the concurrent snapshots must remain");
        assert_eq!(models().len(), 1);
        clear();
    }

    // ── 失效闭环回归 ────────────────────────────────────────────────

    #[test]
    fn set_if_rejects_write_after_generation_changed() {
        let _guard = test_lock();
        clear();
        let gen = generation();
        // 模拟「prime 期间用户登出」：clear 推进代际，旧 prime 的写入必须被拒。
        clear();
        assert!(!set_if(gen, fixture("stale-session-key")));
        assert!(get().is_none(), "stale prime must not write back");
        // 代际未变时正常写入并清 stale。
        let gen2 = generation();
        assert!(set_if(gen2, fixture("fresh-key")));
        assert_eq!(key().as_deref(), Some("fresh-key"));
        clear();
    }

    #[test]
    fn report_auth_failure_marks_stale_and_fires_hook_once() {
        let _guard = test_lock();
        clear();
        set(fixture("about-to-be-revoked"));
        assert!(!is_stale());

        let fires = Arc::new(AtomicUsize::new(0));
        let counter = fires.clone();
        set_refresh_hook(Arc::new(move || { counter.fetch_add(1, Ordering::SeqCst); }));

        report_auth_failure();
        assert!(is_stale(), "auth failure must mark the credential stale");
        assert_eq!(fires.load(Ordering::SeqCst), 1, "hook fires once");
        // 凭据不清空：当前 run 与 UI 不抖动，重取成功前仍可用旧 key 发请求。
        assert_eq!(key().as_deref(), Some("about-to-be-revoked"));

        // 节流窗口内连续 401 不重复 spawn 重取。
        report_auth_failure();
        report_auth_failure();
        assert_eq!(fires.load(Ordering::SeqCst), 1, "throttle suppresses repeat refresh");

        // 重取成功 → set 清 stale 并换上新 key。
        set(fixture("rotated-key"));
        assert!(!is_stale());
        assert_eq!(key().as_deref(), Some("rotated-key"));
        clear();
    }

    /// 熔断：relay 对「上游渠道无可用 key」同样回 401（admin
    /// `service/relay_error_test.go` 的 ErrorCodeChannelNoAvailableKey +
    /// StatusUnauthorized），这种 401 重取只会拿回**同一把合格 key**，
    /// 永远治不好；而 `set` 会清零节流时间戳，于是「401→重取→key没变→
    /// 节流清零→401→重取」会变成无上限循环，每个 attempt 打两个后台请求
    /// （其中 ensureUserModelKey 还带事务与行锁）。连续重取拿回同一把 key
    /// 必须熔断。
    #[test]
    fn unchanged_refetch_circuit_breaks_the_refresh_loop() {
        let _guard = test_lock();
        clear();
        assert!(!refresh_circuit_open());

        let fires = Arc::new(AtomicUsize::new(0));
        let counter = fires.clone();
        set_refresh_hook(Arc::new(move || { counter.fetch_add(1, Ordering::SeqCst); }));

        set(fixture("same-key-forever"));
        // 每次 set 都会清零节流，模拟「重取成功但 key 没变」的真实循环。
        // 前两次仍触发重取（unchanged_refreshes 0→1→2），第三次熔断打开。
        for expected in [1usize, 2, 2] {
            report_auth_failure();
            assert_eq!(
                fires.load(Ordering::SeqCst),
                expected,
                "fires until the circuit opens"
            );
            set(fixture("same-key-forever"));
        }
        assert!(refresh_circuit_open(), "circuit must open after repeated unchanged refetch");
        // 熔断后即使节流被清零也不再触发回调，后台不会被无限打。
        report_auth_failure();
        report_auth_failure();
        assert_eq!(fires.load(Ordering::SeqCst), 2, "circuit stops further refetch");
        // stale 仍保留：手动刷新/重新登录这条路不能被熔断堵死。
        assert!(is_stale());
        clear();
    }

    /// 熔断必须只对「key 没变」生效：token 被删/禁用/额度归零时
    /// ensureUserModelKey 会新建一把，key 变化说明重取真的拿到了新凭据，
    /// 计数归零、自愈继续有效。
    #[test]
    fn a_rotated_key_resets_the_circuit() {
        let _guard = test_lock();
        clear();
        let fires = Arc::new(AtomicUsize::new(0));
        let counter = fires.clone();
        set_refresh_hook(Arc::new(move || { counter.fetch_add(1, Ordering::SeqCst); }));

        set(fixture("rotating-1"));
        for i in 0..4 {
            report_auth_failure();
            set(fixture(&format!("rotating-{}", i + 2)));
        }
        assert!(
            !refresh_circuit_open(),
            "a genuinely rotating key must never trip the circuit"
        );
        assert_eq!(fires.load(Ordering::SeqCst), 4, "every real rotation refetches");

        // clear()（重新登录）复位熔断，新会话重新获得完整自愈机会。
        set(fixture("stuck-key"));
        report_auth_failure();
        set(fixture("stuck-key"));
        report_auth_failure();
        set(fixture("stuck-key"));
        assert!(refresh_circuit_open());
        clear();
        assert!(!refresh_circuit_open(), "logout/login resets the circuit");
        clear();
    }

    #[test]
    fn clear_advances_generation_and_resets_stale() {
        let _guard = test_lock();
        clear();
        set(fixture("k"));
        let gen = generation();
        // 人为置 stale（经上报），clear 必须同时复位。
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        set_refresh_hook(Arc::new(move || { c.fetch_add(1, Ordering::SeqCst); }));
        report_auth_failure();
        assert!(is_stale());
        clear();
        assert!(!is_stale());
        assert!(generation() > gen);
        assert!(get().is_none());
    }
}
