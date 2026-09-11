package com.gourdai.core.config;

import com.gourdai.core.config.entity.*;
import lombok.Getter;
import lombok.Setter;
import org.noear.solon.core.util.Assert;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.solon.ai.talents.mount.MountType;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.Serializable;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

/**
 * 对应 <安装目录>/.gourdai/settings.json
 * <p>统一管理 LLM 模型、MCP 服务器、OpenApi 服务器的持久化配置。</p>
 *
 * @author oisin
 */
@Getter
@Setter
public class AgentSettings implements Serializable {
    private static final Logger LOG = LoggerFactory.getLogger(AgentSettings.class);

    //general 常规
    private final GeneralGroupDo general = new GeneralGroupDo();
    //permission 权限
    private final PermissionGroupDo permission = new PermissionGroupDo();

    //defaultModel
    private String defaultModel;
    //models
    /**
     * 模型表：key = 模型名，value = 模型配置。
     *
     * <p><b>并发约定（copy-on-write）</b>：多个 HTTP 线程与 ManagerTalent 工具线程会并发读写本字段。
     * 所有结构性修改都必须持有本实例锁（下述方法均为 {@code synchronized}，可重入），并遵循
     * 「先复制、再改副本、最后整体替换引用」：绝不在原 map 上就地增删。配合 {@code volatile} 发布，
     * 未持锁的读线程（{@code getModels()} 的迭代、JSON 序列化）拿到的永远是一个完整快照，
     * 既不会 ConcurrentModificationException，也不会看到改到一半的中间态或被并发覆盖。</p>
     */
    private volatile Map<String, ModelDo> models = new LinkedHashMap<>();

    /**
     * 本会话配置加载失败标志。
     *
     * <p>为 true 表示磁盘上的 settings.json 没能正确读出来（JSON 损坏/被截断/IO 异常），
     * 内存里现在只是兜底的空配置。此时 {@link #saveToFile()} 一律拒绝回写——否则随后任意一次
     * saveSettings() 就会用空配置覆盖原文件，用户全部模型配置与 apiKey 永久丢失。</p>
     *
     * <p>解除方式：从同目录的 {@code settings.json.corrupt-<yyyyMMddHHmmss>} 备份恢复出可用的
     * settings.json（或确认可以丢弃后删除该备份），再重启应用重新加载。当前没有「强制回写」入口，
     * 故一律保护。</p>
     */
    private volatile boolean loadFailed;

    /** 损坏配置备份文件名的时间戳后缀格式：{@code settings.json.corrupt-20260910153000} */
    private static final DateTimeFormatter CORRUPT_BACKUP_STAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    //挂载
    private Map<String, MountDo> mountPools = new LinkedHashMap<>();

    //mcp集
    private Map<String, McpServerDo> mcpServers = new LinkedHashMap<>();
    //api集
    private Map<String, ApiSourceDo> apiServers = new LinkedHashMap<>();
    //lsp集
    private Map<String, LspServerDo> lspServers = new LinkedHashMap<>();
    //供应商集（与 models 相同，结构和值修改均通过封装方法 COW 发布）
    private volatile Map<String, ProviderDo> providers = new LinkedHashMap<>();

    /** 内置连接：官方托管入口名称（锁定，不可改名/删除） */
    public static final String BUILTIN_PROVIDER_NAME = "GWork";
    /** 内置连接：品牌升级前的旧名称（仅用于存量配置迁移："Gourd AI" → "GWork"） */
    public static final String LEGACY_BUILTIN_PROVIDER_NAME = "Gourd AI";
    /** 内置连接：官方托管入口 API 地址（锁定，不可修改） */
    public static final String BUILTIN_PROVIDER_API_URL = "https://www.gourd-ai.cn";

    /**
     * 确保内置连接常驻：不存在则注入，存在则强制回写锁定字段（名称/地址/builtin 标记），
     * 同时保留用户可改字段（密钥、超时、作用域、启停、模型列表）。
     *
     * <p>密钥默认留空，由用户自行填写。每次启动加载后调用，实现"内置常驻、自动重建"。</p>
     */
    public synchronized void ensureBuiltinProviders() {
        Map<String, ProviderDo> rebuilt = new LinkedHashMap<>(providers);
        ProviderDo legacy = rebuilt.get(LEGACY_BUILTIN_PROVIDER_NAME);
        if (legacy != null) {
            if (rebuilt.containsKey(BUILTIN_PROVIDER_NAME) == false) {
                rebuilt.remove(LEGACY_BUILTIN_PROVIDER_NAME);
                ProviderDo migrated = copyProvider(legacy);
                migrated.setName(BUILTIN_PROVIDER_NAME);
                rebuilt.put(BUILTIN_PROVIDER_NAME, migrated);
            } else {
                ProviderDo ordinary = copyProvider(legacy);
                ordinary.setBuiltin(false);
                rebuilt.put(LEGACY_BUILTIN_PROVIDER_NAME, ordinary);
            }
        }

        ProviderDo existing = rebuilt.get(BUILTIN_PROVIDER_NAME);
        if (existing == null) {
            existing = new ProviderDo();
            existing.setStandard("openai");
            existing.setApiKey("");
            existing.setEnabled(true);
            existing.setScope(AgentFlags.SCOPE_USER);
        } else {
            existing = copyProvider(existing);
        }
        existing.setName(BUILTIN_PROVIDER_NAME);
        existing.setApiUrl(BUILTIN_PROVIDER_API_URL);
        existing.setBuiltin(true);
        rebuilt.put(BUILTIN_PROVIDER_NAME, existing);
        this.providers = rebuilt;
    }

    private static ModelDo copyModel(ModelDo source) {
        return new ONode().fill(source).toBean(ModelDo.class);
    }

    private static ProviderDo copyProvider(ProviderDo source) {
        return new ONode().fill(source).toBean(ProviderDo.class);
    }

