//! HITL (human-in-the-loop) approval gates.
//!
//! Two independent axes decide whether a bash command needs user approval. Both
//! are ports of the Java kernel's `com.gourdai.harness.hitl` package:
//!
//! - [`shape`] — the command's *shape*: is the operation irreversible?
//!   (Java `HitlStrategy`)
//! - [`path_guard`] — *where* it reads and writes: is the target outside the
//!   workspace? (Java `BashPathGuard`)
//!
//! The split is deliberate and the overlap between them is a feature: when one
//! axis is bypassed the other may still fire. `rm -rf D:\other-project` is
//! caught by both; `Set-Content D:\other-project\f.txt x` only by the path
//! axis.

pub mod path_guard;
pub mod shape;
