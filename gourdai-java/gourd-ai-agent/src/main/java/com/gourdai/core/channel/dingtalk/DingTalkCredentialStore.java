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
package com.gourdai.core.channel.dingtalk;

import org.noear.snack4.ONode;
import com.gourdai.core.channel.AbstractCredentialStore;
import com.gourdai.harness.HarnessEngine;

import java.nio.file.Paths;

/**
 * 钉钉凭据持久化存储
 *
 * <p>将 sessionId -&gt; DingTalkBinding 的映射保存到本地文件，
 * 确保重启后已绑定的钉钉通道自动恢复。DingTalkBinding 中包含 appKey/appSecret，
 * 重启后可据此自动恢复 Stream 连接。</p>
 *
 * @author oisin
 */
public class DingTalkCredentialStore extends AbstractCredentialStore<DingTalkLink.DingTalkBinding> {
    private static final String STORE_FILE = "dingtalk-bindings.json";

    public DingTalkCredentialStore(HarnessEngine engine) {
        super(Paths.get(engine.getUserDir(), engine.getHarnessChannels()), STORE_FILE);
    }

    @Override
    protected String logTag() {
        return "DingTalkStore";
    }

    @Override
    protected DingTalkLink.DingTalkBinding fromNode(ONode node) {
        DingTalkLink.DingTalkBinding binding = new DingTalkLink.DingTalkBinding();
        binding.userId = node.get("userId").getString();
        binding.robotCode = node.get("robotCode").getString();
        binding.lastMessageId = node.get("lastMessageId").getString();
        binding.appKey = node.get("appKey").getString();
        binding.appSecret = node.get("appSecret").getString();

        if (binding.userId == null || binding.userId.isEmpty()) {
            return null;
        }
        return binding;
    }

    @Override
    protected void toNode(ONode node, DingTalkLink.DingTalkBinding binding) {
        node.set("userId", binding.userId);
        node.set("robotCode", binding.robotCode);
        node.set("lastMessageId", binding.lastMessageId);
        node.set("appKey", binding.appKey);
        node.set("appSecret", binding.appSecret);
    }
}