    /** 新增或替换 provider；结构和值均以新快照发布。 */
    public synchronized void putProvider(String name, ProviderDo provider) {
        Map<String, ProviderDo> rebuilt = new LinkedHashMap<>(providers);
        rebuilt.put(name, copyProvider(provider));
        this.providers = rebuilt;
    }

    /** 原位替换 provider，支持改名并保留其在 LinkedHashMap 中的位置。 */
    public synchronized boolean replaceProvider(String oldName, String newName, ProviderDo provider) {
        if (providers.containsKey(oldName) == false) {
            return false;
        }
        if (oldName.equals(newName) == false && providers.containsKey(newName)) {
            return false;
        }
        Map<String, ProviderDo> rebuilt = new LinkedHashMap<>();
        for (Map.Entry<String, ProviderDo> entry : providers.entrySet()) {
            if (entry.getKey().equals(oldName)) {
                rebuilt.put(newName, copyProvider(provider));
            } else {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }
        this.providers = rebuilt;
        return true;
    }

    /** COW 更新 provider 启用状态，返回发布后的副本。 */
    public synchronized ProviderDo setProviderEnabled(String name, boolean enabled) {
        ProviderDo current = providers.get(name);
        if (current == null) {
            return null;
        }
        ProviderDo changed = copyProvider(current);
        changed.setEnabled(enabled);
        Map<String, ProviderDo> rebuilt = new LinkedHashMap<>(providers);
        rebuilt.put(name, changed);
        this.providers = rebuilt;
        return changed;
    }

    /** COW 更新单模型启用状态，返回发布后的副本。 */
    public synchronized ModelDo setModelEnabled(String key, boolean enabled) {
        ModelDo current = models.get(key);
        if (current == null) {
            return null;
        }
        ModelDo changed = copyModel(current);
        changed.setEnabled(enabled);
        Map<String, ModelDo> rebuilt = new LinkedHashMap<>(models);
        rebuilt.put(key, changed);
        this.models = rebuilt;
        return changed;
    }

    /** COW 更新 provider 名下模型可见性，一次性发布完整 models 快照。 */
    public synchronized List<ModelDo> setProviderModelsVisible(String providerName,
                                                                boolean providerEnabled,
                                                                Map<String, Boolean> modelEnabled) {
        Map<String, ModelDo> rebuilt = new LinkedHashMap<>(models);
        List<ModelDo> changedModels = new ArrayList<>();
        String prefix = providerName + "-";
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            ModelDo current = entry.getValue();
            if (providerName.equals(current.getProvider()) == false) {
                continue;
            }
            Boolean enabled = current.getName() != null && current.getName().startsWith(prefix)
                    ? modelEnabled.get(current.getName().substring(prefix.length())) : null;
            ModelDo changed = copyModel(current);
            changed.setVisibled(providerEnabled && (enabled == null || enabled));
            rebuilt.put(entry.getKey(), changed);
            changedModels.add(changed);
        }
        this.models = rebuilt;
        return changedModels;
    }

