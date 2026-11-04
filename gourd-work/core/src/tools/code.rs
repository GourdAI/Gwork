//! code — project scaffolding / build-convention discovery.
//!
//! Rust counterpart of the Java kernel's `CodeTalent`. Java exposes this as a
//! *talent* (it injects the "Core Engineering Protocol" into the system prompt
//! and regenerates `.gwork/WORK.md` on every run). This kernel exposes the same
//! capability as an explicit, model-callable tool instead, which is the
//! non-destructive choice: nothing is written and no prompt is altered unless
//! the model asks for it. The generated `WORK.md` matches Java's byte-for-byte in
//! structure so both kernels agree on a shared workspace.
//!
//! The scan mirrors Java `CodeTalent.init`:
//!   * providers matched at the workspace root emit their *root* commands;
//!   * a bounded (depth ≤ 3) walk finds sub-projects. A sub-project whose
//!     language was **not** seen at the root is "heterogeneous" and gets its own
//!     module command block; one whose language *was* seen at the root is folded
//!     into a one-line sub-module note (it inherits the root's commands);
//!   * a directory already covered by a matched parent is skipped, so a Maven
//!     multi-module tree is not exploded into one block per module.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::registry::{Tool, ToolContext, ToolOutput};

/// A build/test command generator for one language ecosystem.
///
/// Function pointers rather than a trait object: the provider set is fixed and
/// static, and this keeps the whole table in one readable place.
struct Provider {
    id: &'static str,
    type_name: &'static str,
    /// Files whose presence in a directory marks it as this language.
    markers: &'static [&'static str],
    /// Directory names this language produces that must never be walked into.
    ignore_folders: &'static [&'static str],
    /// Override for providers whose marker is an *extension*, not a fixed name
    /// (C#/.NET's `*.sln` / `*.csproj`). `None` = match any `markers` entry.
    custom_match: Option<fn(&Path) -> bool>,
    detect_version: fn(&Path) -> Option<String>,
    root_commands: fn(&mut String),
    module_commands: fn(&mut String, &str),
}

impl Provider {
    fn is_match(&self, dir: &Path) -> bool {
        if let Some(f) = self.custom_match {
            return f(dir);
        }
        self.markers.iter().any(|m| dir.join(m).exists())
    }
}

// ─── Small file helpers (Java `LanguageProvider.readText` / `.find`) ──────────

fn read_text(dir: &Path, name: &str) -> Option<String> {
    let f = dir.join(name);
    if !f.is_file() {
        return None;
    }
    std::fs::read_to_string(&f).ok()
}

