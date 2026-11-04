//! HITL path axis — ported from the Java kernel's `BashPathGuard` (2295 lines).
//!
//! Decides whether a bash command reads or writes **outside the workspace**.
//! The shape axis ([`super::shape`]) decides whether the operation is
//! irreversible; this one decides whether it leaves the sandbox. The two are
//! deliberately redundant: `rm -rf D:\other-project` is caught by both, while
//! `Set-Content D:\other-project\f.txt x` is caught only here.
//!
//! ## The contract this module must honour
//!
//! * **Two passes, write first.** A write is irreversible, a read is not. When
//!   both hit, the card must say "write" — telling the user "this only reads"
//!   about `cat D:\out\f > D:\out\g` gets an approval that overwrites a file.
//! * **Only the first hit is reported.** The card answers "what outside the
//!   workspace does this touch"; listing everything is noise.
//! * **No workspace root ⇒ no verdict.** The boundary must be supplied by the
//!   caller. Guessing one (say the process CWD) flags unrelated user
//!   directories and produces cards the user cannot reason about.
//! * **Exemptions lift reads *and* writes.** Exempting only writes would make
//!   `cat ~/.m2/settings.xml` — an ordinary build-chain read — prompt on every
//!   run, and approval fatigue ends in blind clicking.
//! * **Every declared wrapper is actually handled.** This is the module's
//!   scar-tissue rule: an earlier Java version whitelisted only 6 privilege
//!   escalators in the unmarked-payload fallback, so the other 8 members
//!   (`nohup`, `time`, `nice`, `ionice`, `stdbuf`, `setsid`, `eval` and the
//!   unmarked shell-launcher form) fell through to "do nothing" and
//!   `nohup Set-Content D:\out\f.txt x` was silently released. Worse, the shape
//!   axis did not recognise prefix words either, so `nohup rm -rf <outside>`
//!   failed **both** axes — an unrecoverable recursive delete with zero
//!   approval. [`handle_wrapper`] therefore has no empty branch, and
//!   `every_declared_wrapper_is_actually_handled` locks it.
//!
//! ## Known gaps (deliberate, tracked)
//!
//! * `team/mod.rs` and `server/loop_runner.rs` hardcode `hitl_approved: true`,
//!   so sub-agents and loop tasks bypass this gate entirely. Fixing that is a
//!   separate change (it needs per-invocation decision caching, not a run-level
//!   flag) — see the HITL alignment report.
//! * `write`/`edit` tools do not go through here; they have their own boundary
//!   (`resolve_safe`), matching the Java split between `BashPathGuard` and
//!   `TerminalSupport.resolveSafePath`.
//! * A target whose path is invalid on this platform is *reported* rather than
//!   released: Java's `Paths.get` throws and the catch returns (release), while
//!   Rust's `Path::new` never fails. Reporting is the stricter direction, so
//!   the difference cannot open a hole.

use std::path::{Component, Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;

/// Recursion ceiling for wrapper unwrapping (Java `MAX_UNWRAP_DEPTH`).
const MAX_UNWRAP_DEPTH: usize = 4;

// ══════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════

/// One out-of-workspace access hit.
///
/// Read and write are distinguished because they differ in severity: a write is
/// irreversible (deleted is gone, overwritten is gone), a read is revocable but
/// leaks content. The approval text branches on this, so mislabelling a write as
/// a read makes the user underestimate what they are approving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    target: String,
    verb: String,
    write: bool,
}

impl Verdict {
    /// Absolute, normalised path of the out-of-workspace target.
    pub fn target(&self) -> &str {
        &self.target
    }

    /// The verb or shape that triggered (`Set-Content`, `>`, `rm`, `cat`, …).
    pub fn verb(&self) -> &str {
        &self.verb
    }

    /// Write hit (`true`) or read hit (`false`).
    pub fn is_write(&self) -> bool {
        self.write
    }
}

impl std::fmt::Display for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{} → {}", if self.write { "W " } else { "R " }, self.verb, self.target)
    }
}

/// Check whether a command touches anything outside the workspace.
///
/// Two passes, write first — see the module docs for why the order is load
/// bearing. `extra_exempts` comes from user configuration and exempts **both**
/// reads and writes.
pub fn inspect(command: &str, workspace_root: &Path, extra_exempts: &[PathBuf]) -> Option<Verdict> {
    if command.trim().is_empty() {
        return None;
    }
    // `\r\n` → `\n`: a newline is a segment separator, and a stray `\r` glued to
    // the end of a token corrupts path resolution.
    let text = command.replace("\r\n", "\n");

    let mut write_scan = Scan::new(workspace_root, extra_exempts, true);
    write_scan.run(&text, 0);
    if write_scan.hit.is_some() {
        return write_scan.hit;
    }

    let mut read_scan = Scan::new(workspace_root, extra_exempts, false);
    read_scan.run(&text, 0);
    read_scan.hit
}

/// Built-in exempt roots: build/package-manager caches and system temp dirs.
///
/// These are necessarily outside the workspace, but touching them is *normal
/// toolchain behaviour*, not overreach: `mvn` reads and writes `~/.m2`, `npm`
/// uses `~/.npm`, `cargo` uses `~/.cargo`, compilers use the temp dir. Without
/// the exemption nearly every build prompts in default mode.
///
/// Only "cache / rebuildable artefact" directories are listed. `~/.ssh`,
/// `~/.aws`, `~/.config` and `~/.kube` carry credentials or user configuration
/// and are deliberately absent — reading *or* writing them should prompt.
///
/// Registering a directory that does not exist costs nothing: it can never
/// match, so it can never wrongly release. That is why the Windows `AppData`
/// entries are kept on every platform.
pub fn default_exempt_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    // --- system temp ---
    add_absolute(&mut roots, &[std::env::temp_dir().to_string_lossy().into_owned()]);
    add_absolute(
        &mut roots,
        &[
            "/tmp".into(),
            "/private/tmp".into(),
            "/var/tmp".into(),
            "/private/var/tmp".into(),
            "/var/folders".into(),
            "/private/var/folders".into(),
            "/dev/shm".into(),
            "C:/Windows/Temp".into(),
            "C:/Windows/SoftwareDistribution/Download".into(),
        ],
    );

    // --- build / package caches under the home directory ---
    if let Some(home) = home_dir() {
        let candidates: Vec<String> = HOME_CACHE_DIRS
            .iter()
            .map(|rel| format!("{}/{}", home.to_string_lossy(), rel))
            .collect();
        add_absolute(&mut roots, &candidates);
    }

    // --- Windows-side caches (same disk as home, different path shape) ---
    let mut win: Vec<String> = Vec::new();
    for var in ["LOCALAPPDATA", "APPDATA", "TEMP", "TMP"] {
        if let Ok(v) = std::env::var(var) {
            win.push(v);
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        win.push(format!("{}/AppData/Local/Temp", profile));
    }
    add_absolute(&mut roots, &win);

    roots
}

/// Cache-like subdirectories of the home directory (Java `HOME_CACHE_DIRS`).
///
/// Deliberately only caches and rebuildable artefacts — things that get
/// re-downloaded or regenerated if deleted.
const HOME_CACHE_DIRS: &[&str] = &[
    // JVM ecosystem
    ".m2", ".m2/repository", ".m2/wrapper", ".gradle", ".gradle/caches",
    ".ivy2", ".sbt", ".javafx", ".jdk",
    // Node ecosystem
    ".npm", ".yarn", ".yarn-cache", ".pnpm-store", ".pnpm-state", ".bun", ".deno",
    ".nvm", ".volta", ".node-gyp", ".electron", ".electron-gyp", ".cache",
    // Other languages / package managers
    ".cargo", ".rustup", ".gem", ".bundle", ".composer", ".pub-cache", ".nuget",
    ".dotnet", ".pyenv", ".local/share/pip", ".local/share/uv", ".local/share/virtualenvs",
    ".local/share/pypoetry", ".local/share/coursier", ".pip", ".conda", ".pkgs",
    ".mono", ".cocoapods", ".android", ".android/cache", ".android/avd",
    ".oracle_jre_usage", ".openjfx", ".swt", ".tooling",
    "go/pkg", "go/build", "sdk",
    // macOS / Windows platform caches
    "Library/Caches", "Library/Developer/Xcode/DerivedData",
    "Library/Developer/CoreSimulator/Caches", "Library/Developer/Xcode/iOS DeviceSupport",
    "Library/Android/sdk",
    "AppData/Local/Temp", "AppData/Local/pip", "AppData/Local/pip/cache",
    "AppData/Local/npm-cache", "AppData/Local/Yarn", "AppData/Local/Yarn/Cache",
    "AppData/Local/NuGet", "AppData/Local/NuGet/v3-cache", "AppData/Local/NuGet/plugins",
    "AppData/Local/Microsoft/Windows/INetCache", "AppData/Local/CrashDumps",
    "AppData/Local/uv", "AppData/Local/uv/cache", "AppData/Local/pnpm",
    "AppData/Local/pnpm-cache", "AppData/Local/pnpm-store", "AppData/Local/Go",
    "AppData/Local/JetBrains", "AppData/Local/Microsoft/WindowsApps",
    "AppData/Roaming/npm-cache", "AppData/Roaming/npm",
];

/// Resolve user-configured exemption literals into comparable absolute paths.
///
/// This exists so that `~` and environment-variable expansion have exactly one
/// implementation. If the settings reader expanded them itself, the two would
/// drift — and drift here presents as "I configured an exemption and it does
/// nothing", which pushes the user to switch the whole session to full access,
/// precisely what the setting was meant to avoid.
///
/// **Invalid entries are skipped silently, never fatal.** A shorter exemption
/// list only makes the gate *stricter* (one more prompt); it cannot grant
/// access. Failing the whole save — or disabling the guard — over one mistyped
/// directory is wildly disproportionate.
///
/// Entries that still contain `$` or `%` after expansion are dropped: such a
/// path cannot be compared against a real target, so keeping it would only add
/// an entry that can never match.
pub fn resolve_exempt_dirs(literals: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::with_capacity(literals.len());
    for raw in literals {
        let text = raw.trim();
        if text.is_empty() {
            continue;
        }
        let expanded = expand_vars(text);
        let expanded = expanded.trim();
        if expanded.is_empty() || is_unjudgeable(expanded) {
            continue;
        }
        let p = lexical_normalize(&absolutize(Path::new(expanded)));
        out.push(p);
    }
    out
}

/// The prefix-modifier vocabulary, exposed for the cross-axis consistency test.
///
/// [`super::shape`]'s `prefix_modifier_vocabulary_is_consistent_across_both_axes`
/// asserts that every word this axis unwraps is also recognised by the shape
/// axis' command-position anchor. Drift presents as "prepend this word and one
/// axis stops seeing the command", which defeats the deliberate overlap.
///
/// These 8 are Java's `PREFIX_MODIFIERS` — wrappers that **never** carry a
/// command-payload marker, so after their own options the rest of the segment is
/// the payload verbatim. `eval`/`exec` belong here rather than with the command
/// wrappers because their argument is a command *string*, not a script file, and
/// they never take `-c`.
///
/// The `.exe` spellings and the `.` alias of `source` live in
/// [`COMMAND_WRAPPERS`] and are intentionally not repeated here: the shape axis'
/// anchor whitelist strips `(?:\.exe)?` and has no entry for a bare `.`, so
/// listing them would fail the subset assertion without adding coverage.
pub fn prefix_modifiers_for_test() -> Vec<&'static str> {
    PREFIX_MODIFIERS.to_vec()
}

// ══════════════════════════════════════════════════════════════════════════
// Verb tables
// ══════════════════════════════════════════════════════════════════════════

/// Which positional arguments are write targets.
///
/// The three shell dialects agree surprisingly often: `rm` and `Remove-Item`
/// both take "every positional is a target", `cp` and `Copy-Item` both take
/// "the last one is the target". So Unix commands, CMD commands and PowerShell
/// cmdlets share one table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Every positional argument is a target (rm / del / Remove-Item / mkdir / touch / tee).
    All,
    /// Only the last positional (cp / mv / rsync / Copy-Item / Move-Item).
    Last,
    /// Only the first positional (zip / patch / Export-Csv / Rename-Item).
    First,
    /// Only the second positional (robocopy SRC DST, 7z a ARCHIVE FILES).
    Second,
    /// No positional is a target; only named parameters are (unzip: the
    /// positional is the archive being *read*, the target is `-d DIR`).
    None,
    /// Skip the first positional, the rest are targets.
    ///
    /// For read commands whose first positional is not a path:
    /// `grep PATTERN FILE...`, `findstr PATTERN FILE...`, `sed SCRIPT FILE...`,
    /// `awk SCRIPT FILE...`. Using [`Mode::All`] would feed the pattern or the
    /// script body into the boundary check, and `grep "D:\out\x" a.txt` — whose
    /// pattern merely *looks* like an absolute path — would be a false positive.
    SkipFirstAll,
}

/// One verb's target-extraction rule (shared by the read and write tables).
#[derive(Debug, Clone)]
struct Rule {
    mode: Mode,
    /// Named parameters (lowercase, no leading `-`) whose value is a target path:
    /// PowerShell's `-Path` / `-Destination`, `unzip -d`, …
    path_params: &'static [&'static str],
    /// Named parameters whose value is **not** a path and must be skipped along
    /// with its value (`-Value`, `-Encoding`, …). Skipping them matters: without
    /// it, `-Value "hello"` has `hello` judged as a path.
    skip_params: &'static [&'static str],
    /// Flag used with `gate_absent`; `None` means "check unconditionally".
    gate_flag: Option<&'static str>,
    /// Direction of the gate:
    /// * `false` = check only when the flag **is present** (write table's
    ///   `sed -i`, `find -delete`);
    /// * `true` = check only when the flag is **absent** (read table's `sed`,
    ///   `find`).
    ///
    /// The inverted sense is required: `sed s/a/b/ D:\out\f` without `-i` is a
    /// pure read, with `-i` it is a write. If the read table also said "check
    /// when `-i` is present", every non-`-i` out-of-workspace read would be
    /// missed; if it said "check unconditionally", `sed -i` would be reported by
    /// both tables (write-first would mask it, but the semantics would be mud).
    gate_absent: bool,
}

impl Rule {
    const fn simple(mode: Mode) -> Self {
        Self { mode, path_params: &[], skip_params: PS_NON_PATH_PARAMS, gate_flag: None, gate_absent: false }
    }
    const fn with_paths(mode: Mode, path_params: &'static [&'static str]) -> Self {
        Self { mode, path_params, skip_params: PS_NON_PATH_PARAMS, gate_flag: None, gate_absent: false }
    }
    const fn gated(mode: Mode, gate_flag: &'static str, gate_absent: bool) -> Self {
        Self { mode, path_params: &[], skip_params: PS_NON_PATH_PARAMS, gate_flag: Some(gate_flag), gate_absent }
    }
}

/// PowerShell's generic "takes a value that is not a path" parameter names.
///
/// The default skip set for every cmdlet rule. If a `-Value` or `-Encoding`
/// argument were judged as a path, the best case is a false positive (the value
/// happens to look absolute) and the worst is treating command content as a
/// filename. Skipping one name too many is always cheaper than that.
const PS_NON_PATH_PARAMS: &[&str] = &[
    "value", "encoding", "type", "itemtype", "property", "propertytype", "name",
    "newname", "delimiter", "width", "depth", "stream", "inputobject", "totalcount",
    "tail", "head", "first", "last", "skip", "replace", "filter", "include", "exclude",
    "confirm", "whatif", "erroraction", "errorvariable", "warningaction", "verbose",
    "debug", "outvariable", "outbuffer", "pipelinevariable", "informationaction",
    "force", "recurse", "nonewline", "passthru", "quiet", "credential", "usessl",
    "command", "argumentlist", "workingdirectory", "windowstyle", "verb", "reason",
    "activity", "status", "currentoperation", "parentid", "sourceidentifier",
    "valueonly", "asstring", "asbyte", "nooverwrite", "container", "attributes",
    "culture", "throttlelimit", "timeoutsec", "sessionoption", "authentication",
    "body", "headers", "method", "contenttype", "useragent", "proxy", "proxycredential",
    "infile", "outfile", "responseheadersvariable", "skiphttperrorcheck", "statuscode",
    "statusdescription", "maximumredirection", "allowunencrypted", "port", "computername",
    "pattern", "casesensitive", "simplematch", "context", "allmatches", "raw",
    "readcount", "wait", "noversioncheck", "module", "list", "class", "namespace",
];

/// PowerShell named parameters that mean "write target" (lowercase, no `-`).
const PS_PATH_PARAMS: &[&str] = &[
    "path", "literalpath", "destination", "destinationpath", "filepath", "target",
    "fullpath", "filename", "d",
];

