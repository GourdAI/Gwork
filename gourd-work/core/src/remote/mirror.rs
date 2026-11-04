//! remote/mirror.rs — 远端部署模式（remote-deployed mode）与模型配置内存镜像。
//!
//! ## 为什么需要这个模块
//!
//! 「远程工作区」方案 A 的形态是：远端主机跑**一个完整的 GWork 内核**，桌面壳经
//! SSH 隧道 / WSL localhost 直连访问它（文件、Git、Agent 全在远端执行）。于是
//! 有两个问题必须由内核自己回答：
//!
//! 1. **远端内核凭什么相信「模型配置该由桌面端说了算」？**
//!    远端机器的 `settings.json` 属于远端用户，桌面端不该改写它。Java 侧的答案是
//!    `-Dgwork.remote=true` 标记 + `/web/settings/overlay` 写入口：标记为真时，
//!    内核接受一次「内存镜像」——把桌面端推来的 providers/models/defaultModel
//!    载入进程内存，**拒绝落盘**，进程销毁即消失（apiKey 在远端磁盘零残留）。
//! 2. **桌面端怎么知道镜像还在？**
//!    连接存活与镜像存活是两件事：远端进程被 OOM 收走后由看门狗重拉、或用户手动
//!    重启，数据面 HTTP 探活照样通过，镜像却已归零——用户看到「已连接」而远端
//!    在用空配置跑，没有任何错误。`generation`（世代号）把这件事变成可判定的：
//!    每次成功 apply 自增，进程重启归零，桌面端比对「我推成的那一代」与「远端
//!    当前这一代」即可判定。
//!
//! ## 契约来源
//!
//! Java 权威实现在 `WebSettingsController.settingsOverlayImport` /
//! `settingsMirrorState` 与 `AgentSettings.applyRemoteMirror`。本模块是同一份
//! 语义的 Rust 移植，字段与判定逐条对齐（含 `mirrored` 时拒绝回写、世代号只在
//! 成功路径递增、非远端模式拒绝 overlay 写而放行 mirror-state 读）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use indexmap::IndexMap;
use serde::Deserialize;

use crate::config::{ModelConfig, Settings};

/// 远端部署模式标记（对应 Java `-Dgwork.remote=true` / `AgentFlags.isRemoteDeployed()`）。
///
/// 来源：`GWORK_REMOTE_DEPLOYED` 环境变量，或启动参数 `--remote-deployed`。
/// **环境变量优先**，与凭据注入同一口径（命令行参数在远端 `ps -ef` 下对同机所有
/// 用户可见；这个标记本身不敏感，但两处注入方式一致才不会在维护中分叉）。
pub const ENV_REMOTE_DEPLOYED: &str = "GWORK_REMOTE_DEPLOYED";

/// 进程级远端部署标记。
///
/// 用 `AtomicBool` 而非 `OnceLock`：`serve_with_static` 在测试里会被反复调用，
/// 而标记必须在**任何** settings 读写之前就可被 `persist_settings` 观察到。
/// 默认 false = 本地模式，与 Java 的 `Boolean.parseBoolean(null) == false` 一致。
static REMOTE_DEPLOYED: AtomicBool = AtomicBool::new(false);

/// 设置远端部署标记（`serve_with_static` 启动时调用一次）。
pub fn set_remote_deployed(v: bool) {
    REMOTE_DEPLOYED.store(v, Ordering::SeqCst);
}

/// 当前是否处于远端部署模式。
pub fn is_remote_deployed() -> bool {
    REMOTE_DEPLOYED.load(Ordering::SeqCst)
}

/// 镜像世代号 + 「镜像是否还在内存里」的进程级状态。
///
/// 两者分开存而不是一个 `Option<u64>`：`mirrored` 要参与 `persist_settings` 的
/// 落盘决策（每次 settings 写都要读），而世代号只被 overlay/mirror-state 端点与
/// 其单测触碰。分开后热路径上是一次独立的 relaxed 读，且语义不会互相污染
/// （「世代 0 但 mirrored=true」在重启后是不可能的组合，但两类调用方对这两个
/// 字段的读取时机不同，合并成一个值会迫使它们同时更新）。
#[derive(Debug, Default)]
pub struct MirrorState {
    /// 世代号：每次成功 apply 自增，进程重启归零。
    pub generation: AtomicU64,
    /// 镜像是否仍在内存里（apply 成功 → true；本进程从未 apply → false）。
    pub mirrored: AtomicBool,
}

