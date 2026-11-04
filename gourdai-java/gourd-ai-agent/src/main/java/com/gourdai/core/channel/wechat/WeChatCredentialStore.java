/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.core.channel.wechat;

import org.noear.snack4.ONode;
import com.gourdai.core.channel.AbstractCredentialStore;
import com.gourdai.harness.HarnessEngine;

import java.nio.file.Paths;

/**
 * 微信凭据持久化存储
 *
 * <p>将 sessionId -&gt; WeChatBinding 的映射保存到本地文件，
 * 确保重启后已绑定的微信通道自动恢复。</p>
 *
 * @author oisin
 */
public class WeChatCredentialStore extends AbstractCredentialStore<WeChatLink.WeChatBinding> {
    private static final String STORE_FILE = "wechat-bindings.json";

    public WeChatCredentialStore(HarnessEngine engine) {
        super(Paths.get(engine.getUserDir(), engine.getHarnessChannels()), STORE_FILE);
    }

    @Override
    protected String logTag() {
        return "WeChatStore";
    }

    @Override
    protected WeChatLink.WeChatBinding fromNode(ONode node) {
        WeChatLink.WeChatBinding binding = new WeChatLink.WeChatBinding();
        binding.botToken = node.get("botToken").getString();
        binding.ilinkBotId = node.get("ilinkBotId").getString();
        binding.ilinkUserId = node.get("ilinkUserId").getString();
        binding.cursor = node.get("cursor").getString();
        binding.lastContextToken = node.get("lastContextToken").getString();
        binding.lastFromUserId = node.get("lastFromUserId").getString();

        if (binding.botToken == null || binding.botToken.isEmpty()) {
            return null;
        }
        return binding;
    }

    @Override
    protected void toNode(ONode node, WeChatLink.WeChatBinding binding) {
        node.set("botToken", binding.botToken);
        node.set("ilinkBotId", binding.ilinkBotId);
        node.set("ilinkUserId", binding.ilinkUserId);
        node.set("cursor", binding.cursor);
        node.set("lastContextToken", binding.lastContextToken);
        node.set("lastFromUserId", binding.lastFromUserId);
    }
}