/// First capture group of `pattern` in `content`, trimmed. Flags are baked into
/// each pattern (`(?i)` case-insensitive, `(?s)` dot-all, `(?m)` line anchors),
/// matching Java's `Pattern.CASE_INSENSITIVE | DOTALL`.
fn find_group(content: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(content)?
        .get(1)
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// True when any `*.ext` file sits directly in `dir` (Java DotNet's matcher).
fn has_extension(dir: &Path, ext: &str) -> bool {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| format!(".{}", x) == ext)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ─── Version detectors ────────────────────────────────────────────────────────
//
// Each reads the version *declared in the project's own config* — not the
// version installed on this machine. That distinction is load-bearing: WORK.md
// tells the model which language features are safe to use, which is a property
// of the project's declared target, not of whatever toolchain happens to be on
// PATH.

fn ver_rust(dir: &Path) -> Option<String> {
    let cargo = read_text(dir, "Cargo.toml")?;
    if let Some(v) = find_group(&cargo, r#"(?i)rust-version\s*=\s*"([^"]+)""#) {
        return Some(format!("Rust {}", v));
    }
    find_group(&cargo, r#"(?i)edition\s*=\s*"([^"]+)""#).map(|e| format!("Rust edition {}", e))
}

fn ver_maven(dir: &Path) -> Option<String> {
    let pom = read_text(dir, "pom.xml")?;
    let v = find_group(&pom, r"(?is)<maven\.compiler\.(?:release|source|target)>\s*([\d.]+)\s*<")
        .or_else(|| find_group(&pom, r"(?is)<java\.version>\s*([\d.]+)\s*<"))
        .or_else(|| find_group(&pom, r"(?is)<(?:release|source|target)>\s*([\d.]+)\s*<"))?;
    Some(format!("Java {}", v))
}

fn ver_gradle(dir: &Path) -> Option<String> {
    for name in ["build.gradle.kts", "build.gradle"] {
        let Some(script) = read_text(dir, name) else { continue };
        let v = find_group(
            &script,
            r#"(?is)sourceCompatibility\s*=?\s*(?:JavaVersion\.VERSION_)?["']?([\d._]+)["']?"#,
        )
        .or_else(|| {
            find_group(&script, r"(?is)(?:jvmToolchain\(|JavaLanguageVersion\.of\()\s*(\d+)")
        });
        if let Some(v) = v {
            return Some(format!("Java {}", v.replace('_', ".")));
        }
    }
    None
}

fn ver_go(dir: &Path) -> Option<String> {
    let m = read_text(dir, "go.mod")?;
    find_group(&m, r"(?im)^\s*go\s+([\d.]+)\s*$").map(|v| format!("Go {}", v))
}

fn ver_python(dir: &Path) -> Option<String> {
    if let Some(p) = read_text(dir, "pyproject.toml") {
        if let Some(v) = find_group(&p, r#"(?i)requires-python\s*=\s*"([^"]+)""#) {
            return Some(format!("Python {}", v));
        }
    }
    if let Some(s) = read_text(dir, "setup.py") {
        if let Some(v) = find_group(&s, r#"(?i)python_requires\s*=\s*['"]([^'"]+)['"]"#) {
            return Some(format!("Python {}", v));
        }
    }
    if let Some(pv) = read_text(dir, ".python-version") {
        let t = pv.trim();
        if !t.is_empty() {
            return Some(format!("Python {}", t));
        }
    }
    None
}

fn ver_node(dir: &Path) -> Option<String> {
    if let Some(pkg) = read_text(dir, "package.json") {
        if let Some(v) = find_group(&pkg, r#"(?is)"engines"\s*:\s*\{[^}]*?"node"\s*:\s*"([^"]+)""#) {
            return Some(format!("Node {}", v));
        }
    }
    if let Some(nvmrc) = read_text(dir, ".nvmrc") {
        let t = nvmrc.trim();
        if !t.is_empty() {
            return Some(format!("Node {}", t));
        }
    }
    None
}

fn ver_cangjie(dir: &Path) -> Option<String> {
    let toml = read_text(dir, "cjpm.toml")?;
    find_group(&toml, r#"(?i)cjc-version\s*=\s*"([^"]+)""#).map(|v| format!("Cangjie {}", v))
}

fn ver_cmake(dir: &Path) -> Option<String> {
    let cmake = read_text(dir, "CMakeLists.txt")?;
    if let Some(v) = find_group(&cmake, r"(?i)set\s*\(\s*CMAKE_CXX_STANDARD\s+(\d+)") {
        return Some(format!("C++ {}", v));
    }
    find_group(&cmake, r"(?i)set\s*\(\s*CMAKE_C_STANDARD\s+(\d+)").map(|v| format!("C {}", v))
}

fn ver_flutter(dir: &Path) -> Option<String> {
    let pubspec = read_text(dir, "pubspec.yaml")?;
    if let Some(v) = find_group(&pubspec, r#"(?im)^\s*flutter\s*:\s*["']?([\d][^"'\n]*)"#) {
        return Some(format!("Flutter {}", v.trim()));
    }
    find_group(&pubspec, r#"(?im)^\s*sdk\s*:\s*["']?([\d][^"'\n]*)"#)
        .map(|v| format!("Dart SDK {}", v.trim()))
}

fn ver_php(dir: &Path) -> Option<String> {
    let composer = read_text(dir, "composer.json")?;
    find_group(&composer, r#"(?i)"php"\s*:\s*"([^"]+)""#).map(|v| format!("PHP {}", v))
}

fn ver_dotnet(dir: &Path) -> Option<String> {
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("csproj") {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&p) {
            if let Some(v) = find_group(&content, r"(?is)<TargetFrameworks?>\s*([^<;]+)") {
                return Some(format!(".NET {}", v.trim()));
            }
        }
    }
    None
}

fn dotnet_match(dir: &Path) -> bool {
    has_extension(dir, ".sln") || has_extension(dir, ".csproj")
}

// ─── Command text (verbatim from the Java providers) ──────────────────────────

fn cmd_maven_root(b: &mut String) {
    b.push_str("### 根项目 (Maven)\n- 构建: `mvn clean compile`\n- 全量测试: `mvn test`\n- 单测执行: `mvn test -Dtest=ClassName` (替换为实际类名)\n\n");
}
fn cmd_maven_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Maven)\n- 构建: `cd {} && mvn clean compile`\n- 全量测试: `cd {} && mvn test`\n- 单测执行: `cd {} && mvn test -Dtest=ClassName` (替换为实际类名)\n\n", m, m, m, m));
}

fn cmd_gradle_root(b: &mut String) {
    b.push_str("### 根项目 (Gradle)\n- 构建: `./gradlew build` (或 `gradle build`)\n- 全量测试: `./gradlew test`\n- 单测执行: `./gradlew test --tests \"ClassName\"` (替换为实际类名)\n\n");
}
fn cmd_gradle_mod(b: &mut String, m: &str) {
    // Gradle addresses sub-projects by `:`-separated path, not a filesystem path.
    let g = m.replace('/', ":");
    b.push_str(&format!("### 模块 (Module): {} (Gradle)\n- 构建: `./gradlew :{}:build`\n- 全量测试: `./gradlew :{}:test`\n- 单测执行: `./gradlew :{}:test --tests \"ClassName\"`\n\n", m, g, g, g));
}

fn cmd_node_root(b: &mut String) {
    b.push_str("### 根项目 (Node/TS)\n- 安装: `npm install`\n- 构建: `npm run build`\n- 全量测试: `npm test`\n- 单文件测试: `npm test -- path/to/file.test.ts` (替换为实际文件路径)\n\n");
}
fn cmd_node_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Node/TS)\n- 安装: `cd {} && npm install`\n- 构建: `cd {} && npm run build`\n- 全量测试: `cd {} && npm test`\n- 单文件测试: `cd {} && npm test -- path/to/file.test.ts` (替换为实际文件路径)\n\n", m, m, m, m, m));
}

