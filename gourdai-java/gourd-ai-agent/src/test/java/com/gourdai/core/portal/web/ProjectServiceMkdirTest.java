package com.gourdai.core.portal.web;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.Result;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * {@link ProjectService#mkdir(String, String)} 语义测试。
 *
 * <p>该端点为远程连接向导「选目录」步与目录浏览器「新建文件夹」而加，核心不变量是
 * <b>建目录但不登记为项目</b>——这正是它与 {@link ProjectService#create(String, String)}
 * 的唯一但关键的区别（create 末尾 {@code return add(...)} 会顺带登记并置顶）。</p>
 *
 * <p>为什么必须分开：目录浏览器里的「新建文件夹」是<b>导航途中</b>动作，用户往往只是
 * 建个中间层目录再往里进。若复用 create，每建一层就往工作区下拉塞一条垃圾项目条目；
 * 远程场景更糟——登记会写进<b>远端</b> projects.json，本地列表扇出拉取后冒出一堆
 * 无意义的远端项目。登记应只由用户最终「选定此目录」触发。</p>
 *
 * <p>覆盖：不登记不变量（含与 create 的对照）、目录确实建成、返回值形状、
 * 空名/非法字符/父目录不存在/目录已存在四类失败、路径穿越防御、幂等重跑安全。</p>
 *
 * @author oisin
 */
public class ProjectServiceMkdirTest {
    private Path root;
    private String originalGwork;

    @BeforeEach
    void setUp() throws Exception {
        originalGwork = System.getProperty("gwork.home");
        root = Files.createTempDirectory("project-mkdir-test");
        System.setProperty("gwork.home", root.toString());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (originalGwork != null) {
            System.setProperty("gwork.home", originalGwork);
        } else {
            System.clearProperty("gwork.home");
        }
        deleteRecursively(root);
    }

    /**
     * 核心不变量：mkdir 建出目录，但项目列表<b>不增加</b>（不登记）。
     *
     * <p>这是本端点存在的全部理由。若哪天有人「顺手复用 create」或加一句 add，
     * 这条会立刻红——而用户侧的症状是工作区下拉里多出一堆他只想临时建来放东西的目录。</p>
     */
    @Test
    void mkdirCreatesDirectoryWithoutRegisteringProject() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("workspaces");

        // 先有一个已登记项目，确保列表非空（否则「列表没变」可能只是空集自比）
        Result<List<Map>> before = service.add(parent.toString(), null);
        Assertions.assertEquals(200, before.getCode());
        int beforeCount = service.list().getData().size();
        Assertions.assertTrue(beforeCount >= 1, "前置：应至少有一个已登记项目");

        Result<Map> rst = service.mkdir(parent.toString(), "new-folder");
        Assertions.assertEquals(200, rst.getCode(), "mkdir 应成功");
        Assertions.assertTrue(Files.isDirectory(parent.resolve("new-folder")), "目录应真实建成");

        int afterCount = service.list().getData().size();
        Assertions.assertEquals(beforeCount, afterCount,
                "mkdir 不得登记为项目（登记只由「选定此目录」触发）：列表条数应保持不变");
        for (Map<?, ?> p : service.list().getData()) {
            Assertions.assertFalse(String.valueOf(p.get("path")).endsWith("new-folder"),
                    "mkdir 新建的目录不得出现在项目列表里");
        }
    }

    /**
     * 对照组：create 会登记（证明 mkdir 与 create 的差异是真实的、被测出来的，
     * 而不是两者都不登记导致断言恒真）。
     */
    @Test
    void createRegistersProjectWhileMkdirDoesNot() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("compare");

        Result<List<Map>> created = service.create(parent.toString(), "via-create");
        Assertions.assertEquals(200, created.getCode());
        Assertions.assertTrue(Files.isDirectory(parent.resolve("via-create")));
        Assertions.assertTrue(created.getData().stream()
                        .anyMatch(p -> String.valueOf(p.get("path")).endsWith("via-create")),
                "create 必须登记（既有语义，本测试仅作对照）");

        Result<Map> mkdirRst = service.mkdir(parent.toString(), "via-mkdir");
        Assertions.assertEquals(200, mkdirRst.getCode());
        Assertions.assertTrue(Files.isDirectory(parent.resolve("via-mkdir")));
        Assertions.assertFalse(service.list().getData().stream()
                        .anyMatch(p -> String.valueOf(p.get("path")).endsWith("via-mkdir")),
                "mkdir 必须不登记——与 create 的行为差异是本端点的全部意义");
    }

    /**
     * 连续建多层中间目录都不污染项目列表（模拟用户在目录浏览器里逐级新建的真实用法）。
     */
    @Test
    void repeatedMkdirOfIntermediateDirsKeepsProjectListClean() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("deep");
        int base = service.list().getData().size();

        Path cur = parent;
        for (String name : new String[]{"a", "b", "c", "d"}) {
            Result<Map> rst = service.mkdir(cur.toString(), name);
            Assertions.assertEquals(200, rst.getCode(), "第 " + name + " 层应建成");
            cur = cur.resolve(name);
            Assertions.assertTrue(Files.isDirectory(cur));
        }

        Assertions.assertEquals(base, service.list().getData().size(),
                "建了 4 层中间目录，项目列表一条都不该多");
    }

    /**
     * 返回值形状：前端靠 data.path 决定「建完后进入哪个目录」，
     * 必须是后端规范化后的绝对路径（大小写/分隔符归一），不能是前端拼的。
     */
    @Test
    void mkdirReturnsNormalizedAbsolutePathAndName() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("ret");

        Result<Map> rst = service.mkdir(parent.toString(), "  spaced-name  ");
        Assertions.assertEquals(200, rst.getCode());
        Map<?, ?> data = rst.getData();
        Assertions.assertNotNull(data, "成功时必须回 data");
        String path = String.valueOf(data.get("path"));
        String name = String.valueOf(data.get("name"));

        Assertions.assertEquals("spaced-name", name, "name 应 trim 后回传");
        Assertions.assertTrue(Files.isDirectory(Path.of(path)), "回传的 path 必须是真实存在的目录");
        Assertions.assertTrue(Path.of(path).isAbsolute(), "path 必须是绝对路径");
        Assertions.assertEquals(parent.resolve("spaced-name").toAbsolutePath().normalize(),
                Path.of(path).normalize(), "path 应等于父目录 + trim 后的名字");
        Assertions.assertFalse(path.contains(".."), "path 不得含 .. 残段");
    }

    /**
     * 名称为空/纯空白：400（不静默成功建出无名目录）。
     */
    @Test
    void mkdirRejectsEmptyName() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("empty");
        Assertions.assertEquals(400, service.mkdir(parent.toString(), null).getCode());
        Assertions.assertEquals(400, service.mkdir(parent.toString(), "").getCode());
        Assertions.assertEquals(400, service.mkdir(parent.toString(), "   ").getCode());
        Assertions.assertEquals(0, countChildren(parent), "失败时不得建出任何目录");
    }

    /**
     * 非法字符：路径分隔符与 {@code ..}、{@code :} 一律拒（与 create 同口径，
     * 避免「create 严格、mkdir 宽松」的双标绕过面）。
     */
    @Test
    void mkdirRejectsIllegalNameCharacters() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("illegal");

        for (String bad : new String[]{"..", "a/b", "a\\b", "..\\evil", "../evil", "C:x", "a:b"}) {
            Result<Map> rst = service.mkdir(parent.toString(), bad);
            Assertions.assertEquals(400, rst.getCode(), "非法名应被拒: " + bad);
        }
        Assertions.assertEquals(0, countChildren(parent), "任何非法名都不得建出目录");
    }

    /**
     * 路径穿越防御：即使名字看着合法，拼接后逃出父目录也必须拒。
     * （二次校验 target.startsWith(parentDir)，防御编码绕过）
     */
    @Test
    void mkdirCannotEscapeParentDirectory() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("escape");
        Path sibling = root.resolve("ws").resolve("sibling");

        // 父目录本身含 .. 段：直接判非法
        Assertions.assertEquals(400, service.mkdir(parent.toString() + "/../..", "x").getCode());

        // 正常父目录 + 纯名，不得在父目录之外落盘
        Result<Map> rst = service.mkdir(parent.toString(), "ok-name");
        Assertions.assertEquals(200, rst.getCode());
        Assertions.assertTrue(Files.isDirectory(parent.resolve("ok-name")));
        Assertions.assertFalse(Files.exists(sibling), "不得在父目录之外建东西");
    }

    /**
     * 父目录不存在：404（不是 500，也不是静默成功）。
     */
    @Test
    void mkdirRejectsMissingParent() throws Exception {
        ProjectService service = new ProjectService();
        Path missing = root.resolve("ws").resolve("no-such-parent");
        Result<Map> rst = service.mkdir(missing.toString(), "child");
        Assertions.assertEquals(404, rst.getCode());
        Assertions.assertFalse(Files.exists(missing), "父目录不存在时不得顺手把它建出来");
    }

    /**
     * 父目录是文件而非目录：404（避免把文件当目录用导致更晦涩的 IO 异常）。
     */
    @Test
    void mkdirRejectsFileAsParent() throws Exception {
        ProjectService service = new ProjectService();
        Path file = root.resolve("a-file.txt");
        Files.writeString(file, "not a dir");
        Assertions.assertEquals(404, service.mkdir(file.toString(), "child").getCode());
    }

    /**
     * 目标已存在：400 且明示「目录已存在」。
     *
     * <p>不能静默成功：静默会让用户以为建好了自己的新目录，随后「选定此目录」进入的
     * 却是别人的既有目录（远程场景下尤其危险——可能是别人的部署目录）。</p>
     */
    @Test
    void mkdirRejectsExistingDirectory() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("exists");
        Files.createDirectories(parent.resolve("taken"));

        Result<Map> rst = service.mkdir(parent.toString(), "taken");
        Assertions.assertEquals(400, rst.getCode());
        Assertions.assertTrue(String.valueOf(rst.getDescription()).contains("已存在"),
                "错误文案应明确指向「已存在」，让用户知道该换个名字");
    }

    /**
     * 目标名与既有<b>文件</b>同名：同样拒（否则用户以为建了目录，实际指向一个文件，
     * 后续 browse 会 404，错误现场离根因很远）。
     */
    @Test
    void mkdirRejectsNameCollidingWithFile() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("collision");
        Files.writeString(parent.resolve("README.md"), "x");

        Result<Map> rst = service.mkdir(parent.toString(), "README.md");
        Assertions.assertEquals(400, rst.getCode());
        Assertions.assertTrue(Files.isRegularFile(parent.resolve("README.md")), "既有文件不得被动过");
    }

    /**
     * 名称首尾空白 trim：与 create 同口径（用户在输入框里带出尾随空格很常见）。
     */
    @Test
    void mkdirTrimsName() throws Exception {
        ProjectService service = new ProjectService();
        Path parent = createProjectDir("trim");

        Result<Map> rst = service.mkdir(parent.toString(), "  proj-x  ");
        Assertions.assertEquals(200, rst.getCode());
        Assertions.assertTrue(Files.isDirectory(parent.resolve("proj-x")), "应按 trim 后的名字建");
        /* 断言「只建了 trim 后的那一个」而不是去 resolve 带空格的名字：
           Windows 下尾随空格是非法路径字符，parent.resolve("  proj-x  ") 会直接抛
           InvalidPathException（首版就是这里报错，属测试自身缺陷，不是产品缺陷）。
           列目录比名字更直接地表达了意图：不得多出任何带空格的目录。 */
        try (Stream<Path> s = Files.list(parent)) {
            List<String> names = s.map(p -> p.getFileName().toString()).sorted().toList();
            Assertions.assertEquals(List.of("proj-x"), names,
                    "只应存在 trim 后的目录，不得按原始带空格名建");
        }
    }

    /**
     * 父目录为空/空白时回落用户主目录（与 create 同默认），且仍然不登记。
     */
    @Test
    void mkdirDefaultsToUserHomeWhenParentBlank() throws Exception {
        ProjectService service = new ProjectService();
        Path home = Path.of(System.getProperty("gwork.home"));
        // gwork.home 被指向临时目录，AgentFlags.getUserHome 亦随之落在临时区内
        int base = service.list().getData().size();

        Result<Map> rst = service.mkdir("", "home-child-" + System.nanoTime());
        Assertions.assertEquals(200, rst.getCode(), "空父目录应回落到用户主目录而非失败");
        Assertions.assertEquals(base, service.list().getData().size(), "默认父目录路径同样不得登记");
        Assertions.assertTrue(Files.isDirectory(Path.of(String.valueOf(rst.getData().get("path")))));
        Assertions.assertNotNull(home);
    }

    private Path createProjectDir(String name) throws Exception {
        Path dir = root.resolve("ws").resolve(name);
        Files.createDirectories(dir);
        return dir.toAbsolutePath().normalize();
    }

    private static int countChildren(Path dir) throws Exception {
        if (!Files.exists(dir)) return 0;
        try (Stream<Path> s = Files.list(dir)) {
            return (int) s.count();
        }
    }

    private static void deleteRecursively(Path path) throws Exception {
        if (path == null || !Files.exists(path)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(path)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                    // 临时目录清理尽力而为（Windows 文件锁可能残留，不影响断言）
                }
            });
        }
    }
}
