package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.Result;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * FileService 文件树过滤测试 —— 验证点前缀文件/目录正常展示，
 * 仅排除清单内的目录（如 .git、node_modules）被隐藏。
 *
 * @author oisin
 */
public class FileServiceTest {

    @Test
    public void testTreeShowsDotFiles() throws Exception {
        Path root = Files.createTempDirectory("filer-test");
        try {
            // 应展示的点前缀条目
            Files.createFile(root.resolve(".gitignore"));
            Files.createFile(root.resolve(".env"));
            Files.createDirectory(root.resolve(".github"));
            Files.createFile(root.resolve(".github").resolve("workflow.yml"));
            // 应隐藏的排除清单目录
            Files.createDirectory(root.resolve(".git"));
            Files.createDirectory(root.resolve("node_modules"));
            // 普通条目
            Files.createFile(root.resolve("pom.xml"));
            Files.createDirectory(root.resolve("src"));

            FileService service = new FileService(root.toString());
            Result<List<Map>> rst = service.tree("", 1, root.toString());
            List<Map> nodes = rst.getData();
            List<String> names = nodes.stream()
                    .map(m -> String.valueOf(m.get("name")))
                    .collect(Collectors.toList());

            Assertions.assertTrue(names.contains(".gitignore"), "点前缀文件 .gitignore 应展示");
            Assertions.assertTrue(names.contains(".env"), "点前缀文件 .env 应展示");
            Assertions.assertTrue(names.contains(".github"), "点前缀目录 .github 应展示");
            Assertions.assertTrue(names.contains("pom.xml"));
            Assertions.assertTrue(names.contains("src"));

            Assertions.assertFalse(names.contains(".git"), ".git 应被隐藏");
            Assertions.assertFalse(names.contains("node_modules"), "node_modules 应被隐藏");

            // 文件搜索同样覆盖点前缀文件
            Result<List<Map>> srst = service.search(".env", root.toString());
            List<String> paths = srst.getData().stream()
                    .map(m -> String.valueOf(m.get("path")))
                    .collect(Collectors.toList());
            Assertions.assertTrue(paths.contains(".env"), "搜索应能命中点前缀文件");
        } finally {
            deleteRecursively(root.toFile());
        }
    }

    /**
     * 【2026-10-10 154 事故修复】远端后端家目录 .gwork-remote 必须被排除：
     * 后端日志目录若被 watcher 监听会形成自激循环（日志写 → inotify 事件 →
     * push + DEBUG 日志 → 更多事件），风暴期拖垮远端使探活整窗误判。
     * 行为级：文件树不展示；契约级：FileService 与 WorkspaceWatcher 两份
     * 清单必须同时含 .gwork-remote（防单边漂移）。
     */
    @Test
    public void testGworkRemoteDirExcluded() throws Exception {
        Path root = Files.createTempDirectory("filer-gworkremote-test");
        try {
            Files.createDirectory(root.resolve(".gwork-remote"));
            Files.createFile(root.resolve(".gwork-remote").resolve("server.log"));
            Files.createDirectory(root.resolve(".gwork"));

            FileService service = new FileService(root.toString());
            Result<List<Map>> rst = service.tree("", 1, root.toString());
            List<String> names = rst.getData().stream()
                    .map(m -> String.valueOf(m.get("name")))
                    .collect(Collectors.toList());
            Assertions.assertFalse(names.contains(".gwork-remote"), ".gwork-remote 应被隐藏");
            Assertions.assertFalse(names.contains(".gwork"), ".gwork 应被隐藏");
        } finally {
            deleteRecursively(root.toFile());
        }

        // 双清单防漂移：两份源码的排除清单必须同时含 .gwork-remote
        String fs = new String(Files.readAllBytes(Path.of(
                "src/main/java/com/gourdai/core/portal/web/FileService.java")), "UTF-8");
        String ww = new String(Files.readAllBytes(Path.of(
                "src/main/java/com/gourdai/core/portal/WorkspaceWatcher.java")), "UTF-8");
        String token = "\"" + ".gwork-remote" + "\"";
        Assertions.assertTrue(fs.contains(token), "FileService 排除清单缺 .gwork-remote");
        Assertions.assertTrue(ww.contains(token), "WorkspaceWatcher 排除清单缺 .gwork-remote");
    }

