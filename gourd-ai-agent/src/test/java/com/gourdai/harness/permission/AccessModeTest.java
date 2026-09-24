package com.gourdai.harness.permission;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 访问控制档位内核的契约。
 *
 * <p>这些断言锁的是「解析失败时往哪边倒」——档位来自会话快照与前端参数，
 * 属于不可信输入。倒向宽松会让脏值变成越权，倒向严格最坏只是多问一句，
 * 因此 normalize 必须是 fail-safe 的，且要有测试钉死。</p>
 */
class AccessModeTest {

    @Test
    void normalizeRecognizesBothCodesCaseInsensitively() {
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize("default"));
        Assertions.assertEquals(AccessMode.FULL, AccessMode.normalize("full"));
        Assertions.assertEquals(AccessMode.FULL, AccessMode.normalize("FULL"));
        Assertions.assertEquals(AccessMode.FULL, AccessMode.normalize("  Full  "));
    }

    @Test
    void normalizeAcceptsEnumInstanceAndName() {
        Assertions.assertEquals(AccessMode.FULL, AccessMode.normalize(AccessMode.FULL));
        // enum name 与 code 在本枚举中恰好同形，两个口径都要能认，避免调用方传错口径时静默降档
        Assertions.assertEquals(AccessMode.FULL, AccessMode.normalize("FULL"));
    }

    /**
     * 最要紧的一组：所有「读不到 / 读不懂」的情况一律回落最严档。
     *
     * <p>历史快照没有该字段（null 与空串）、前端传了拼错的码值、将来新增档位后
     * 回滚到旧版本读到未知码值——都不能变成放行。</p>
     */
    @Test
    void normalizeFailsSafeToDefault() {
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize(null));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize(""));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize("   "));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize("ful"));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize("bypassPermissions"));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize("full_access"));
        Assertions.assertEquals(AccessMode.DEFAULT, AccessMode.normalize(123));
    }

    /**
     * isAllowed 与 normalize 的取向刻意相反：接口层要能识别「传了个不存在的档位」并拒绝，
     * 否则前端字段拼错会静默退回默认档，表现为「点了完全访问但没生效」且无任何线索。
     *
     * <p>但首尾空白是宽容的：表单参数经网络传输后带空格是常态，trim 掉再匹配是合理的宽容度。</p>
     */
    @Test
    void isAllowedStaysStrictForApiValidation() {
        Assertions.assertTrue(AccessMode.isAllowed("default"));
        Assertions.assertTrue(AccessMode.isAllowed("full"));
        Assertions.assertTrue(AccessMode.isAllowed("FULL"));
        Assertions.assertTrue(AccessMode.isAllowed(" default "));

        Assertions.assertFalse(AccessMode.isAllowed(null));
        Assertions.assertFalse(AccessMode.isAllowed(""));
        Assertions.assertFalse(AccessMode.isAllowed("  "));
        Assertions.assertFalse(AccessMode.isAllowed("everything"));
        Assertions.assertFalse(AccessMode.isAllowed("full_access"));
        Assertions.assertFalse(AccessMode.isAllowed("bypassPermissions"));
    }

    @Test
    void codeAndIsFullAreStable() {
        Assertions.assertEquals("default", AccessMode.DEFAULT.code());
        Assertions.assertEquals("full", AccessMode.FULL.code());
        Assertions.assertFalse(AccessMode.DEFAULT.isFull());
        Assertions.assertTrue(AccessMode.FULL.isFull());
    }

    /**
     * 键值三兄弟必须同值：ATTR_KEY 同时用于工具透传与 Prompt 属性透传。
     *
     * <p>若两处不同值，会出现「提示词说严禁绝对路径、实际却已放行」的自相矛盾——
     * 模型据错误先验自我设限，完全访问档等于白开。</p>
     */
    @Test
    void transportKeysAreAligned() {
        Assertions.assertEquals(AccessMode.ATTR_KEY, AccessMode.PROMPT_ATTR_KEY,
                "toolContext 与 Prompt 属性的档位键必须同值，否则提示词与真实放行会不一致");
        Assertions.assertEquals("_access_mode", AccessMode.CTX_KEY);
        Assertions.assertEquals("__accessMode", AccessMode.ATTR_KEY);
    }
}
