package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * ProjectService 同机目录定位（locate）的纯函数语义测试。
 *
 * <p>覆盖两个 static 包可见方法：{@code normalizeFingerprint}（指纹归一化：去 null/空/隐藏名、
 * trim、大小写不敏感排序、不修改入参）与 {@code isMatch}（目录名 + 子目录指纹匹配判定，
 * 含 Windows/非 Windows 两条大小写分支、隐藏子目录不计入指纹、目录不存在）。</p>
 *
 * <p>说明：{@code locate} 的扫描 roots 来自 {@code AgentFlags.getUserHome()} 与 {@code File.listRoots()}，
 * 属于真实机器环境，单测里跑全盘 BFS 既慢又不可控，因此这里只测不依赖文件系统的纯函数部分，
 * 目录树用 {@code @TempDir} 构造。</p>
 *
 * @author oisin
 */
public class ProjectServiceLocateTest {

    @TempDir
    Path tempDir;

    // ==================== normalizeFingerprint ====================

    /**
     * 丢弃 null、空串（含纯空白）与以 '.' 开头的名字，其余 trim 保留。
     */
    @Test
    void normalizeFingerprintDropsNullBlankAndDotNames() {
        List<String> raw = Arrays.asList("src", null, "  ", "", ".git", "  dist  ", ".idea");
        List<String> rst = ProjectService.normalizeFingerprint(raw);

        Assertions.assertEquals(Arrays.asList("dist", "src"), rst);
    }

    /**
     * 排序采用大小写不敏感序：结果与入参顺序无关，且大写字母不会排到小写之前。
     */
    @Test
    void normalizeFingerprintSortsCaseInsensitively() {
        List<String> a = ProjectService.normalizeFingerprint(Arrays.asList("zeta", "Alpha", "middle"));
        List<String> b = ProjectService.normalizeFingerprint(Arrays.asList("middle", "zeta", "Alpha"));

        Assertions.assertEquals(Arrays.asList("Alpha", "middle", "zeta"), a);
        Assertions.assertEquals(a, b); // 顺序无关
    }

    /**
     * null 入参返回空列表（不抛异常），且返回的是新列表、不修改入参。
     */
    @Test
    void normalizeFingerprintHandlesNullAndDoesNotMutateInput() {
        Assertions.assertTrue(ProjectService.normalizeFingerprint(null).isEmpty());

        List<String> raw = new ArrayList<>(Arrays.asList("b", "a", ".hidden", null));
        List<String> rst = ProjectService.normalizeFingerprint(raw);

        Assertions.assertEquals(Arrays.asList("a", "b"), rst);
        // 入参保持不变（含 null 与隐藏名，顺序也不变）
        Assertions.assertEquals(4, raw.size());
        Assertions.assertEquals("b", raw.get(0));
        Assertions.assertEquals("a", raw.get(1));
        Assertions.assertEquals(".hidden", raw.get(2));
        Assertions.assertNull(raw.get(3));
        Assertions.assertNotSame(raw, rst);
    }

    // ==================== isMatch ====================

    /**
     * 建两棵目录树：a/{x,y} 与 b/{x,z}，返回 a 目录。
     */
    private File createTrees() throws Exception {
        Files.createDirectories(tempDir.resolve("a").resolve("x"));
        Files.createDirectories(tempDir.resolve("a").resolve("y"));
        Files.createDirectories(tempDir.resolve("b").resolve("x"));
        Files.createDirectories(tempDir.resolve("b").resolve("z"));
        return tempDir.resolve("a").toFile();
    }

    /**
     * 指纹顺序无关：a 的子目录是 {x,y}，传 ["y","x"] 同样命中。
     */
    @Test
    void isMatchIgnoresFingerprintOrder() throws Exception {
        File a = createTrees();
        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("y", "x"));