/// **Write** verb table; keys are lowercase. Read verbs live in [`READ_RULES`].
///
/// The single inclusion criterion: **the verb produces a write effect on the
/// filesystem.**
///
/// ## Why two tables instead of one table plus a flag
///
/// The same verb's positional semantics usually differ between the read and
/// write sides. `cp SRC DST` takes LAST on the write side (DST) and FIRST on the
/// read side (SRC). `unzip ARCHIVE -d DIR` does not count ARCHIVE as a target on
/// the write side ([`Mode::None`]) but ARCHIVE is exactly the target on the read
/// side. Merging them turns into a pile of conditionals where every edit has to
/// consider both directions at once — drift is then only a matter of time. The
/// two tables share [`Rule`] and [`Scan::check`]; only the registration lines are
/// duplicated.
///
/// ## Deliberately excluded: `sc`
///
/// `sc` is PowerShell's `Set-Content` alias, but also Windows' service controller
/// `sc.exe`, and a spreadsheet program on Unix. In `sc \\server config svc` the
/// UNC host name would be taken as a write target and falsely reported, so only
/// the unambiguous `set-content` is registered.
///
/// ## Duplicate keys
///
/// Java builds these with `HashMap.put`, where a repeated key silently overwrites
/// the earlier entry — no compile error, no runtime error, and behaviour tests
/// can stay green. That actually happened: `select-string` was re-registered as
/// [`Mode::All`] by a later PowerShell block, which made the *pattern* the search
/// target, so an in-workspace `Select-String "<outside absolute path>" src/a.txt`
/// was falsely reported while the identically shaped `grep`/`findstr` was
/// released. The Rust tables are arrays scanned linearly, and
/// `verb_tables_have_no_duplicate_keys` locks the invariant. Where Java relied on
/// a later `put` winning (`cat`, `dir`, `ls` are registered twice in
/// `READ_RULES`), the **final effective** rule is what is written here, with a
/// note.
static WRITE_RULES: Lazy<Vec<(&'static str, Rule)>> = Lazy::new(|| {
    let all = Rule::simple(Mode::All);
    let last = Rule::simple(Mode::Last);
    let first = Rule::simple(Mode::First);
    let second = Rule::simple(Mode::Second);
    let ps_path_all = Rule::with_paths(Mode::All, PS_PATH_PARAMS);
    let ps_path_first = Rule::with_paths(Mode::First, PS_PATH_PARAMS);
    let new_item_paths: &[&str] = &["path", "literalpath"];
    let destination: &[&str] = &["destination"];
    let dest_path: &[&str] = &["destinationpath"];
    let file_paths: &[&str] = &["filepath", "literalpath"];

    let mut v: Vec<(&'static str, Rule)> = Vec::new();

    // ---- deletion (Unix / CMD / PS agree: every positional is a target) ----
    for verb in ["rm", "del", "erase", "unlink", "shred", "rmdir", "rd", "srm"] {
        v.push((verb, all.clone()));
    }
    v.push(("remove-item", ps_path_all.clone()));
    v.push(("ri", ps_path_all.clone()));

    // ---- creation ----
    for verb in ["mkdir", "md", "touch", "mkfifo", "mknod"] {
        v.push((verb, all.clone()));
    }
    v.push(("new-item", Rule::with_paths(Mode::All, new_item_paths)));
    v.push(("ni", Rule::with_paths(Mode::All, new_item_paths)));

    // ---- copy / move / install / link (target = last positional) ----
    for verb in ["cp", "copy", "mv", "move", "install", "rsync", "scp", "ln"] {
        v.push((verb, last.clone()));
    }
    v.push(("copy-item", Rule::with_paths(Mode::Last, destination)));
    v.push(("cpi", Rule::with_paths(Mode::Last, destination)));
    v.push(("move-item", Rule::with_paths(Mode::Last, destination)));
    v.push(("mi", Rule::with_paths(Mode::Last, destination)));
    v.push(("xcopy", last.clone()));
    v.push(("robocopy", second.clone()));
    v.push(("mklink", first.clone()));
    v.push(("ren", first.clone()));
    v.push(("rename", first.clone()));
    v.push(("rename-item", ps_path_first.clone()));
    v.push(("rni", ps_path_first.clone()));

    // ---- writing content ----
    v.push(("tee", all.clone()));
    v.push(("truncate", last.clone()));
    v.push(("set-content", ps_path_all.clone()));
    v.push(("add-content", ps_path_all.clone()));
    v.push(("ac", ps_path_all.clone()));
    v.push(("out-file", Rule::with_paths(Mode::All, file_paths)));
    v.push(("set-item", ps_path_all.clone()));
    v.push(("si", ps_path_all.clone()));
    v.push(("clear-item", ps_path_all.clone()));
    v.push(("cli", ps_path_all.clone()));
    v.push(("clear-content", ps_path_all.clone()));
    v.push(("export-csv", ps_path_first.clone()));
    v.push(("export-clixml", ps_path_first.clone()));
    v.push(("set-acl", ps_path_first.clone()));
    v.push(("new-itemproperty", ps_path_first.clone()));
    v.push(("set-itemproperty", ps_path_first.clone()));
    v.push(("remove-itemproperty", ps_path_first.clone()));
    v.push(("clear-itemproperty", ps_path_first.clone()));
    v.push(("move-itemproperty", Rule::with_paths(Mode::First, destination)));
    v.push(("copy-itemproperty", Rule::with_paths(Mode::First, destination)));

    // ---- archives (write target shapes vary; approximated positionally) ----
    v.push(("zip", first.clone()));
    v.push(("7z", second.clone()));
    v.push(("7za", second.clone()));
    v.push(("7zr", second.clone()));
    v.push(("gzip", all.clone()));
    v.push(("bzip2", all.clone()));
    v.push(("xz", all.clone()));
    v.push(("zstd", all.clone()));
    v.push(("compress-archive", Rule::with_paths(Mode::First, dest_path)));
    v.push(("expand-archive", Rule::with_paths(Mode::First, dest_path)));
    // unzip's positional is the archive being *read*; the write target is `-d`.
    v.push(("unzip", Rule::with_paths(Mode::None, &["d"])));

    // ---- in-place rewrite (a write only with the flag; otherwise read table) ----
    v.push(("sed", Rule::gated(Mode::All, "-i", false)));
    v.push(("gsed", Rule::gated(Mode::All, "-i", false)));
    v.push(("perl", Rule::gated(Mode::All, "-i", false)));
    v.push(("find", Rule::gated(Mode::First, "-delete", false)));
    v.push(("gfind", Rule::gated(Mode::First, "-delete", false)));

    // ---- patching (target = the file being rewritten) ----
    v.push(("patch", first.clone()));

    // ---- download-to-disk (target path is explicit on the command line) ----
    v.push(("certutil", last.clone()));
    v.push(("bitsadmin", last));

    v
});

/// Read verb table; keys are lowercase. See [`WRITE_RULES`] for why this is a
/// separate table.
///
/// ## Deliberately not registered
///
/// `mvn`, `npm`, `git`, `cargo`, `javac` and friends. They really do read
/// outside the workspace (dependency repositories, the global git config), but
/// those paths are not on the command line, so this layer cannot see them — and
/// they are used constantly, so gating them would make default mode unusable.
/// Their build caches are already exempt, and the write table covers the forms
/// where they *do* take a path argument.
///
/// Also: recursive traversal by `ls`-family commands is the structured file
/// tools' business; the bash side only judges paths written explicitly on the
/// command line.
static READ_RULES: Lazy<Vec<(&'static str, Rule)>> = Lazy::new(|| {
    let all = Rule::simple(Mode::All);
    let first = Rule::simple(Mode::First);
    let ps_path_all = Rule::with_paths(Mode::All, PS_PATH_PARAMS);
    let skip_first = Rule::simple(Mode::SkipFirstAll);
    let ps_skip_first = Rule::with_paths(Mode::SkipFirstAll, &["path", "literalpath"]);
    let src_paths: &[&str] = &["path", "literalpath"];

    let mut v: Vec<(&'static str, Rule)> = Vec::new();

    // ---- Unix read commands ----
    // awk/gawk/sed/perl are NOT here: their first positional is the *script
    // body*, not a path, so they need SkipFirstAll (registered further down).
    for verb in [
        "tac", "bat", "less", "head", "tail", "nl", "od", "xxd", "hexdump",
        "strings", "file", "stat", "wc", "md5sum", "sha1sum", "sha256sum",
        "cksum", "du", "tree", "cut", "sort", "uniq", "diff", "cmp", "comm",
        "paste", "join", "column", "expand", "unexpand",
    ] {
        v.push((verb, all.clone()));
    }
    // `cat`, `more`, `dir`, `ls` are registered once each below with their
    // *final* Java semantics (Java re-`put`s them in the PowerShell block, where
    // the later write wins). `cat`/`dir`/`ls` end up as PS_PATH_PARAMS variants;
    // in PowerShell they are aliases of Get-Content / Get-ChildItem, which is the
    // same read semantics under a different spelling.
    v.push(("cat", ps_path_all.clone()));
    v.push(("more", all.clone()));
    v.push(("dir", ps_path_all.clone()));
    v.push(("ls", ps_path_all.clone()));

    // grep family: the first positional is the pattern, the rest are files.
    for verb in ["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "findstr"] {
        v.push((verb, skip_first.clone()));
    }
    // Select-String / sls: `-Path` is a named parameter (the usual PS spelling)
    // and the positional shape matches grep (first is the pattern). These must be
    // registered exactly once — see the duplicate-key note on WRITE_RULES.
    v.push(("select-string", ps_skip_first.clone()));
    v.push(("sls", ps_skip_first.clone()));
    v.push(("eza", all.clone()));
    v.push(("exa", all.clone()));

    // ---- CMD read commands ----
    v.push(("type", all.clone()));

    // ---- copy/move *sources*: a cross-disk copy reads outside content in ----
    // The write table covers their destination side (Last / Second); this adds
    // the source side (First). A same-disk `mv` is a rename and reads nothing,
    // but judging by the source path is still right: it is moving an object that
    // lives outside the workspace.
    v.push(("cp", first.clone()));
    v.push(("copy", first.clone()));
    v.push(("copy-item", Rule::with_paths(Mode::First, src_paths)));
    v.push(("cpi", Rule::with_paths(Mode::First, src_paths)));
    v.push(("mv", first.clone()));
    v.push(("move", first.clone()));
    v.push(("move-item", Rule::with_paths(Mode::First, src_paths)));
    v.push(("mi", Rule::with_paths(Mode::First, src_paths)));
    v.push(("xcopy", first.clone()));
    v.push(("robocopy", first.clone()));
    v.push(("rsync", first.clone()));
    v.push(("scp", first.clone()));
    v.push(("install", first.clone()));

    // ---- PowerShell read cmdlets and aliases ----
    v.push(("get-content", ps_path_all.clone()));
    v.push(("gc", ps_path_all.clone()));
    v.push(("get-item", ps_path_all.clone()));
    v.push(("gi", ps_path_all.clone()));
    v.push(("get-childitem", ps_path_all.clone()));
    v.push(("gci", ps_path_all.clone()));
    v.push(("get-itemproperty", ps_path_all.clone()));
    v.push(("gp", ps_path_all.clone()));
    v.push(("import-csv", ps_path_all.clone()));
    v.push(("import-clixml", ps_path_all.clone()));
    v.push(("convertfrom-json", ps_path_all.clone()));
    v.push(("get-acl", ps_path_all.clone()));
    v.push(("get-filehash", ps_path_all.clone()));
    v.push(("gfh", ps_path_all.clone()));
    v.push(("test-path", ps_path_all.clone()));
    v.push(("resolve-path", ps_path_all.clone()));
    v.push(("get-contentraw", ps_path_all.clone()));

    // ---- archives: the positional is the archive being read (opposite of the
    //      write table's Mode::None) ----
    v.push(("unzip", first.clone()));
    v.push(("zipinfo", first.clone()));
    v.push(("gzip", all.clone()));
    v.push(("bzip2", all.clone()));
    v.push(("xz", all.clone()));
    v.push(("zstd", all.clone()));
    v.push(("expand-archive", Rule::with_paths(Mode::First, src_paths)));

    // ---- inverted gate: a read only when the write flag is absent ----
    // sed/gsed's first positional is the script body, hence SkipFirstAll.
    v.push(("sed", Rule::gated(Mode::SkipFirstAll, "-i", true)));
    v.push(("gsed", Rule::gated(Mode::SkipFirstAll, "-i", true)));
    v.push(("perl", Rule::gated(Mode::SkipFirstAll, "-i", true)));
    v.push(("awk", skip_first.clone()));
    v.push(("gawk", skip_first.clone()));
    v.push(("mawk", skip_first.clone()));
    // find's start directory is the first positional (same as the write table).
    v.push(("find", Rule::gated(Mode::First, "-delete", true)));
    v.push(("gfind", Rule::gated(Mode::First, "-delete", true)));

    // ---- patch: reads the source patch file ----
    v.push(("patch", all));

    v
});

