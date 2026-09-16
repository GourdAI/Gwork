package labs.bot.gourdai;

import com.gourdai.core.config.entity.ModelDo;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public class ModelDoTest {
    @Test
    public void testModelDoCreation() {
        ModelDo model = new ModelDo();
        model.setName("test-name");
        model.setModel("test-model");
        model.setStandard("openai");
        model.setApiUrl("https://api.test.com");
        model.setApiKey("test-key");
        model.setScope("user");
        
        assertEquals("test-name", model.getNameOrModel());
        assertEquals("test-model", model.getModel());
        assertEquals("openai", model.getStandardOrProvider());
        assertEquals("https://api.test.com", model.getApiUrl());
        assertEquals("test-key", model.getApiKey());
        assertEquals("user", model.getScope());
        
        System.out.println("ModelDo creation test passed");
    }

    /** uidOf 必须确定性派生（跨调用/跨大小写一致），且不同渠道区分。 */
    @Test
    public void testUidOfDeterministicAndCaseInsensitive() {
        String a = ModelDo.uidOf("MAD", "gpt-5.6-sol");
        assertEquals(a, ModelDo.uidOf("MAD", "gpt-5.6-sol"), "同一 provider/model 两次派生必须一致");
        assertEquals(a, ModelDo.uidOf("mad", "GPT-5.6-SOL"), "大小写差异必须归并为同一 uid");
        assertNotEquals(a, ModelDo.uidOf("黑驴", "gpt-5.6-sol"), "不同渠道同名模型必须区分");
        assertEquals(16, a.length(), "uid 为 16 个 hex 字符");
    }

    /** stableUid 惰性缓存：首次现算回填字段，此后不再随 provider/model 字段变化。 */
    @Test
    public void testStableUidCachesDerivedValue() {
        ModelDo model = new ModelDo();
        model.setProvider("MAD");
        model.setModel("gpt-5.6-sol");
        assertNull(model.getUid(), "初始无 uid");
        String uid = model.stableUid();
        assertNotNull(uid);
        assertEquals(uid, model.getUid(), "派生后回填字段");
        model.setProvider("renamed-provider");
        assertEquals(uid, model.stableUid(), "uid 一旦存在不再随字段变化（改名身份保持）");
    }
}