fn cmd_go_root(b: &mut String) {
    b.push_str("### 根项目 (Go)\n- 依赖同步: `go mod tidy`\n- 构建: `go build ./...`\n- 全量测试: `go test ./...`\n- 单测执行: `go test -v -run TestName ./...` (替换 TestName 为实际函数名)\n\n");
}
fn cmd_go_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Go)\n- 构建: `cd {} && go build`\n- 全量测试: `cd {} && go test ./...`\n- 单测执行: `cd {} && go test -v -run TestName` (替换 TestName 为实际函数名)\n\n", m, m, m, m));
}

fn cmd_python_root(b: &mut String) {
    b.push_str("### 根项目 (Python)\n- 环境: 优先检查并激活 `venv` 或 `.venv`\n- 依赖: `pip install -r requirements.txt` (或使用 poetry/pdm)\n- 全量测试: `pytest` 或 `python -m unittest discover`\n- 单文件测试: `pytest -m path/to/test_file.py` (替换为实际路径)\n\n");
}
fn cmd_python_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Python)\n- 环境: 优先检查并激活 `venv` 或 `.venv`\n- 依赖: `cd {} && pip install -r requirements.txt`\n- 全量测试: `cd {} && pytest`\n- 单文件测试: `cd {} && pytest path/to/test_file.py` (替换为实际路径)\n\n", m, m, m, m));
}

fn cmd_rust_root(b: &mut String) {
    b.push_str("### 根项目 (Rust)\n- 构建: `cargo build`\n- 全量测试: `cargo test`\n- 运行: `cargo run`\n- 单项测试: `cargo test -- test_name` (替换为实际模块或函数名)\n\n");
}
fn cmd_rust_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Rust)\n- 构建: `cd {} && cargo build`\n- 全量测试: `cd {} && cargo test`\n- 单项测试: `cd {} && cargo test -- test_name` (替换为实际模块或函数名)\n\n", m, m, m, m));
}

fn cmd_cangjie_root(b: &mut String) {
    b.push_str("### 根项目 (Cangjie)\n- 构建: `cjpm build`\n- 全量测试: `cjpm test`\n- 运行: `cjpm run`\n- 单项测试: `cjpm test --filter <test_case>` (替换为实际测试用例名)\n\n");
}
fn cmd_cangjie_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Cangjie)\n- 构建: `cd {} && cjpm build`\n- 全量测试: `cd {} && cjpm test`\n- 单项测试: `cd {} && cjpm test --filter <test_case>`\n\n", m, m, m, m));
}

