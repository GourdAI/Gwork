package com.gourdai.core.portal.web.model;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ModelsFetchReasonTest {
    @Test void classifiesStatuses() {
        assertNull(ModelsFetchReason.ofStatus(200));
        assertNull(ModelsFetchReason.ofStatus(299));
        assertEquals(ModelsFetchReason.AUTH_FAILED, ModelsFetchReason.ofStatus(401));
        assertEquals(ModelsFetchReason.AUTH_FAILED, ModelsFetchReason.ofStatus(403));
        assertEquals(ModelsFetchReason.AUTH_FAILED, ModelsFetchReason.ofStatus(407));
        assertEquals(ModelsFetchReason.NOT_SUPPORTED, ModelsFetchReason.ofStatus(404));
        assertEquals(ModelsFetchReason.NOT_SUPPORTED, ModelsFetchReason.ofStatus(405));
        assertEquals(ModelsFetchReason.NOT_SUPPORTED, ModelsFetchReason.ofStatus(501));
        assertEquals(ModelsFetchReason.TIMEOUT, ModelsFetchReason.ofStatus(408));
        assertEquals(ModelsFetchReason.TIMEOUT, ModelsFetchReason.ofStatus(504));
        assertEquals(ModelsFetchReason.RATE_LIMITED, ModelsFetchReason.ofStatus(429));
        assertEquals(ModelsFetchReason.UPSTREAM_ERROR, ModelsFetchReason.ofStatus(500));
        assertEquals(ModelsFetchReason.BAD_STATUS, ModelsFetchReason.ofStatus(400));
    }
}