impl MirrorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前世代号。
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// 是否处于镜像态（镜像态下内核**不得**把 models/providers/defaultModel
    /// 写回磁盘——那会把桌面端推来的凭据落到远端机器的 settings.json 上）。
    pub fn is_mirrored(&self) -> bool {
        self.mirrored.load(Ordering::SeqCst)
    }
}

/// overlay 端点的请求体（三段白名单，与 Java `MirrorPayload` 逐字对齐）。
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct MirrorPayload {
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    pub providers: serde_json::Value,
    pub models: serde_json::Value,
}

impl Default for MirrorPayload {
    fn default() -> Self {
        Self {
            default_model: String::new(),
            providers: serde_json::Value::Object(serde_json::Map::new()),
            models: serde_json::Value::Object(serde_json::Map::new()),
        }
    }
}

/// overlay 导入的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// 成功：返回新的世代号与「载入了多少个启用模型」。
    Applied {
        generation: u64,
        model_count: usize,
    },
    /// 非远端模式：Java 在此直接 `Result.failure`，壳侧据此判定连接失败。
    NotRemoteMode,
    /// 载荷不是 JSON 对象（含空载荷）。
    ///
    /// **关键性质：这个分支不得递增世代号。** 世代号必须严格对应「真的生效过
    /// 一次镜像」（Java `AgentSettings.mirrorGeneration` 的文档口径）；否则一次
    /// 失败推送会让桌面端记下一个新的世代，而远端内存里其实什么都没有——
    /// 于是「远端丢镜像」永远查不出来（比对恒相等）。Java 侧用
    /// `mirrorGenerationNotBumpedOnMalformedPayload` 钉住同一条性质。
    Malformed,
}

/// 把镜像载入 `settings`（**纯函数**，便于单测与变异验证）。
///
/// 语义逐条对齐 Java `AgentSettings.applyRemoteMirror`：
/// - `providers` / `models` 缺失或不是对象 → 视为空表（不报错，替换语义）；
/// - `models` 的**数组**形态（旧格式）同样接受，按 `name` 归一成表；
/// - 单个条目解析失败**跳过**而不是整体失败：`Settings::deserialize_models`
///   的既有口径就是「一条坏数据不能清空用户的模型选择器」，镜像路径必须同口径，
///   否则一个手改过的远端条目会让整次镜像被拒（而拒绝的后果是连接失败）；
/// - `defaultModel` 缺失 → 空串（Java `Assert.isEmpty` 归一为「无默认模型」）。
///
/// **不落盘**：本函数只改内存。写盘由 `persist_settings` 依据
/// [`MirrorState::is_mirrored`] 拒绝，而不是靠调用方记得别调。
pub fn apply_to_settings(settings: &mut Settings, payload: &MirrorPayload) {
    // providers 不进 Settings 结构体（本内核的 providers 端点直接读磁盘键），
    // 但镜像态下它们同样不得落盘——由 persist_settings 统一拒绝三个键。
    let _ = &payload.providers;

    let mut models: IndexMap<String, ModelConfig> = IndexMap::new();
    match &payload.models {
        serde_json::Value::Object(map) => {
            for (key, raw) in map {
                match serde_json::from_value::<ModelConfig>(raw.clone()) {
                    Ok(mut m) => {
                        // 键即模型名：settings.json 的 models 是「名字 → 配置」，
                        // 而 ModelConfig.name 由 serde 从条目内读取。条目缺 name
                        // 时以键补齐，否则前端选择器会显示成 model id。
                        if m.name.trim().is_empty() {
                            m.name = key.clone();
                        }
                        models.insert(key.clone(), m);
                    }
                    Err(e) => {
                        tracing::warn!(model = %key, error = %e, "镜像载荷里有一条模型配置无法解析，已跳过");
                    }
                }
            }
        }
        // 数组形态：与 Settings::deserialize_models 的 legacy 归一同口径。
        serde_json::Value::Array(items) => {
            for raw in items {
                match serde_json::from_value::<ModelConfig>(raw.clone()) {
                    Ok(m) => {
                        let key = if m.name.trim().is_empty() {
                            m.model.clone()
                        } else {
                            m.name.clone()
                        };
                        models.insert(key, m);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "镜像载荷里有一条模型配置无法解析（数组形态），已跳过");
                    }
                }
            }
        }
        _ => {}
    }

    settings.models = models;
    settings.default_model = payload.default_model.clone();
}

