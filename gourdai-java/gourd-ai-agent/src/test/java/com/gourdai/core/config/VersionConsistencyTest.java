package com.gourdai.core.config;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 版本号跨文件一致性契约：{@link AgentFlags#getVersion()} 是全仓唯一权威，
 * 其余声明处必须与它逐字对齐。
 *
 * <p><b>为什么必须有这一组测试</b>：版本号在仓库里有约十处副本——pom 的
 * {@code project.version}、{@code setup/info.json}、两个 setup 脚本的 {@code VERSION}
 * 变量、README 徽章、Electron 与 Tauri 两个模块的 package.json / tauri.conf.json /
 * Cargo.toml。其中只有 Tauri 模块的五处有 {@code cmd/set-version.js} 兜底，其余全靠
 * 发版时人工同步；而漏改任何一处都<b>不会让构建报错</b>：pom 与 AgentFlags 漂移只会让
 * build-info 指纹与更新检测各说各话，setup 脚本漂移会让新装用户拿到旧包，README 漂移
 * 只是误导。这类失效安静到只有用户踩中才会暴露。</p>
 *
 * <p>本测试把「十处副本必须同源」钉成红灯：下次改版本号漏了任何一处，这里直接失败并
 * 点名漂移文件与它的现值，不必等发版后用户回报。</p>
 *
 * <p>锁文件（Cargo.lock / package-lock.json）不入库，不在本契约范围内——它们由
 * set-version.js 的终检负责。</p>
 */
class VersionConsistencyTest {

    /** 权威版本（去前导 v 的裸形态，如 {@code 0.2.3}）。 */
    private static final String BARE = bare(AgentFlags.getVersion());

    /** 展示形态（带前导 v，如 {@code v0.2.3}）。 */
    private static final String DISPLAY = "v" + BARE;

    private static String bare(String version) {
        Assertions.assertNotNull(version, "AgentFlags.getVersion() 不得为 null");
        Assertions.assertTrue(version.startsWith("v"),
                "展示形态应带前导 v（本契约以 v 前缀为展示口径）: " + version);
        return version.substring(1);
    }

    /** 从当前工作目录（surefire 下为模块目录）上溯定位仓库根。 */
    private static Path repoRoot() {
        Path dir = Paths.get("").toAbsolutePath();
        for (int i = 0; i < 6; i++) {
            if (Files.isRegularFile(dir.resolve("pom.xml"))
                    && Files.isRegularFile(dir.resolve("gourd-ai-agent").resolve("pom.xml"))) {
                return dir;
            }
            dir = dir.getParent();
            if (dir == null) {
                break;
            }
        }
        Assertions.fail("未能从工作目录上溯定位仓库根（需要同时含 pom.xml 与 gourd-ai-agent/pom.xml）");
        return null;
    }

    private static String read(Path file) throws IOException {
        Assertions.assertTrue(Files.isRegularFile(file), "契约所需的文件不存在: " + file);
        return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    }

    /** 收集所有漂移项，一次性报全，避免修一处跑一轮。 */
    private static void assertNoDrift(List<String> drift) {
        Assertions.assertTrue(drift.isEmpty(),
                "版本号副本与 AgentFlags.getVersion()（" + DISPLAY + "）不一致：\n  - "
                        + String.join("\n  - ", drift));
    }

    @Test
    void pomProjectVersionMatchesAgentFlags() throws IOException {
        String pom = read(repoRoot().resolve("gourd-ai-agent/pom.xml"));
        // 以本模块 artifactId 为锚，取其后的第一个 <version>：parent 段在它之前，
        // 全文首个 <version> 是 parent 的版本（4.1.0），绝不能拿全文首处当本模块版本。
        int anchor = pom.indexOf("<artifactId>gourd-ai-agent</artifactId>");
        Assertions.assertTrue(anchor >= 0, "pom 中未找到本模块 artifactId 锚点");
        Matcher m = Pattern.compile("<version>([^<]+)</version>").matcher(pom.substring(anchor));
        Assertions.assertTrue(m.find(), "本模块 artifactId 之后未找到 <version> 标签");
        Assertions.assertEquals(BARE, m.group(1),
                "gourd-ai-agent/pom.xml 的 project.version 必须等于 AgentFlags 的裸版本");
    }

    @Test
    void setupInfoJsonVersionsMatchAgentFlags() throws IOException {
        ONode json = ONode.ofJson(read(repoRoot().resolve("gourd-ai-agent/setup/info.json")));
        List<String> drift = new ArrayList<>();
        for (String key : new String[]{"cli_version", "ide_version"}) {
            String actual = json.get(key).getValueAs();
            if (!DISPLAY.equals(actual)) {
                drift.add("setup/info.json 的 " + key + " 是 " + actual);
            }
        }
        assertNoDrift(drift);
    }

    @Test
    void setupScriptsVersionVariableMatchesAgentFlags() throws IOException {
        List<String> drift = new ArrayList<>();
        Path root = repoRoot();

        String ps1 = read(root.resolve("gourd-ai-agent/setup/setup.ps1"));
        Matcher ps1m = Pattern.compile("\\$VERSION\\s*=\\s*\"([^\"]+)\"").matcher(ps1);
        boolean ps1Found = ps1m.find();
        if (!ps1Found || !DISPLAY.equals(ps1m.group(1))) {
            drift.add("setup/setup.ps1 的 $VERSION 是 " + (ps1Found ? ps1m.group(1) : "<缺失>"));
        }
        // 下载地址必须由 $VERSION 拼装：写死版本号的话，改了变量也照样下旧包
        if (!ps1.contains("releases/download/$VERSION/")) {
            drift.add("setup/setup.ps1 的 PACKAGE_URL 未用 $VERSION 拼装（写死地址会绕过版本变量）");
        }

        String sh = read(root.resolve("gourd-ai-agent/setup/setup.sh"));
        Matcher shm = Pattern.compile("^VERSION=\"([^\"]+)\"", Pattern.MULTILINE).matcher(sh);
        boolean shFound = shm.find();
        if (!shFound || !DISPLAY.equals(shm.group(1))) {
            drift.add("setup/setup.sh 的 VERSION 是 " + (shFound ? shm.group(1) : "<缺失>"));
        }
        if (!sh.contains("releases/download/${VERSION}/")) {
            drift.add("setup/setup.sh 的 PACKAGE_URL 未用 ${VERSION} 拼装（写死地址会绕过版本变量）");
        }

        assertNoDrift(drift);
    }

    @Test
    void readmeBadgeMatchesAgentFlags() throws IOException {
        String readme = read(repoRoot().resolve("README.md"));
        // 只认徽章 URL 里的版本段：正文别处提到旧版本号不应让本断言假绿。
        Matcher m = Pattern.compile("img\\.shields\\.io/badge/(v[0-9][0-9._]*)-Latest").matcher(readme);
        Assertions.assertTrue(m.find(), "README.md 中未找到 Version 徽章（img.shields.io/badge/vX.Y.Z-Latest）");
        Assertions.assertEquals(DISPLAY, m.group(1),
                "README.md 的版本徽章必须展示 " + DISPLAY);
    }

    @Test
    void desktopAndTauriShellVersionsMatchAgentFlags() throws IOException {
        List<String> drift = new ArrayList<>();
        Path root = repoRoot();

        String desktopPkg = ONode.ofJson(read(root.resolve("gourd-ai-desktop/package.json"))).get("version").getValueAs();
        if (!BARE.equals(desktopPkg)) {
            drift.add("gourd-ai-desktop/package.json 的 version 是 " + desktopPkg);
        }

        String tauriPkg = ONode.ofJson(read(root.resolve("gourd-ai-tauri/package.json"))).get("version").getValueAs();
        if (!BARE.equals(tauriPkg)) {
            drift.add("gourd-ai-tauri/package.json 的 version 是 " + tauriPkg);
        }

        String tauriConf = ONode.ofJson(read(root.resolve("gourd-ai-tauri/src-tauri/tauri.conf.json"))).get("version").getValueAs();
        if (!BARE.equals(tauriConf)) {
            drift.add("gourd-ai-tauri/src-tauri/tauri.conf.json 的 version 是 " + tauriConf);
        }

        String cargo = read(root.resolve("gourd-ai-tauri/src-tauri/Cargo.toml"));
        int pkg = cargo.indexOf("[package]");
        int nextSection = cargo.indexOf('\n', pkg) + 1;
        int end = cargo.indexOf("\n[", nextSection);
        String body = end < 0 ? cargo.substring(pkg) : cargo.substring(pkg, end);
        Matcher cm = Pattern.compile("^version\\s*=\\s*\"([^\"]+)\"", Pattern.MULTILINE).matcher(body);
        boolean cargoFound = cm.find();
        if (!cargoFound || !BARE.equals(cm.group(1))) {
            drift.add("gourd-ai-tauri/src-tauri/Cargo.toml 的 [package] version 是 "
                    + (cargoFound ? cm.group(1) : "<缺失>"));
        }

        assertNoDrift(drift);
    }
}