    /**
     * read() 二进制探测：含 NUL 字节的文件返回 binary 标记而非乱码内容；
     * 纯文本文件仍正常返回 content（无回归）。
     */
    @Test
    public void testReadBinaryDetection() throws Exception {
        Path root = Files.createTempDirectory("filer-binary-test");
        try {
            // 二进制文件：头部含 NUL 字节（模拟 PNG 头）
            byte[] pngLike = new byte[] { (byte) 0x89, 'P', 'N', 'G', 0x00, 0x00, 0x00, 0x0D };
            Files.write(root.resolve("logo.png"), pngLike);
            // 纯文本文件
            Files.write(root.resolve("hello.txt"), "hello world".getBytes("UTF-8"));

            FileService service = new FileService(root.toString());

            Map<String, Object> bin = service.read("logo.png", root.toString()).getData();
            Assertions.assertEquals(Boolean.TRUE, bin.get("binary"), "含 NUL 文件应标记 binary");
            Assertions.assertNull(bin.get("content"), "二进制文件不应返回乱码内容");
            Assertions.assertEquals("logo.png", bin.get("name"));

            Map<String, Object> txt = service.read("hello.txt", root.toString()).getData();
            Assertions.assertNull(txt.get("binary"), "文本文件不应带 binary 标记");
            Assertions.assertEquals("hello world", txt.get("content"));
        } finally {
            deleteRecursively(root.toFile());
        }
    }

    /**
     * resolveForRaw() 安全边界：沿用 read 同一套校验（拒绝 ..、越界、目录、不存在），
     * 合法文件返回 File 本体。
     */
    @Test
    public void testResolveForRawSecurity() throws Exception {
        Path root = Files.createTempDirectory("filer-raw-test");
        try {
            Path sub = Files.createDirectory(root.resolve("assets"));
            Files.write(sub.resolve("a.png"), new byte[] { 1, 2, 3 });

            FileService service = new FileService(root.toString());

            // 合法文件
            Result<File> ok = service.resolveForRaw("assets/a.png", root.toString());
            Assertions.assertEquals(200, ok.getCode());
            Assertions.assertNotNull(ok.getData());
            Assertions.assertEquals("a.png", ok.getData().getName());

            // .. 路径拒绝（优先命中参数校验）
            Assertions.assertEquals(400, service.resolveForRaw("../outside.png", root.toString()).getCode());
            // 越界拒绝（绝对路径指向根外，规范化后不在根内）
            Path outsideRoot = Files.createTempDirectory("filer-raw-outside");
            try {
                Path outsideFile = Files.createFile(outsideRoot.resolve("outside.png"));
                Assertions.assertEquals(403, service.resolveForRaw(outsideFile.toString(), root.toString()).getCode());
            } finally {
                deleteRecursively(outsideRoot.toFile());
            }
            // 目录拒绝
            Assertions.assertEquals(404, service.resolveForRaw("assets", root.toString()).getCode());
            // 不存在拒绝
            Assertions.assertEquals(404, service.resolveForRaw("nope.png", root.toString()).getCode());
            // 空路径拒绝
            Assertions.assertEquals(400, service.resolveForRaw("", root.toString()).getCode());
        } finally {
            deleteRecursively(root.toFile());
        }
    }

    /** contentTypeOf() MIME 映射：预览类型命中，未知扩展名回退 octet-stream */
    @Test
    public void testContentTypeOf() {
        Assertions.assertEquals("image/png", FileService.contentTypeOf("a.png"));
        Assertions.assertEquals("image/jpeg", FileService.contentTypeOf("b.JPG"));
        Assertions.assertEquals("application/pdf", FileService.contentTypeOf("doc.pdf"));
        Assertions.assertEquals("audio/mpeg", FileService.contentTypeOf("song.mp3"));
        Assertions.assertEquals("video/mp4", FileService.contentTypeOf("clip.mp4"));
        Assertions.assertEquals("application/octet-stream", FileService.contentTypeOf("archive.zip"));
        Assertions.assertEquals("application/octet-stream", FileService.contentTypeOf("noext"));
        Assertions.assertEquals("application/octet-stream", FileService.contentTypeOf(null));
    }

    private void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        f.delete();
    }
}