fn lookup_rule<'a>(table: &'a [(&'static str, Rule)], key: &str) -> Option<&'a Rule> {
    table.iter().find(|(k, _)| *k == key).map(|(_, r)| r)
}

/// Verbs needing bespoke extraction: the target hangs off a flag, which the
/// generic positional rules cannot express. The same flag also means different
/// things on different verbs (`tar -f` is the archive being written when
/// creating, the archive being read when extracting), so each gets its own code.
const SPECIAL_VERBS: &[&str] = &[
    "dd", "tar", "gtar", "bsdtar", "curl", "curl.exe", "wget", "aria2c", "axel", "fetch",
];

// ══════════════════════════════════════════════════════════════════════════
// Wrappers
// ══════════════════════════════════════════════════════════════════════════

/// ① Command-expanding wrappers: may carry a payload marker (`-c` / `/c` /
/// `-Command` / `-File`) or may not (`sudo X`, `bash x.sh`, `source x.sh`).
///
/// Not expanding them is the bypass: `sh -c "rm -rf /opt/x"`,
/// `powershell -Command "Set-Content D:\out\f.txt x"` and
/// `powershell -EncodedCommand <base64>` all hide an out-of-workspace write
/// inside a string argument. `-EncodedCommand` is the worst — it is
/// Base64(UTF-16LE) and cannot be eyeballed.
const COMMAND_WRAPPERS: &[&str] = &[
    "sh", "bash", "zsh", "ksh", "dash", "fish", "ash", "csh", "tcsh",
    "source", ".",
    "powershell", "powershell.exe", "pwsh", "pwsh.exe",
    "cmd", "cmd.exe",
    "wsl", "wsl.exe",
    "sudo", "doas", "su", "runas", "runas.exe", "gsudo",
];

/// ② Prefix modifiers: **never** carry a command-payload marker; the command
/// follows their own options directly.
///
/// They only add scheduling attributes (background / timing / priority /
/// buffering / session), so semantically they are "run the command as-is".
/// Hence the same handling as the privilege escalators: skip own options, the
/// rest is the payload.
///
/// This table drives real behaviour (branch ① of [`Scan::handle_wrapper`]), so it
/// is not a dead classification: adding a word here stops that word from going
/// through the payload-marker scan. It must stay in sync with the shape axis'
/// anchor whitelist — locked by
/// `prefix_modifier_vocabulary_is_consistent_across_both_axes`.
const PREFIX_MODIFIERS: &[&str] = &[
    "nohup", "time", "nice", "ionice", "stdbuf", "setsid", "eval", "exec",
];

/// Verbs that change the base for relative paths.
const CD_VERBS: &[&str] = &["cd", "chdir", "pushd", "popd", "set-location", "sl"];

/// Flags whose value is a command string to expand recursively.
const WRAPPER_PAYLOAD_FLAGS: &[&str] = &["-c", "-command", "/c", "/k", "-cmd", "-e", "-execute"];

/// Flags whose value is a **script file**.
///
/// Kept separate from [`WRAPPER_PAYLOAD_FLAGS`] on purpose: in
/// `powershell -File D:\out\x.ps1` the path is not command text. Expanding it as
/// a command yields `baseName = "x.ps1"`, a verb in no table → silent release.
/// The correct reading is "read a script outside the workspace".
const SCRIPT_PAYLOAD_FLAGS: &[&str] = &["-file", "/f"];

/// Flags whose value is Base64(UTF-16LE) command text.
const ENCODED_FLAGS: &[&str] = &["-encodedcommand", "-enc", "-ec", "/encodedcommand"];

/// Options that take a separate value, which must be skipped with them.
const VALUE_FLAGS: &[&str] = &["-u", "-user", "--user", "-d", "--distribution", "-g", "--group"];

/// Script file extensions: what follows is not a command name but a **file that
/// will be read and executed**.
const SCRIPT_EXTENSIONS: &[&str] = &[
    ".sh", ".bash", ".zsh", ".ksh", ".fish", ".csh", ".tcsh",
    ".ps1", ".psm1", ".psd1", ".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".wsh", ".msc", ".py", ".rb", ".pl", ".php", ".lua",
];

fn is_wrapper(key: &str) -> bool {
    COMMAND_WRAPPERS.contains(&key) || PREFIX_MODIFIERS.contains(&key)
}

fn is_known_verb(word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let key = word.to_lowercase();
    lookup_rule(&WRITE_RULES, &key).is_some()
        || lookup_rule(&READ_RULES, &key).is_some()
        || SPECIAL_VERBS.contains(&key.as_str())
        || CD_VERBS.contains(&key.as_str())
        || is_wrapper(&key)
}

// ══════════════════════════════════════════════════════════════════════════
// Exclusion sets and patterns
// ══════════════════════════════════════════════════════════════════════════

/// Non-filesystem drive prefixes: writing these is not a file-boundary crossing
/// (registry keys are constrained elsewhere).
const PS_DRIVE_PREFIXES: &[&str] = &[
    "hklm:", "hkcu:", "hkcr:", "hku:", "hkcc:", "env:", "cert:", "wsman:",
    "variable:", "function:", "alias:", "registry::", "microsoft.powershell",
];

/// Redirection to a null device, or a file-descriptor dup: not a real file write.
const NULL_TARGETS: &[&str] = &[
    "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero",
    "/dev/random", "/dev/urandom", "nul", "null", "$null", "-", "con", "conout$", "conin$",
];

/// Characters after which a backslash acts as an escape (Unix shell semantics).
///
/// **Deliberately excludes** alphanumerics and `: . _ - * ? # = ~ ! ( )`. The
/// first group are ordinary parts of a Windows path (`\o` in `D:\other\x.txt` is
/// a separator, not an escape); the second are **legal NTFS filename characters**
/// (`C:\proj#1\a.txt`, `D:\a=b`, `C:\Program Files (x86)`). Treating them as
/// escapable eats the backslash and destroys the path.
///
/// Cost: on Unix, `rm \*` (deleting a file literally named `*`) is no longer
/// recognised as an escape. But the token still contains a wildcard, so it goes
/// through the owning-directory rule ([`wildcard_prefix`]) — the same outcome as
/// if the escape had been recognised. No real loss.
const SHELL_ESCAPABLE: &str = " \t\n\r'\"$`;|&<>";

static CMD_SHORT_OPTION: Lazy<Regex> = Lazy::new(|| Regex::new("^/[A-Za-z]{1,2}$").unwrap());
static WINDOWS_OPTION: Lazy<Regex> =
    Lazy::new(|| Regex::new("^/[A-Za-z][A-Za-z0-9]*(?::\\S*)?$").unwrap());
static FD_DUP: Lazy<Regex> = Lazy::new(|| Regex::new("^&?\\d*>&\\d+$").unwrap());
static PS_PROVIDER_DRIVE: Lazy<Regex> =
    Lazy::new(|| Regex::new("^[a-z][a-z0-9_.]*:[\\\\/].*").unwrap());

static ENV_VAR_PS: Lazy<Regex> =
    Lazy::new(|| Regex::new("(?i)\\$\\{?env:([A-Za-z_][A-Za-z0-9_]*)\\}?").unwrap());
static HOME_VAR: Lazy<Regex> =
    Lazy::new(|| Regex::new("\\$\\{?(HOME|USERPROFILE)\\}?").unwrap());
static CMD_VAR: Lazy<Regex> =
    Lazy::new(|| Regex::new("%([A-Za-z_][A-Za-z0-9_]*)%").unwrap());

/// .NET static-method calls: the way to write a file in PowerShell that bypasses
/// every cmdlet.
///
/// `[System.IO.File]::WriteAllText("D:\out\f.txt", $c)` contains no cmdlet name,
/// so the verb tables cannot see it at all — but it is a real write, and models
/// do use it: under PowerShell 5.1 it is the only reliable way to write UTF-8
/// without a BOM. Hence a dedicated extraction by method name.
static DOTNET_WRITE_CALL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\[?\s*(?:System\.IO\.)?(File|Directory|FileInfo|DirectoryInfo)\s*\]?\s*::\s*(WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines|OpenWrite|Create|CreateText|Copy|Move|Delete|Replace|Encrypt|Decrypt|SetAttributes|SetCreationTime|SetLastWriteTime|SetLastAccessTime|CreateDirectory|WriteAllTextAsync|WriteAllBytesAsync)\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^,)\s]+))"#,
    )
    .unwrap()
});

/// .NET static **read** methods.
///
/// Kept apart from the write pattern rather than merged: the two have different
/// consequences (read vs write must be reported separately), and methods like
/// `File.Open` cannot be classified by name. So the read side lists only methods
/// that are unambiguously reads, and the ambiguous ones (`Open`, `OpenRead`,
/// `OpenWrite`) go on the **write** side — treating a possible read as a write is
/// the safe error, treating a possible write as a read is not.
static DOTNET_READ_CALL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\[?\s*(?:System\.IO\.)?(File|Directory|FileInfo|DirectoryInfo)\s*\]?\s*::\s*(ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenText|OpenRead|ReadAllTextAsync|ReadAllBytesAsync|ReadAllLinesAsync|Exists|GetFiles|GetDirectories|GetFileSystemEntries|EnumerateFiles|EnumerateDirectories|GetLastWriteTime|GetLastAccessTime|GetCreationTime|GetAttributes)\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^,)\s]+))"#,
    )
    .unwrap()
});

/// `dd ... of=PATH` — the write target.
static DD_OF: Lazy<Regex> =
    Lazy::new(|| Regex::new("(?i)(?:^|[\\s;|&])of=([^\\s;|&]+)").unwrap());
/// `dd ... if=PATH` — the read source.
static DD_IF: Lazy<Regex> =
    Lazy::new(|| Regex::new("(?i)(?:^|[\\s;|&])if=([^\\s;|&]+)").unwrap());
/// Downloader output: `curl -o PATH`, `wget -O PATH`, `aria2c -o PATH`.
static DOWNLOAD_OUT: Lazy<Regex> = Lazy::new(|| {
    Regex::new("(?i)(?:^|[\\s;|&])(?:-o|-O|--output|--output-document)\\s*=?\\s*([^\\s;|&]+)")
        .unwrap()
});
/// `tar`'s archive file (`-f` / `--file`, including bundled short options `-czf`).
static TAR_FILE_FLAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new("(?i)(?:^|[\\s;|&])--file[=\\s]([^\\s;|&]+)|(?:^|[\\s;|&])-[a-z]*f\\s*([^\\s;|&]+)")
        .unwrap()
});
/// `tar`'s extraction directory (`-C DIR` / `--directory DIR`).
static TAR_DIR_FLAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new("(?i)(?:^|[\\s;|&])--directory[=\\s]([^\\s;|&]+)|(?:^|[\\s;|&])-C\\s*([^\\s;|&]+)")
        .unwrap()
});

/// `tar` create mode: a lowercase `c` anywhere inside a bundled short option
/// (`-c`, `-czf`, `-cf`), or the long `--create`.
///
/// **Deliberately case sensitive**: `-C` is `--directory` (the extraction
/// target), `-c` is create. Adding `(?i)` conflates them and turns "read an
/// archive and extract it" into "write an archive".
///
/// **`c` must not be required at the end of the bundle**: in the real-world
/// `tar -czf x.tgz src` the `c` is followed by `zf`, so the older spelling
/// `-[a-z]*c\b` never matched and every create-mode write target was missed.
/// `fancy_regex` is required for the lookahead.
static TAR_CREATE: Lazy<fancy_regex::Regex> = Lazy::new(|| {
    fancy_regex::Regex::new(
        r"(?:^|[\s;|&])(?:-(?=[a-z]*c)[a-z]+(?![A-Za-z0-9])|--create(?![A-Za-z0-9-]))",
    )
    .unwrap()
});
/// `tar` extract mode: a lowercase `x` anywhere in the bundle, or `--extract`.
static TAR_EXTRACT: Lazy<fancy_regex::Regex> = Lazy::new(|| {
    fancy_regex::Regex::new(
        r"(?:^|[\s;|&])(?:-(?=[a-z]*x)[a-z]+(?![A-Za-z0-9])|--extract(?![A-Za-z0-9-]))",
    )
    .unwrap()
});

// ══════════════════════════════════════════════════════════════════════════
// Lexer
// ══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokKind {
    /// Ordinary word: command name, argument, path.
    Word,
    /// Segment separator: `; | & && ||` and newline.
    Sep,
    /// Output redirection (`> >> 2> 1>>`) — a write signal.
    RedirOut,
    /// Input redirection (`< <<`) — a read; not of interest here, but needed to
    /// tokenise correctly.
    RedirIn,
    /// Parenthesis: sub-shell / PS grouping, a hard segment boundary.
    Paren,
}

#[derive(Debug, Clone)]
struct Tok {
    kind: TokKind,
    text: String,
}

/// Split command text into a token stream.
///
/// ## Why this cannot be a regex split
///
/// Quoting is non-trivial in all three dialects: the semicolon in `"a;b"` is not
/// a separator; in Unix `'it's'` closes at the second quote; inside PowerShell
/// double quotes a backtick is the escape character while in Unix it is command
/// substitution. A regex split gets these wrong, and each mistake is either a
/// missed block or a false one.
///
/// `$(...)` and backtick command substitution deliberately get **no** nesting
/// precedence: parentheses are segment boundaries, so the inner command is
/// checked as its own segment. For the purpose of "extract the access targets"
/// that is equivalent to expanding, and it is simple enough not to get wrong.
fn tokenize(s: &str) -> Vec<Tok> {
    // A char vec rather than byte indexing: the Java original indexes UTF-16
    // code units, and slicing a Rust `&str` at a non-boundary panics. Commands
    // routinely contain CJK paths.
    let cs: Vec<char> = s.chars().collect();
    let n = cs.len();
    let mut out: Vec<Tok> = Vec::new();
    let mut cur = String::new();
    let mut has_cur = false;
    let mut quote: char = '\0';
    let mut i = 0usize;

    macro_rules! flush {
        () => {
            if has_cur {
                out.push(Tok { kind: TokKind::Word, text: std::mem::take(&mut cur) });
                has_cur = false;
            }
        };
    }

    while i < n {
        let c = cs[i];

        if quote != '\0' {
            // Inside quotes: only the closing quote and escapes matter. The two
            // dialects escape differently inside double quotes, so they must be
            // handled separately:
            //   PowerShell uses the backtick, and a backslash is a path separator
            //     ("D:\other\x.txt" must survive verbatim);
            //   bash uses the backslash, but only when followed by $ ` " \ or a
            //     newline — elsewhere it is a literal.
            // An earlier version ate the character after every backslash, turning
            // "D:\other\x.txt" into D:otherx.txt, so PowerShell's ordinary
            // spelling of a quoted Windows absolute path was missed 100% of the
            // time.
            // Single quotes are fully literal in both dialects, guaranteed by the
            // `quote == '"'` guard.
            if quote == '"' && i + 1 < n {
                let nq = cs[i + 1];
                if c == '`'
                    || (c == '\\' && (nq == '$' || nq == '`' || nq == '"' || nq == '\\' || nq == '\n'))
                {
                    cur.push(nq);
                    i += 2;
                    continue;
                }
            }
            if c == quote {
                quote = '\0';
                i += 1;
                continue;
            }
            cur.push(c);
            i += 1;
            continue;
        }

        if c == '\'' || c == '"' {
            // An empty quote pair still counts as a word (e.g. `-Value ""`).
            quote = c;
            has_cur = true;
            i += 1;
            continue;
        }

        if c == '\\' && i + 1 < n {
            // An escape only when followed by a shell metacharacter (Unix:
            // `foo\ bar`, `\$HOME`). Otherwise the backslash is a Windows path
            // separator and must be kept verbatim — eating it turns
            // D:\other\x.txt into D:otherx.txt and misses every out-of-workspace
            // write on Windows.
            let next = cs[i + 1];
            if SHELL_ESCAPABLE.contains(next) {
                cur.push(next);
                i += 2;
                continue;
            }
            cur.push('\\');
            has_cur = true;
            i += 1;
            continue;
        }

        if c == '\n' || c == ';' {
            flush!();
            out.push(Tok { kind: TokKind::Sep, text: c.to_string() });
            i += 1;
            continue;
        }

        if c == '|' || c == '&' {
            flush!();
            let mut j = i;
            let mut op = String::new();
            while j < n && (cs[j] == '|' || cs[j] == '&') {
                op.push(cs[j]);
                j += 1;
            }
            out.push(Tok { kind: TokKind::Sep, text: op });
            i = j;
            continue;
        }

        if c == '(' || c == ')' {
            flush!();
            out.push(Tok { kind: TokKind::Paren, text: c.to_string() });
            i += 1;
            continue;
        }

        if c == '>' || c == '<' {
            flush!();
            let mut j = i;
            let mut op = String::new();
            while j < n && (cs[j] == '>' || cs[j] == '<') {
                op.push(cs[j]);
                j += 1;
            }
            let kind = if op.contains('>') { TokKind::RedirOut } else { TokKind::RedirIn };
            out.push(Tok { kind, text: op });
            i = j;
            continue;
        }

        if c.is_whitespace() {
            flush!();
            i += 1;
            continue;
        }

        cur.push(c);
        has_cur = true;
        i += 1;
    }

    // Final flush is inlined rather than using the macro: the macro resets
    // `has_cur`, which is dead here (we return immediately), and that dead store
    // is what the `unused_assignments` lint flags.
    if has_cur {
        out.push(Tok { kind: TokKind::Word, text: cur });
    }
    out
}