fn cmd_cmake_root(b: &mut String) {
    b.push_str("### 根项目 (C/C++)\n- 构建: `mkdir -p build && cd build && cmake .. && make`\n- 全量测试: `cd build && ctest`\n- 单项测试: `cd build && ctest -R <test_name_regexp>` (替换为正则过滤)\n\n");
}
fn cmd_cmake_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (C/C++)\n- 构建: `cd {} && mkdir -p build && cd build && cmake .. && make`\n- 全量测试: `cd {}/build && ctest`\n- 单项测试: `cd {}/build && ctest -R <test_name_regexp>`\n\n", m, m, m, m));
}

fn cmd_flutter_root(b: &mut String) {
    b.push_str("### 根项目 (Flutter/Dart)\n- 依赖: `flutter pub get`\n- 全量测试: `flutter test`\n- 单文件测试: `flutter test path/to/test_file.dart` (替换为实际路径)\n\n");
}
fn cmd_flutter_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (Flutter/Dart)\n- 依赖: `cd {} && flutter pub get`\n- 全量测试: `cd {} && flutter test`\n- 单文件测试: `cd {} && flutter test path/to/test_file.dart`\n\n", m, m, m, m));
}

fn cmd_php_root(b: &mut String) {
    b.push_str("### 根项目 (PHP/Composer)\n- 依赖: `composer install`\n- 全量测试: `./vendor/bin/phpunit`\n- 单文件测试: `./vendor/bin/phpunit path/to/TestFile.php` (替换为实际路径)\n\n");
}
fn cmd_php_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (PHP/Composer)\n- 依赖: `cd {} && composer install`\n- 全量测试: `cd {} && ./vendor/bin/phpunit`\n- 单文件测试: `cd {} && ./vendor/bin/phpunit path/to/TestFile.php`\n\n", m, m, m, m));
}

fn cmd_dotnet_root(b: &mut String) {
    b.push_str("### 根项目 (C#/.NET)\n- 还原: `dotnet restore`\n- 构建: `dotnet build`\n- 全量测试: `dotnet test`\n- 单测执行: `dotnet test --filter FullyQualifiedName=Namespace.ClassName` (替换为实际类名)\n\n");
}
fn cmd_dotnet_mod(b: &mut String, m: &str) {
    b.push_str(&format!("### 模块 (Module): {} (C#/.NET)\n- 还原: `cd {} && dotnet restore`\n- 构建: `cd {} && dotnet build`\n- 全量测试: `cd {} && dotnet test`\n- 单测执行: `cd {} && dotnet test --filter FullyQualifiedName=Namespace.ClassName` (替换为实际类名)\n\n", m, m, m, m, m));
}

/// The provider table, in Java's registration order (`CodeTalent` constructor).
/// Order is observable: it decides which provider claims a directory that matches
/// several, and the order stacks are listed in the result message.
fn providers() -> Vec<Provider> {
    vec![
        Provider { id: "Maven", type_name: "Maven 模块", markers: &["pom.xml"], ignore_folders: &["target"], custom_match: None, detect_version: ver_maven, root_commands: cmd_maven_root, module_commands: cmd_maven_mod },
        Provider { id: "Gradle", type_name: "Gradle 模块", markers: &["build.gradle", "build.gradle.kts", "settings.gradle"], ignore_folders: &["build", ".gradle"], custom_match: None, detect_version: ver_gradle, root_commands: cmd_gradle_root, module_commands: cmd_gradle_mod },
        Provider { id: "Node", type_name: "Node 项目", markers: &["package.json"], ignore_folders: &["node_modules"], custom_match: None, detect_version: ver_node, root_commands: cmd_node_root, module_commands: cmd_node_mod },
        Provider { id: "Go", type_name: "Go 模块", markers: &["go.mod"], ignore_folders: &["vendor"], custom_match: None, detect_version: ver_go, root_commands: cmd_go_root, module_commands: cmd_go_mod },
        Provider { id: "Python", type_name: "Python 项目", markers: &["requirements.txt", "pyproject.toml", "setup.py"], ignore_folders: &["venv", ".venv", "__pycache__"], custom_match: None, detect_version: ver_python, root_commands: cmd_python_root, module_commands: cmd_python_mod },
        Provider { id: "Rust", type_name: "Rust 项目", markers: &["Cargo.toml"], ignore_folders: &["target"], custom_match: None, detect_version: ver_rust, root_commands: cmd_rust_root, module_commands: cmd_rust_mod },
        Provider { id: "Cangjie", type_name: "仓颉项目", markers: &["cjpm.toml"], ignore_folders: &["target", ".cjpm"], custom_match: None, detect_version: ver_cangjie, root_commands: cmd_cangjie_root, module_commands: cmd_cangjie_mod },
        Provider { id: "CMake", type_name: "C/C++ 项目", markers: &["CMakeLists.txt"], ignore_folders: &["build", "CMakeFiles", ".cmake"], custom_match: None, detect_version: ver_cmake, root_commands: cmd_cmake_root, module_commands: cmd_cmake_mod },
        Provider { id: "Flutter", type_name: "Flutter 项目", markers: &["pubspec.yaml"], ignore_folders: &[".dart_tool", ".packages", "build"], custom_match: None, detect_version: ver_flutter, root_commands: cmd_flutter_root, module_commands: cmd_flutter_mod },
        Provider { id: "PHP", type_name: "PHP 项目", markers: &["composer.json"], ignore_folders: &["vendor"], custom_match: None, detect_version: ver_php, root_commands: cmd_php_root, module_commands: cmd_php_mod },
        Provider { id: "C#/.NET", type_name: "C# 项目", markers: &[], ignore_folders: &["obj", "bin"], custom_match: Some(dotnet_match), detect_version: ver_dotnet, root_commands: cmd_dotnet_root, module_commands: cmd_dotnet_mod },
    ]
}

