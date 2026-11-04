#!/usr/bin/env bash
# GWork 构建脚本（Linux / macOS）
# 用法：
#   ./build.sh                    # 完整构建
#   SKIP_MAVEN=true ./build.sh    # 跳过 Maven
#   SKIP_JLINK=true ./build.sh    # 跳过 jlink
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXTRA_RESOURCES_DIR="${SCRIPT_DIR}/build/extraResources"
JRE_DIR="${EXTRA_RESOURCES_DIR}/jre"
JAR_SOURCE="${PROJECT_ROOT}/gourd-ai-agent/target/gourd-ai-agent.jar"
UI_SOURCE="${PROJECT_ROOT}/gourd-ai-agent/src/main/resources/static"
UI_DEST="${SCRIPT_DIR}/build/ui"

echo "=== GWork 构建（Electron）==="
echo "平台: $(uname -s)/$(uname -m)"

# 1. Maven 构建 JAR
if [ "${SKIP_MAVEN:-false}" = "false" ]; then
    echo "[1/5] Maven 构建 gourd-ai-agent.jar..."
    (cd "${PROJECT_ROOT}" && mvn -pl gourd-ai-agent -am package -DskipTests -q)
fi
[ -f "${JAR_SOURCE}" ] || { echo "错误: JAR 不存在: ${JAR_SOURCE}"; exit 1; }

# 2. 复制 JAR 到 build/extraResources/
echo "[2/5] 复制 JAR 到 build/extraResources/..."
mkdir -p "${EXTRA_RESOURCES_DIR}"
cp -f "${JAR_SOURCE}" "${EXTRA_RESOURCES_DIR}/gourd-ai-agent.jar"

# 3. 复制前端 UI 到 build/ui/（单一来源：直接取自 gourd-ai-agent 静态资源）
echo "[3/5] 复制前端 UI 到 build/ui/..."
[ -f "${UI_SOURCE}/index.html" ] || { echo "错误: UI 源不存在: ${UI_SOURCE}"; exit 1; }
rm -rf "${UI_DEST}"
mkdir -p "${UI_DEST}"
cp -R "${UI_SOURCE}/." "${UI_DEST}/"

# 4. jlink 生成精简 JRE 到 build/extraResources/jre/
if [ "${SKIP_JLINK:-false}" = "false" ]; then
    echo "[4/5] jlink 生成精简 JRE..."
    [ -n "${JAVA_HOME:-}" ] || { echo "错误: 未设置 JAVA_HOME"; exit 1; }
    MODULES="java.base,java.logging,java.sql,java.naming,java.management,java.instrument,java.net.http,jdk.crypto.ec,jdk.zipfs,jdk.unsupported"
    rm -rf "${JRE_DIR}"
    "${JAVA_HOME}/bin/jlink" \
        --module-path "${JAVA_HOME}/jmods" \
        --add-modules "${MODULES}" \
        --output "${JRE_DIR}" \
        --strip-debug --compress 2 \
        --no-header-files --no-man-pages
    chmod +x "${JRE_DIR}/bin/java" 2>/dev/null || true
    echo "  JRE: $(du -sh ${JRE_DIR} | cut -f1)"
fi

# 5. Electron Builder 打包（输出到 out/）
echo "[5/5] npm install && electron-builder..."
(cd "${SCRIPT_DIR}" && npm install && npm run build:$([ "$(uname -s)" = "Darwin" ] && echo "mac" || echo "linux"))

echo ""
echo "=== 构建完成 ==="
echo "安装包: ${SCRIPT_DIR}/out/"