/// Split a token stream on segment separators and parentheses.
fn split_segments(toks: &[Tok]) -> Vec<Vec<Tok>> {
    let mut segs: Vec<Vec<Tok>> = Vec::new();
    let mut cur: Vec<Tok> = Vec::new();
    for t in toks {
        if t.kind == TokKind::Sep || t.kind == TokKind::Paren {
            if !cur.is_empty() {
                segs.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(t.clone());
        }
    }
    if !cur.is_empty() {
        segs.push(cur);
    }
    segs
}

fn first_word(seg: &[Tok]) -> Option<&Tok> {
    seg.iter().find(|t| t.kind == TokKind::Word)
}

/// Next ordinary word at or after `from`.
///
/// Steps **over** redirection operators: in `cmd > a.txt` the target sits after
/// the `REDIR_OUT`, and stopping there would lose it.
fn next_word(seg: &[Tok], from: usize) -> Option<&Tok> {
    let mut i = from;
    while i < seg.len() {
        match seg[i].kind {
            TokKind::Word => return Some(&seg[i]),
            TokKind::RedirOut | TokKind::RedirIn => i += 1,
            _ => break,
        }
    }
    None
}

/// The command name itself: strip the path prefix
/// (`C:\Windows\System32\cmd.exe` → `cmd.exe`) and PowerShell's call operator /
/// splatting prefix (`& Set-Content` → `Set-Content`).
fn base_name(raw: &str) -> String {
    let mut t = raw.trim();
    while t.starts_with('&') || t.starts_with('@') || t.starts_with('%') {
        t = t[1..].trim();
    }
    let slash = t.rfind('/').or(t.rfind('\\'));
    if let Some(idx) = slash {
        if idx < t.len().saturating_sub(1) {
            t = &t[idx + 1..];
        }
    }
    t.to_string()
}

/// Whether a flag appears in the segment.
///
/// Recognises three shapes: a standalone long option (`--in-place`), a
/// standalone short option (`-i`), and the letter inside a bundled short option
/// (`sed -i.bak`, `perl -pi`).
fn has_flag(seg: &[Tok], flag: &str) -> bool {
    let f = flag.to_lowercase();
    let short_flag = f.starts_with('-') && !f.starts_with("--") && f.len() == 2;
    let want = f.chars().nth(1);

    for t in seg {
        if t.kind != TokKind::Word {
            continue;
        }
        let v = t.text.to_lowercase();
        if v == f {
            return true;
        }
        if f.starts_with("--") {
            if v.starts_with(&format!("{}=", f)) {
                return true;
            }
            continue;
        }
        if short_flag && v.starts_with('-') && !v.starts_with("--") {
            if let Some(w) = want {
                if v.chars().skip(1).any(|c| c == w) {
                    return true;
                }
            }
        }
    }
    false
}

/// Re-join a segment's tokens into approximate original text, for the patterns
/// that only accept a string (.NET calls, dd, tar, downloaders).
///
/// The reconstruction is a **deliberate approximation**: `tokenize` already
/// stripped quotes, so this rejoins with spaces. Those patterns only care about
/// "the path literal after the flag", and quoting does not change the extraction.
fn segment_text(seg: &[Tok]) -> String {
    let mut sb = String::new();
    for t in seg {
        if matches!(t.kind, TokKind::Word | TokKind::RedirOut | TokKind::RedirIn) {
            if !sb.is_empty() {
                sb.push(' ');
            }
            sb.push_str(&t.text);
        }
    }
    sb
}

/// Skip a wrapper's **own** options; return the index of the first non-option.
///
/// Recognises both option prefixes: Unix `-` (`sudo -u root`, `stdbuf -oL`) and
/// Windows `/` (`runas /user:Administrator`).
///
/// **The `/` prefix must be shape-restricted.** Treating every `/`-initial word
/// as an option would skip `/usr/bin/rm` in `sudo /usr/bin/rm -rf D:\out` — the
/// actual command — leaving the payload as `-rf D:\out`, losing the verb and
/// silently releasing. So only `/letter alnum* [:value]` with **no second slash**
/// counts, which naturally excludes paths.
///
/// An option's value is skipped with it (`-u root`: `root` is not the command);
/// `/user:Administrator` is inline and has no separate value.
fn skip_own_options(seg: &[Tok], from: usize) -> usize {
    let mut i = from;
    while i < seg.len() {
        let t = &seg[i];
        if t.kind != TokKind::Word {
            i += 1;
            continue;
        }
        let lt = t.text.to_lowercase();
        let is_option = lt.starts_with('-') || WINDOWS_OPTION.is_match(&t.text);
        if !is_option {
            break;
        }
        i += 1;
        if VALUE_FLAGS.contains(&lt.as_str()) {
            while i < seg.len() && seg[i].kind != TokKind::Word {
                i += 1;
            }
            if i < seg.len() {
                i += 1;
            }
        }
    }
    i
}

/// Find the **real command start** inside a prefix modifier's argument area.
///
/// ## Why "skip options" is not enough
///
/// In `nice -n 5 mv a.txt D:\out\a.txt`, `-n` takes the value `5`, and `5` has
/// no `-` prefix so it is not an option — it gets taken as "the modified
/// command", `baseName("5") = "5"` matches no rule, and the command is silently
/// released. This shape was observed in the Java repo. Enumerating
/// [`VALUE_FLAGS`] can never be complete (every modifier has its own
/// value-taking options) and each omission is a bypass.
///
/// The general rule: **the first *known verb* after the prefix modifier is the
/// modified command.** A known verb is one registered in any table (write / read
/// / special / cd / wrapper). So both tokens of `-n 5` miss, scanning continues,
/// and it stops at `mv`.
///
/// **When no known verb is found, return the original index** — not the end. In
/// `sudo mvn test`, `mvn` is in no table; returning the original index leaves the
/// payload as `mvn test`, which recurses, matches nothing and is released without
/// a false positive. Returning the end would give an empty payload and lose the
/// script-file judgement (`bash scripts/build.sh`).
fn find_command_start(seg: &[Tok], from: usize) -> usize {
    for i in from..seg.len() {
        if seg[i].kind != TokKind::Word {
            continue;
        }
        if is_known_verb(&base_name(&seg[i].text)) {
            return i;
        }
    }
    from
}

/// Whether a word is a script file path (by extension; a wildcard means "not a
/// script", leaving it to the wildcard rule).
fn is_script_file(text: &str) -> bool {
    let lt = text.to_lowercase();
    if lt.contains('*') || lt.contains('?') {
        return false;
    }
    SCRIPT_EXTENSIONS.iter().any(|ext| lt.ends_with(ext))
}

/// The first word of a payload string (to tell a command from a script path).
fn first_payload_word(payload: &str) -> Option<String> {
    let toks = tokenize(payload);
    first_word(&toks).map(|t| t.text.clone())
}

fn join_from(seg: &[Tok], from: usize) -> Option<String> {
    let mut sb = String::new();
    for t in seg.iter().skip(from) {
        if t.kind != TokKind::Word {
            continue;
        }
        if !sb.is_empty() {
            sb.push(' ');
        }
        sb.push_str(&t.text);
    }
    if sb.is_empty() {
        None
    } else {
        Some(sb)
    }
}

/// Decode a PowerShell `-EncodedCommand` payload (Base64 of UTF-16LE).
///
/// A decode failure returns `None` (release) rather than an error: if it cannot
/// be decoded it is also not a command this layer can judge, and
/// `-EncodedCommand` is common in legitimate ops scripts (this very project uses
/// it), so a hard block would cause false positives. The real backstop for that
/// path is the OS sandbox.
///
/// Java uses `Base64.getMimeDecoder()`, which **ignores every character outside
/// the base64 alphabet** (including newlines). Rust's decoders reject them, so
/// the input is filtered first to match.
fn decode_encoded_command(b64: &str) -> Option<String> {
    use base64::Engine;
    let trimmed = b64.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let cfg = base64::engine::general_purpose::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent);
    let engine =
        base64::engine::general_purpose::GeneralPurpose::new(&base64::alphabet::STANDARD, cfg);
    let raw = engine.decode(cleaned.as_bytes()).ok()?;
    if raw.is_empty() {
        return None;
    }
    // UTF-16LE, matching Java's `new String(raw, UTF_16LE)` (invalid sequences
    // become U+FFFD there, and `from_utf16_lossy` does the same).
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

// ══════════════════════════════════════════════════════════════════════════
// Path helpers (pure functions)
// ══════════════════════════════════════════════════════════════════════════

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Expand variables and `~`.
///
/// Only forms whose value is **knowable** are expanded: `~` (home),
/// `$HOME` / `${HOME}` / `$USERPROFILE`, `$env:NAME`, `%NAME%` (when the
/// variable exists). Anything unresolvable is left verbatim and the caller
/// decides whether to give up.
///
/// A missing `%NAME%` is **kept verbatim** rather than dropped: under CMD an
/// undefined variable expands to the empty string, and keeping it makes the path
/// resolve to something containing `%` (necessarily inside the workspace →
/// released), which points the same way as CMD's real behaviour and cannot cause
/// a false positive.
///
/// A missing `$env:NAME` is likewise kept verbatim rather than expanded to
/// empty. PowerShell's real semantics *are* empty (`$env:UNSET\f.txt` writes to
/// the current drive root), but that would resolve the target to `D:\f.txt` and
/// be reported to the user — who wrote `$env:UNSET\f.txt`, so the approval text
/// would be inexplicable and approving it would not tell them where it goes.
/// Keeping it verbatim lets [`has_unresolved_var`] release it, consistent with
/// the `%NAME%` case (the same shape must not get two different rulings, or that
/// is a drift point).
fn expand_vars(raw: &str) -> String {
    let mut s = raw.to_string();

    if s == "~" {
        return home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or(s);
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return format!("{}{}", home.to_string_lossy(), rest);
        }
    }

    s = replace_by_pattern(&s, &ENV_VAR_PS, |name| std::env::var(name).ok());
    s = replace_by_pattern(&s, &HOME_VAR, |name| {
        if name.eq_ignore_ascii_case("USERPROFILE") {
            std::env::var("USERPROFILE").ok()
        } else {
            home_dir()
                .map(|h| h.to_string_lossy().into_owned())
                .or_else(|| std::env::var("HOME").ok())
        }
    });
    s = replace_by_pattern(&s, &CMD_VAR, |name| {
        // Missing → keep the original text (see the method docs).
        std::env::var(name).ok().or_else(|| Some(format!("%{}%", name)))
    });
    s
}

/// Replace every match of `p` in `s`; a `None` from `lookup` means "no value
/// known", in which case the original match text is kept.
fn replace_by_pattern<F>(s: &str, p: &Regex, lookup: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = String::with_capacity(s.len());
    let mut last = 0usize;
    for caps in p.captures_iter(s) {
        let m = caps.get(0).expect("group 0 always exists");
        out.push_str(&s[last..m.start()]);
        let name = caps.get(1).map(|g| g.as_str()).unwrap_or("");
        match lookup(name) {
            Some(v) => out.push_str(&v),
            None => out.push_str(m.as_str()),
        }
        last = m.end();
    }
    out.push_str(&s[last..]);
    out
}

/// A token that does not look like a path; must be excluded before path parsing.
///
/// * `-xxx` flags: `-r` in `cp -r SRC DST` would be misjudged as a write target;
/// * CMD short options like `/s`, `/q`: see [`CMD_SHORT_OPTION`].
fn is_option_like(t: &str) -> bool {
    if t.starts_with('-') && t.chars().count() > 1 {
        return true;
    }
    CMD_SHORT_OPTION.is_match(t)
}

fn is_null_target(t: &str) -> bool {
    let lt = t.to_lowercase();
    if NULL_TARGETS.contains(&lt.as_str()) {
        return true;
    }
    // File-descriptor dup: `>&1`, `2>&1`. tokenize splits on `&`, so this catches
    // the glued form.
    FD_DUP.is_match(&lt)
}

/// A non-filesystem drive (registry key, environment variable, certificate, …).
///
/// A single-letter drive (`C:\`, `D:/`) **is** a filesystem and must go on to the
/// boundary check, so that test comes first and the order cannot be swapped.
fn is_non_filesystem_drive(t: &str) -> bool {
    let lt = t.to_lowercase();
    let mut chars = lt.chars();
    if let (Some(c0), Some(c1)) = (chars.next(), chars.next()) {
        if c1 == ':' && c0.is_ascii_alphabetic() {
            return false;
        }
    }
    if PS_DRIVE_PREFIXES.iter().any(|pre| lt.starts_with(pre)) {
        return true;
    }
    // Any other `provider:path` PowerShell drive.
    PS_PROVIDER_DRIVE.is_match(&lt)
}

/// Give up when a target cannot be resolved to a definite path. Used for
/// **configuration entries and `cd` targets only**.
///
/// A `$` or `%` surviving expansion means the path depends on a runtime value
/// this layer cannot see; a `*` or `?` means it is a wildcard (the real target
/// set is unknown).
///
/// This **releases** rather than blocks: when ownership cannot be determined,
/// blocking produces an approval the user can neither explain nor fix by
/// approving (approving still does not say where it will write).
///
/// **Access targets do not use this.** A wildcard's owning directory *is*
/// definite (`D:\out\*.*` certainly belongs to `D:\out`), so releasing all of
/// them would let an out-of-workspace bulk delete through. See
/// [`has_unresolved_var`] and [`wildcard_prefix`]. This function is kept for the
/// two call sites where a wildcard is meaningless: exemption config entries and
/// `cd` targets.
fn is_unjudgeable(expanded: &str) -> bool {
    has_unresolved_var(expanded) || wildcard_prefix(expanded).is_some()
}

/// Whether the string contains a variable reference whose value this layer
/// cannot see (`$` / `%`).
///
/// This is the genuinely undecidable shape: in
/// `$d="D:\out"; Set-Content "$d\f.txt" x` the value of `$d` exists only at
/// runtime. Release is the only option (a documented capability boundary).
fn has_unresolved_var(expanded: &str) -> bool {
    expanded.contains('$') || expanded.contains('%')
}

/// The **owning directory prefix** of a wildcard path; `None` when there is no
/// wildcard.
///
/// ## Why this is decidable
///
/// `*` and `?` only expand in the **last few** segments; the directory part
/// before them is literal. So every possible match of `D:\out\*.*` lies inside
/// `D:\out` — judging that prefix judges the whole target set, and the conclusion
/// is conservatively correct: prefix outside the workspace ⇒ every match is
/// outside (block); prefix inside ⇒ matches are not necessarily all inside
/// (`src/*\.txt` cannot leave the workspace, because a wildcard does not cross a
/// separator), so releasing is also right.
///
/// An earlier implementation released every wildcard target, with the result
/// that `del D:\out\*.*` and `Remove-Item D:\out\* -Recurse -Force` — out-of-
/// workspace **bulk deletes** — were missed by both axes (the shape axis'
/// `del /s` / `rd /s` patterns require `/s`, which these lack).
///
/// The cut is at "the last separator before the first wildcard", so a
/// multi-level wildcard (`D:/out/*/*.txt`) still retreats only to the first
/// definite directory level.
///
/// Returns the owning prefix; an **empty string** when there is no separator
/// before the wildcard (`*.txt`, meaning "owned by the current base"); `None`
/// when there is no wildcard at all.
fn wildcard_prefix(expanded: &str) -> Option<String> {
    let cs: Vec<char> = expanded.chars().collect();
    let w = cs.iter().position(|c| *c == '*' || *c == '?')?;

    let cut = (0..w).rev().find(|&i| cs[i] == '/' || cs[i] == '\\');
    let Some(cut) = cut else {
        // `*.txt`: no directory part before the wildcard, so it belongs to the
        // current base.
        return Some(String::new());
    };
    if cut == 0 {
        // `/*.txt`: owned by the root itself. The separator must be kept, or the
        // empty prefix would be treated as relative and fall back to the base
        // directory, missing a root-level wildcard.
        return Some(cs[0].to_string());
    }

    let prefix: String = cs[..cut].iter().collect();

    // Windows drive root: `D:\*` cuts to `D:`, and `Path::new("D:")` is
    // **drive-relative** (`is_absolute() == false`), so `base.join()` resolves it
    // to "the current directory on D:" rather than the drive root. In the Java
    // repo this resolved to `D:\work\gourd\gourdai\` (a trailing-separator oddity
    // — the workspace itself) and the verdict was *accidentally* still "outside",
    // only because that odd path's last segment is literally `"gourdai\\"` and
    // does not equal the workspace's `"gourdai"`. A different JDK or platform
    // could flip it to "inside", silently releasing `Remove-Item D:\*` (deleting
    // the whole drive). **A correct result that depends on luck is a defect**, so
    // the separator is put back, making it a genuinely absolute path
    // (`D:\` with `is_absolute() == true`) and the verdict independent of any
    // literal coincidence.
    if prefix.len() == 2 {
        let mut it = prefix.chars();
        if let (Some(c0), Some(c1)) = (it.next(), it.next()) {
            if c1 == ':' && c0.is_ascii_alphabetic() {
                return format!("{}{}", prefix, cs[cut]).into();
            }
        }
    }
    Some(prefix)
}

/// Lexical normalisation: resolve `.` and `..` without touching the filesystem.
///
/// Mirrors Java's `Path.normalize()`. A `..` at the root is dropped
/// (`D:\..\foo` → `D:\foo`), matching Java; a `..` above a relative path is kept
/// (`..\foo`), since there is nothing to pop.
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Prefix(pre) => out.push(pre.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let has_root = out.has_root();
                if !out.pop() && !has_root {
                    out.push("..");
                }
                // With a root and nothing to pop we are at the root: ignore, as
                // Java's normalize does.
            }
            Component::Normal(s) => out.push(s),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// Make a path absolute against the process CWD (Java `toAbsolutePath()`).
fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(p),
        Err(_) => p.to_path_buf(),
    }
}

/// Strip Windows' verbatim prefix that `canonicalize` adds.
///
/// `std::fs::canonicalize` returns `\\?\D:\foo` (and `\\?\UNC\server\share`).
/// Left in place, every comparison against a non-verbatim root fails and
/// **everything** looks out-of-workspace — the guard would prompt on every
/// in-workspace write. `dunce` would do this, but adding a dependency is not
/// worth four lines.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// Resolve symlinks when possible, else fall back to the lexical path
/// (Java `realOrLexical`).
///
/// Target exists → canonicalise. Otherwise walk up to the **nearest existing
/// ancestor**, canonicalise that, then re-append the collected tail segments and
/// normalise. If even that fails (an unreachable drive), fall back to the lexical
/// path so an out-of-workspace verdict is still possible.
///
/// This is the symlink-escape defence, structurally identical to
/// `TerminalSupport.resolveSafePath`: without it, a symlink inside the workspace
/// pointing at `D:\` disguises an out-of-workspace write as an in-workspace one.
fn real_or_lexical(target: &Path) -> PathBuf {
    if target.exists() {
        if let Ok(real) = std::fs::canonicalize(target) {
            return strip_verbatim(real);
        }
        return lexical_normalize(target);
    }
    let mut ancestor = target.to_path_buf();
    let mut tail: Vec<String> = Vec::new();
    while ancestor.parent().is_some() && !ancestor.exists() {
        let name = ancestor
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        tail.insert(0, name);
        if !ancestor.pop() {
            break;
        }
    }
    let real = match std::fs::canonicalize(&ancestor) {
        Ok(r) => strip_verbatim(r),
        Err(_) => return lexical_normalize(target),
    };
    let mut out = real;
    for seg in tail {
        if !seg.is_empty() {
            out.push(seg);
        }
    }
    lexical_normalize(&out)
}