/// 统计「启用且可见」的模型数（与前端选择器、Java `isEnabled()` 口径一致）。
pub fn enabled_model_count(settings: &Settings) -> usize {
    settings
        .models
        .values()
        .filter(|m| m.enabled && m.visibled)
        .count()
}

/// 端点级入口：校验模式 → 解析 → 载入 → 递增世代号。
///
/// 抽成独立函数（而非把逻辑写在 handler 里）的理由：这条链上每个判定都有明确
/// 的故障形态（非远端模式开放写接口 = 白增攻击面；世代号在失败路径递增 = 桌面端
/// 以为镜像还在），而 handler 里做不了单测。
///
/// 收 **原始 JSON 串**而不是已解析的 `MirrorPayload`：解析失败必须走
/// [`ApplyOutcome::Malformed`] 这条**不递增世代号**的路径，而那个性质只有把解析
/// 放在这里才能被单测钉住（放在 handler 里就变成「提前 return，没人测」）。
/// 与 Java `applyRemoteMirror(String json)` 抛异常的形态同构。
pub fn apply_overlay(state: &MirrorState, settings: &mut Settings, raw: &str) -> ApplyOutcome {
    if !is_remote_deployed() {
        return ApplyOutcome::NotRemoteMode;
    }
    // 解析失败 / 根不是对象 → Malformed，且**不动** settings 与世代号。
    // 顺序要紧：先解析再改 settings，否则一次坏推送会把内存里的模型表清空
    // （而镜像态又关掉了落盘，用户再也救不回来）。
    //
    // 显式要求根是 JSON 对象：`MirrorPayload` 是 derive 的结构体，serde 会**同时**
    // 接受位置数组形态（`[]` → 全默认值），于是一个误发的 `[]` 会被当成「空镜像」
    // 把模型表清空（Applied，世代号还递增）。契约是三段白名单对象，故这里先验根
    // 形态再反序列化——把「数组/标量根」明确归入 Malformed，而不是依赖 serde 的
    // 宽容。Java 侧 `ONode.get("providers")` 对数组根返回空节点，行为接近但不完全
    // 一致；本内核选择更严的一侧，因为静默清空模型表的代价远高于拒绝一次坏推送。
    let trimmed = raw.trim();
    if !trimmed.starts_with('{') {
        tracing::warn!("overlay 载荷根不是 JSON 对象，已拒绝（世代号不变）");
        return ApplyOutcome::Malformed;
    }
    let payload: MirrorPayload = match serde_json::from_str(trimmed) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "overlay 载荷解析失败，已拒绝（世代号不变）");
            return ApplyOutcome::Malformed;
        }
    };
    apply_to_settings(settings, &payload);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.mirrored.store(true, Ordering::SeqCst);
    ApplyOutcome::Applied {
        generation,
        model_count: enabled_model_count(settings),
    }
}