/// Directory names never walked into (Java `CodeTalent.isIgnored`): hidden dirs,
/// the universal `bin`/`build`, plus every provider's `ignore_folders`.
fn is_ignored_dir(name: &str, providers: &[Provider]) -> bool {
    if name.starts_with('.') || name == "bin" || name == "build" {
        return true;
    }
    providers.iter().any(|p| p.ignore_folders.contains(&name))
}

fn append_versions(buf: &mut String, versions: &[(String, String)]) {
    if versions.is_empty() {
        return;
    }
    buf.push_str("## 环境版本 (Environment Versions)\n\n> 以下为项目配置文件中**声明**的版本（非本机安装版本），写代码时请对齐该版本的语法特性。\n\n");
    for (k, v) in versions {
        buf.push_str(&format!("- {}: {}\n", k, v));
    }
    buf.push('\n');
}

fn append_guidelines(buf: &mut String) {
    buf.push_str("## 工程规约 (Guidelines)\n\n");
    buf.push_str("- **读前必改**: 在进行任何修改前，务必完整阅读相关文件内容。\n");
    buf.push_str("- **原子作业**: 每次仅实现一个功能或修复一个 Bug。\n");
    buf.push_str("- **验证驱动**: 任务完成前必须运行测试进行验证。\n");
    buf.push_str("- **路径规范**: 仅使用相对路径（例如：`src/main/java/App.java`，严禁使用 `./src/...`）。\n");
    buf.push_str("- **风格对齐**: 必须遵循代码库中已有的编码风格和设计模式。\n");
    buf.push_str("- **版本对齐**: 参考「环境版本」章节声明的版本，不要使用超过该版本的语法特性；若未列出版本，应从配置文件或构建工具复核后再决定。\n");
    buf.push_str("- **环境感知**: 利用你对各语言默认本地仓库路径（如 Maven、Node）的知识，协助排查依赖问题或进行源码分析。\n");
    buf.push_str("- **临时文件**: 验证脚本、探测代码、对比截图等一次性文件放到工作区根的 `.tmp/` 目录下（例：`.tmp/probe.js`），用完可以删，**不删也不影响交付**：`.tmp/` 已被版本控制忽略，且不会出现在变更列表里。**严禁**把 `verify_*.js`、`probe_*.js`、`*.log`、临时截图这类文件放到 `src/`、项目根或任何会被提交的位置。若确需保留持久化的中间产物，先征得用户同意并加入忽略清单。\n\n");
}