        Assertions.assertTrue(ProjectService.isMatch(a, "a", want, true));
    }

    /**
     * Windows 语义：目录名忽略大小写（"A" 命中磁盘上的 "a"）。
     */
    @Test
    void isMatchIsCaseInsensitiveOnWindows() throws Exception {
        File a = createTrees();
        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));

        Assertions.assertTrue(ProjectService.isMatch(a, "A", want, true));
        Assertions.assertTrue(ProjectService.isMatch(a, "a", want, true));
    }

    /**
     * 非 Windows 语义：目录名大小写敏感（"a" 命中，"A" 不命中）。
     */
    @Test
    void isMatchIsCaseSensitiveOnNonWindows() throws Exception {
        File a = createTrees();
        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));

        Assertions.assertTrue(ProjectService.isMatch(a, "a", want, false));
        Assertions.assertFalse(ProjectService.isMatch(a, "A", want, false));
    }

    /**
     * 指纹不一致（多/少/换子目录）不命中：b 的指纹是 {x,z}，与 a 的 {x,y} 不同。
     */
    @Test
    void isMatchRejectsDifferentFingerprint() throws Exception {
        File a = createTrees();
        File b = tempDir.resolve("b").toFile();
        List<String> wrong = ProjectService.normalizeFingerprint(Arrays.asList("x", "z"));

        Assertions.assertFalse(ProjectService.isMatch(a, "a", wrong, true));
        Assertions.assertFalse(ProjectService.isMatch(a, "b", wrong, true)); // 名字对不上
        Assertions.assertTrue(ProjectService.isMatch(b, "b", wrong, true)); // b 自身命中
    }

    /**
     * 隐藏子目录（'.' 开头）不计入指纹：a 下新增 .h 后仍按 {x,y} 命中。
     */
    @Test
    void isMatchIgnoresHiddenChildDirectories() throws Exception {
        File a = createTrees();
        Files.createDirectories(tempDir.resolve("a").resolve(".h"));

        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));
        Assertions.assertTrue(ProjectService.isMatch(a, "a", want, true));

        // 期望指纹里带隐藏名则不命中（浏览器端也拿不到隐藏目录）
        List<String> wantWithHidden = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));
        wantWithHidden.add(".h");
        wantWithHidden.sort(String.CASE_INSENSITIVE_ORDER);
        Assertions.assertFalse(ProjectService.isMatch(a, "a", wantWithHidden, true));
    }

    /**
     * 子集语义：期望指纹是实际指纹的子集即命中。
     *
     * <p>背景：webkitdirectory 选择路径拿不到空子目录（文件列表里不出现），提交的指纹天然是
     * 实际指纹的子集；精确相等会让「选已登记目录」这种最高频场景系统性漏配。</p>
     */
    @Test
    void isMatchAcceptsSubsetFingerprint() throws Exception {
        createTrees();                                              // a/{x,y}
        Files.createDirectories(tempDir.resolve("a").resolve("z"));   // a 实际为 {x,y,z}
        List<String> subset = ProjectService.normalizeFingerprint(Arrays.asList("y", "x"));

        Assertions.assertTrue(ProjectService.isMatch(tempDir.resolve("a").toFile(), "a", subset, true));

        // 超集/交集不命中：期望含实际没有的子目录
        List<String> superset = ProjectService.normalizeFingerprint(Arrays.asList("x", "y", "nope"));
        Assertions.assertFalse(ProjectService.isMatch(tempDir.resolve("a").toFile(), "a", superset, true));
    }

    // ==================== matchRegistered（locate 阶段一） ====================

    /**
     * 阶段一在登记表内直接比对：命中返回登记路径，未命中返回空；非法路径静默跳过。
     */
    @Test
    void matchRegisteredHitsByNameAndFingerprint() throws Exception {
        createTrees();   // a/{x,y}, b/{x,z}
        List<java.util.Map> projects = new ArrayList<>();
        java.util.Map<String, Object> pa = new java.util.LinkedHashMap<>();
        pa.put("name", "A");
        pa.put("path", tempDir.resolve("a").toString());
        java.util.Map<String, Object> pb = new java.util.LinkedHashMap<>();
        pb.put("name", "B");
        pb.put("path", tempDir.resolve("b").toString());
        java.util.Map<String, Object> bad = new java.util.LinkedHashMap<>();
        bad.put("name", "bad");
        bad.put("path", "\\\\??\\invalid\\path");
        projects.add(pa);
        projects.add(pb);
        projects.add(bad);

        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));
        List<String> hits = ProjectService.matchRegistered(projects, "a", want, true);

        Assertions.assertEquals(1, hits.size());
        Assertions.assertEquals(tempDir.resolve("a").toAbsolutePath().normalize().toString(), hits.get(0));

        // 名字对不上 → 空；null 登记表 → 空（不抛）
        Assertions.assertTrue(ProjectService.matchRegistered(projects, "zz", want, true).isEmpty());
        Assertions.assertTrue(ProjectService.matchRegistered(null, "a", want, true).isEmpty());
    }

    /**
     * 阶段一最多返回 2 条（与 locate 的早停语义一致，前端只需唯一/消歧两种交互）：
     * 三个不同父目录下的同名目录 p1/same、p2/same、p3/same（子结构同为 {k}）全部命中时截断为 2。
     */
    @Test
    void matchRegisteredCapsAtTwoCandidates() throws Exception {
        List<java.util.Map> projects = new ArrayList<>();
        for (String parent : Arrays.asList("p1", "p2", "p3")) {
            Files.createDirectories(tempDir.resolve(parent).resolve("same").resolve("k"));
            java.util.Map<String, Object> p = new java.util.LinkedHashMap<>();
            p.put("name", parent);
            p.put("path", tempDir.resolve(parent).resolve("same").toString());
            projects.add(p);
        }

        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("k"));
        List<String> hits = ProjectService.matchRegistered(projects, "same", want, true);

        Assertions.assertEquals(2, hits.size());
    }

    // ==================== scanFileSystem（locate 阶段二优先根） ====================

    /**
     * 优先根：已登记项目的父目录作为扫描根——新兄弟目录（次高频选择）无需依赖 home/盘符根的深度与预算。
     *
     * <p>证明方式：JUnit TempDir 在 Windows 上位于 AppData（SCAN_EXCLUDED）子树内，home 根与盘符根
     * 都到不了它；因此 newSib 能被命中本身就证明扫描是从「登记父目录」这个优先根出发的。
     * 构造两个同名命中目录触发早停（满 2 即 break），保证用例不会真跑全盘 BFS。</p>
     */
    @Test
    void scanFileSystemUsesRegisteredParentAsPriorityRoot() throws Exception {
        Files.createDirectories(tempDir.resolve("pa").resolve("same").resolve("k"));
        Files.createDirectories(tempDir.resolve("pb").resolve("same").resolve("k"));

        List<java.util.Map> projects = new ArrayList<>();
        for (String parent : Arrays.asList("pa", "pb")) {
            java.util.Map<String, Object> p = new java.util.LinkedHashMap<>();
            p.put("name", parent);
            p.put("path", tempDir.resolve(parent).toString());
            projects.add(p);
        }

        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("k"));
        List<String> candidates = new ArrayList<>();
        long scanned = ProjectService.scanFileSystem(projects, "same", want, true, candidates);

        // 两个同名命中 → 早停；且命中路径只能是 tempDir 下两个父目录里的 same（优先根直达）
        Assertions.assertEquals(2, candidates.size());
        Assertions.assertTrue(candidates.contains(tempDir.resolve("pa").resolve("same").toAbsolutePath().normalize().toString()));
        Assertions.assertTrue(candidates.contains(tempDir.resolve("pb").resolve("same").toAbsolutePath().normalize().toString()));
        // 早停生效：home/盘符根浅层 + 优先根两层即命中 2 个候选，访问数远小于预算上限 30000
        Assertions.assertTrue(scanned < 5000, "scanned=" + scanned);
    }

    /**
     * 目录不存在（或不是目录）时不命中；文件条目同样不命中。
     */
    @Test
    void isMatchRejectsMissingDirectory() throws Exception {
        createTrees();
        File missing = tempDir.resolve("not-exist").toFile();
        List<String> want = ProjectService.normalizeFingerprint(Arrays.asList("x", "y"));

        Assertions.assertFalse(ProjectService.isMatch(missing, "not-exist", want, true));
        Assertions.assertFalse(ProjectService.isMatch(null, "a", want, true));

        // 空目录 + 空指纹：命中（项目根下没有子目录也是合法场景）
        Files.createDirectories(tempDir.resolve("empty"));
        File empty = tempDir.resolve("empty").toFile();
        Assertions.assertTrue(ProjectService.isMatch(empty, "empty", new ArrayList<>(), true));
        Assertions.assertFalse(ProjectService.isMatch(empty, "empty", want, true));
    }
}