/// Resolve for the root and for exemption entries (Java `toReal`).
fn to_real(p: &Path) -> PathBuf {
    if p.exists() {
        if let Ok(real) = std::fs::canonicalize(p) {
            return strip_verbatim(real);
        }
    }
    lexical_normalize(p)
}

/// Boundary test: is `target` inside `root`?
///
/// Component-wise, **not** a string-prefix comparison: `D:\work\gourdai2` has
/// `D:\work\gourdai` as a string prefix but is not inside it, and a string
/// comparison would wrongly call it inside.
///
/// On Windows the comparison is case-insensitive per component. Java gets this
/// for free (`WindowsPath.startsWith` is case-insensitive, and `toRealPath`
/// returns NTFS's real casing so root and target agree); Rust's
/// `Path::starts_with` compares `OsStr` exactly, so without this
/// `Set-Content D:\WORK\GOURDAI-OTHER\f.txt` against workspace `D:\work\gourdai`
/// would be judged by casing rather than by location. **This step has no
/// counterpart in the Java source** — it is required by the platform difference.
fn is_inside(root: &Path, target: &Path) -> bool {
    let rc: Vec<Component<'_>> = root.components().collect();
    let tc: Vec<Component<'_>> = target.components().collect();
    if rc.len() > tc.len() {
        return false;
    }
    rc.iter().zip(tc.iter()).all(|(a, b)| component_eq(a, b))
}

fn component_eq(a: &Component<'_>, b: &Component<'_>) -> bool {
    if cfg!(windows) {
        let sa = a.as_os_str().to_string_lossy();
        let sb = b.as_os_str().to_string_lossy();
        sa.eq_ignore_ascii_case(&sb)
    } else {
        a == b
    }
}

/// Option name (lowercase, no leading `-`); `None` when the token is not an option.
fn option_name(token: &str) -> Option<String> {
    let t = token.trim();
    if !t.starts_with('-') {
        return None;
    }
    let name = match t.find('=') {
        Some(i) if i > 0 => &t[..i],
        _ => t,
    };
    let name = name.trim_start_matches('-');
    if name.is_empty() || name.len() > 40 {
        return None;
    }
    Some(name.to_lowercase())
}