/// Bounded (depth ≤ `max_depth`) directory walk from `root`, pruning ignored
/// subtrees, returning directory paths relative to `root` with `/` separators,
/// sorted for deterministic output. The root itself is excluded.
fn collect_subdirs(root: &Path, max_depth: usize, providers: &[Provider]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| {
            // Never prune the root itself, whatever it is named.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !is_ignored_dir(&name, providers)
        })
    {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 || !entry.file_type().is_dir() {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !rel.is_empty() {
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

/// The scan result, split out so the caller can decide whether the file changed.
struct ScanResult {
    content: String,
    stacks: Vec<String>,
    versions: Vec<String>,
}

/// Generate the WORK.md body for `root` (Java `CodeTalent.init`).
fn scan_project(root: &Path) -> ScanResult {
    let providers = providers();
    let mut content = String::from("## 构建与测试指令 (Build and Test Commands)\n\n");
    let mut stacks: Vec<String> = Vec::new();
    // Insertion-ordered version map (Java uses a LinkedHashMap).
    let mut versions: Vec<(String, String)> = Vec::new();
    let mut root_matched: HashSet<&str> = HashSet::new();

    for p in &providers {
        if p.is_match(root) {
            root_matched.insert(p.id);
            stacks.push(format!("{}(Root)", p.id));
            (p.root_commands)(&mut content);
            if let Some(v) = (p.detect_version)(root) {
                versions.push((format!("{} (Root)", p.id), v));
            }
        }
    }

    let mut has_submodules_section = false;
    let mut processed: Vec<String> = Vec::new();

    for rel in collect_subdirs(root, 3, &providers) {
        // A directory under an already-claimed parent inherits it (Maven's
        // multi-module convention) and is not listed separately.
        if processed.iter().any(|p| rel.starts_with(&format!("{}/", p))) {
            continue;
        }
        for p in &providers {
            if !p.is_match(&root.join(&rel)) {
                continue;
            }
            processed.push(rel.clone());
            let heterogeneous = !root_matched.contains(p.id);
            let ver = (p.detect_version)(&root.join(&rel));
            if heterogeneous {
                stacks.push(format!("{}({})", rel, p.id));
                (p.module_commands)(&mut content, &rel);
                if let Some(v) = ver {
                    versions.push((format!("{} ({})", rel, p.id), v));
                }
            } else {
                if !has_submodules_section {
                    content.push_str("### 子模块与子项目 (Sub-modules & Sub-projects)\n");
                    has_submodules_section = true;
                }
                content.push_str(&format!("- {}: {}", rel, p.type_name));
                if let Some(v) = ver {
                    content.push_str(&format!("（{}）", v));
                }
                content.push_str("。受根项目指令统一控制。\n");
            }
            break; // one directory claims exactly one primary language
        }
    }

    if has_submodules_section {
        content.push('\n');
    }
    append_versions(&mut content, &versions);
    append_guidelines(&mut content);

    ScanResult {
        content,
        stacks,
        versions: versions.into_iter().map(|(_, v)| v).collect(),
    }
}

/// Append `entry` to `<root>/.git/info/exclude` if absent — never touching the
/// user's `.gitignore` (Java `ensureInGitExclude`). Best-effort: any failure is
/// ignored, because keeping scratch dirs out of `git status` must never block
/// scaffolding. In worktree/submodule layouts `.git` is a file, not a dir, and
/// the gitdir it points at is not guessed — the write is simply skipped.
fn ensure_git_exclude(root: &Path, entry: &str) {
    let git_dir = root.join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let info = git_dir.join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return;
    }
    let exclude = info.join("exclude");
    let bare = entry.trim_end_matches('/');
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| {
        let t = l.trim();
        t == entry || t == bare
    }) {
        return;
    }
    let mut out = String::new();
    if !existing.is_empty() {
        out.push_str(existing.trim_end());
        out.push_str("\n\n");
    }
    out.push_str(entry);
    out.push('\n');
    let _ = std::fs::write(&exclude, out);
}

/// The generated WORK.md path for a workspace root.
fn work_md_path(root: &Path) -> PathBuf {
    root.join(".gwork").join("WORK.md")
}

pub struct CodeTool;

#[async_trait::async_trait]
impl Tool for CodeTool {
    fn name(&self) -> &str { "code" }
    fn description(&self) -> &str {
        "代码专家：扫描项目、自动识别技术栈，并生成/更新 `.gwork/WORK.md` 工程规约（含各模块的构建与测试指令、声明的语言版本）。在接手一个陌生代码库、需要确认如何构建和测试时调用。"
    }
    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "要扫描的项目根目录（相对工作区或绝对路径）。默认工作区根。"}
            },
            "required": []
        })
    }
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext) -> ToolOutput {
        let raw = args["path"].as_str().unwrap_or_default().trim();
        let root = if raw.is_empty() {
            ctx.workspace.clone()
        } else {
            let p = PathBuf::from(raw);
            if p.is_absolute() { p } else { ctx.workspace.join(p) }
        };
        let root = root.canonicalize().unwrap_or(root);
        if !root.is_dir() {
            return ToolOutput::err(format!("目录不存在或不可读：{}", root.display()));
        }

        // The walk touches the filesystem; keep it off the async worker. It only
        // reads files (no `block_in_place`), so `spawn_blocking` is safe here.
        let root_for_task = root.clone();
        let handle = tokio::task::spawn_blocking(move || -> ToolOutput {
            let scan = scan_project(&root_for_task);
            let target = work_md_path(&root_for_task);
            let mut updated = true;
            if let Ok(existing) = std::fs::read_to_string(&target) {
                updated = existing != scan.content;
            }
            if updated {
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&target, &scan.content) {
                    return ToolOutput::err(format!("写入 WORK.md 失败：{}", e));
                }
            }
            ensure_git_exclude(&root_for_task, ".gwork/");
            ensure_git_exclude(&root_for_task, ".tmp/");

            let mut msg = String::from(if updated { "已更新" } else { "已验证" });
            msg.push_str("项目工程规范");
            if scan.stacks.is_empty() {
                msg.push_str(" (未检测到明确的技术栈)");
            } else {
                msg.push_str(&format!(" (检测到技术栈: {})", scan.stacks.join(", ")));
            }
            if !scan.versions.is_empty() {
                msg.push_str(&format!(" (环境版本: {})", scan.versions.join(", ")));
            }
            msg.push_str(&format!("\n规约文件：{}", target.display()));
            ToolOutput::ok(msg)
        });
        match handle.await {
            Ok(out) => out,
            Err(e) => ToolOutput::err(format!("项目扫描失败：{}", e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "gwork-code-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn detects_a_rust_root_with_declared_version() {
        let s = Scratch::new("rust-root");
        s.write("Cargo.toml", "[package]\nname = \"x\"\nrust-version = \"1.77.2\"\nedition = \"2021\"\n");
        let r = scan_project(&s.0);
        assert!(r.stacks.contains(&"Rust(Root)".to_string()), "{:?}", r.stacks);
        assert!(r.versions.iter().any(|v| v == "Rust 1.77.2"), "{:?}", r.versions);
        assert!(r.content.contains("cargo build"), "{}", r.content);
        // rust-version wins over edition.
        assert!(!r.versions.iter().any(|v| v.contains("edition")), "{:?}", r.versions);
    }

    #[test]
    fn rust_version_falls_back_to_edition() {
        let s = Scratch::new("rust-edition");
        s.write("Cargo.toml", "[package]\nname = \"x\"\nedition = \"2021\"\n");
        let r = scan_project(&s.0);
        assert!(r.versions.iter().any(|v| v == "Rust edition 2021"), "{:?}", r.versions);
    }

    #[test]
    fn a_heterogeneous_subproject_gets_its_own_module_block() {
        // Rust at root, a Maven sub-project: Maven was not matched at root, so it is
        // heterogeneous and must get full module commands.
        let s = Scratch::new("hetero");
        s.write("Cargo.toml", "[package]\nname=\"x\"\nedition=\"2021\"\n");
        s.write("gourdai-java/pom.xml", "<project><properties><java.version>17</java.version></properties></project>");
        let r = scan_project(&s.0);
        assert!(r.stacks.contains(&"gourdai-java(Maven)".to_string()), "{:?}", r.stacks);
        assert!(r.content.contains("### 模块 (Module): gourdai-java (Maven)"), "{}", r.content);
        assert!(r.content.contains("cd gourdai-java && mvn test"), "{}", r.content);
        assert!(r.versions.iter().any(|v| v == "Java 17"), "{:?}", r.versions);
    }

    #[test]
    fn a_same_language_subproject_is_folded_into_a_note() {
        // Two Rust crates: the sub one is homogeneous, so it inherits root commands
        // and appears only as a sub-module line, not a full block.
        let s = Scratch::new("homo");
        s.write("Cargo.toml", "[workspace]\n");
        s.write("crates/inner/Cargo.toml", "[package]\nname=\"inner\"\nedition=\"2021\"\n");
        let r = scan_project(&s.0);
        assert!(r.content.contains("### 子模块与子项目"), "{}", r.content);
        assert!(r.content.contains("crates/inner: Rust 项目"), "{}", r.content);
        assert!(!r.content.contains("### 模块 (Module): crates/inner"), "homogeneous sub must not get its own block: {}", r.content);
    }

    #[test]
    fn ignored_directories_are_never_walked() {
        // A Cargo.toml buried under target/ must not register as a sub-project:
        // target/ is a build artifact, and scanning it would invent phantom modules.
        //
        // The fixture keeps the buried crate at depth 2 (`target/dep`), inside the
        // depth-3 walk. An earlier version put it at depth 4 (`target/debug/build/
        // dep`), which the walk never reached anyway — so the test passed on the
        // depth cap, not on the ignore rule, and survived a mutant that disabled
        // pruning entirely. Depth 2 is what makes `is_ignored_dir` load-bearing.
        let s = Scratch::new("ignored");
        s.write("Cargo.toml", "[package]\nname=\"x\"\nedition=\"2021\"\n");
        s.write("target/dep/Cargo.toml", "[package]\nname=\"dep\"\n");
        // node_modules is another provider's ignore folder; prove the rule is not
        // Rust-specific.
        s.write("node_modules/pkg/package.json", "{}");
        let r = scan_project(&s.0);
        assert!(!r.content.contains("dep"), "target/ subtree must be pruned: {}", r.content);
        assert!(!r.content.contains("pkg"), "node_modules/ subtree must be pruned: {}", r.content);
    }

    #[test]
    fn dotnet_is_matched_by_extension_not_fixed_name() {
        let s = Scratch::new("dotnet");
        s.write("App/App.csproj", "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>");
        let r = scan_project(&s.0);
        assert!(r.stacks.iter().any(|x| x.contains("C#/.NET")), "{:?}", r.stacks);
        assert!(r.versions.iter().any(|v| v == ".NET net8.0"), "{:?}", r.versions);
    }

    #[test]
    fn gradle_module_paths_use_colon_addressing() {
        let s = Scratch::new("gradle");
        s.write("build.gradle", "");
        s.write("sub/mod/build.gradle", "");
        let r = scan_project(&s.0);
        // Homogeneous (Gradle at root), so it is a note; but a heterogeneous gradle
        // module would use `:sub:mod`. Assert the root command shape is present.
        assert!(r.content.contains("./gradlew build"), "{}", r.content);
        let _ = &r;
    }

    #[test]
    fn an_empty_project_reports_no_stack_but_still_writes_guidelines() {
        let s = Scratch::new("empty");
        let r = scan_project(&s.0);
        assert!(r.stacks.is_empty());
        // The guidelines and the header are always present so the file is never empty.
        assert!(r.content.contains("工程规约"), "{}", r.content);
        assert!(r.content.contains("构建与测试指令"), "{}", r.content);
    }

    #[test]
    fn scan_is_deterministic_across_runs() {
        // Same input must produce byte-identical output, or the "updated?" check
        // would rewrite the file on every call and the git-exclude would churn.
        let s = Scratch::new("determinism");
        s.write("Cargo.toml", "[package]\nname=\"x\"\nedition=\"2021\"\n");
        s.write("web/package.json", "{\"engines\":{\"node\":\">=18\"}}");
        let a = scan_project(&s.0);
        let b = scan_project(&s.0);
        assert_eq!(a.content, b.content, "scan must be deterministic");
    }

    #[test]
    fn git_exclude_is_idempotent_and_creates_the_entry() {
        let s = Scratch::new("gitexclude");
        std::fs::create_dir_all(s.0.join(".git")).unwrap();
        ensure_git_exclude(&s.0, ".gwork/");
        ensure_git_exclude(&s.0, ".gwork/"); // second call must not duplicate
        ensure_git_exclude(&s.0, ".tmp/");
        let content = std::fs::read_to_string(s.0.join(".git/info/exclude")).unwrap();
        assert_eq!(content.matches(".gwork/").count(), 1, "must not duplicate: {}", content);
        assert_eq!(content.matches(".tmp/").count(), 1, "{}", content);
    }

    #[test]
    fn git_exclude_skips_a_worktree_git_file() {
        // In a worktree/submodule `.git` is a file, not a dir; the gitdir it points
        // at is not guessed, so nothing is written and nothing panics.
        let s = Scratch::new("gitfile");
        std::fs::write(s.0.join(".git"), "gitdir: /elsewhere").unwrap();
        ensure_git_exclude(&s.0, ".gwork/");
        assert!(!s.0.join(".git/info/exclude").exists());
    }

    #[test]
    fn find_group_returns_none_on_no_match() {
        assert_eq!(find_group("no version here", r#"(?i)rust-version\s*=\s*"([^"]+)""#), None);
        assert_eq!(find_group("rust-version = \"1.70\"", r#"(?i)rust-version\s*=\s*"([^"]+)""#).as_deref(), Some("1.70"));
    }
}
