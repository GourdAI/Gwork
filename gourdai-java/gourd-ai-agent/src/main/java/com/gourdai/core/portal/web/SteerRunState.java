package com.gourdai.core.portal.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 单个 run 独占的插话邮箱状态。
 *
 * <p>所有方法都只允许在 WebGate 的 session inputLock 内调用；邮箱与 runId 绑定，
 * 旧 run 的结束回调无法摘取新 run 的插话。</p>
 */
final class SteerRunState {
    enum Lifecycle { RUNNING, ENDED, CANCELLED }

    final String runId;
    final Map<String, SteerEnvelope> pending = new LinkedHashMap<>();
    Lifecycle lifecycle = Lifecycle.RUNNING;

    SteerRunState(String runId) {
        this.runId = runId;
    }

    List<SteerEnvelope> drain() {
        List<SteerEnvelope> items = new ArrayList<>(pending.values());
        pending.clear();
        return items;
    }
}
