/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.channel.feishu;

import org.noear.snack4.ONode;
import com.gourdai.core.channel.AbstractCredentialStore;
import com.gourdai.harness.HarnessEngine;

import java.nio.file.Paths;

/**
 * 飞书凭据持久化存储
 *
 * <p>将 sessionId -&gt; FeishuBinding 的映射保存到本地文件，
 * 确保重启后已绑定的飞书通道自动恢复。FeishuBinding 中包含 appId/appSecret，
 * 重启后可据此自动恢复 WebSocket 连接。</p>
 *
 * @author oisin
 */
public class FeishuCredentialStore extends AbstractCredentialStore<FeishuLink.FeishuBinding> {
    private static final String STORE_FILE = "feishu-bindings.json";

    public FeishuCredentialStore(HarnessEngine engine) {
        super(Paths.get(engine.getUserDir(), engine.getHarnessChannels()), STORE_FILE);
    }

    @Override
    protected String logTag() {
        return "FeishuStore";
    }

    @Override
    protected FeishuLink.FeishuBinding fromNode(ONode node) {
        FeishuLink.FeishuBinding binding = new FeishuLink.FeishuBinding();
        binding.openId = node.get("openId").getString();
        binding.lastMessageId = node.get("lastMessageId").getString();
        binding.appId = node.get("appId").getString();
        binding.appSecret = node.get("appSecret").getString();

        if (binding.openId == null || binding.openId.isEmpty()) {
            return null;
        }
        return binding;
    }

    @Override
    protected void toNode(ONode node, FeishuLink.FeishuBinding binding) {
        node.set("openId", binding.openId);
        node.set("lastMessageId", binding.lastMessageId != null ? binding.lastMessageId : "");
        node.set("appId", binding.appId);
        node.set("appSecret", binding.appSecret);
    }
}
