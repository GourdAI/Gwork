package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;

/**
 * {@link GitService#parseNumstat} 的聚焦测试（纯字符串 seam，不 spawn 真 git）。
 *
 * <p><b>WHY</b>：监控面板环境区首行的彩色「+N -M」来自 {@code git diff HEAD --numstat}
 * 的聚合值；聚合逻辑若把二进制文件的 {@code -} 计数或畸形行计入，面板会展示错误行数。
 * 与 {@code GitServiceRemoteInfoTest} 同纪律：解析逻辑抽成静态 seam 后无需真仓库即可
 * 覆盖全部分支。</p>
 */
class GitServiceNumstatTest {

    @Test
    void sumsAdditionsAndDeletionsAcrossRows() {
        int[] r = GitService.parseNumstat(Arrays.asList("3\t1\tsrc/a.java", "10\t20\tsrc/b.java"));
        Assertions.assertEquals(13, r[0]);
        Assertions.assertEquals(21, r[1]);
    }

    @Test
    void binaryDashCountsAsZero() {
        // git 对二进制文件输出 "-\t-\t<path>"，与 GitHub 同口径按 0 计
        int[] r = GitService.parseNumstat(Arrays.asList("-\t-\tassets/logo.png", "4\t0\tsrc/c.java"));
        Assertions.assertEquals(4, r[0]);
        Assertions.assertEquals(0, r[1]);
    }

    @Test
    void renameRowWithTabsInPathOnlyReadsFirstTwoColumns() {
        int[] r = GitService.parseNumstat(Collections.singletonList("2\t2\told.java => new.java"));
        Assertions.assertEquals(2, r[0]);
        Assertions.assertEquals(2, r[1]);
    }

    @Test
    void blankAndMalformedLinesAreSkipped() {
        int[] r = GitService.parseNumstat(Arrays.asList("", "garbage", "7", "5\t6\tsrc/d.java"));
        Assertions.assertEquals(5, r[0]);
        Assertions.assertEquals(6, r[1]);
    }

    @Test
    void emptyOrNullInputIsZeroZero() {
        Assertions.assertArrayEquals(new int[]{0, 0}, GitService.parseNumstat(Collections.emptyList()));
        Assertions.assertArrayEquals(new int[]{0, 0}, GitService.parseNumstat(null));
    }
}