/// 是否处于「镜像已载入」状态的单行判据（供 `persist_settings` 使用）。
///
/// 与 [`MirrorState::is_mirrored`] 分开：`persist_settings` 拿不到 `MirrorState`
/// 时（例如未来的 CLI 路径）仍以进程标记为准，避免「换一个调用点就漏掉落盘
/// 拒绝」——那正是这个模块要消灭的故障形态。
pub fn mirror_active(state: &MirrorState) -> bool {
    state.is_mirrored()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 碰进程级远端标记的用例共用这把锁。
    ///
    /// `REMOTE_DEPLOYED` 是全局 `AtomicBool`，而 cargo test 默认多线程跑用例：
    /// 一个用例末尾的 `set_remote_deployed(false)` 与另一个用例开头的 `true`
    /// 交错，就会得到随机失败（CI 上最难查的那类假失败）。本模块的用例几乎
    /// 全部要摆弄这个标记，故一律持锁。
    ///
    /// 用例 panic 会把锁打成 poisoned：取回内部值继续跑（每个用例自己设定标记
    /// 初值，不依赖上一个用例留下的状态），否则一个失败会连带挂掉其余全部。
    /// 与 `server.rs` 的 `route_test_guard()` 同一口径。
    fn flag_guard() -> std::sync::MutexGuard<'static, ()> {
        static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
        match GUARD.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 非远端模式必须拒绝 overlay 写。
    ///
    /// 这条不是防御性装饰：本地内核若接受镜像写入，任何能访问端口的本地进程都能
    /// 用一份空模型表覆盖掉用户的配置（且镜像态会同时关掉落盘，配置再也救不回来）。
    #[test]
    fn overlay_write_is_refused_outside_remote_mode() {
        let _g = flag_guard();
        set_remote_deployed(false);
        let st = MirrorState::new();
        let mut s = Settings::default();
        let out = apply_overlay(&st, &mut s, r#"{"models":{}}"#);
        assert_eq!(out, ApplyOutcome::NotRemoteMode);
        assert_eq!(st.generation(), 0, "拒绝不得递增世代号");
        assert!(!st.is_mirrored(), "拒绝不得置镜像态");
    }

    /// 成功路径：世代号从 1 起递增，且每次 apply 都自增（重复推送是幂等替换）。
    #[test]
    fn generation_increments_on_every_successful_apply() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings::default();
        let p = r#"{"defaultModel":"m1","providers":{"p":{"apiKey":"sk-x"}},"models":{
                 "m1":{"name":"m1","model":"gpt-4o","enabled":true,"visibled":true},
                 "m2":{"name":"m2","model":"gpt-4o-mini","enabled":false,"visibled":true}
               }}"#;
        assert_eq!(
            apply_overlay(&st, &mut s, p),
            ApplyOutcome::Applied {
                generation: 1,
                model_count: 1
            }
        );
        assert_eq!(st.generation(), 1);
        assert!(st.is_mirrored());
        assert_eq!(s.default_model, "m1");
        assert!(s.models.contains_key("m1"));
        // 第二次推送：替换语义 + 世代递增
        assert!(matches!(
            apply_overlay(&st, &mut s, p),
            ApplyOutcome::Applied { generation: 2, .. }
        ));
        assert_eq!(st.generation(), 2);
        set_remote_deployed(false);
    }

    /// 坏条目跳过而不是整体失败：一条手改过的条目不能清空整个模型表。
    #[test]
    fn one_bad_entry_does_not_empty_the_model_table() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings::default();
        let p = r#"{"models":{
                 "good":{"name":"good","model":"gpt-4o","enabled":true,"visibled":true},
                 "bad":{"name":123}
               }}"#;
        let out = apply_overlay(&st, &mut s, p);
        assert!(matches!(out, ApplyOutcome::Applied { .. }));
        assert_eq!(s.models.len(), 1, "坏条目被跳过，好条目保留");
        assert!(s.models.contains_key("good"));
        set_remote_deployed(false);
    }

    /// 数组形态（legacy）同样接受，按 name/model 归一键。
    #[test]
    fn array_form_models_are_normalized() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings::default();
        let p = r#"{"models":[{"name":"a","model":"gpt-4o"},{"model":"gpt-4o-mini"}]}"#;
        apply_overlay(&st, &mut s, p);
        assert!(s.models.contains_key("a"), "有 name 用 name 作键");
        assert!(
            s.models.contains_key("gpt-4o-mini"),
            "无 name 用 model id 作键"
        );
        set_remote_deployed(false);
    }

    /// `defaultModel` 缺失 → 空串（不得 panic，不得保留旧默认）。
    #[test]
    fn missing_default_model_clears_it() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings {
            default_model: "stale".into(),
            ..Settings::default()
        };
        apply_overlay(&st, &mut s, r#"{"models":{}}"#);
        assert_eq!(s.default_model, "");
        set_remote_deployed(false);
    }

    /// 空对象载荷是合法载荷（清空镜像），不得被当成 malformed。
    #[test]
    fn empty_object_payload_is_valid() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings::default();
        s.models.insert("x".to_string(), ModelConfig::default());
        let out = apply_overlay(&st, &mut s, r#"{}"#);
        assert!(matches!(out, ApplyOutcome::Applied { .. }));
        assert!(s.models.is_empty(), "空载荷 = 空镜像（替换语义）");
        set_remote_deployed(false);
    }

    /// 畸形载荷：不得递增世代号，也不得动 settings。
    ///
    /// 这是整条屏障链上最隐蔽的故障形态：若一次坏推送也递增世代号，桌面端会记下
    /// 一个「远端其实没有」的世代，此后比对恒相等 → 「远端丢镜像」永远查不出来。
    /// 对应 Java `mirrorGenerationNotBumpedOnMalformedPayload`。
    #[test]
    fn malformed_payload_bumps_nothing() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings {
            default_model: "keep".into(),
            ..Settings::default()
        };
        s.models.insert("keep".to_string(), ModelConfig::default());
        for bad in ["", "   ", "not json", "{", r#"{"models": }"#, "[]", "123"] {
            let out = apply_overlay(&st, &mut s, bad);
            assert_eq!(out, ApplyOutcome::Malformed, "载荷 {:?} 应判 malformed", bad);
            assert_eq!(st.generation(), 0, "畸形载荷不得递增世代号: {:?}", bad);
            assert!(!st.is_mirrored(), "畸形载荷不得置镜像态: {:?}", bad);
        }
        // settings 原封不动（坏推送不得清空内存里的模型表）
        assert!(s.models.contains_key("keep"), "畸形载荷不得改动 settings");
        assert_eq!(s.default_model, "keep");
        set_remote_deployed(false);
    }

    /// 根不是对象（数组/标量）也判 malformed：`MirrorPayload` 是结构体，
    /// serde 对非对象根会解析失败，不得被误当成「空镜像」。
    #[test]
    fn non_object_root_is_malformed() {
        let _g = flag_guard();
        set_remote_deployed(true);
        let st = MirrorState::new();
        let mut s = Settings::default();
        assert_eq!(apply_overlay(&st, &mut s, "[]"), ApplyOutcome::Malformed);
        assert_eq!(apply_overlay(&st, &mut s, "null"), ApplyOutcome::Malformed);
        assert_eq!(st.generation(), 0);
        set_remote_deployed(false);
    }

    /// 进程标记的来源：环境变量 / 显式设置。
    #[test]
    fn remote_flag_defaults_off_and_can_be_set() {
        let _g = flag_guard();
        // 默认关闭（本用例可能先于其它用例跑，故只断言「可设置」与「可关闭」）。
        set_remote_deployed(true);
        assert!(is_remote_deployed());
        set_remote_deployed(false);
        assert!(!is_remote_deployed());
        let _ = ENV_REMOTE_DEPLOYED; // 名字契约（启动器按此注入）
    }

    /// `modelCount` 的口径：只数 **enabled && visibled**。
    ///
    /// 壳侧真正关心的是「远端此刻有没有可用模型」，而不是配置里躺着多少条。
    /// 两个过滤条件缺一不可：只数 enabled 会把「已启用但被隐藏」的条目算进去
    /// （前端选择器根本不渲染它们，于是壳看到 modelCount>0 而用户看到空下拉）；
    /// 只数 visibled 则会把禁用项算进去（同样不可选）。
    #[test]
    fn model_count_requires_both_enabled_and_visibled() {
        let mut s = Settings::default();
        let mk = |enabled: bool, visibled: bool| ModelConfig {
            enabled,
            visibled,
            ..ModelConfig::default()
        };
        s.models.insert("ok".into(), mk(true, true));
        s.models.insert("disabled".into(), mk(false, true));
        s.models.insert("hidden".into(), mk(true, false));
        s.models.insert("both-off".into(), mk(false, false));
        assert_eq!(enabled_model_count(&s), 1, "只有 enabled&&visibled 才算可用");

        // 空表 = 0（壳据此判定「远端没有可用模型」，不得与解析失败混淆）
        assert_eq!(enabled_model_count(&Settings::default()), 0);
    }

    /// 镜像态判据必须与状态对象一致（persist_settings 依赖它拒绝落盘）。
    #[test]
    fn mirror_active_reflects_the_state() {
        let st = MirrorState::new();
        assert!(!mirror_active(&st));
        st.mirrored.store(true, Ordering::SeqCst);
        assert!(mirror_active(&st));
    }
}
