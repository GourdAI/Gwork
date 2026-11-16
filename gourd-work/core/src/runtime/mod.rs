//! runtime — 托管运行时（managed runtimes）。
//!
//! 首个成员是 `node`：CLI 连接器（钉钉/飞书/企微/腾讯会议等厂商官方 npm CLI）
//! 需要 Node.js 才能安装与运行，而 GWork 的用户不保证装过 Node。本模块提供
//! 「探测系统 node → 不达标则下载内置 node」的自动保障，形态对标 WorkBuddy
//! 的 binaries 管理（取证见 .gwork/PLAN-connector-registry.md 第七节），但
//! 校验更严：**sha256 内嵌常量**，不在线拉校验文件（镜像的校验文件与制品同源，
//! 在线拉不构成独立信任）。

pub mod node;