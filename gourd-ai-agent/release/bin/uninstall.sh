#!/bin/bash
# Safe CLI uninstaller. User data is retained unless --purge-data is explicit.
set -e
INSTALL_DIR="$HOME/.gwork"
TARGET_BIN_DIR="$INSTALL_DIR/bin"
PURGE=false
[ "${1:-}" = "--purge-data" ] && PURGE=true

remove_path_entries() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  tmp="${file}.gwork.tmp"
  sed -E '/^[[:space:]]*# Solon Code CLI[[:space:]]*$/d; /^[[:space:]]*export PATH="\$PATH:\$HOME\/\.gourdai\/bin"[[:space:]]*$/d; /^[[:space:]]*export PATH="\$PATH:\$HOME\/\.gwork\/bin"[[:space:]]*$/d; /^[[:space:]]*set -gx PATH.*\$HOME\/\.gourdai\/bin[[:space:]]*$/d; /^[[:space:]]*set -gx PATH.*\$HOME\/\.gwork\/bin[[:space:]]*$/d' "$file" > "$tmp"
  mv "$tmp" "$file"
}
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.config/fish/config.fish"; do remove_path_entries "$f"; done

# Remove only links whose resolved target is one of this installation's launchers.
for name in gwork gourdai; do
  for link in "/usr/local/bin/$name" "$HOME/.local/bin/$name" "$HOME/bin/$name"; do
  [ -L "$link" ] || continue
  target="$(readlink "$link")"
  case "$target" in
    "$TARGET_BIN_DIR/$name"|"$TARGET_BIN_DIR/./$name") rm -f "$link" 2>/dev/null || true;;
  esac
  done
done

# Remove only standalone-CLI files carrying its sentinel. Desktop provisioned launchers are preserved.
if [ -d "$TARGET_BIN_DIR" ]; then
  for f in gwork gourdai gwork.ps1 gourdai.ps1 gwork.bat gourdai.bat; do
    target="$TARGET_BIN_DIR/$f"
    [ -f "$target" ] && grep -qF "gwork-cli-installed" "$target" 2>/dev/null && rm -f "$target"
  done
  # The standalone jar/uninstallers are removed only when at least one standalone launcher was installed.
  if ! grep -qF "gourd-ai-desktop-provisioned" "$TARGET_BIN_DIR/gwork" 2>/dev/null; then
    rm -f "$TARGET_BIN_DIR/gourd-ai-agent.jar" "$TARGET_BIN_DIR/uninstall.sh" "$TARGET_BIN_DIR/uninstall.ps1"
  fi
fi
if $PURGE; then
  rm -rf "$INSTALL_DIR"
  echo "Purged $INSTALL_DIR"
else
  echo "Removed CLI files; retained user data in $INSTALL_DIR. Use --purge-data to delete it."
fi
