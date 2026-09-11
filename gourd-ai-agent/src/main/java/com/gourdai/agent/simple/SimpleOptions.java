package com.gourdai.agent.simple;

import com.gourdai.agent.event.AgentEvent;
import org.noear.solon.ai.chat.ModelOptionsAmend;
import org.noear.solon.lang.Preview;
import reactor.core.publisher.FluxSink;

/**
 * 简单智能体运行选项
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class SimpleOptions extends ModelOptionsAmend<SimpleOptions, SimpleInterceptor> {
    private transient FluxSink<AgentEvent> streamSink;

    protected void setStreamSink(FluxSink<AgentEvent> streamSink) {
        this.streamSink = streamSink;
    }

    public FluxSink<AgentEvent> getStreamSink() {
        return streamSink;
    }

    protected SimpleOptions copy() {
        SimpleOptions tmp = new SimpleOptions();
        tmp.putAll(this);

        return tmp;
    }
}