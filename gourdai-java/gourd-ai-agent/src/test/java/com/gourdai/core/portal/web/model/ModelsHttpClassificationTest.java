package com.gourdai.core.portal.web.model;

import org.junit.jupiter.api.Test;

import javax.net.ssl.SSLHandshakeException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.*;

class ModelsHttpClassificationTest {
    @Test void classifiesWrappedTransportFailures() {
        assertEquals(ModelsFetchReason.DNS_FAILED, ModelsHttp.classifyTransport(new RuntimeException(new UnknownHostException())));
        assertEquals(ModelsFetchReason.TLS_ERROR, ModelsHttp.classifyTransport(new RuntimeException(new SSLHandshakeException("x"))));
        assertEquals(ModelsFetchReason.CONNECT_TIMEOUT, ModelsHttp.classifyTransport(new SocketTimeoutException("connect timed out")));
        assertEquals(ModelsFetchReason.READ_TIMEOUT, ModelsHttp.classifyTransport(new SocketTimeoutException("timeout")));
        assertEquals(ModelsFetchReason.CONNECT_TIMEOUT, ModelsHttp.classifyTransport(new ConnectException("connection timed out")));
        assertEquals(ModelsFetchReason.CONNECT_REFUSED, ModelsHttp.classifyTransport(new ConnectException("Connection refused")));
        assertEquals(ModelsFetchReason.NETWORK_ERROR, ModelsHttp.classifyTransport(new NoRouteToHostException()));
        assertEquals(ModelsFetchReason.READ_TIMEOUT, ModelsHttp.classifyTransport(new InterruptedIOException()));
        assertEquals(ModelsFetchReason.READ_TIMEOUT, ModelsHttp.classifyTransport(new TimeoutException()));
        assertEquals(ModelsFetchReason.NETWORK_ERROR, ModelsHttp.classifyTransport(new RuntimeException()));
    }

    @Test void validatesUrls() {
        assertEquals("https://localhost:11434", ModelsHttp.requireHttpUrl("https://localhost:11434", "t"));
        assertThrows(ModelsFetchException.class, () -> ModelsHttp.requireHttpUrl("ftp://host", "t"));
        assertThrows(ModelsFetchException.class, () -> ModelsHttp.requireHttpUrl("https：//host", "t"));
        assertThrows(ModelsFetchException.class, () -> ModelsHttp.requireHttpUrl("https://host?q=1", "t"));
    }
}
