#!/bin/bash
# GWork CLI installer (Linux / macOS / Git Bash)
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_BIN_DIR="$SOURCE_DIR/bin"
SOURCE_SKILLS_DIR="$SOURCE_DIR/skills"
SOURCE_AGENTS="$SOURCE_DIR/AGENTS.md"
TARGET_DIR="$HOME/.gwork"
TARGET_BIN_DIR="$TARGET_DIR/bin"
TARGET_SKILLS_DIR="$TARGET_DIR/skills"
OLD_DIR="$HOME/.gourdai"

if ! command -v java >/dev/null 2>&1; then
  echo -e "${RED}[Error] Java is not installed or not in PATH${NC}"; exit 1
fi
if [ ! -d "$SOURCE_BIN_DIR" ]; then echo "[Error] Source bin directory not found: $SOURCE_BIN_DIR"; exit 1; fi

mkdir -p "$TARGET_DIR" "$TARGET_BIN_DIR" "$TARGET_SKILLS_DIR"

# Migrate user data only. bin is deliberately excluded; existing target files win.
merge_tree() {
  local src="$1" dest="$2" child name
  mkdir -p "$dest"
  while IFS= read -r -d '' child; do
    name="$(basename "$child")"
    [ "$name" = "bin" ] && continue
    if [ "$src" = "$OLD_DIR" ] && [ "$name" = ".gourdai" ] && [ -d "$child" ]; then
      merge_tree "$child" "$dest"
      continue
    fi
    if [ -e "$dest/$name" ] || [ -L "$dest/$name" ]; then
      [ -d "$child" ] && [ -d "$dest/$name" ] && merge_tree "$child" "$dest/$name"
    else
      cp -R "$child" "$dest/$name"
    fi
  done < <(find "$src" -mindepth 1 -maxdepth 1 -print0)
}
if [ -d "$OLD_DIR" ]; then
  echo "Migrating user data from $OLD_DIR (without bin/, target files win)..."
  merge_tree "$OLD_DIR" "$TARGET_DIR"
fi

# Runtime files are installer-owned and may be refreshed.
cp -R "$SOURCE_BIN_DIR/." "$TARGET_BIN_DIR/"
[ -f "$SOURCE_AGENTS" ] && [ ! -f "$TARGET_DIR/AGENTS.md" ] && cp "$SOURCE_AGENTS" "$TARGET_DIR/AGENTS.md"
if [ -d "$SOURCE_SKILLS_DIR" ]; then
  for skill in "$SOURCE_SKILLS_DIR"/*/; do
    [ -d "$skill" ] || continue
    name=$(basename "$skill"); rm -rf "$TARGET_SKILLS_DIR/$name"; cp -R "$skill" "$TARGET_SKILLS_DIR/$name"
  done
fi

cat > "$TARGET_BIN_DIR/gwork" <<'LAUNCHER'
#!/bin/bash
# gwork-cli-installed
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# JVM 内存参数：与桌面端 gourd-ai-tauri/src-tauri/src/backend.rs 的 jvm_memory_opts() 同源。
# 不给这组参数时 JDK 会按物理内存推导默认值（实测 32G 机器上 InitialHeap=512M /
# MaxHeap=8.4G / G1GC），一启动就预提交 512MB，且 G1 峰值后不把堆归还 OS。
# SerialGC + MinHeapFreeRatio/MaxHeapFreeRatio 使 GC 后按比例收缩并归还 OS；
# 只设 -Xms/-Xmx 而不配 FreeRatio 是负优化（实测反升到 341M）。
# 【改动约】上方 backend.rs 的取值变动时，本文件与 install.ps1 需同步。
JAVA_OPTS=(
  "-Xms48m" "-Xmx1024m" "-Xss512k"
  "-XX:+UseSerialGC" "-XX:MinHeapFreeRatio=10" "-XX:MaxHeapFreeRatio=25"
  "-XX:MaxMetaspaceSize=192m" "-XX:CompressedClassSpaceSize=64m"
  "-XX:ReservedCodeCacheSize=96m" "-XX:InitialCodeCacheSize=4m" "-XX:-UsePerfData"
  "-Dfile.encoding=UTF-8" "-Dgwork.home=$HOME"
)
JAVA_VER=$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)
[ -n "$JAVA_VER" ] && [ "$JAVA_VER" -ge 21 ] 2>/dev/null && JAVA_OPTS+=("--enable-native-access=ALL-UNNAMED")
[ -n "$MSYSTEM" ] && JAVA_OPTS+=("-Djline.terminal.type=xterm-256color")
exec java "${JAVA_OPTS[@]}" -jar "$SCRIPT_DIR/gourd-ai-agent.jar" "$@"
LAUNCHER
cp "$TARGET_BIN_DIR/gwork" "$TARGET_BIN_DIR/gourdai"
chmod +x "$TARGET_BIN_DIR/gwork" "$TARGET_BIN_DIR/gourdai"

# Remove only installer-owned legacy PATH entries, then add the exact new directory.
PATH_FILES=("$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc")
for file in "${PATH_FILES[@]}"; do
  [ -f "$file" ] || continue
  tmp="${file}.gwork.tmp"
  sed -E '/^[[:space:]]*# (GWork|Solon Code) CLI[[:space:]]*$/d; /^[[:space:]]*export PATH="\$PATH:\$HOME\/\.gourdai\/bin"[[:space:]]*$/d; /^[[:space:]]*export PATH="\$PATH:\$HOME\/\.gwork\/bin"[[:space:]]*$/d' "$file" > "$tmp"
  printf '\n# GWork CLI\nexport PATH="$PATH:$HOME/.gwork/bin"\n' >> "$tmp"
  mv "$tmp" "$file"
done
FISH_CONFIG="$HOME/.config/fish/config.fish"
if [ -f "$FISH_CONFIG" ]; then
  tmp="${FISH_CONFIG}.gwork.tmp"; sed -E '/^[[:space:]]*# (GWork|Solon Code) CLI[[:space:]]*$/d; /^[[:space:]]*set -gx PATH.*\$HOME\/\.gourdai\/bin[[:space:]]*$/d; /^[[:space:]]*set -gx PATH.*\$HOME\/\.gwork\/bin[[:space:]]*$/d' "$FISH_CONFIG" > "$tmp"
  printf '\n# GWork CLI\nset -gx PATH $PATH $HOME/.gwork/bin\n' >> "$tmp"; mv "$tmp" "$FISH_CONFIG"
fi

echo -e "${GREEN}Installation complete: $TARGET_DIR${NC}"
echo "Commands: gwork (primary), gourdai (compatibility alias)"