/// Register candidate path literals as exempt roots.
///
/// `null` / blank / invalid literals are skipped: a shorter exemption list only
/// makes the gate **stricter** (one more prompt), never grants access, so there
/// is nothing to throw here.
fn add_absolute(roots: &mut Vec<PathBuf>, candidates: &[String]) {
    for c in candidates {
        let t = c.trim();
        if t.is_empty() || t == "null" {
            continue;
        }
        roots.push(lexical_normalize(&absolutize(Path::new(t))));
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Scan state machine
// ══════════════════════════════════════════════════════════════════════════

/// Mutable state for one [`inspect`] pass.
///
/// `base` must be maintained **across segments**: in
/// `Set-Location D:\out; Set-Content f.txt x` the second segment is a relative
/// path, and only by following the `cd` can you see that it writes outside the
/// workspace. Ignoring `cd` misses that whole class.
///
/// No thread-local state: that would leak across tests with a reused thread, and
/// a missed bind/unbind is a silent failure.
struct Scan {
    root: PathBuf,
    exempts: Vec<PathBuf>,
    dir_stack: Vec<PathBuf>,
    /// What this pass looks for: `true` = out-of-workspace **writes** only,
    /// `false` = out-of-workspace **reads** only.
    ///
    /// One instance runs one pass. Two instances rather than one looking for both
    /// because `hit` holds a single result and write must win (see [`inspect`]).
    /// One class rather than two because the path resolution and exemption logic
    /// are identical — only "which verb table" and "which redirection kind"
    /// differ, and duplicating the boundary logic would be the next drift point.
    write_mode: bool,
    base: PathBuf,
    hit: Option<Verdict>,
}

impl Scan {
    fn new(workspace_root: &Path, extra_exempts: &[PathBuf], write_mode: bool) -> Self {
        let root = to_real(&lexical_normalize(&absolutize(workspace_root)));
        let base = root.clone();

        let mut ex = default_exempt_roots();

        // On Windows a "rooted but drive-less" path like `/tmp` resolves against
        // the base drive to `D:\tmp`, while the exemption list's `/tmp` resolves
        // to `C:\tmp` (the process drive). They would not match and would falsely
        // report, so add same-named variants on the workspace's own root.
        if let Some(prefix) = root.components().next() {
            if matches!(prefix, Component::Prefix(_)) {
                let root_dir = PathBuf::from(prefix.as_os_str()).join("\\");
                for rel in ["tmp", "var/tmp", "private/tmp", "var/folders"] {
                    ex.push(to_real(&lexical_normalize(&root_dir.join(rel))));
                }
            }
        }

        for p in extra_exempts {
            ex.push(to_real(&lexical_normalize(&absolutize(p))));
        }

        Self { root, exempts: ex, dir_stack: Vec::new(), write_mode, base, hit: None }
    }

    fn run(&mut self, text: &str, depth: usize) {
        if depth > MAX_UNWRAP_DEPTH || self.hit.is_some() {
            return;
        }

        // .NET static calls must be scanned over the **whole text**: the opening
        // paren of `WriteAllText(` is a segment boundary for tokenize, which
        // would put the method name and its path argument in different segments,
        // so a per-segment scan can never match.
        self.scan_dotnet_calls(text);
        if self.hit.is_some() {
            return;
        }

        let toks = tokenize(text);
        for seg in split_segments(&toks) {
            if self.hit.is_some() {
                return;
            }
            self.handle_segment(&seg, depth);
        }
    }

    fn handle_segment(&mut self, seg: &[Tok], depth: usize) {
        // 1. Redirection: the strongest access signal, independent of the verb.
        //    The write pass recognises `>` (`cat x > D:\out\f`), the read pass
        //    `<` (`sort < D:\out\f`). One kind per pass so the same redirection
        //    is not reported by both.
        let want = if self.write_mode { TokKind::RedirOut } else { TokKind::RedirIn };
        for i in 0..seg.len() {
            if seg[i].kind == want {
                let op = seg[i].text.clone();
                if let Some(target) = next_word(seg, i + 1) {
                    let text = target.text.clone();
                    self.check(&text, &op);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
        }

        // 2. The segment's leading verb (path prefix and PS call operator stripped).
        let Some(head) = first_word(seg) else { return };
        let verb = base_name(&head.text);
        let key = verb.to_lowercase();

        // 3. cd family: update the base for relative paths; writes nothing itself.
        if CD_VERBS.contains(&key.as_str()) {
            self.apply_cd(&key, seg);
            return;
        }

        // 4. Bespoke shapes (dd / tar / downloaders).
        if SPECIAL_VERBS.contains(&key.as_str()) {
            self.scan_special(&key, seg);
            return;
        }

        // 5. Wrappers, dispatched by "is what follows a command or a script
        //    file". All three classes must have real handling — any of them
        //    falling through to "do nothing" is a bypass (proven in this repo:
        //    an early version had only COMMAND_WRAPPERS, and 8 members were
        //    silently released).
        if is_wrapper(&key) {
            self.handle_wrapper(&key, seg, depth);
            return;
        }

        // 6. The generic verb table for this pass.
        let table = if self.write_mode { &*WRITE_RULES } else { &*READ_RULES };
        let Some(rule) = lookup_rule(table, &key).cloned() else { return };
        if let Some(gate) = rule.gate_flag {
            let present = has_flag(seg, gate);
            // gate_absent=false: check only when the flag is present (write
            //   table: sed -i / find -delete)
            // gate_absent=true : check only when the flag is absent (read table:
            //   sed without -i is a pure read)
            if rule.gate_absent == present {
                return;
            }
        }
        self.apply_rule(&verb, seg, &rule);
    }

    fn apply_rule(&mut self, verb: &str, seg: &[Tok], rule: &Rule) {
        let mut positional: Vec<String> = Vec::new();
        let mut skip_next = false;
        let mut pending_path_param: Option<String> = None;

        for t in seg.iter().skip(1) {
            if t.kind != TokKind::Word {
                continue;
            }
            let v = t.text.clone();

            if skip_next {
                skip_next = false;
                continue;
            }
            if let Some(param) = pending_path_param.take() {
                let label = format!("{} -{}", verb, param);
                self.check(&v, &label);
                if self.hit.is_some() {
                    return;
                }
                continue;
            }

            if let Some(opt) = option_name(&v) {
                if rule.path_params.contains(&opt.as_str()) {
                    // The `-Path=X` form carries its value inline, so there is no
                    // need to wait for the next token.
                    match v.find('=') {
                        Some(eq) if eq > 0 => {
                            let value = v[eq + 1..].to_string();
                            let label = format!("{} -{}", verb, opt);
                            self.check(&value, &label);
                            if self.hit.is_some() {
                                return;
                            }
                        }
                        _ => pending_path_param = Some(opt),
                    }
                } else if rule.skip_params.contains(&opt.as_str()) && !v.contains('=') {
                    skip_next = true;
                }
                continue;
            }

            if is_option_like(&v) {
                continue;
            }

            positional.push(v);
        }

        match rule.mode {
            Mode::All => {
                for p in positional {
                    self.check(&p, verb);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
            Mode::SkipFirstAll => {
                // The first positional is the pattern / script body; paths start
                // at the second.
                for p in positional.iter().skip(1) {
                    self.check(p, verb);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
            Mode::Last => {
                if let Some(p) = positional.last() {
                    self.check(p, verb);
                }
            }
            Mode::First => {
                if let Some(p) = positional.first() {
                    self.check(p, verb);
                }
            }
            Mode::Second => {
                if positional.len() >= 2 {
                    self.check(&positional[1], verb);
                }
            }
            Mode::None => {}
        }
    }

    /// Scan .NET static-method calls.
    ///
    /// Takes the **whole command text**, not a segment: the opening paren of
    /// `WriteAllText(` is a segment boundary for tokenize, which would separate
    /// the method name from its path argument and make a per-segment scan always
    /// miss. Reading the raw text has a second benefit — quotes are still
    /// present, so path-literal boundaries are clearer.
    fn scan_dotnet_calls(&mut self, text: &str) {
        // Both passes share this method, selecting the table by write_mode. One
        // Scan runs one pass, so the same text cannot be reported as both.
        let pattern = if self.write_mode { &*DOTNET_WRITE_CALL } else { &*DOTNET_READ_CALL };
        for caps in pattern.captures_iter(text) {
            let path = caps
                .get(3)
                .or_else(|| caps.get(4))
                .or_else(|| caps.get(5))
                .map(|m| m.as_str().trim().to_string());
            let Some(path) = path.filter(|p| !p.is_empty()) else { continue };
            let ty = caps.get(1).map(|m| m.as_str()).unwrap_or("File");
            let method = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let verb = format!("[System.IO.{}]::{}", ty, method);
            self.check(&path, &verb);
            if self.hit.is_some() {
                return;
            }
        }
    }

    fn scan_special(&mut self, key: &str, seg: &[Tok]) {
        let text = segment_text(seg);

        if key == "dd" {
            // The write pass looks at `of=`, the read pass at `if=`.
            let pattern = if self.write_mode { &*DD_OF } else { &*DD_IF };
            let verb = if self.write_mode { "dd of=" } else { "dd if=" };
            for caps in pattern.captures_iter(&text) {
                if let Some(v) = caps.get(1).map(|m| m.as_str().to_string()) {
                    self.check(&v, verb);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
            return;
        }

        // curl / wget / aria2c / axel / fetch: `-o` is the write side. The read
        // side does not care (a remote URL is not a local path).
        if !is_tar_verb(key) {
            if self.write_mode {
                for caps in DOWNLOAD_OUT.captures_iter(&text) {
                    if let Some(v) = caps.get(1).map(|m| m.as_str().to_string()) {
                        let verb = format!("{} -o", key);
                        self.check(&v, &verb);
                        if self.hit.is_some() {
                            return;
                        }
                    }
                }
            }
            return;
        }

        // tar:
        //   write pass — in create mode the `-f` archive is written; in extract
        //                mode the `-C` directory is written
        //   read pass  — in extract/list mode the `-f` archive is the source
        //                being read (e.g. `tar -xf D:\out\a.tgz -C <inside>`)
        let creating = TAR_CREATE.find(&text).ok().flatten().is_some();
        let extracting = TAR_EXTRACT.find(&text).ok().flatten().is_some();

        if self.write_mode {
            let pattern = if creating && !extracting {
                Some((&*TAR_FILE_FLAG, format!("{} -f", key)))
            } else if extracting {
                Some((&*TAR_DIR_FLAG, format!("{} -C", key)))
            } else {
                None
            };
            let Some((pattern, verb)) = pattern else { return };
            for caps in pattern.captures_iter(&text) {
                let v = caps
                    .get(1)
                    .or_else(|| caps.get(2))
                    .map(|m| m.as_str().to_string());
                if let Some(v) = v {
                    self.check(&v, &verb);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
        } else if !creating || extracting {
            // Read pass: in extract/list mode the archive at `-f` is the **source
            // being read**, so check whether it is outside.
            // Pure create mode (creating && !extracting) is deliberately excluded:
            // there `-f` is the write target, already reported by the write pass.
            // Reporting it here too would judge the same `-f` twice for one
            // command (write-first already covers it; the read pass is redundant).
            for caps in TAR_FILE_FLAG.captures_iter(&text) {
                let v = caps
                    .get(1)
                    .or_else(|| caps.get(2))
                    .map(|m| m.as_str().to_string());
                if let Some(v) = v {
                    let verb = format!("{} -f (read)", key);
                    self.check(&v, &verb);
                    if self.hit.is_some() {
                        return;
                    }
                }
            }
        }
    }

    /// Apply cd / pushd / popd, updating the base for relative paths.
    ///
    /// `popd` returns to the previous directory, hence a stack; an empty stack
    /// returns to the workspace root. `cd -` (previous directory) and a bare `cd`
    /// (home) have no determinable base, so they fall back to the workspace root
    /// — subsequent relative paths are then judged inside (released). Missing a
    /// block is preferable to producing an approval the user cannot explain.
    fn apply_cd(&mut self, key: &str, seg: &[Tok]) {
        if key == "popd" {
            self.base = self.dir_stack.pop().unwrap_or_else(|| self.root.clone());
            return;
        }
        if key == "pushd" {
            let b = self.base.clone();
            self.dir_stack.push(b);
        }
        let Some(target) = next_word(seg, 1) else {
            self.base = self.root.clone();
            return;
        };
        let text = target.text.clone();
        if text.starts_with('-') {
            self.base = self.root.clone();
            return;
        }
        if let Some(p) = self.resolve(&text) {
            self.base = p;
        }
    }

    /// Wrapper dispatch: three semantics, three routes, and **no branch may
    /// silently do nothing**.
    ///
    /// The order is deliberate:
    /// 1. prefix modifiers (nohup / time / eval …): no payload marker, so after
    ///    their own options the rest is the command;
    /// 2. `-EncodedCommand <base64>`: decode, then expand recursively;
    /// 3. script markers (`-File` / `/f`): what follows is a **script file**,
    ///    judged as a read target (expanding it as command text yields `x.ps1`, a
    ///    verb in no table → silent release);
    /// 4. command markers (`-c` / `-Command` / `/c` / `/k`): expand recursively,
    ///    **and additionally check whether the first word is a script file** —
    ///    `cmd /c D:\out\x.bat` takes this route and recursion alone would miss it;
    /// 5. no marker: privilege escalators / WSL expand as a command; shell
    ///    launchers and `source` / `.` take a script file as their first
    ///    positional; everything else falls back to command expansion.
    ///
    /// **This method must not have a "do nothing and return" path.** An early
    /// version hardcoded the unmarked-wrapper whitelist to 6 privilege escalators
    /// and returned for every other member, so the whole segment went unchecked
    /// and `nohup Set-Content D:\out\f.txt x` was silently released in default
    /// mode. The final fallback now expands unconditionally.
    fn handle_wrapper(&mut self, key: &str, seg: &[Tok], depth: usize) {
        // ① Prefix modifier: never carries a command-payload marker. Skip its own
        //    options, then locate the first "known verb" or "script file" (see
        //    expand_unmarked_payload for the `nice -n 5` / `nohup ./x.sh` cases).
        if PREFIX_MODIFIERS.contains(&key) {
            let start = skip_own_options(seg, 1);
            self.expand_unmarked_payload(key, seg, start, depth);
            return;
        }

        for i in 1..seg.len() {
            if seg[i].kind != TokKind::Word {
                continue;
            }
            let lt = seg[i].text.to_lowercase();
            let flag_text = seg[i].text.clone();

            // ② Base64-encoded command
            if ENCODED_FLAGS.contains(&lt.as_str()) {
                let decoded = next_word(seg, i + 1)
                    .map(|t| t.text.clone())
                    .and_then(|b64| decode_encoded_command(&b64));
                if let Some(payload) = decoded {
                    self.run_payload(&payload, depth);
                }
                return;
            }

            // ③ Script-file marker: powershell -File X.ps1
            if SCRIPT_PAYLOAD_FLAGS.contains(&lt.as_str()) {
                if let Some(script) = next_word(seg, i + 1) {
                    let text = script.text.clone();
                    let verb = format!("{} {}", key, flag_text);
                    self.check_script_read(&text, &verb);
                }
                return;
            }

            // ④ Command marker: sh -c "..." / cmd /c ... / powershell -Command "..."
            if WRAPPER_PAYLOAD_FLAGS.contains(&lt.as_str()) {
                let payload = join_from(seg, i + 1);
                let first = payload.as_deref().and_then(first_payload_word);
                if first.as_deref().map(is_script_file).unwrap_or(false) {
                    // `cmd /c D:\out\x.bat` — the payload is a script file, not a
                    // command. Report the **first word**, not the whole string:
                    // the string may carry arguments ("D:\out\x.bat arg1"), and
                    // parsing that as one path yields an odd path containing a
                    // space → parse failure → silent release.
                    let word = first.unwrap();
                    let verb = format!("{} {}", key, flag_text);
                    self.check_script_read(&word, &verb);
                    return;
                }
                if let Some(p) = payload {
                    self.run_payload(&p, depth);
                }
                return;
            }
        }

        // ⑤ No marker: privilege escalators, WSL, prefix modifiers and script
        //    launchers all come here.
        let start = skip_own_options(seg, 1);
        self.expand_unmarked_payload(key, seg, start, depth);
    }

    /// Expand an unmarked payload: first decide whether it is a **script file
    /// path** (judge as a read target), otherwise expand it as a command.
    ///
    /// **Must be uniform across all wrappers**, not a branch for one class only:
    /// in `nohup D:\out\x.sh`, `nohup` is a *prefix modifier*, not a shell
    /// launcher, but the semantics are still "executed this script file". Measured
    /// in the Java repo: with the branch open only to shell launchers, both
    /// `nohup D:\out\x.sh` and `setsid D:\out\x.sh` were silently released — and
    /// `nohup ./build.sh` is one of nohup's most common uses, not an edge case.
    ///
    /// [`find_command_start`] runs before the script test, and both layers are
    /// needed: `nice -n 5 mv ...` needs the former to skip an option's value,
    /// `nohup ./x.sh` needs the latter to recognise a script.
    fn expand_unmarked_payload(&mut self, key: &str, seg: &[Tok], start: usize, depth: usize) {
        let cmd_start = find_command_start(seg, start);
        let first = next_word(seg, cmd_start).map(|t| t.text.clone());
        if let Some(first) = first {
            if is_script_file(&first) {
                // bash D:\out\x.sh / source x.sh / . x.sh / nohup ./x.sh — the
                // script file is a read target.
                self.check_script_read(&first, key);
                return;
            }
        }
        if let Some(payload) = join_from(seg, cmd_start) {
            self.run_payload(&payload, depth);
        }
    }

    /// Recursively expand a payload command. An empty payload genuinely has
    /// nothing to judge, so nothing happens.
    fn run_payload(&mut self, payload: &str, depth: usize) {
        if !payload.trim().is_empty() {
            self.run(payload, depth + 1);
        }
    }

    /// Judge "an out-of-workspace script that will be executed" as a **read**.
    ///
    /// The script's contents are invisible to this layer (reading the file would
    /// be needed), but reading a script outside the workspace is no less risky
    /// than reading a data file — a script can write anything. Reported only on
    /// the read pass: reporting it on the write pass would mislabel "read an
    /// external script" as "wrote", contradicting the two-pass division of labour.
    fn check_script_read(&mut self, script_path: &str, verb: &str) {
        if self.write_mode {
            return;
        }
        let label = format!("{} (script)", verb);
        self.check(script_path, &label);
    }

    /// Judge whether one target is out of bounds; record the first hit.
    ///
    /// Reads and writes share this judgement deliberately: "what counts as
    /// inside", "which directories are exempt" and "how symlink escape is
    /// prevented" are all independent of the access type. Writing a second copy
    /// for reads would let the two exemption lists drift, and that drift presents
    /// as "I configured an exemption and it only works for writes" — very hard to
    /// attribute.
    ///
    /// The chain order is deliberate: first exclude things that are not paths at
    /// all (options, null devices, registry keys, unresolvable variables /
    /// wildcards), then resolve, then compare boundaries. Putting the exclusions
    /// first is what stops `/s` and `&1` from being resolved to `D:\s` and
    /// falsely reported.
    fn check(&mut self, raw_target: &str, verb: &str) {
        if self.hit.is_some() {
            return;
        }

        let t = raw_target.trim();
        if t.is_empty() || is_option_like(t) || is_null_target(t) || is_non_filesystem_drive(t) {
            return;
        }

        let mut expanded = expand_vars(t);
        if expanded.trim().is_empty() {
            return;
        }
        expanded = expanded.trim().to_string();

        // Strip PowerShell's `FileSystem::` provider prefix.
        if expanded.to_lowercase().starts_with("filesystem::") {
            expanded = expanded["filesystem::".len()..].trim().to_string();
        }

        // A variable reference: its value exists only at runtime, so this layer
        // genuinely cannot judge → release (capability boundary).
        if has_unresolved_var(&expanded) {
            return;
        }

        // Wildcard: the target set is unknown, but the **owning directory** is
        // literal → judge that prefix instead. Releasing all wildcards would leave
        // `del D:\out\*.*` — an out-of-workspace bulk delete — completely unguarded.
        if let Some(prefix) = wildcard_prefix(&expanded) {
            // Empty = no directory part before the wildcard (`*.txt`), so it is
            // owned by the current base.
            expanded = if prefix.is_empty() { ".".to_string() } else { prefix };
        }

        let p = Path::new(&expanded);
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.base.join(p)
        };
        let p = lexical_normalize(&p);

        let resolved = real_or_lexical(&p);

        if is_inside(&self.root, &resolved) {
            return;
        }
        for ex in &self.exempts {
            if is_inside(ex, &resolved) {
                return;
            }
        }

        self.hit = Some(Verdict {
            target: resolved.to_string_lossy().into_owned(),
            verb: verb.to_string(),
            write: self.write_mode,
        });
    }

    /// Resolve a target to an absolute real path (for [`Scan::apply_cd`]).
    ///
    /// The symlink defence is structurally identical to
    /// `TerminalSupport.resolveSafePath`: canonicalise when the target exists,
    /// otherwise "the real path of the nearest existing ancestor plus the
    /// remaining lexical segments". Without it, a symlink inside the workspace
    /// pointing at `D:\` disguises an out-of-workspace write as an in-workspace
    /// one.
    fn resolve(&self, raw_target: &str) -> Option<PathBuf> {
        let expanded = expand_vars(raw_target.trim());
        let expanded = expanded.trim();
        if expanded.is_empty() || is_unjudgeable(expanded) {
            return None;
        }
        let p = Path::new(expanded);
        let p = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.base.join(p)
        };
        Some(real_or_lexical(&lexical_normalize(&p)))
    }
}

fn is_tar_verb(key: &str) -> bool {
    key.starts_with("tar") || key == "gtar" || key == "bsdtar"
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Test fixture.
    ///
    /// **Deliberately not `std::env::temp_dir()`**: the temp directory is the
    /// first entry of [`default_exempt_roots`], so a workspace built under it
    /// would have its "outside" targets land inside the temp tree too and be
    /// released by the exemption — every test would pass while the guard does
    /// nothing. The Java suite has the same constraint
    /// (`BashPathGuardTest.java:49-55`) and builds under the module's `target/`.
    struct Fixture {
        holder: PathBuf,
        workspace: PathBuf,
        outside: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let holder = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(format!("bpg-test-{}", nanos));
            let workspace = holder.join("ws");
            let outside = holder.join("outside");
            std::fs::create_dir_all(workspace.join("src")).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            Self { holder, workspace, outside }
        }

        /// An absolute path outside the workspace.
        fn out(&self, rel: &str) -> String {
            self.outside.join(rel).to_string_lossy().into_owned()
        }

        fn inspect(&self, cmd: &str) -> Option<Verdict> {
            inspect(cmd, &self.workspace, &[])
        }

        fn blocked(&self, cmd: &str) {
            assert!(
                self.inspect(cmd).is_some(),
                "expected a verdict (command should be gated): {}",
                cmd
            );
        }

        fn blocked_write(&self, cmd: &str) {
            let v = self.inspect(cmd);
            assert!(v.is_some(), "expected a WRITE verdict, got none: {}", cmd);
            assert!(
                v.as_ref().unwrap().is_write(),
                "understated the risk — expected a WRITE verdict, got a READ: {} ({})",
                cmd,
                v.unwrap()
            );
        }

        fn blocked_read(&self, cmd: &str) {
            let v = self.inspect(cmd);
            assert!(v.is_some(), "expected a READ verdict, got none: {}", cmd);
            assert!(
                !v.as_ref().unwrap().is_write(),
                "overstated the risk — expected a READ verdict, got a WRITE: {} ({})",
                cmd,
                v.unwrap()
            );
        }

        fn released(&self, cmd: &str) {
            assert!(
                self.inspect(cmd).is_none(),
                "false positive — expected no verdict for: {} (got {})",
                cmd,
                self.inspect(cmd).unwrap()
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.holder);
        }
    }

    // ── 1. PowerShell writes outside the workspace ─────────────────────────

    #[test]
    fn blocks_powershell_writes_outside_workspace() {
        let f = Fixture::new();
        f.blocked_write(&format!("Set-Content {} x", f.out("f.txt")));
        f.blocked_write(&format!("Add-Content {} x", f.out("f.txt")));
        f.blocked_write(&format!("Out-File -FilePath {}", f.out("f.txt")));
        f.blocked_write(&format!("New-Item -Path {}", f.out("d")));
        f.blocked_write(&format!("Remove-Item {}", f.out("f.txt")));
        f.blocked_write(&format!("Copy-Item a.txt -Destination {}", f.out("f.txt")));
        f.blocked_write(&format!("Move-Item a.txt {}", f.out("f.txt")));
        f.blocked_write(&format!("Rename-Item -Path {}", f.out("f.txt")));
    }

    // ── 2. Unix-style writes outside the workspace ─────────────────────────

    #[test]
    fn blocks_unix_style_writes_outside_workspace() {
        let f = Fixture::new();
        f.blocked_write(&format!("rm -rf {}", f.out("d")));
        f.blocked_write(&format!("cp a.txt {}", f.out("f.txt")));
        f.blocked_write(&format!("mv a.txt {}", f.out("f.txt")));
        f.blocked_write(&format!("mkdir {}", f.out("d")));
        f.blocked_write(&format!("touch {}", f.out("f.txt")));
        f.blocked_write(&format!("tee {}", f.out("f.txt")));
        f.blocked_write(&format!("truncate -s0 {}", f.out("f.txt")));
        f.blocked_write(&format!("dd if=a.bin of={}", f.out("x.bin")));
        f.blocked_write(&format!("sed -i s/a/b/ {}", f.out("f.txt")));
    }

    // ── 3. Escaping via a parent directory ─────────────────────────────────

    /// The easiest shape to miss: no drive letter, looks like an in-workspace
    /// operation, but `..` walks out.
    #[test]
    fn blocks_escaping_via_parent_directory() {
        let f = Fixture::new();
        f.blocked("rm -rf ../ws-sibling");
        f.blocked("cp a.txt ../../escape.txt");
        f.blocked("echo x > ../outside.txt");
        // PowerShell accepts both separators on Windows, but on Unix a backslash
        // is an ordinary filename character: `..\..\f.txt` is then a single
        // in-workspace name with no `..` component, so the guard correctly
        // releases it and the old Windows-only expectation went red on the
        // Linux CI gate. Keep the Windows spelling on Windows and use the POSIX
        // spelling elsewhere — the "write verb + parent escape" case stays
        // covered on both.
        let ps_escape = if cfg!(windows) {
            "Set-Content ..\\..\\f.txt x"
        } else {
            "Set-Content ../../f.txt x"
        };
        f.blocked(ps_escape);
    }

    // ── 4. Redirection, independent of the verb table ──────────────────────

    #[test]
    fn blocks_redirection_regardless_of_verb() {
        let f = Fixture::new();
        f.blocked_write(&format!("echo hacked > {}", f.out("f.txt")));
        f.blocked_write(&format!("echo hacked >> {}", f.out("f.txt")));
        // `node` and `mvn` are in no verb table; the redirection still writes out.
        f.blocked_write(&format!("node build.js > {}", f.out("log.txt")));
        f.blocked_write(&format!("mvn test 2> {}", f.out("err.txt")));
        f.blocked_write(&format!("Get-Process | Out-File {}", f.out("p.txt")));
    }

    #[test]
    fn blocks_input_redirection_independently_of_verb_table() {
        let f = Fixture::new();
        // psql / sqlite3 / jq are in no verb table — assert that first, otherwise
        // the test could pass for the wrong reason (the verb table catching it).
        for v in ["psql", "sqlite3", "jq"] {
            assert!(!is_known_verb(v), "{} must not be in any verb table", v);
        }
        f.blocked_read(&format!("psql < {}", f.out("dump.sql")));
        f.blocked_read(&format!("sqlite3 db < {}", f.out("s.sql")));
        f.blocked_read(&format!("jq . < {}", f.out("d.json")));
    }

    // ── 5. Windows backslash paths are not mangled ─────────────────────────

    /// The Windows life-or-death case: a backslash must not be eaten as a Unix
    /// escape, and a quoted path containing spaces must stay in one piece.
    #[test]
    fn windows_backslash_paths_are_not_mangled() {
        let f = Fixture::new();
        let target = f.out("sub\\f.txt");
        f.blocked_write(&format!("Set-Content {} x", target));
        f.blocked_write(&format!("Set-Content \"{}\" x", target));
        // Forward slashes must work too.
        let fwd = f.out("sub/f.txt").replace('\\', "/");
        f.blocked_write(&format!("Set-Content {} x", fwd));
        // The reported target must retain the path structure — otherwise the
        // block might have happened for an unrelated reason (a false green).
        let v = f.inspect(&format!("Set-Content {} x", target)).unwrap();
        assert!(
            v.target().contains("sub"),
            "target lost its path structure: {}",
            v.target()
        );
    }

    #[test]
    fn quoted_path_with_spaces_stays_intact() {
        let f = Fixture::new();
        let dir = f.outside.join("Program Files").join("app");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("x.txt").to_string_lossy().into_owned();
        f.blocked_write(&format!("Set-Content \"{}\" x", target));
    }

    // ── 6. Writes hidden inside shell wrappers ─────────────────────────────

    #[test]
    fn blocks_writes_hidden_inside_shell_wrappers() {
        let f = Fixture::new();
        let t = f.out("f.txt");
        f.blocked_write(&format!("sh -c \"rm -rf {}\"", f.out("d")));
        f.blocked_write(&format!("bash -c 'cp a.txt {}'", t));
        f.blocked_write(&format!("powershell -Command \"Set-Content {} x\"", t));
        f.blocked_write(&format!("cmd /c copy a.txt {}", t));
        f.blocked_write(&format!("sudo tee {}", t));
        f.blocked_write(&format!("wsl -d Ubuntu rm -rf {}", f.out("d")));
        f.blocked_write(&format!("nohup sh -c \"rm -rf {}\" &", f.out("d")));
    }

    // ── 7. Base64-encoded PowerShell command ───────────────────────────────

    /// The most covert bypass: the content cannot be eyeballed.
    #[test]
    fn blocks_base64_encoded_powershell_command() {
        use base64::Engine;
        let f = Fixture::new();
        let cmd = format!("Set-Content {} x", f.out("f.txt"));
        let utf16: Vec<u8> = cmd
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&utf16);
        f.blocked_write(&format!("powershell -EncodedCommand {}", b64));
        f.blocked_write(&format!("powershell -enc {}", b64));
    }

    #[test]
    fn encoded_command_decode_failure_releases_rather_than_errors() {
        // Java returns null (release) on a decode failure: -EncodedCommand is
        // common in legitimate ops scripts, so a hard block would false-positive.
        assert_eq!(decode_encoded_command("!!!not base64!!!"), None);
        assert_eq!(decode_encoded_command(""), None);
        assert_eq!(decode_encoded_command("   "), None);
    }

    // ── 8. .NET static-method calls ────────────────────────────────────────

    #[test]
    fn blocks_dotnet_static_write_calls() {
        let f = Fixture::new();
        let t = f.out("f.txt");
        f.blocked_write(&format!("[System.IO.File]::WriteAllText(\"{}\", $c)", t));
        f.blocked_write(&format!("[System.IO.File]::WriteAllBytes('{}', $b)", t));
        f.blocked_write(&format!("[System.IO.File]::Delete(\"{}\")", t));
        f.blocked_write(&format!("[System.IO.Directory]::CreateDirectory(\"{}\")", f.out("d")));
        f.blocked_write(&format!("[IO.File]::AppendAllText(\"{}\", $c)", t));
    }

    #[test]
    fn blocks_dotnet_read_calls() {
        let f = Fixture::new();
        let t = f.out("f.txt");
        f.blocked_read(&format!("[System.IO.File]::ReadAllText(\"{}\")", t));
        f.blocked_read(&format!("[System.IO.File]::ReadAllBytes(\"{}\")", t));
        f.blocked_read(&format!("[System.IO.File]::ReadAllLines(\"{}\")", t));
        f.blocked_read(&format!("[IO.File]::Exists(\"{}\")", t));
        f.blocked_read(&format!("[System.IO.Directory]::GetFiles(\"{}\")", f.outside.display()));
    }

    // ── 9. cd changes the relative base ────────────────────────────────────

    #[test]
    fn blocks_after_cd_changes_relative_base() {
        let f = Fixture::new();
        let out = f.outside.to_string_lossy().into_owned();
        f.blocked_write(&format!("cd {}; Set-Content f.txt x", out));
        f.blocked_write(&format!("Set-Location {}; echo x > f.txt", out));
        f.blocked_write(&format!("pushd {}; New-Item f.txt", out));
        f.blocked_write(&format!("cd {} && rm -rf .", out));
        // Inside the workspace, a relative write stays released.
        f.released("cd src; Set-Content f.txt x");
    }

    // ── 10. Wildcards are judged by their owning directory ─────────────────

    #[test]
    fn wildcard_targets_are_judged_by_their_owning_directory() {
        let f = Fixture::new();
        f.blocked_write(&format!("Remove-Item {}\\* -Recurse -Force", f.outside.display()));
        f.blocked_write(&format!("del {}\\*.*", f.outside.display()));
        f.blocked_read(&format!("cat {}\\*.txt", f.outside.display()));
        f.blocked_write(&format!("rm -rf {}/sub/*", f.outside.display().to_string().replace('\\', "/")));
        // In-workspace wildcards must not be blocked.
        f.released("cat src/*.java");
        f.released("rm -rf build/*");
        f.released("ls *.md");
    }

    #[test]
    fn wildcard_prefix_handles_the_drive_root_trap() {
        // `D:\*` must cut to `D:\` (absolute), not `D:` (drive-relative, which
        // would resolve against the base directory). A correct verdict that
        // depends on that coincidence is a defect.
        assert_eq!(wildcard_prefix(r"D:\*").as_deref(), Some(r"D:\"));
        assert_eq!(wildcard_prefix(r"D:\out\*.*").as_deref(), Some(r"D:\out"));
        assert_eq!(wildcard_prefix("*.txt").as_deref(), Some(""));
        assert_eq!(wildcard_prefix("/*.txt").as_deref(), Some("/"));
        assert_eq!(wildcard_prefix("/a/b/*.txt").as_deref(), Some("/a/b"));
        assert_eq!(wildcard_prefix("plain.txt"), None);
    }

    // ── 11. Prefix modifiers are unwrapped, not skipped ────────────────────

    /// The proven P0 bypass: 8 declared members fell through to "do nothing".
    #[test]
    fn prefix_modifiers_are_unwrapped_not_skipped() {
        let f = Fixture::new();
        let t = f.out("f.txt");
        // Write side.
        f.blocked_write(&format!("nohup Set-Content {} x", t));
        f.blocked_write(&format!("time cp a.txt {}", t));
        f.blocked_write(&format!("nice mv a.txt {}", t));
        f.blocked_write(&format!("setsid mv a.txt {}", t));
        f.blocked_write(&format!("ionice dd if=a of={}", t));
        f.blocked_write(&format!("eval \"Set-Content {} x\"", t));
        f.blocked_write(&format!("nohup Remove-Item {}", t));
        // Read side.
        f.blocked_read(&format!("nohup cat {}", t));
        f.blocked_read(&format!("time head {}", t));
        f.blocked_read(&format!("stdbuf -oL cat {}", t));
        f.blocked_read(&format!("exec cat {}", t));
        // A modifier's own options must not disturb payload location: `5` is not
        // an option, so "skip options" alone would take it as the command.
        f.blocked_write(&format!("nice -n 5 mv a.txt {}", t));
        f.blocked_write(&format!("stdbuf -oL tee {}", t));
        // Stacked prefixes.
        f.blocked_write(&format!("nohup sudo mv a.txt {}", t));
        f.blocked_read(&format!("stdbuf -oL nohup cat {}", t));
    }

    #[test]
    fn every_declared_wrapper_is_actually_handled() {
        // The direct anti-regression guard for the P0 bypass: for every declared
        // wrapper member, at least one of the five payload shapes must produce a
        // verdict. A member that reaches a "do nothing" branch fails here.
        let f = Fixture::new();
        let t = f.out("f.txt");
        let d = f.out("dir");
        let script = f.out("x.sh");

        let mut unhandled: Vec<&str> = Vec::new();
        for w in COMMAND_WRAPPERS.iter().chain(PREFIX_MODIFIERS.iter()) {
            let shapes = [
                format!("{} Set-Content {} x", w, t),
                format!("{} -c \"rm -rf {}\"", w, d),
                format!("{} /c copy a.txt {}", w, t),
                format!("{} -Command \"Set-Content {} x\"", w, t),
                format!("{} {}", w, script),
            ];
            let handled = shapes.iter().any(|cmd| f.inspect(cmd).is_some());
            if !handled {
                unhandled.push(w);
            }
        }
        assert!(
            unhandled.is_empty(),
            "these declared wrappers fall through without being checked (a bypass): {:?}",
            unhandled
        );
    }

    // ── 12. Out-of-workspace script files are blocked as reads ─────────────

    #[test]
    fn out_of_workspace_script_files_are_blocked_as_reads() {
        let f = Fixture::new();
        let s = f.out("x.sh");
        let ps = f.out("x.ps1");
        let bat = f.out("x.bat");
        for w in ["bash", "sh", "zsh", "source", "."] {
            f.blocked_read(&format!("{} {}", w, s));
        }
        f.blocked_read(&format!("powershell -File {}", ps));
        f.blocked_read(&format!("cmd /c {}", bat));
        f.blocked_read(&format!("nohup {}", s));
        f.blocked_read(&format!("setsid {}", s));
        f.blocked_read(&format!("time {}", s));
        // In-workspace scripts must not be blocked.
        f.released("bash scripts/build.sh");
        f.released("nohup ./build.sh");
    }

    /// The killer case: reporting the whole payload string would produce a path
    /// with two drive colons, which Java's `Paths.get` rejects → silent release.
    /// Mutation M13 survived until this assertion was added.
    #[test]
    fn script_with_arguments_reports_the_first_word_only() {
        let f = Fixture::new();
        let bat = f.out("x.bat");
        let log = f.out("logs/a.txt");
        let v = f.inspect(&format!("cmd /c {} {}", bat, log));
        assert!(v.is_some(), "script with arguments must still be caught");
        let target = v.unwrap().target;
        assert!(
            !target.contains(' ') || target.ends_with("x.bat"),
            "must report the script path, not the whole argument string: {}",
            target
        );
    }

    // ── 13. Normal workflows are not over-blocked ──────────────────────────

    #[test]
    fn does_not_over_block_normal_workflows() {
        let f = Fixture::new();
        // Build and VCS tools are in no verb table — assert it, otherwise the
        // releases below could pass for the wrong reason.
        for v in ["mvn", "npm", "git", "cargo", "python", "node", "pip", "yarn", "pnpm"] {
            assert!(!is_known_verb(v), "{} must not be in any verb table", v);
        }
        f.released("mvn -q test");
        f.released("npm install");
        f.released("git status");
        f.released("cargo build --release");
        f.released("python script.py");
        f.released("node index.js");
        f.released("ls -la");
        f.released("echo hello | grep h");
        f.released("Set-Content src/a.txt x");
        f.released("rm -rf build");

        // The part that actually has teeth: a high-frequency command carrying an
        // out-of-workspace absolute path argument must still be released, because
        // the verb is in no table. Relative-path arguments would be released even
        // if the verb were wrongly registered, so only these prove the point
        // (mutation R8 survived on the relative-path forms alone).
        f.released(&format!("mvn -f {} test", f.out("pom.xml")));
        f.released(&format!("npm --prefix {} install", f.out("pkg")));
        f.released(&format!("git --git-dir={} status", f.out("repo.git")));
        f.released(&format!("cargo build --manifest-path {}", f.out("Cargo.toml")));
        f.released(&format!("python {}", f.out("helper.py")));
        f.released(&format!("node {}", f.out("tool.js")));
    }

    // ── 14. Harmless forms that look like paths ────────────────────────────

    #[test]
    fn releases_harmless_forms_that_look_like_paths() {
        let f = Fixture::new();
        // CMD short options: `/s` is not `D:\s`. Without the exclusion, Windows
        // would false-positive on a large scale.
        f.released("rd /s /q build\\out");
        f.released("del /f /q target\\*");
        f.released("copy /y a.txt b.txt");
        f.released("robocopy src dst /E /NFL /NDL /NJH /NJS");
        // Null devices and fd dups.
        f.released("echo x > /dev/null");
        f.released("cmd 2>&1");
        f.released("cmd 2>/dev/null");
        // Non-filesystem drives.
        f.released("Set-Item HKLM:\\SOFTWARE\\X v");
        f.released("Get-ChildItem Env:FOO");
        f.released("Get-ChildItem Cert:\\CurrentUser\\My");
        // In-workspace wildcard.
        f.released("Remove-Item -Path *.tmp");
    }

    #[test]
    fn cmd_short_option_pattern_is_limited_to_two_letters() {
        // Limited to 1-2 letters precisely so it does not swallow `/tmp` or
        // `/var`, which are real Unix directories.
        assert!(CMD_SHORT_OPTION.is_match("/s"));
        assert!(CMD_SHORT_OPTION.is_match("/q"));
        assert!(!CMD_SHORT_OPTION.is_match("/tmp"));
        assert!(!CMD_SHORT_OPTION.is_match("/var"));
        assert!(!CMD_SHORT_OPTION.is_match("/usr/bin/rm"));
    }

    // ── 15. Non-path parameter values ──────────────────────────────────────

    #[test]
    fn releases_non_path_parameter_values() {
        let f = Fixture::new();
        // The text being written into a file is not a target path. Without
        // skipParams, `-Value "D:\out\notapath.txt"` would be judged as one.
        f.released(&format!("Set-Content -Path src/x.txt -Value \"{}\"", f.out("notapath.txt")));
        f.released("Set-Content -Path src/x.txt -Encoding UTF8");
        f.released("Out-File -FilePath src/x.txt -Width 200");
        f.released(&format!("New-Item -Path src/x -Value {}", f.out("v")));
        // Verbs in no table at all.
        f.released(&format!("Write-Host {}", f.out("justtext")));
        f.released(&format!("echo {}", f.out("justtext")));
    }

    // ── 16. Unjudgeable targets vs resolvable variables ────────────────────

    /// A pair of opposite guards that must both hold.
    #[test]
    fn releases_unjudgeable_targets() {
        let f = Fixture::new();
        // A variable whose value exists only at runtime: this layer cannot judge.
        f.released(&format!("d=\"{}\"; Set-Content \"$d/f.txt\" x", f.outside.display()));
        f.released("Set-Content $target x");
        f.released("Set-Content $env:SOMEDIR_UNSET_PROBE\\f.txt x");
        f.released("Set-Content %SOMEDIR_UNSET_PROBE%\\f.txt x");
    }

    #[test]
    fn expands_resolvable_environment_variables() {
        let f = Fixture::new();
        // If "unknown → release" were over-implemented as "every $env:/%VAR% →
        // release", then `$env:USERPROFILE\Documents\x.txt` would be a complete
        // bypass — and it is one of the most common absolute-path spellings in
        // PowerShell.
        if std::env::var("USERPROFILE").is_ok() {
            f.blocked_write("Set-Content $env:USERPROFILE\\bpg-probe-outside.txt x");
            f.blocked_write("copy a.txt %USERPROFILE%\\bpg-probe-outside.txt");
        }
        // A build cache under the same variable must still be exempt.
        if std::env::var("USERPROFILE").is_ok() {
            f.released("Set-Content $env:USERPROFILE\\.cargo\\config x");
        }
    }

    // ── 17. Write takes priority when both hit ─────────────────────────────

    #[test]
    fn write_takes_priority_when_both_hit() {
        let f = Fixture::new();
        // A single pass reporting "whoever appears first" would call the first
        // two reads: the user would think they are only looking at a file, approve
        // casually, and actually overwrite something outside.
        f.blocked_write(&format!("cat /etc/hosts > {}", f.out("dump.txt")));
        f.blocked_write(&format!("grep x {} > {}", f.out("a.txt"), f.out("b.txt")));
        f.blocked_read(&format!("cat {} > ./local.txt", f.out("a.txt")));
    }

    // ── 18. Gate flags and pattern-vs-path positionals ─────────────────────

    #[test]
    fn sed_and_find_gate_on_their_write_flag() {
        let f = Fixture::new();
        let t = f.out("f.txt");
        // In-workspace: both forms released.
        f.released("sed s/a/b/ src/x.txt");
        f.released("sed -i s/a/b/ src/x.txt");
        // Out-of-workspace: without -i it is a read, with -i a write. The
        // inverted gate sense is what makes both correct.
        f.blocked_read(&format!("sed s/a/b/ {}", t));
        f.blocked_write(&format!("sed -i s/a/b/ {}", t));
        let d = f.outside.to_string_lossy().into_owned();
        f.blocked_read(&format!("find {} -name foo", d));
        f.blocked_write(&format!("find {} -name foo -delete", d));
    }

    #[test]
    fn pattern_is_not_treated_as_a_read_target() {
        let f = Fixture::new();
        // The pattern merely looks like an absolute path; the file being searched
        // is inside. Mode::All would report this.
        f.released(&format!("grep \"{}\" src/a.txt", f.out("x.txt")));
        f.released(&format!("Select-String \"{}\" src/a.txt", f.out("log.txt")));
        f.released(&format!("findstr \"{}\" src\\a.txt", f.out("x.txt")));
        // The real out-of-workspace file must still be caught.
        f.blocked_read(&format!("grep foo {}", f.out("a.txt")));
        f.blocked_read(&format!("Select-String foo {}", f.out("a.txt")));
        // …and the verb is genuinely registered (otherwise the block above could
        // have come from somewhere else).
        assert!(is_known_verb("select-string"));
    }

    // ── 19. Special verbs ──────────────────────────────────────────────────

    #[test]
    fn blocks_archive_and_download_targets_outside() {
        let f = Fixture::new();
        f.blocked_write(&format!("tar -czf {} src", f.out("a.tgz")));
        f.blocked_write(&format!("tar -xzf a.tgz -C {}", f.out("dir")));
        f.blocked_write(&format!("curl -o {} http://x/y", f.out("f.bin")));
        f.blocked_write(&format!("wget -O {} http://x/y", f.out("f.bin")));
        f.blocked_read(&format!("dd if={} of=local.bin", f.out("a.bin")));
    }

    #[test]
    fn tar_create_and_extract_are_case_sensitive() {
        // `-C` is --directory (the extraction target); `-c` is create. Adding
        // (?i) conflates them and turns "read an archive and extract it" into
        // "write an archive".
        assert!(TAR_CREATE.find("tar -czf x.tgz src").ok().flatten().is_some());
        assert!(TAR_CREATE.find("tar -cf x.tar src").ok().flatten().is_some());
        assert!(TAR_CREATE.find("tar --create -f x.tar src").ok().flatten().is_some());
        assert!(TAR_CREATE.find("tar -C dir -xf a.tgz").ok().flatten().is_none());
        assert!(TAR_EXTRACT.find("tar -xzf a.tgz").ok().flatten().is_some());
        assert!(TAR_EXTRACT.find("tar --extract -f a.tgz").ok().flatten().is_some());
        assert!(TAR_EXTRACT.find("tar -czf x.tgz src").ok().flatten().is_none());
    }

    // ── 20. Structural guards ──────────────────────────────────────────────

    #[test]
    fn verb_tables_have_no_duplicate_keys() {
        // A duplicate key in Java's HashMap silently overwrote the earlier entry:
        // no compile error, no runtime error, and behaviour tests could stay
        // green. `select-string` was actually clobbered that way.
        for (name, table) in [("WRITE_RULES", &*WRITE_RULES), ("READ_RULES", &*READ_RULES)] {
            let mut seen: HashMap<&str, usize> = HashMap::new();
            for (k, _) in table.iter() {
                *seen.entry(k).or_insert(0) += 1;
            }
            let dups: Vec<&&str> = seen.iter().filter(|(_, n)| **n > 1).map(|(k, _)| k).collect();
            assert!(dups.is_empty(), "{} has duplicate keys: {:?}", name, dups);
            // Self-check against a false green from an empty extraction.
            assert!(table.len() >= 40, "{} looks too small ({}), extraction may be broken", name, table.len());
        }
    }

    #[test]
    fn literal_arrays_have_no_duplicates() {
        // Hit twice in the Java repo: `select-string`, and `"registry::"` inside
        // PS_DRIVE_PREFIXES.
        let arrays: Vec<(&str, &[&str])> = vec![
            ("PS_NON_PATH_PARAMS", PS_NON_PATH_PARAMS),
            ("PS_PATH_PARAMS", PS_PATH_PARAMS),
            ("SPECIAL_VERBS", SPECIAL_VERBS),
            ("CD_VERBS", CD_VERBS),
            ("COMMAND_WRAPPERS", COMMAND_WRAPPERS),
            ("PREFIX_MODIFIERS", PREFIX_MODIFIERS),
            ("WRAPPER_PAYLOAD_FLAGS", WRAPPER_PAYLOAD_FLAGS),
            ("SCRIPT_PAYLOAD_FLAGS", SCRIPT_PAYLOAD_FLAGS),
            ("ENCODED_FLAGS", ENCODED_FLAGS),
            ("VALUE_FLAGS", VALUE_FLAGS),
            ("SCRIPT_EXTENSIONS", SCRIPT_EXTENSIONS),
            ("PS_DRIVE_PREFIXES", PS_DRIVE_PREFIXES),
            ("NULL_TARGETS", NULL_TARGETS),
            ("HOME_CACHE_DIRS", HOME_CACHE_DIRS),
        ];
        let mut total = 0usize;
        for (name, arr) in arrays {
            let mut seen: HashMap<&str, usize> = HashMap::new();
            for item in arr {
                *seen.entry(*item).or_insert(0) += 1;
            }
            let dups: Vec<&&str> = seen.iter().filter(|(_, n)| **n > 1).map(|(k, _)| k).collect();
            assert!(dups.is_empty(), "{} has duplicate entries: {:?}", name, dups);
            total += arr.len();
        }
        assert!(total >= 60, "literal arrays total {} — extraction may be broken", total);
    }

    #[test]
    fn write_table_covers_both_dialects_and_aliases() {
        for verb in [
            "rm", "del", "remove-item", "ri", "cp", "copy-item", "mv", "move-item",
            "mkdir", "md", "new-item", "set-content", "add-content", "out-file",
            "tee", "robocopy", "unzip", "sed", "touch", "rd", "rmdir",
        ] {
            assert!(
                lookup_rule(&WRITE_RULES, verb).is_some(),
                "write table is missing {}",
                verb
            );
        }
        // `sc` is ambiguous (PS Set-Content alias / Windows service controller /
        // Unix spreadsheet). Registering it would take the UNC host in
        // `sc \\server config svc` as a write target.
        assert!(
            lookup_rule(&WRITE_RULES, "sc").is_none(),
            "`sc` must stay out of the write table (UNC host false positive)"
        );
    }

    // ── 21. Boundary semantics ─────────────────────────────────────────────

    #[test]
    fn distinguishes_a_sibling_with_the_same_string_prefix() {
        // `D:\work\gourdai2` has `D:\work\gourdai` as a *string* prefix but is not
        // inside it. A string comparison would wrongly release it.
        let root = if cfg!(windows) { Path::new(r"D:\work\gourdai") } else { Path::new("/work/gourdai") };
        let sibling = if cfg!(windows) { Path::new(r"D:\work\gourdai2\f.txt") } else { Path::new("/work/gourdai2/f.txt") };
        let child = if cfg!(windows) { Path::new(r"D:\work\gourdai\src\f.txt") } else { Path::new("/work/gourdai/src/f.txt") };
        assert!(!is_inside(root, sibling), "string-prefix sibling must not count as inside");
        assert!(is_inside(root, child));
        assert!(is_inside(root, root), "the root itself is inside");
    }

    #[test]
    fn no_verdict_for_an_empty_command() {
        let f = Fixture::new();
        assert_eq!(inspect("", &f.workspace, &[]), None);
        assert_eq!(inspect("   ", &f.workspace, &[]), None);
        assert_eq!(inspect("\n\n", &f.workspace, &[]), None);
    }

    #[test]
    fn exemptions_apply_to_reads_as_well_as_writes() {
        // Exempting only writes would make `cat ~/.m2/settings.xml` — an ordinary
        // build-chain read — prompt on every run. Java mutation R9 changed this to
        // write-only and the equivalent test went red.
        let f = Fixture::new();
        let exempt = f.outside.join("cache");
        std::fs::create_dir_all(&exempt).unwrap();
        let target = exempt.join("settings.xml").to_string_lossy().into_owned();
        let exempts = vec![exempt.clone()];

        let w = inspect(&format!("Set-Content {} x", target), &f.workspace, &exempts);
        assert!(w.is_none(), "exempt directory must not be reported as a write");
        let r = inspect(&format!("cat {}", target), &f.workspace, &exempts);
        assert!(r.is_none(), "exempt directory must not be reported as a read either");
    }

    #[test]
    fn exemption_covers_subdirectories_but_does_not_leak() {
        let f = Fixture::new();
        let exempt = f.outside.join("cache");
        std::fs::create_dir_all(exempt.join("deep")).unwrap();
        let sibling = f.outside.join("sibling");
        std::fs::create_dir_all(&sibling).unwrap();
        let exempts = vec![exempt.clone()];

        // Subdirectories are covered (prefix semantics).
        let deep = exempt.join("deep").join("f.txt").to_string_lossy().into_owned();
        assert!(inspect(&format!("Set-Content {} x", deep), &f.workspace, &exempts).is_none());
        // A sibling is not.
        let sib = sibling.join("f.txt").to_string_lossy().into_owned();
        assert!(inspect(&format!("Set-Content {} x", sib), &f.workspace, &exempts).is_some());
    }

    #[test]
    fn user_configured_exemption_is_honoured() {
        let f = Fixture::new();
        let exempt = f.outside.join("mine");
        std::fs::create_dir_all(&exempt).unwrap();
        let target = exempt.join("f.txt").to_string_lossy().into_owned();
        // Without the exemption it is blocked…
        assert!(inspect(&format!("Set-Content {} x", target), &f.workspace, &[]).is_some());
        // …with it, released.
        let exempts = resolve_exempt_dirs(&[exempt.to_string_lossy().into_owned()]);
        assert_eq!(exempts.len(), 1);
        assert!(inspect(&format!("Set-Content {} x", target), &f.workspace, &exempts).is_none());
    }

    #[test]
    fn resolve_exempt_dirs_is_tolerant_and_never_panics() {
        // A shorter exemption list only makes the gate stricter, so invalid
        // entries are skipped rather than fatal.
        let out = resolve_exempt_dirs(&[
            "".into(),
            "   ".into(),
            "$env:SOMEDIR_UNSET_PROBE\\x".into(), // unresolvable → dropped
            "%SOMEDIR_UNSET_PROBE%\\x".into(),    // unresolvable → dropped
            "*.txt".into(),                       // wildcard → dropped
        ]);
        assert!(out.is_empty(), "unjudgeable entries must be dropped, got {:?}", out);

        let home = resolve_exempt_dirs(&["~".into(), "~/x".into()]);
        if home_dir().is_some() {
            assert_eq!(home.len(), 2, "tilde forms must expand");
            assert!(home.iter().all(|p| p.is_absolute()));
        }
    }

    #[test]
    fn default_exempt_roots_exclude_credential_directories() {
        // Only caches and rebuildable artefacts. ~/.ssh, ~/.aws, ~/.config and
        // ~/.kube carry credentials or user configuration: reading *or* writing
        // them should prompt.
        let roots = default_exempt_roots();
        assert!(!roots.is_empty());
        let as_strings: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        for forbidden in [".ssh", ".aws", ".kube"] {
            assert!(
                !as_strings.iter().any(|r| r.ends_with(forbidden)),
                "{} must not be an exempt root",
                forbidden
            );
        }
        // And the caches that must be there.
        assert!(as_strings.iter().any(|r| r.ends_with(".cargo")));
        assert!(as_strings.iter().any(|r| r.ends_with(".m2")));
    }

    #[test]
    fn blocks_writes_into_user_data_under_home() {
        // The converse of the exemption test: home is outside the workspace and
        // is not exempt, so writing user data there is gated.
        let f = Fixture::new();
        if let Some(home) = home_dir() {
            let target = home.join("Documents").join("bpg-probe.txt");
            let cmd = format!("Set-Content {} x", target.to_string_lossy());
            assert!(f.inspect(&cmd).is_some(), "writing into ~/Documents must be gated");
        }
    }

    // ── 22. Lexer unit tests ───────────────────────────────────────────────

    #[test]
    fn tokenize_keeps_windows_backslashes_verbatim() {
        let toks = tokenize(r#"Set-Content "D:\other\x.txt" x"#);
        let words: Vec<&str> = toks
            .iter()
            .filter(|t| t.kind == TokKind::Word)
            .map(|t| t.text.as_str())
            .collect();
        assert_eq!(words, vec!["Set-Content", r"D:\other\x.txt", "x"]);
    }

    #[test]
    fn tokenize_treats_a_semicolon_inside_quotes_as_literal() {
        let toks = tokenize(r#"echo "a;b""#);
        assert!(
            !toks.iter().any(|t| t.kind == TokKind::Sep),
            "a quoted semicolon is not a segment separator"
        );
        let words: Vec<&str> = toks.iter().filter(|t| t.kind == TokKind::Word).map(|t| t.text.as_str()).collect();
        assert_eq!(words, vec!["echo", "a;b"]);
    }

    #[test]
    fn tokenize_classifies_redirection_kinds() {
        let toks = tokenize("cmd 2> out.txt < in.txt");
        let kinds: Vec<TokKind> = toks.iter().map(|t| t.kind).collect();
        assert!(kinds.contains(&TokKind::RedirOut));
        assert!(kinds.contains(&TokKind::RedirIn));
    }

    #[test]
    fn base_name_strips_paths_and_call_operators() {
        assert_eq!(base_name(r"C:\Windows\System32\cmd.exe"), "cmd.exe");
        assert_eq!(base_name("& Set-Content"), "Set-Content");
        assert_eq!(base_name("@splat"), "splat");
        assert_eq!(base_name("/usr/bin/rm"), "rm");
        assert_eq!(base_name("rm"), "rm");
    }

    #[test]
    fn has_flag_recognises_bundled_short_options() {
        let seg = tokenize("sed -i.bak s/a/b/ f.txt");
        assert!(has_flag(&seg, "-i"), "the letter inside a bundle counts (sed -i.bak)");
        let seg2 = tokenize("perl -pi -e x f.txt");
        assert!(has_flag(&seg2, "-i"), "perl -pi bundles i");
        let seg3 = tokenize("sed s/a/b/ f.txt");
        assert!(!has_flag(&seg3, "-i"));
    }

    #[test]
    fn skip_own_options_does_not_swallow_a_unix_command_path() {
        // `/usr/bin/rm` must not be mistaken for a Windows-style option, or the
        // payload loses its verb and is silently released.
        let seg = tokenize("sudo /usr/bin/rm -rf /opt/x");
        let start = skip_own_options(&seg, 1);
        assert_eq!(seg[start].text, "/usr/bin/rm");
        assert!(WINDOWS_OPTION.is_match("/user:Administrator"));
        assert!(!WINDOWS_OPTION.is_match("/usr/bin/rm"));
    }

    #[test]
    fn find_command_start_skips_an_option_value() {
        // `5` carries no `-`, so "skip options" alone would take it as the
        // command; `baseName("5")` matches no rule and the command is released.
        let seg = tokenize("nice -n 5 mv a.txt /out/a.txt");
        let start = find_command_start(&seg, skip_own_options(&seg, 1));
        assert_eq!(seg[start].text, "mv");
    }

    #[test]
    fn find_command_start_returns_the_original_index_for_an_unknown_verb() {
        // `sudo mvn test`: mvn is in no table. Returning the end would give an
        // empty payload and lose the script-file judgement.
        let seg = tokenize("sudo mvn test");
        let from = skip_own_options(&seg, 1);
        assert_eq!(find_command_start(&seg, from), from);
        assert_eq!(seg[from].text, "mvn");
    }

    #[test]
    fn is_script_file_recognises_extensions_and_rejects_wildcards() {
        assert!(is_script_file("build.sh"));
        assert!(is_script_file(r"D:\out\x.ps1"));
        assert!(is_script_file("x.BAT"), "extension match is case-insensitive");
        assert!(!is_script_file("x.txt"));
        assert!(!is_script_file("*.sh"), "a wildcard goes to the wildcard rule");
    }

    #[test]
    fn lexical_normalize_resolves_parent_segments() {
        assert_eq!(lexical_normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(lexical_normalize(Path::new("./a")), PathBuf::from("a"));
        assert_eq!(lexical_normalize(Path::new("../a")), PathBuf::from("../a"));
        if cfg!(windows) {
            // A `..` at the root is dropped, matching Java's normalize.
            assert_eq!(lexical_normalize(Path::new(r"D:\..\foo")), PathBuf::from(r"D:\foo"));
        }
    }

    #[test]
    fn strip_verbatim_removes_the_windows_prefix() {
        // canonicalize returns `\\?\D:\foo`; left in place every comparison
        // against a non-verbatim root fails and everything looks outside.
        if cfg!(windows) {
            assert_eq!(strip_verbatim(PathBuf::from(r"\\?\D:\foo")), PathBuf::from(r"D:\foo"));
            assert_eq!(
                strip_verbatim(PathBuf::from(r"\\?\UNC\server\share")),
                PathBuf::from(r"\\server\share")
            );
        }
        assert_eq!(strip_verbatim(PathBuf::from("/plain/path")), PathBuf::from("/plain/path"));
    }

    #[test]
    fn is_non_filesystem_drive_keeps_real_drives() {
        // A single-letter drive is a filesystem and must reach the boundary check,
        // so that test comes first and the order cannot be swapped.
        assert!(!is_non_filesystem_drive(r"C:\x"));
        assert!(!is_non_filesystem_drive("D:/x"));
        assert!(is_non_filesystem_drive("HKLM:\\SOFTWARE\\X"));
        assert!(is_non_filesystem_drive("Env:FOO"));
        assert!(is_non_filesystem_drive("Cert:\\CurrentUser\\My"));
        assert!(is_non_filesystem_drive("registry::HKEY_LOCAL_MACHINE\\X"));
    }

    #[test]
    fn is_null_target_covers_devices_and_fd_dups() {
        for t in ["/dev/null", "nul", "NUL", "$null", "-", "con", "2>&1", ">&1"] {
            assert!(is_null_target(t), "{} must be treated as a null target", t);
        }
        assert!(!is_null_target("out.txt"));
    }

    #[test]
    fn prefix_modifiers_are_a_subset_of_the_shape_axis_vocabulary() {
        // Duplicated here (shape.rs has the authoritative copy) so this module's
        // own suite fails fast if the list drifts.
        let allowed = [
            "nohup", "time", "nice", "ionice", "stdbuf", "setsid", "eval", "exec",
            "sudo", "doas", "gsudo", "runas", "su", "sh", "bash", "zsh", "ksh",
            "dash", "fish", "ash", "csh", "tcsh", "source", "powershell", "pwsh",
            "cmd", "wsl",
        ];
        for w in prefix_modifiers_for_test() {
            assert!(allowed.contains(&w), "{} is not in the shape axis anchor whitelist", w);
        }
        assert_eq!(prefix_modifiers_for_test().len(), 8);
    }

    #[test]
    fn max_unwrap_depth_bounds_recursion() {
        // A pathological chain of wrappers must terminate rather than overflow.
        let f = Fixture::new();
        let deep = format!("{} Set-Content {} x", "nohup ".repeat(40), f.out("f.txt"));
        let _ = f.inspect(&deep);
    }
}
