package com.gourdai.core.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

class AgentFlagsTest {
    private String originalGwork;
    private String originalGourdai;
    private String originalUserHome;
    private String originalUserDir;

    @BeforeEach
    void saveProperties() {
        originalGwork = System.getProperty("gwork.home");
        originalGourdai = System.getProperty("gourdai.home");
        originalUserHome = System.getProperty("user.home");
        originalUserDir = System.getProperty("user.dir");
    }

    @AfterEach
    void restoreProperties() {
        restore("gwork.home", originalGwork);
        restore("gourdai.home", originalGourdai);
        restore("user.home", originalUserHome);
        restore("user.dir", originalUserDir);
    }

    @Test
    void defaultsToUserHome() {
        System.clearProperty("gwork.home");
        System.clearProperty("gourdai.home");
        System.setProperty("user.home", " /tmp/test-user-home ");
        System.setProperty("user.dir", "/workspace");
        Assertions.assertEquals("/tmp/test-user-home", AgentFlags.getHarnessBase());
    }

    @Test
    void overridePriorityAndTrim() {
        System.setProperty("gwork.home", "  /preferred  ");
        System.setProperty("gourdai.home", "/legacy");
        Assertions.assertEquals("/preferred", AgentFlags.getHarnessBase());
    }

    @Test
    void mergesIntoExistingTargetWithTargetPriorityAndSkipsBin() throws Exception {
        Path root = Files.createTempDirectory("agent-flags-migration");
        try {
            Path legacy = root.resolve(".gourdai");
            Path current = root.resolve(".gwork");
            Files.createDirectories(legacy.resolve("nested/deep"));
            Files.createDirectories(legacy.resolve("bin"));
            Files.writeString(legacy.resolve("settings.json"), "legacy");
            Files.writeString(legacy.resolve("nested/deep/value.txt"), "nested");
            Files.writeString(legacy.resolve("bin/unsafe.cmd"), "skip");
            Files.createDirectories(current);
            Files.writeString(current.resolve("settings.json"), "current");
            Files.writeString(current.resolve("existing.txt"), "keep");
            Files.createDirectories(legacy.resolve(".gourdai/more"));
            Files.writeString(legacy.resolve(".gourdai/more/value.txt"), "nested-root");
            // 嵌套 bin 是合法数据（技能/扩展自带脚本），只有**根部** bin 才是旧启动器
            Files.createDirectories(legacy.resolve("skills/demo/bin"));
            Files.writeString(legacy.resolve("skills/demo/bin/run.sh"), "skill-script");
            Files.createDirectories(legacy.resolve(".gourdai/extensions/ext/bin"));
            Files.writeString(legacy.resolve(".gourdai/extensions/ext/bin/tool"), "ext-tool");

            System.setProperty("gwork.home", root.toString());
            AgentFlags.migrateLegacyHarnessHome();

            Assertions.assertEquals("current", Files.readString(current.resolve("settings.json")));
            Assertions.assertEquals("nested", Files.readString(current.resolve("nested/deep/value.txt")));
            Assertions.assertEquals("nested-root", Files.readString(current.resolve("more/value.txt")));
            Assertions.assertFalse(Files.exists(current.resolve("bin/unsafe.cmd")));
            // 回归：逐层跳过 bin 会静默丢弃这两个文件
            Assertions.assertEquals("skill-script", Files.readString(current.resolve("skills/demo/bin/run.sh")));
            Assertions.assertEquals("ext-tool", Files.readString(current.resolve("extensions/ext/bin/tool")));
            // 已成功复制的源被回收；冲突项（settings.json）与根部 bin 保留在旧目录
            Assertions.assertFalse(Files.exists(legacy.resolve("nested/deep/value.txt")));
            Assertions.assertFalse(Files.exists(legacy.resolve("skills/demo/bin/run.sh")));
            Assertions.assertEquals("legacy", Files.readString(legacy.resolve("settings.json")));
            Assertions.assertEquals("skip", Files.readString(legacy.resolve("bin/unsafe.cmd")));
        } finally {
            try (Stream<Path> paths = Files.walk(root)) {
                paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (Exception ignored) { }
                });
            }
        }
    }

    private static void restore(String key, String value) {
        if (value == null) System.clearProperty(key); else System.setProperty(key, value);
    }
}