    /**
     * provider 改名时复制并更新其模型值、尽可能同步模型 key；返回实际 oldKey -> newKey。
     */
    public synchronized Map<String, String> renameProviderModels(String oldProvider, String newProvider) {
        String oldPrefix = oldProvider + "-";
        String newPrefix = newProvider + "-";
        Set<String> occupied = new LinkedHashSet<>(models.keySet());
        Map<String, String> renamed = new LinkedHashMap<>();
        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            String oldKey = entry.getKey();
            ModelDo current = entry.getValue();
            if (oldProvider.equals(current.getProvider()) == false) {
                rebuilt.put(oldKey, current);
                continue;
            }
            String newKey = oldKey;
            if (oldKey.startsWith(oldPrefix)) {
                String candidate = newPrefix + oldKey.substring(oldPrefix.length());
                if (candidate.equals(oldKey) || occupied.contains(candidate) == false) {
                    newKey = candidate;
                    renamed.put(oldKey, newKey);
                }
            }
            ModelDo changed = copyModel(current);
            changed.setProvider(newProvider);
            if (newKey.equals(oldKey) == false) {
                changed.setName(newKey);
            }
            rebuilt.put(newKey, changed);
        }
        this.models = rebuilt;
        repairRenamedReferences(renamed);
        return renamed;
    }

    private void repairRenamedReferences(Map<String, String> renamed) {
        String renamedDefault = renamed.get(defaultModel);
        if (renamedDefault != null) {
            defaultModel = renamedDefault;
        }
        String acpModel = general.getAcpModel();
        String renamedAcp = renamed.get(acpModel);
        if (renamedAcp != null) {
            general.setAcpModel(renamedAcp);
        }
    }

    // ==================== 模型顺序不变量 ====================

    /** 手工模型（未归属任何 provider）的分组键：不参与归组，各自保持原位。 */
    private static final String UNGROUPED_MODEL_KEY = "";

    /**
     * 模型分组依据：provider 名称；空 provider 返回 {@link #UNGROUPED_MODEL_KEY}，
     * 表示「手工模型」——它们不属于任何供应商区块，归组时保持原位不动。
     */
    private static String modelGroupKey(ModelDo model) {
        String provider = model.getProvider();
        return (provider == null || provider.isEmpty()) ? UNGROUPED_MODEL_KEY : provider;
    }

    /**
     * 顺序不变量：同一 provider 的模型在 {@link #models} 中必须连续。
     *
     * <p>稳定归组：组间顺序 = 各组在原列表中首次出现的顺序；组内顺序 = 原组内相对顺序。
     * 不按名称排序、不由前端重排。用于修复历史增量同步把同 provider 新模型追加到总表末尾
     * 造成的同 provider 分裂多段问题。</p>
     *
     * <p><b>手工模型（provider 为空）保持原位</b>：它们不隶属任何供应商区块，若参与归组会被
     * 整体前移到首个手工模型处，造成「用户没动过的模型位置自己变了」。此处按原索引留在原地，
     * 仅真正的 provider 区块做合并。</p>
     *
     * @return true 表示顺序确实发生了变化（存在同 provider 分裂段）
     */
    public boolean normalizeModelProviderOrder() {
        return normalizeModelProviderOrder(null);
    }

    /**
     * 同 {@link #normalizeModelProviderOrder()}；额外把被合并（原本分裂成多段）的 provider
     * 名称收集到 splitProviders，供调用方打印影响面。
     *
     * @param splitProviders 可为 null；非 null 时按首次出现顺序写入发生过合并的 provider 名
     */
    public synchronized boolean normalizeModelProviderOrder(List<String> splitProviders) {
        // 分裂检测：仅针对真实 provider（手工模型天然散落，不算分裂）
        Set<String> seen = new HashSet<>();
        Set<String> split = new LinkedHashSet<>();
        String previousGroup = null;
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            String group = modelGroupKey(entry.getValue());
            if (group.equals(previousGroup) == false) {
                if (UNGROUPED_MODEL_KEY.equals(group) == false && seen.contains(group)) {
                    split.add(group); // 同 provider 再次出现：存在分裂段
                }
                seen.add(group);
                previousGroup = group;
            }
        }

        if (splitProviders != null) {
            splitProviders.addAll(split);
        }

        if (split.isEmpty()) {
            return false;
        }

        // 归组：手工模型按原索引占位不动；每个 provider 区块整体落在其首次出现的位置
        Map<String, List<Map.Entry<String, ModelDo>>> groups = new LinkedHashMap<>();
        List<String> slots = new ArrayList<>(); // 槽位序列：provider 名，或 null 表示手工模型占位
        List<Map.Entry<String, ModelDo>> ungrouped = new ArrayList<>();

        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            String group = modelGroupKey(entry.getValue());
            if (UNGROUPED_MODEL_KEY.equals(group)) {
                slots.add(null);
                ungrouped.add(entry);
                continue;
            }
            if (groups.containsKey(group) == false) {
                groups.put(group, new ArrayList<>());
                slots.add(group); // 该 provider 首次出现，占一个区块槽位
            }
            groups.get(group).add(entry);
        }

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        int ungroupedIndex = 0;
        for (String slot : slots) {
            if (slot == null) {
                Map.Entry<String, ModelDo> entry = ungrouped.get(ungroupedIndex++);
                rebuilt.put(entry.getKey(), entry.getValue());
                continue;
            }
            for (Map.Entry<String, ModelDo> entry : groups.get(slot)) {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }

        this.models = rebuilt;
        return true;
    }

    /**
     * 把模型插入其 provider 区块末尾：同 provider 已有模型时插到该区块最后一个模型之后，
     * 否则追加到总表末尾。避免新增模型把已有同 provider 区块劈开、或自身被劈到远处。
     *
     * <p>同名语义与 {@code Map.put} 一致：若 key 已存在，新配置覆盖旧配置。旧条目会被先摘除，
     * 确保新配置落入目标 provider 区块（而不是被旧条目原位回填覆盖）。</p>
     */
    public synchronized void addModelInProviderBlock(ModelDo model) {
        model = copyModel(model);
        String key = model.getNameOrModel();
        String group = modelGroupKey(model);

        // COW：先复制再改副本，最后整体替换引用（见 models 字段的并发约定），
        // 不得在原 map 上就地 remove/put，否则未持锁的读线程会撞上 ConcurrentModificationException
        Map<String, ModelDo> current = new LinkedHashMap<>(models);

        // 同名旧条目先摘除：否则它仍占着原槽位，重建时会在区块插入后再次 put 把新配置覆盖回去
        current.remove(key);

        String lastKeyOfGroup = null;
        for (Map.Entry<String, ModelDo> entry : current.entrySet()) {
            if (group.equals(modelGroupKey(entry.getValue()))) {
                lastKeyOfGroup = entry.getKey();
            }
        }

        if (lastKeyOfGroup == null) {
            current.put(key, model);
            this.models = current;
            return;
        }

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        for (Map.Entry<String, ModelDo> entry : current.entrySet()) {
            rebuilt.put(entry.getKey(), entry.getValue());
            if (entry.getKey().equals(lastKeyOfGroup)) {
                rebuilt.put(key, model);
            }
        }
        this.models = rebuilt;
    }

    /**
     * 原位替换模型：新配置接管 oldKey 在原列表中的槽位（位置不变），支持同时改名；
     * oldKey 不存在时退化为 {@link #addModelInProviderBlock(ModelDo)}。
     *
     * <p><b>顺序不变量由本方法自行保证</b>：若新旧配置的 provider 不同，原位替换会把目标
     * provider 的区块勈成两段，故此时方法内部自动归组一次（{@link #normalizeModelProviderOrder()}），
     * 返回时「同一 provider 的模型连续」一定成立，调用方无需再补一次 normalize 兜着。
     * provider 未变时不归组，以严格保持本方法「接管原槽位、位置不变」的契约。</p>
     *
     * @return false 表示改名目标与另一个已存在模型重名，为避免静默覆盖丢模型已放弃本次替换（集合未变）
     */
    public synchronized boolean replaceModelInPlace(String oldKey, ModelDo newModel) {
        newModel = copyModel(newModel);
        if (models.containsKey(oldKey) == false) {
            addModelInProviderBlock(newModel); // 同一把实例锁，synchronized 可重入，不会死锁
            return true;
        }

        String newKey = newModel.getNameOrModel();
        // 改名撞库防御：newKey 已被另一个模型占用时，重建会把那个模型覆盖掉（总数静默减少）
        if (newKey.equals(oldKey) == false && models.containsKey(newKey)) {
            return false;
        }

        // provider 是否发生变化：变了就不能只做原位替换，否则破坏区块连续性
        String oldGroup = modelGroupKey(models.get(oldKey));
        String newGroup = modelGroupKey(newModel);

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (entry.getKey().equals(oldKey)) {
                rebuilt.put(newKey, newModel);
            } else {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }
        this.models = rebuilt;

        if (newKey.equals(oldKey) == false) {
            Map<String, String> renamed = new LinkedHashMap<>();
            renamed.put(oldKey, newKey);
            repairRenamedReferences(renamed);
        }
        if (oldGroup.equals(newGroup) == false) {
            // 归位：把被勈开的目标 provider 区块合并回其首次出现处，其余模型相对顺序不变
            normalizeModelProviderOrder();
        }
        return true;
    }

    /**
     * 批量原位改名模型 key：新 key 接管旧 key 在原列表中的槽位，provider 区块整体位置不变。
     *
     * <p>撞库防御：新 key 已被「不参与本次改名」的模型占用，或多个旧 key 映射到同一新 key 时，
     * 该条改名被跳过（保留旧 key），避免静默覆盖导致模型总数减少。</p>
     *
     * @param oldToNew 旧 key -> 新 key 映射；不在映射中的 key 原样保留
     * @return 实际生效的改名数量
     */
    public synchronized int applyModelKeyRenames(Map<String, String> oldToNew) {
        if (oldToNew == null || oldToNew.isEmpty()) {
            return 0;
        }

        // 目标 key 被占用判定：现有 key 中排除即将释放的旧 key，再叠加已采纳的新 key
        Set<String> occupied = new LinkedHashSet<>(models.keySet());
        occupied.removeAll(oldToNew.keySet());

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        int renamed = 0;
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            String oldKey = entry.getKey();
            String newKey = oldToNew.get(oldKey);
            if (newKey == null || newKey.equals(oldKey) || occupied.contains(newKey)) {
                rebuilt.put(oldKey, entry.getValue()); // 不改名或目标被占：保留旧 key
                occupied.add(oldKey);
                continue;
            }
            rebuilt.put(newKey, entry.getValue());
            occupied.add(newKey);
            renamed++;
        }
        this.models = rebuilt;
        return renamed;
    }

    /**
     * 整体重建指定 provider 的模型区块：按 orderedKeys 顺序连续摆放，区块整体位于该 provider
     * 在原列表中首次出现的位置；其余 provider 模型的相对顺序不变。
     *
     * <p>orderedKeys 中不存在于当前集合的模型被忽略；该 provider 存在但不在 orderedKeys 中的模型
     * 按原相对顺序补在区块之后（防御性兜底，正常同步流程不会出现）。</p>
     *
     * @return true 表示顺序确实发生了变化
     */
    public synchronized boolean reorderProviderModels(String provider, List<String> orderedKeys) {
        if (provider == null || provider.isEmpty()) {
            return false;
        }

        // 该 provider 当前成员（按原顺序）
        Set<String> members = new LinkedHashSet<>();
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (provider.equals(modelGroupKey(entry.getValue()))) {
                members.add(entry.getKey());
            }
        }
        if (members.isEmpty()) {
            return false;
        }

        List<String> block = new ArrayList<>();
        if (orderedKeys != null) {
            for (String key : orderedKeys) {
                if (members.contains(key) && block.contains(key) == false) {
                    block.add(key);
                }
            }
        }
        for (String key : members) {
            if (block.contains(key) == false) {
                block.add(key);
            }
        }

        List<String> originalKeys = new ArrayList<>(models.keySet());

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        boolean inserted = false;
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (provider.equals(modelGroupKey(entry.getValue()))) {
                if (inserted == false) {
                    for (String key : block) {
                        rebuilt.put(key, models.get(key));
                    }
                    inserted = true;
                }
                // 该 provider 原槽位全部让位，区块整体前移到首次出现处
            } else {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }

        boolean changed = new ArrayList<>(rebuilt.keySet()).equals(originalKeys) == false;
        if (changed) {
            this.models = rebuilt;
        }
        return changed;
    }

    // ==================== 模型删除与供应商级联删除 ====================

    /**
     * 移除单个模型（COW 重建，其余模型相对顺序不变）。
     *
     * <p>供调用方替代 {@code getModels().remove(key)} 的裸 map 操作：后者绕过了本类的实例锁，
     * 与顺序不变量方法并发时会互相覆盖，也会破坏「同 provider 连续」不变量。</p>
     *
     * @return true 表示确实移除了一个模型
     */
    public boolean removeModel(String key) {
        return removeModels(Collections.singletonList(key)).isEmpty() == false;
    }

    /** 复制旧值后修改，并一次性发布新的 models 快照。 */
    public synchronized ModelDo updateModel(String key, Consumer<ModelDo> updater) {
        ModelDo current = models.get(key);
        if (current == null) {
            return null;
        }
        ModelDo changed = copyModel(current);
        updater.accept(changed);
        Map<String, ModelDo> rebuilt = new LinkedHashMap<>(models);
        rebuilt.put(key, changed);
        this.models = rebuilt;
        return changed;
    }

    /** 删除后修复 defaultModel / ACP 引用；默认模型优先回落到第一个启用模型。 */
    private void repairRemovedModelReferences(Set<String> removedKeys) {
        if (removedKeys.contains(defaultModel)) {
            defaultModel = firstEnabledModelName();
        }
        if (removedKeys.contains(general.getAcpModel())) {
            general.setAcpModel(null);
        }
    }

    private String firstEnabledModelName() {
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (entry.getValue().isEnabled()) {
                return entry.getKey();
            }
        }
        return null;
    }

    /**
     * 批量移除模型：一次性摘除给定 key（COW 重建，其余模型相对顺序不变）。
     *
     * @param keys 待移除的模型 key；null/空集合直接返回空列表
     * @return 实际被移除的 key 列表（按其在 models 中的原顺序），供调用方同步摘除运行时引擎并打日志
     */
    public synchronized List<String> removeModels(Collection<String> keys) {
        if (keys == null || keys.isEmpty()) {
            return new ArrayList<>();
        }

        Set<String> targets = new HashSet<>(keys);
        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        List<String> removed = new ArrayList<>();
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (targets.contains(entry.getKey())) {
                removed.add(entry.getKey());
            } else {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }
        this.models = rebuilt;
        repairRemovedModelReferences(new HashSet<>(removed));
        return removed;
    }

    /**
     * 级联删除供应商：同时移除 provider 条目本身 + 其名下所有 {@link ModelDo}，
     * 并对每个被删模型调用 {@code engineModelRemover}（通常是 {@code engine::removeModel}）
     * 从运行时引擎摘除。
     *
     * <p>修复：早前删除 provider 只摘掉 providers 里的一条，名下 ModelDo 与其 apiKey 永久残留在
     * settings.json 里，模型仍可被调用（孤儿模型）。</p>
     *
     * <p>引擎摘除刻意放在配置锁<b>之外</b>执行：持锁回调外部组件，若其内部反向读取配置
     * 并在另一线程上等待，存在死锁风险。本类不引用 HarnessEngine（避免 config → harness 反向依赖），
     * 故引擎摘除以回调形式由调用方注入。</p>
     *
     * @param providerName       供应商名称；null/空字符串不做任何事
     * @param engineModelRemover 运行时摘除回调，可为 null（仅清配置、不动引擎）
     * @return 被级联删除的模型 key 列表（按原顺序）
     */
    public List<String> removeProviderCascade(String providerName, Consumer<String> engineModelRemover) {
        List<String> removedKeys = removeProviderConfig(providerName);

        if (engineModelRemover != null) {
            for (String key : removedKeys) {
                try {
                    engineModelRemover.accept(key);
                } catch (Exception e) {
                    // 单个模型摘除失败不中断整个级联删除：配置侧已清干净，不能因引擎异常而回滚
                    LOG.warn("[Settings] Failed to remove model {} from engine on provider cascade delete: {}",
                            key, e.getMessage());
                }
            }
        }
        return removedKeys;
    }

    /**
     * {@link #removeProviderCascade(String, Consumer)} 的配置侧：移除 provider 条目与其名下所有模型。
     * <p>两者在同一把锁内完成，保证「provider 没了但模型还在」的中间态不会被其他线程观察到。</p>
     */
    private synchronized List<String> removeProviderConfig(String providerName) {
        if (providerName == null || providerName.isEmpty()) {
            return new ArrayList<>();
        }

        Map<String, ProviderDo> providerSnapshot = new LinkedHashMap<>(providers);
        providerSnapshot.remove(providerName);

        Map<String, ModelDo> rebuilt = new LinkedHashMap<>();
        List<String> removedKeys = new ArrayList<>();
        for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
            if (providerName.equals(modelGroupKey(entry.getValue()))) {
                removedKeys.add(entry.getKey());
            } else {
                rebuilt.put(entry.getKey(), entry.getValue());
            }
        }
        this.providers = providerSnapshot;
        this.models = rebuilt;
        repairRemovedModelReferences(new HashSet<>(removedKeys));
        return removedKeys;
    }

    /**
     * 与 HarnessProperties（即 AgentProperties）双向合并。
     * <p>如果 settings 有数据，以 settings 为准同步到 props；
     * 如果 settings 为空，则从 props 补充到 settings。</p>
     */
    public synchronized void mergeFrom(AgentProperties props) {
        if (general.getHistoryWindowSize() == null) {
            general.setHistoryWindowSize(props.getHistoryWindowSize());
        }

        if (general.getCompressionRatio() == null) {
            general.setCompressionRatio(props.getCompressionRatio());
        }

        if (general.getCompressionTargetRatio() == null) {
            general.setCompressionTargetRatio(props.getCompressionTargetRatio());
        }

        if (general.getCompressionReservedOutputTokens() == null) {
            general.setCompressionReservedOutputTokens(props.getCompressionReservedOutputTokens());
        }

        if (general.getIntentChainEnabled() == null) {
            general.setIntentChainEnabled(props.isIntentChainEnabled());
        }

        if (general.getIntentChainMaxTokens() == null) {
            general.setIntentChainMaxTokens(props.getIntentChainMaxTokens());
        }

        if(general.getSummaryModel() == null){
            general.setSummaryModel(props.getSummaryModel());
        }

        if (general.getSandboxMode() == null) {
            general.setSandboxMode(props.isSandboxMode());
        }

        if (general.getSandboxAllowUserHome() == null) {
            general.setSandboxAllowUserHome(props.isSandboxAllowUserHome());
        }

        if (general.getSandboxSystemRestrict() == null) {
            general.setSandboxSystemRestrict(props.isSandboxSystemRestrict());
        }

        if (general.getApiRetries() == null) {
            general.setApiRetries(props.getApiRetries());
        }

        if (general.getMcpRetries() == null) {
            general.setMcpRetries(props.getMcpRetries());
        }

        if (general.getModelRetries() == null) {
            general.setModelRetries(props.getModelRetries());
        }

        if (general.getMemoryEnabled() == null) {
            general.setMemoryEnabled(props.isMemoryEnabled());
        }

        if (general.getMemoryIsolation() == null) {
            general.setMemoryIsolation(props.isMemoryIsolation());
        }

        if (general.getMcpEnabled() == null) {
            general.setMcpEnabled(props.isMcpEnabled());
        }

        if (general.getOpenApiEnabled() == null) {
            general.setOpenApiEnabled(props.isOpenApiEnabled());
        }

        if (general.getLspEnabled() == null) {
            general.setLspEnabled(props.isLspEnabled());
        }

        if(general.getUserAgent() == null){
            general.setUserAgent(props.getUserAgent());
        }

        if(general.getMaxTurns() == null) {
            general.setMaxTurns(props.getMaxTurns());

            if (general.getMaxTurns() == null) {
                general.setMaxTurns(20);
            }
        }

        if(general.getAutoRethink() == null){
            general.setAutoRethink(props.isAutoRethink());
        }

        if(general.getHitlEnabled() == null){
            general.setHitlEnabled(props.isHitlEnabled());
        }

        if(general.getSubagentEnabled() == null){
            general.setSubagentEnabled(props.isSubagentEnabled());
        }

        if(general.getCliPrintSimplified() == null){
            general.setCliPrintSimplified(props.isCliPrintSimplified());
        }

        if(general.getCliThinkPrinted() == null){
            general.setCliThinkPrinted(props.isThinkPrinted());
        }

        //-----------------------------------------------------

        if(permission.getTools().size() == 0) {
            permission.getTools().addAll(props.getTools());

            if (permission.getTools().size() == 0) {
                permission.getTools().add("**");
            }
        }

        if(permission.getDisallowedTools().size() == 0){
            permission.getDisallowedTools().addAll(props.getDisallowedTools());
        }

        //-----------------------------------------------------

        if (Assert.isEmpty(this.defaultModel)) {
            this.defaultModel = props.getDefaultModel();
        }

        if (this.models.size() == 0) {
            // COW：不在原 map 上就地 put，与其余结构性修改保持一致的发布语义
            Map<String, ModelDo> seeded = new LinkedHashMap<>();
            for (ModelDo modelDo : props.getModels()) {
                seeded.put(modelDo.getNameOrModel(), modelDo);
            }
            this.models = seeded;
        }

        // 合并完成后统一兜底：如果 defaultModel 未指定，取第一个模型
        if (Assert.isEmpty(this.defaultModel) && this.models.size() > 0) {
            this.defaultModel = this.models.values().iterator().next().getNameOrModel();
        }

        if (this.mcpServers.size() == 0) {
            this.mcpServers.putAll(props.getMcpServers());
        }

        if (this.apiServers.size() == 0) {
            this.apiServers.putAll(props.getApiServers());
        }

        if (this.mountPools.size() == 0) {
            for (Map.Entry<String, String> entry : props.getSkillPools().entrySet()) {
                this.mountPools.put(entry.getKey(), new MountDo(AgentFlags.SCOPE_USER, "", MountType.SKILLS, entry.getValue(), false, true, false));
            }
        }

        if (this.lspServers.size() == 0) {
            this.lspServers.putAll(props.getLspServers());
        }
    }

    /**
     * 从文件加载配置。
     *
     * <p>两级配置：<b>全局</b>（{@link AgentFlags#getHarnessBase()}，安装目录）与
     * <b>工作区</b>（{@link AgentFlags#getUserDir()}）。当二者不同一路径时，先加载全局，
     * 再让工作区<b>按存在的键覆盖标量/general/permission</b>；对集合类
     * （models/providers/mcpServers/apiServers/mountPools/lspServers）采用<b>叠加合并</b>：
     * 工作区同名键覆盖，其余保留全局条目。</p>
     *
     * <p>此举修复：ACP 子进程 cwd=工作区，若工作区 {@code settings.json} 的 {@code models} 为空
     * {@code {}}，早前的整体 bind 可能把全局模型清空，导致「未配置可用模型」。显式叠加后，
     * 空的工作区集合不再抹掉全局配置。</p>
     */
    public static AgentSettings loadFromFile() {
        try {
            Path globalFile = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            Path localFile = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            boolean isLocalAsGlobal = localFile.toString().equals(globalFile.toString());

            AgentSettings agentSettings = new AgentSettings();
            // 任一份 settings.json 读取/解析失败即置位：返回前落到 loadFailed 上，
            // saveToFile 据此拒绝回写，避免用兜底空配置覆盖磁盘上那份可能只是暂时读不出的原文件
            boolean corrupted = false;

            if (Files.exists(globalFile)) {
                //全局配置：按文件粒度捕获失败（readSettingsNode 内部已备份损坏文件并记 ERROR），
                //降级后仍继续加载工作区那份，不让单份文件损坏拖垮整个启动
                ONode oNode = readSettingsNode(globalFile);
                if (oNode == null) {
                    corrupted = true;
                } else {
                    oNode.bindTo(agentSettings);
                }
            }

            if (isLocalAsGlobal == false) {
                //如果本地文件，不同于全局文件
                if (Files.exists(localFile)) {
                    //先解析再快照：解析失败时整段跳过（不 bind、不叠加合并），完整保留已加载的全局配置。
                    //必须在快照之前解析，否则 bind 中途抛错会留下半套工作区配置、且全局快照没被补回
                    ONode oNode = readSettingsNode(localFile);
                    if (oNode == null) {
                        corrupted = true;
                    } else {
                        //工作区配置：先快照全局集合，bind 覆盖标量/general/permission 后再叠加合并集合，
                        //避免工作区空集合（如 "models": {}）抹掉全局条目
                        Map<String, ModelDo> gModels = new LinkedHashMap<>(agentSettings.models);
                        Map<String, MountDo> gMountPools = new LinkedHashMap<>(agentSettings.mountPools);
                        Map<String, McpServerDo> gMcpServers = new LinkedHashMap<>(agentSettings.mcpServers);
                        Map<String, ApiSourceDo> gApiServers = new LinkedHashMap<>(agentSettings.apiServers);
                        Map<String, LspServerDo> gLspServers = new LinkedHashMap<>(agentSettings.lspServers);
                        Map<String, ProviderDo> gProviders = new LinkedHashMap<>(agentSettings.providers);
                        String gDefaultModel = agentSettings.defaultModel;

                        oNode.bindTo(agentSettings);

                        //集合：以全局为底，工作区同名键覆盖、其余保留全局（叠加，不清空）
                        mergeMissing(agentSettings.models, gModels);
                        mergeMissing(agentSettings.mountPools, gMountPools);
                        mergeMissing(agentSettings.mcpServers, gMcpServers);
                        mergeMissing(agentSettings.apiServers, gApiServers);
                        mergeMissing(agentSettings.lspServers, gLspServers);
                        mergeMissing(agentSettings.providers, gProviders);

                        //defaultModel：工作区未显式指定则保留全局（bind 不会为缺失键赋 null，此处再兜底）
                        if (Assert.isEmpty(agentSettings.defaultModel)) {
                            agentSettings.defaultModel = gDefaultModel;
                        }
                    }
                }
            }

            agentSettings.ensureBuiltinProviders();

            // 历史数据迁移：旧版增量同步把同 provider 的新模型追加到总表末尾，导致同 provider 分裂多段；
            // 此处做一次稳定归组（组间=首次出现顺序、组内=原相对顺序），接口与前端原样展示内存顺序即可。
            //
            // ⚠️ 只改内存、不在加载时写盘：saveToFile 按 scope 把模型拆进全局/工作区两个文件，
            // 而本方法的合并顺序是「先工作区、再补全局缺失」——若同一 provider 同时含 workspace 与
            // user 模型，归组结果落盘后又会被重新拆开，下次加载再度判定为分裂，形成
             // 「每次加载都重排 + 回写」的死循环（AcpLink 每轮 prompt 都会 loadFromFile，等于每问一句
             // 重写两个配置文件，且并发下互相覆盖）。saveToFile 现已是原子写，但重排-拆分互相抵消的问题仍在。
            // 顺序会在下一次用户主动保存（各写入入口均调 saveSettings）时自然持久化。
            List<String> splitProviders = new ArrayList<>();
            if (agentSettings.normalizeModelProviderOrder(splitProviders)) {
                LOG.info("[Settings] Model order normalized in memory (not persisted here): {} provider(s) had split blocks {}, {} models total",
                        splitProviders.size(), splitProviders, agentSettings.models.size());
            }

            // 加载失败标记必须在返回前落定：saveToFile 依赖它决定是否允许回写
            agentSettings.loadFailed = corrupted;

            return agentSettings;
        } catch (Exception e) {
            LOG.error("[Settings] Failed to load settings from file, falling back to an empty in-memory config: {}",
                    e.getMessage(), e);
            AgentSettings fallback = new AgentSettings();
            fallback.ensureBuiltinProviders();
            // 连兜底加载都异常（多为 IO 层问题）：内存里是空配置，一律禁止回写，
            // 否则一次 saveSettings() 就把用户全部模型与 apiKey 清空
            fallback.loadFailed = true;
            return fallback;
        }
    }

    /**
     * 读取并解析单份 settings.json（含旧格式 models 数组归一化）。
     *
     * <p>失败时<b>先把损坏文件备份</b>再返回 null，由调用方降级。备份是「不丢配置」的前提：
     * 调用方随后会退到兜底空配置，若没有这份备份，一次 saveSettings() 就把用户全部模型与
     * apiKey 永久覆盖掉了。</p>
     *
     * @return 解析结果；读取或解析失败返回 null（已备份并已记 ERROR）
     */
    private static ONode readSettingsNode(Path file) {
        try {
            String json = new String(Files.readAllBytes(file), "UTF-8");
            ONode oNode = ONode.ofJson(json);

            normalizeModelsNode(oNode);

            return oNode;
        } catch (Exception e) {
            backupCorruptFile(file, e);
            return null;
        }
    }

    /**
     * 把读取/解析失败的配置文件复制为同目录 {@code settings.json.corrupt-<yyyyMMddHHmmss>} 备份，
     * 供用户手工恢复。
     *
     * <p>备份失败只 WARN 不抛：降级流程必须继续，否则会因备份失败而启动不了。</p>
     *
     * @return 备份文件路径；备份失败返回 null
     */
    private static Path backupCorruptFile(Path file, Exception cause) {
        Path backup = file.resolveSibling(file.getFileName() + ".corrupt-"
                + LocalDateTime.now().format(CORRUPT_BACKUP_STAMP));
        try {
            Files.copy(file, backup, StandardCopyOption.REPLACE_EXISTING);
            LOG.error("[Settings] Corrupt config file {} backed up as {} (cause: {}). In-memory config falls back to "
                            + "empty for that file and auto-save is DISABLED for this session, so the on-disk config will "
                            + "NOT be overwritten. To recover: restore a valid {} from that backup (or delete the backup "
                            + "if the config can be discarded), then restart the app.",
                    file, backup.getFileName(), cause.getMessage(), file.getFileName());
            return backup;
        } catch (Exception e) {
            LOG.warn("[Settings] Failed to back up corrupt settings file {} as {}: {}",
                    file, backup.getFileName(), e.getMessage());
            return null;
        }
    }

    /** 旧格式兼容：models 若为数组，转成 {name: item} 的对象形态。 */
    private static void normalizeModelsNode(ONode oNode) {
        ONode oModels = oNode.get("models");
        if (oModels.isArray()) {
            ONode map = new ONode().asObject();
            for (ONode item : oModels.getArrayUnsafe()) {
                map.set(item.get("name").getString(), item);
            }
            oNode.set("models", map);
        }
    }

    /**
     * 把 {@code base}（全局快照）中 {@code target} 尚未包含的键补回 target。
     * <p>target（工作区覆盖后的结果）同名键优先；base 仅填补缺失键，保证全局条目不被空集合抹掉。</p>
     */
    private static <T> void mergeMissing(Map<String, T> target, Map<String, T> base) {
        for (Map.Entry<String, T> entry : base.entrySet()) {
            if (target.containsKey(entry.getKey()) == false) {
                target.put(entry.getKey(), entry.getValue());
            }
        }
    }

    /**
     * 保存配置到文件。
     *
     * <p>两道保护：</p>
     * <ol>
     *   <li><b>加载失败不回写</b>：本会话未能读出磁盘配置（{@link #loadFailed}）时直接 return。
     *       此时内存里只是兜底空配置，写下去等于清空用户全部模型与 apiKey。当前没有「强制保存」
     *       入口，故 UI 上的显式保存同样受此保护；解除方式见 {@link #loadFailed} 的说明。</li>
     *   <li><b>原子写</b>：先写同目录临时文件再 move 覆盖（{@link #atomicWrite(Path, String)}），
     *       避免写入中途崩溃/断电留下截断 JSON——截断文件下次加载解析失败，与第 1 道保护叠加
     *       才能真正保证配置可恢复。</li>
     * </ol>
     */
    public synchronized void saveToFile() {
        try {
            Path globalFileOld = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "config.yml").toAbsolutePath();
            Path localFileOld = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "config.yml").toAbsolutePath();

            Path globalFile = Paths.get(AgentFlags.getHarnessBase(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            Path localFile = Paths.get(AgentFlags.getUserDir(), AgentFlags.getHarnessHome(), "settings.json").toAbsolutePath();
            boolean isLocalAsGlobal = localFile.toString().equals(globalFile.toString());

            //加载失败保护：内存里是兜底空配置，回写会把磁盘上那份（可能只是暂时读不出）永久覆盖掉
            if (loadFailed) {
                LOG.warn("[Settings] Refusing to save: this session failed to load the on-disk config, so memory only "
                                + "holds an empty fallback and writing would wipe all models/apiKeys. To re-enable saving, "
                                + "restore a valid settings.json from the settings.json.corrupt-* backup in {} (or delete "
                                + "that backup if the config can be discarded), then restart.",
                        globalFile.getParent());
                return;
            }

            // 保存锁覆盖快照生成与所有相关文件落盘。若只锁快照生成、锁外写盘，较早快照可能
            // 在较新快照之后完成 move，最终反而把旧状态留在磁盘。
            String[] jsonSnapshot = createJsonSnapshot(isLocalAsGlobal);

            Files.createDirectories(globalFile.getParent());
            atomicWrite(globalFile, jsonSnapshot[0]);
            Files.deleteIfExists(globalFileOld); //有新配置后，去掉旧配置


            if (isLocalAsGlobal == false) {
                //如果本地文件，不同于全局文件
                Files.createDirectories(localFile.getParent());
                atomicWrite(localFile, jsonSnapshot[1]);
                Files.deleteIfExists(localFileOld); //有新配置后，去掉旧配置
            }
        } catch (Exception e) {
            LOG.warn("[Settings] Failed to save settings to file: {}", e.getMessage());
        }
    }

    /**
     * 原子写：先写同目录临时文件，再 move 覆盖目标。
     *
     * <p>避免直接 {@code Files.write(target, ...)} 在写入中途崩溃/断电时留下截断 JSON：
     * 截断文件下次加载解析失败，若再叠加兜底空配置回写，用户配置就不可恢复了。</p>
     *
     * <p>文件系统不支持 {@link StandardCopyOption#ATOMIC_MOVE} 时降级为仅 REPLACE_EXISTING。
     * 临时文件在 finally 里兜底删除（move 成功后已不存在，deleteIfExists 空转无害）。</p>
     */
    private static void atomicWrite(Path target, String content) throws IOException {
        Path temp = target.resolveSibling(target.getFileName() + ".tmp-" + System.nanoTime());
        try {
            Files.write(temp, content.getBytes(StandardCharsets.UTF_8));
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }


    private synchronized String[] createJsonSnapshot(boolean isLocalAsGlobal) {
        return new String[]{getGlobalJson(isLocalAsGlobal), isLocalAsGlobal ? null : getLocalJson()};
    }

    public synchronized String getGlobalJson(boolean isLocalAsGlobal) {
        ONode oNode = new ONode(Options.of(Feature.Write_PrettyFormat));
        oNode.getOrNew("general").fill(general);
        oNode.getOrNew("permission").fill(permission);

        oNode.set("defaultModel", this.defaultModel);

        oNode.getOrNew("models").asObject().then(map -> {
            for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getValue().getNameOrModel()).then(item -> {
                    item.fill(entry.getValue());
                    item.remove("userAgent");

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mcpServers").asObject().then(map -> {
            for (Map.Entry<String, McpServerDo> entry : mcpServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("apiServers").asObject().then(map -> {
            for (Map.Entry<String, ApiSourceDo> entry : apiServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mountPools").asObject().then(map -> {
            for (Map.Entry<String, MountDo> entry : mountPools.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("lspServers").asObject().then(map -> {
            for (Map.Entry<String, LspServerDo> entry : lspServers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("providers").asObject().then(map -> {
            for (Map.Entry<String, ProviderDo> entry : providers.entrySet()) {
                if (isLocalAsGlobal == false && AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope())) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        return oNode.toJson();
    }

    public synchronized String getLocalJson() {
        ONode oNode = new ONode(Options.of(Feature.Write_PrettyFormat));

        oNode.getOrNew("models").asObject().then(map -> {
            for (Map.Entry<String, ModelDo> entry : models.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getValue().getNameOrModel()).then(item -> {
                    item.fill(entry.getValue());
                    item.remove("userAgent");

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mcpServers").asObject().then(map -> {
            for (Map.Entry<String, McpServerDo> entry : mcpServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("apiServers").asObject().then(map -> {
            for (Map.Entry<String, ApiSourceDo> entry : apiServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        oNode.getOrNew("mountPools").asObject().then(map -> {
            for (Map.Entry<String, MountDo> entry : mountPools.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("lspServers").asObject().then(map -> {
            for (Map.Entry<String, LspServerDo> entry : lspServers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).fill(entry.getValue());
            }
        });

        oNode.getOrNew("providers").asObject().then(map -> {
            for (Map.Entry<String, ProviderDo> entry : providers.entrySet()) {
                if (AgentFlags.SCOPE_LOCAL.equals(entry.getValue().getScope()) == false) {
                    continue;
                }

                map.getOrNew(entry.getKey()).then(item -> {
                    item.fill(entry.getValue());

                    if (entry.getValue().getTimeout() != null) {
                        item.set("timeout", entry.getValue().getTimeout().getSeconds() + "s");
                    }
                });
            }
        });

        return oNode.toJson();
    }
}