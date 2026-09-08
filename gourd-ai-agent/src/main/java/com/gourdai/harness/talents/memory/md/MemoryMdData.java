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
package com.gourdai.harness.talents.memory.md;

import org.noear.snack4.ONode;
import com.gourdai.harness.talents.memory.MemorySearchResult;
import com.gourdai.harness.talents.memory.MemoryStorer;
import com.gourdai.harness.talents.memory.MemoryTitles;
import org.noear.solon.ai.util.Markdown;
import org.noear.solon.ai.util.MarkdownUtil;
import org.noear.solon.core.util.Assert;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * MD 方案的共享数据层：统一管理 MD 文件读写、内存缓存与搜索索引。
 *
 * <p>Store 层和 Search 层共享同一个 MdMemoryData 实例，保证：
 * <ul>
 *   <li>启动时从 MD 文件目录全量加载，重启后搜索索引不丢失</li>
 *   <li>写入 MD 文件的同时更新内存缓存和搜索索引，保证存搜一致性</li>
 *   <li>读取优先走内存缓存，避免重复磁盘 I/O</li>
 *   <li>分词结果内联到索引条目，随条目生命周期自动释放，无缓存泄漏风险</li>
 *   <li>Front Matter 中保存完整 storeKey，消除文件名还原的不确定性</li>
 *   <li>原子写入自动降级（兼容 Windows/FAT32/NFS/Docker overlay）</li>
 *   <li>TTL 过期支持启动时清理和定期后台清理</li>
 * </ul>
 *
 * @author oisin
 * @since 3.10.5
 */
public class MemoryMdData implements AutoCloseable {
    private static final Logger LOG = LoggerFactory.getLogger(MemoryMdData.class);
    private static final DateTimeFormatter FORMATTER = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final String FRONT_MATTER_DELIMITER = "---";
    private static final Map<Path, Object> ROOT_LOCKS = new ConcurrentHashMap<>();

    private final Path baseDir;
    private final Object rootLock;

    /**
     * 内存缓存：storeKey → MemoryEntry
     * storeKey 格式："{userId}__{key}"
     */
    private final Map<String, MemoryEntry> cache = new ConcurrentHashMap<>();

    /**
     * 搜索索引：userId → { docId → IndexEntry }
     * 按用户分组，搜索时直接定位用户，避免全量遍历
     */
    private final Map<String, Map<String, IndexEntry>> indexByUser = new ConcurrentHashMap<>();

    /**
     * 后台过期清理调度器（可选，通过 enableAutoCleanup 开启）
     */
    private ScheduledExecutorService cleanupScheduler;

    public MemoryMdData(Path baseDir) {
        this.baseDir = prepareBaseDir(baseDir);
        this.rootLock = ROOT_LOCKS.computeIfAbsent(this.baseDir, ignored -> new Object());
        synchronized (rootLock) {
            loadFromDisk(this.baseDir);
            cleanupTmpFiles(this.baseDir);
        }
    }

    private static Path prepareBaseDir(Path requested) {
        if (requested == null) {
            throw new IllegalArgumentException("baseDir must not be null");
        }
        Path absolute = requested.toAbsolutePath().normalize();
        try {
            rejectSymbolicLinkComponents(absolute);
            Files.createDirectories(absolute);
            rejectSymbolicLinkComponents(absolute);
            Path real = absolute.toRealPath(LinkOption.NOFOLLOW_LINKS);
            if (!Files.isDirectory(real, LinkOption.NOFOLLOW_LINKS)) {
                throw new IllegalArgumentException("Memory storage path is not a directory: " + requested);
            }
            return real;
        } catch (IOException e) {
            throw new IllegalArgumentException("Failed to prepare secure memory storage directory: " + requested, e);
        }
    }

    private static void rejectSymbolicLinkComponents(Path path) throws IOException {
        Path current = path.getRoot();
        for (Path part : path) {
            current = current == null ? part : current.resolve(part);
            if (Files.exists(current, LinkOption.NOFOLLOW_LINKS) && Files.isSymbolicLink(current)) {
                throw new IOException("Symbolic link is not allowed in memory storage path: " + current);
            }
        }
    }

    // ==================== Store 操作 ====================

    /**
     * 存入记忆条目：写 MD 文件 + 更新内存缓存
     *
     * <p>注意：搜索索引的更新由 MemoryTalent 统一调用 updateIndex() 完成，
     * 保持与其他方案（Lucene/Repository/Rogue）的调用约定一致，避免双写冗余。
     */
    public void put(String userId, String key, String val, int ttl) {
        String storeKey = buildStoreKey(userId, key);
        synchronized (rootLock) {
            try {
                ONode node = ONode.ofJson(val);
                String content = node.get("content").getString();
                String title = MemoryTitles.resolve(node.get("title").getString(), content);
                String time = node.get("time").getString();
                int importance = node.get("importance").getInt();
                String storedTime = getNow();

                Path file = resolveFile(storeKey);
                writeMdFile(file, storeKey, title, time, importance, ttl, storedTime, content);
                MemoryEntry entry = new MemoryEntry(title, content, time, importance, ttl, storedTime);
                cache.put(storeKey, entry);
                indexByUser.computeIfAbsent(userId, ignored -> new ConcurrentHashMap<>())
                        .put(buildDocId(userId, key), new IndexEntry(userId, key, title, content, importance, time,
                                ttl, storedTime));
            } catch (Exception e) {
                LOG.error("MdMemoryData put error, userId={}, key={}", userId, key, e);
                throw new IllegalStateException("Failed to persist memory: " + key, e);
            }
        }
    }

    /**
     * 获取记忆条目：优先走内存缓存，缓存未命中再读磁盘
     */
    public String get(String userId, String key) {
        synchronized (rootLock) {
            String storeKey = buildStoreKey(userId, key);
            MemoryEntry entry = cache.get(storeKey);
            if (entry == null) {
                entry = loadFromMdFile(storeKey);
                if (entry == null) return null;
                cache.put(storeKey, entry);
                indexByUser.computeIfAbsent(userId, k -> new ConcurrentHashMap<>())
                        .putIfAbsent(buildDocId(userId, key),
                                new IndexEntry(userId, key, entry.title, entry.content, entry.importance, entry.time,
                                        entry.ttl, entry.storedTime));
            }
            if (isExpired(entry)) {
                removeLocked(userId, key);
                return null;
            }
            return buildJson(entry.title, entry.content, entry.time, entry.importance);
        }
    }

    /**
     * 删除记忆条目：删 MD 文件 + 清缓存 + 清搜索索引
     */
    public void remove(String userId, String key) {
        synchronized (rootLock) {
            removeLocked(userId, key);
        }
    }

    private void removeLocked(String userId, String key) {
        String storeKey = buildStoreKey(userId, key);
        Path file = resolveFile(storeKey);
        try {
            boolean deleted = Files.deleteIfExists(file);
            if (!deleted) {
                LOG.warn("MdMemoryData remove: file not found, userId={}, key={}, file={}", userId, key, file);
            } else {
                LOG.debug("MdMemoryData remove: file deleted, userId={}, key={}", userId, key);
            }
        } catch (IOException e) {
            LOG.error("MdMemoryData remove error (file may be locked), userId={}, key={}, file={}", userId, key, file, e);
            throw new IllegalStateException("Failed to delete memory file: " + file, e);
        }

        cache.remove(storeKey);
        Map<String, IndexEntry> userMap = indexByUser.get(userId);
        if (userMap != null) {
            userMap.remove(buildDocId(userId, key));
            if (userMap.isEmpty()) indexByUser.remove(userId, userMap);
        }
    }

    public MemoryStorer.ClearResult clear(String userId) {
        validateIdentity("userId", userId);
        synchronized (rootLock) {
            Map<String, IndexEntry> userMap = indexByUser.get(userId);
            List<String> snapshot = userMap == null ? Collections.emptyList() : userMap.values().stream()
                    .map(e -> e.userKey).distinct().collect(Collectors.toList());
            List<String> failed = new ArrayList<>();
            int deleted = 0;
            for (String key : snapshot) {
                try {
                    removeLocked(userId, key);
                    deleted++;
                } catch (RuntimeException e) {
                    failed.add(key);
                    LOG.error("MdMemoryData clear error, userId={}, key={}", userId, key, e);
                }
            }
            Map<String, IndexEntry> remaining = indexByUser.get(userId);
            return new MemoryStorer.ClearResult(deleted, failed, remaining == null ? 0 : remaining.size());
        }
    }

    public int count(String userId) {
        validateIdentity("userId", userId);
        synchronized (rootLock) {
            removeExpiredEntriesLocked(userId);
            Map<String, IndexEntry> userMap = indexByUser.get(userId);
            return userMap == null ? 0 : userMap.size();
        }
    }

    // ==================== Search 操作 ====================

    /**
     * 搜索：基于缓存的关键词匹配 + 重要性权重评分
     * 按 userId 直接定位索引，避免全量遍历
     */
    public List<MemorySearchResult> search(String userId, String query, int limit) {
        validateIdentity("userId", userId);
        if (query == null || query.trim().isEmpty() || limit <= 0) {
            return Collections.emptyList();
        }

        removeExpiredEntries(userId);
        Map<String, IndexEntry> userIndex = indexByUser.get(userId);
        if (userIndex == null || userIndex.isEmpty()) {
            return Collections.emptyList();
        }

        Set<String> queryTokens = tokenize(query.toLowerCase());

        List<ScoredEntry> scored = new ArrayList<>();
        for (IndexEntry entry : userIndex.values()) {
            double score = computeScore(entry, queryTokens);
            if (score > 0) {
                scored.add(new ScoredEntry(entry, score));
            }
        }

        return scored.stream()
                .sorted(Comparator.comparingDouble((ScoredEntry se) -> se.score).reversed())
                .limit(limit)
                .map(se -> toSearchResult(se.entry))
                .collect(Collectors.toList());
    }

    /**
     * 获取高价值热记忆
     */
    public List<MemorySearchResult> getHotMemories(String userId, int limit) {
        validateIdentity("userId", userId);
        if (limit <= 0) return Collections.emptyList();
        removeExpiredEntries(userId);
        Map<String, IndexEntry> userIndex = indexByUser.get(userId);
        if (userIndex == null || userIndex.isEmpty()) {
            return Collections.emptyList();
        }

        return userIndex.values().stream()
                .filter(e -> e.importance >= 5)
                .sorted(Comparator.comparingInt((IndexEntry e) -> e.importance).reversed()
                        .thenComparing((IndexEntry e) -> e.time, Comparator.reverseOrder()))
                .limit(limit)
                .map(this::toSearchResult)
                .collect(Collectors.toList());
    }

    /**
     * 列举全部记忆条目（不做重要度过滤），按重要度倒序、时间倒序返回
     */
    public List<MemorySearchResult> listAll(String userId, int limit) {
        validateIdentity("userId", userId);
        if (limit <= 0) return Collections.emptyList();
        synchronized (rootLock) {
            removeExpiredEntriesLocked(userId);
            Map<String, IndexEntry> userIndex = indexByUser.get(userId);
            if (userIndex == null || userIndex.isEmpty()) return Collections.emptyList();
            return userIndex.values().stream()
                    .sorted(Comparator.comparingInt((IndexEntry e) -> e.importance).reversed()
                            .thenComparing((IndexEntry e) -> e.time, Comparator.reverseOrder()))
                    .limit(limit)
                    .map(this::toSearchResult)
                    .collect(Collectors.toList());
        }
    }

    /**
     * 列举指定用户下所有记忆条目的 key
     */
    public Set<String> keys(String userId) {
        validateIdentity("userId", userId);
        removeExpiredEntries(userId);
        Map<String, IndexEntry> userIndex = indexByUser.get(userId);
        if (userIndex == null || userIndex.isEmpty()) {
            return Collections.emptySet();
        }
        return userIndex.values().stream()
                .map(e -> e.userKey)
                .collect(Collectors.toSet());
    }

    /**
     * 手动更新搜索索引（由 MemoryTalent 统一调用，兼容 MemorySearchProvider.updateIndex 接口）
     */
    public void updateIndex(String userId, String key, String fact, int importance, String time) {
        updateIndex(userId, key, null, fact, importance, time);
    }

    public void updateIndex(String userId, String key, String title, String fact, int importance, String time) {
        synchronized (rootLock) {
            MemoryEntry stored = cache.get(buildStoreKey(userId, key));
            // put 已在同一存储锁内同步索引；存储条目不存在时拒绝迟到的索引更新，避免 clear/remove 后复活。
            if (stored == null) return;
            Map<String, IndexEntry> userIndex = indexByUser.computeIfAbsent(userId, k -> new ConcurrentHashMap<>());
            userIndex.put(buildDocId(userId, key), new IndexEntry(userId, key,
                    MemoryTitles.resolve(title, fact), fact, importance, time, stored.ttl, stored.storedTime));
        }
    }

    /**
     * 手动移除搜索索引（由 MemoryTalent 统一调用，兼容 MemorySearchProvider.removeIndex 接口）
     */
    public void removeIndex(String userId, String key) {
        synchronized (rootLock) {
            Map<String, IndexEntry> userIndex = indexByUser.get(userId);
            if (userIndex != null) userIndex.remove(buildDocId(userId, key));
        }
    }

    // ==================== 启动加载 ====================

    /**
     * 从磁盘全量加载 MD 文件到缓存和搜索索引
     */
    private void loadFromDisk(Path baseDir) {
        int expiredCount = 0;
        try (Stream<Path> files = Files.list(baseDir)) {
            List<Path> mdFiles = files.filter(p -> p.getFileName().toString().endsWith(".md"))
                                      .collect(Collectors.toList());

            for (Path file : mdFiles) {
                LoadResult lr = loadSingleFile(file);
                if (lr == LoadResult.EXPIRED) {
                    expiredCount++;
                }
            }
        } catch (IOException e) {
            LOG.error("MdMemoryData loadFromDisk error", e);
        }

        if (!cache.isEmpty()) {
            LOG.info("MdMemoryData loaded {} entries from {} ({} expired cleaned)",
                    cache.size(), baseDir, expiredCount);
        }
    }

    private enum LoadResult { LOADED, EXPIRED, SKIPPED }

    private LoadResult loadSingleFile(Path file) {
        try {
            Path safeFile = ensureWithinBase(file.toAbsolutePath().normalize());
            FrontMatter fm = parseFrontMatter(Files.readAllLines(safeFile, StandardCharsets.UTF_8));
            if (fm == null) {
                return LoadResult.SKIPPED;
            }

            // 优先从 Front Matter 读取 storeKey（可靠还原），但不信任文件内元数据。
            boolean hasStoredKey = fm.storeKey != null && !fm.storeKey.isEmpty();
            String storeKey = fm.storeKey;
            if (!hasStoredKey) {
                // 兼容旧格式文件：从文件名启发式还原
                storeKey = fileNameToStoreKey(safeFile.getFileName().toString());
                LOG.warn("MdMemoryData: file has no name field, heuristic restore may be inaccurate: {}", safeFile);
            }
            String[] parts = splitStoreKey(storeKey);
            if (parts == null) {
                LOG.warn("MdMemoryData: invalid name field ignored: {}", safeFile);
                return LoadResult.SKIPPED;
            }
            Path expectedFile = resolveFile(storeKey);
            if (hasStoredKey && !expectedFile.equals(safeFile)) {
                LOG.warn("MdMemoryData: name field does not match file path, ignored: file={}, name={}", safeFile, storeKey);
                return LoadResult.SKIPPED;
            }

            // 旧数据缺 stored_at 时按 fact time、文件最后修改时间依次回退。
            fm.storedTime = resolveStoredTime(fm.storedTime, fm.time, safeFile);
            if (isExpired(fm.ttl, fm.storedTime)) {
                Files.deleteIfExists(safeFile);
                return LoadResult.EXPIRED;
            }

            if (fm.content == null || fm.content.trim().isEmpty()) {
                LOG.warn("MdMemoryData: file has empty content: {}", file);
                return LoadResult.SKIPPED;
            }

            String title = MemoryTitles.resolve(fm.title, fm.content);
            cache.put(storeKey, new MemoryEntry(title, fm.content, fm.time, fm.importance, fm.ttl, fm.storedTime));
            if (parts != null) {
                indexByUser.computeIfAbsent(parts[0], k -> new ConcurrentHashMap<>())
                        .put(buildDocId(parts[0], parts[1]),
                                new IndexEntry(parts[0], parts[1], title, fm.content, fm.importance, fm.time,
                                        fm.ttl, fm.storedTime));
            }

            return LoadResult.LOADED;
        } catch (Exception e) {
            LOG.warn("MdMemoryData loadSingleFile error: {}", file, e);
            return LoadResult.SKIPPED;
        }
    }

    // ==================== MD 文件读写 ====================

    /**
     * 写入 MD 文件（原子写入 + 自动降级）
     */
    private void writeMdFile(Path file, String storeKey, String title, String time, int importance, int ttl,
                             String storedTime, String content) throws IOException {
        String md = buildMdContent(storeKey, title, time, importance, ttl, storedTime, content);
        Path safeFile = ensureWithinBase(file);
        ensureSafeExistingPath(safeFile);
        Path tmpFile = Files.createTempFile(baseDir, ".memory-", ".tmp");
        try {
            ensureSafeExistingPath(tmpFile);
            Files.write(tmpFile, md.getBytes(StandardCharsets.UTF_8), StandardOpenOption.TRUNCATE_EXISTING);
            try {
                Files.move(tmpFile, safeFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                // 降级为普通 rename（Windows/FAT32/NFS/Docker overlay 等环境）
                Files.move(tmpFile, safeFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmpFile);
        }
    }

    /**
     * 从 MD 文件加载单条记忆（缓存未命中时调用）
     */
    private MemoryEntry loadFromMdFile(String storeKey) {
        Path file = resolveFile(storeKey);
        if (!Files.exists(file)) {
            return null;
        }

        try {
            FrontMatter fm = parseFrontMatter(Files.readAllLines(file, StandardCharsets.UTF_8));
            if (fm == null) {
                return null;
            }
            if (fm.storeKey != null && !fm.storeKey.isEmpty() && !storeKey.equals(fm.storeKey)) {
                LOG.warn("MdMemoryData: name field does not match requested key, ignored: file={}, name={}", file, fm.storeKey);
                return null;
            }
            fm.storedTime = resolveStoredTime(fm.storedTime, fm.time, file);
            MemoryEntry tempEntry = new MemoryEntry(MemoryTitles.resolve(fm.title, fm.content), fm.content,
                    fm.time, fm.importance, fm.ttl, fm.storedTime);

            // 先检查 TTL，过期的直接删除文件返回 null，避免无意义的补写 I/O
            if (isExpired(tempEntry)) {
                try { Files.deleteIfExists(file); } catch (IOException ignored) {}
                return null;
            }

            // 未过期且 Front Matter 中缺少 storeKey 时补写
            if (fm.storeKey == null || fm.storeKey.isEmpty()) {
                try {
                    writeMdFile(file, storeKey, tempEntry.title, fm.time, fm.importance, fm.ttl, fm.storedTime, fm.content);
                } catch (IOException ignored) {
                }
            }

            return tempEntry;
        } catch (IOException e) {
            LOG.error("MdMemoryData loadFromMdFile error, key={}", storeKey, e);
            return null;
        }
    }

    // ===================== 内部工具方法 =====================

    /**
     * 构建完整 storeKey："{userId}__{key}"
     */
    private String buildStoreKey(String userId, String key) {
        validateIdentity("userId", userId);
        validateIdentity("key", key);
        return userId + "__" + key;
    }

    private void validateIdentity(String field, String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(field + " must not be empty");
        }
        if (!value.equals(value.trim()) || value.indexOf('\0') >= 0
                || value.contains("/") || value.contains("\\") || value.contains("..")) {
            throw new IllegalArgumentException("Illegal " + field + ": " + value);
        }
        try {
            if (Paths.get(value).isAbsolute()) {
                throw new IllegalArgumentException("Illegal " + field + ": absolute path");
            }
        } catch (InvalidPathException e) {
            throw new IllegalArgumentException("Illegal " + field + ": invalid path", e);
        }
    }

    /**
     * 构建 docId："{userId}:{key}"
     * <p>
     * 当前与 storeKey 格式一致，独立方法便于后续格式变化时统一修改。
     */
    private String buildDocId(String userId, String key) {
        validateIdentity("userId", userId);
        validateIdentity("key", key);
        return userId + ":" + key;
    }

    private Path resolveFile(String storeKey) {
        String[] parts = splitStoreKey(storeKey);
        if (parts == null) {
            throw new IllegalArgumentException("Illegal storeKey: " + storeKey);
        }
        Path file = ensureWithinBase(baseDir.resolve(storeKey + ".md").normalize());
        try {
            ensureSafeExistingPath(file);
        } catch (IOException e) {
            throw new IllegalArgumentException("Unsafe memory path: " + file, e);
        }
        return file;
    }

    private Path ensureWithinBase(Path target) {
        Path normalized = target.toAbsolutePath().normalize();
        if (!normalized.startsWith(baseDir)) {
            throw new IllegalArgumentException("Memory path escapes base directory: " + target);
        }
        return normalized;
    }

    private void ensureSafeExistingPath(Path target) throws IOException {
        Path normalized = ensureWithinBase(target);
        rejectSymbolicLinkComponents(normalized);
        Path parent = normalized.getParent();
        if (parent == null || !parent.toRealPath(LinkOption.NOFOLLOW_LINKS).equals(baseDir)) {
            throw new IOException("Memory path parent escapes real storage root: " + target);
        }
        if (Files.exists(normalized, LinkOption.NOFOLLOW_LINKS) && Files.isSymbolicLink(normalized)) {
            throw new IOException("Symbolic link memory file is not allowed: " + target);
        }
    }

    /**
     * 清理残留的 .tmp 文件（writeMdFile 中 move 失败时可能残留）
     */
    private void cleanupTmpFiles(Path baseDir) {
        try (Stream<Path> files = Files.list(baseDir)) {
            files.filter(p -> p.getFileName().toString().startsWith(".memory-")
                            && p.getFileName().toString().endsWith(".tmp"))
                 .forEach(p -> {
                     try {
                         if (!Files.isSymbolicLink(p)) Files.deleteIfExists(p);
                     } catch (IOException ignored) {}
                 });
        } catch (IOException ignored) {
        }
    }

    /**
     * 从文件名启发式还原 storeKey（仅用于兼容不含 storeKey 字段的旧格式文件）
     * <p>
     * 注意：此还原将 _ 替换为 : ，如果 key 本身含 _ 还原会不准确。
     * 建议新文件都通过 Front Matter 中的 name 字段精确还原。
     */
    private String fileNameToStoreKey(String fileName) {
        String name = fileName.endsWith(".md") ? fileName.substring(0, fileName.length() - 3) : fileName;
        // 去掉 hash 前缀（格式：{hash}_xxx）
        int underscoreIdx = name.indexOf('_');
        if (underscoreIdx > 0) {
            name = name.substring(underscoreIdx + 1);
        }
        return name.replace("_", ":");
    }

    /**
     * 拆分 storeKey 为 userId 和 key
     * "{userId}__{key}" → ["{userId}", "{key}"]
     */
    private String[] splitStoreKey(String storeKey) {
        if (storeKey == null) return null;
        int sepIdx = storeKey.indexOf("__");
        if (sepIdx <= 0 || sepIdx + 2 >= storeKey.length()) return null;
        String userId = storeKey.substring(0, sepIdx);
        String key = storeKey.substring(sepIdx + 2);
        try {
            validateIdentity("userId", userId);
            validateIdentity("key", key);
        } catch (IllegalArgumentException e) {
            return null;
        }
        return new String[]{userId, key};
    }

    private String buildMdContent(String storeKey, String title, String time, int importance, int ttl,
                                  String storedTime, String content) {
        StringBuilder sb = new StringBuilder();
        sb.append(FRONT_MATTER_DELIMITER).append("\n");
        sb.append("name: \"").append(escapeYaml(storeKey)).append("\"\n");
        sb.append("title: \"").append(escapeYaml(MemoryTitles.resolve(title, content))).append("\"\n");
        sb.append("time: \"").append(time).append("\"\n");
        sb.append("importance: ").append(importance).append("\n");
        sb.append("ttl: ").append(ttl).append("\n");
        sb.append("stored_at: \"").append(storedTime).append("\"\n");
        sb.append(FRONT_MATTER_DELIMITER).append("\n\n");
        sb.append(content).append("\n");
        return sb.toString();
    }

    /**
     * 转义 YAML 值中的特殊字符（storeKey 含冒号，必须引号包裹）
     */
    private String escapeYaml(String val) {
        if (val == null) return "";
        return val.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * 解析 MD 文件的 Front Matter
     *
     * <p>使用项目自带的 {@link MarkdownUtil} 解析 YAML Front Matter，替代手写解析。
     * MarkdownUtil 基于 SnakeYAML，可复原地处理转义字符（先 \\ 再 \"），
     * 且只在前几行内查找结束符 --- ，避免 body 中的 --- 被误识别。
     */
    private FrontMatter parseFrontMatter(List<String> lines) {
        if (Assert.isEmpty(lines)) return null;

        Markdown markdown = MarkdownUtil.resolve(lines);

        ONode meta = markdown.getMetadata();
        if (meta.size() == 0) return null;

        FrontMatter fm = new FrontMatter();
        fm.content = markdown.getContent();

        if (meta.hasKey("name")) {
            fm.storeKey = meta.get("name").getString();
        }
        if (meta.hasKey("title")) {
            fm.title = meta.get("title").getString();
        }
        if (meta.hasKey("time")) {
            fm.time = meta.get("time").getString();
        }
        if (meta.hasKey("importance")) {
            fm.importance = meta.get("importance").getInt();
        }
        if (meta.hasKey("ttl")) {
            fm.ttl = meta.get("ttl").getInt();
        }
        if (meta.hasKey("stored_at")) {
            fm.storedTime = meta.get("stored_at").getString();
        }

        return fm;
    }

    private boolean isExpired(MemoryEntry entry) {
        return isExpired(entry.ttl, entry.storedTime);
    }

    private boolean isExpired(int ttl, String storedTime) {
        Long expiresAt = expiresAtEpochMs(ttl, storedTime);
        return expiresAt != null && System.currentTimeMillis() >= expiresAt;
    }

    private Long expiresAtEpochMs(int ttl, String storedTime) {
        if (ttl < 0 || storedTime == null || storedTime.isEmpty()) return null;
        try {
            LocalDateTime stored = LocalDateTime.parse(storedTime, FORMATTER);
            return stored.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli() + ttl * 1000L;
        } catch (Exception e) {
            return null;
        }
    }

    private String resolveStoredTime(String storedTime, String factTime, Path file) {
        if (isValidTime(storedTime)) return storedTime;
        if (isValidTime(factTime)) return factTime;
        try {
            return LocalDateTime.ofInstant(Files.getLastModifiedTime(file).toInstant(), ZoneId.systemDefault())
                    .format(FORMATTER);
        } catch (IOException e) {
            LOG.warn("MdMemoryData cannot resolve stored time from file: {}", file, e);
            return "";
        }
    }

    private boolean isValidTime(String value) {
        if (value == null || value.isEmpty()) return false;
        try {
            LocalDateTime.parse(value, FORMATTER);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void removeExpiredEntries(String userId) {
        synchronized (rootLock) {
            removeExpiredEntriesLocked(userId);
        }
    }

    private void removeExpiredEntriesLocked(String userId) {
        Map<String, IndexEntry> userIndex = indexByUser.get(userId);
        if (userIndex == null || userIndex.isEmpty()) return;
        List<String> expired = userIndex.values().stream()
                .filter(e -> isExpired(e.ttl, e.storedTime))
                .map(e -> e.userKey)
                .collect(Collectors.toList());
        for (String key : expired) {
            try {
                removeLocked(userId, key);
            } catch (RuntimeException e) {
                LOG.warn("MdMemoryData expired entry could not be deleted; keeping it visible for retry: userId={}, key={}",
                        userId, key, e);
            }
        }
    }

    private String buildJson(String title, String content, String time, int importance) {
        return "{\"title\":" + ONode.serialize(MemoryTitles.resolve(title, content))
                + ",\"content\":" + ONode.serialize(content)
                + ",\"time\":" + ONode.serialize(time)
                + ",\"importance\":" + importance + "}";
    }

    private String getNow() {
        return LocalDateTime.now().format(FORMATTER);
    }

    // ==================== 后台过期清理 ====================

    /**
     * 启用后台定时清理过期条目
     *
     * @param intervalSeconds 清理间隔（秒）
     */
    public MemoryMdData enableAutoCleanup(long intervalSeconds) {
        if (cleanupScheduler != null) {
            return this; // 已启用
        }
        cleanupScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "md-memory-cleanup");
            t.setDaemon(true);
            return t;
        });
        cleanupScheduler.scheduleAtFixedRate(() -> {
                    try {
                        cleanupExpired();
                    } catch (Exception e) {
                        LOG.error("MdMemoryData cleanup error", e);
                    }
                },
                intervalSeconds, intervalSeconds, TimeUnit.SECONDS);
        LOG.info("MdMemoryData auto-cleanup enabled, interval={}s", intervalSeconds);
        return this;
    }

    /**
     * 主动清理所有过期条目（缓存 + 磁盘文件）
     *
     * <p>先收集过期 key 再统一删除，避免遍历中修改导致的弱一致性问题。
     */
    public void cleanupExpired() {
        synchronized (rootLock) {
            List<String[]> expiredKeys = new ArrayList<>();
            for (Map.Entry<String, MemoryEntry> e : cache.entrySet()) {
                if (isExpired(e.getValue())) {
                    String[] parts = splitStoreKey(e.getKey());
                    if (parts != null) expiredKeys.add(parts);
                }
            }
            int removed = 0;
            for (String[] parts : expiredKeys) {
                try {
                    removeLocked(parts[0], parts[1]);
                    removed++;
                } catch (RuntimeException e) {
                    LOG.warn("MdMemoryData cleanup could not delete expired entry: userId={}, key={}", parts[0], parts[1], e);
                }
            }
            if (removed > 0) LOG.debug("MdMemoryData cleanup: {} expired entries removed", removed);
        }
    }

    // ==================== 搜索评分 ====================

    /**
     * 获取索引条目的分词结果（内联缓存，随条目生命周期自动释放）
     *
     * <p>双重检查锁定保证线程安全：volatile 读在 synchronized 外面，
     * 绝大多数情况下直接返回已缓存的分词结果，不进入同步块。
     */
    private Set<String> getTokens(IndexEntry entry) {
        Set<String> tokens = entry.tokens;
        if (tokens == null) {
            synchronized (entry) {
                tokens = entry.tokens;
                if (tokens == null) {
                    tokens = tokenize(entry.content.toLowerCase());
                    entry.tokens = tokens;
                }
            }
        }
        return tokens;
    }

    /**
     * 分词：支持英文单词切分 + 中文 bi-gram
     *
     * <p>英文：按非字母数字字符分割，长度 >1 的 token 保留。
     * <p>中文：对连续中文字符做 bi-gram（每两个相邻字组成一个 token），
     * 提升"用户偏好使用Solon框架"这类混合文本的搜索命中率。
     */
    private Set<String> tokenize(String text) {
        Set<String> tokens = new HashSet<>();

        // 提取所有连续的英文片段和中文片段
        StringBuilder englishBuf = new StringBuilder();
        StringBuilder chineseBuf = new StringBuilder();

        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c >= '\u4e00' && c <= '\u9fff') {
                // 先 flush 英文缓冲区
                flushEnglish(englishBuf, tokens);
                chineseBuf.append(c);
            } else if (Character.isLetterOrDigit(c)) {
                // 先 flush 中文缓冲区
                flushChinese(chineseBuf, tokens);
                englishBuf.append(c);
            } else {
                // 分隔符：flush 两个缓冲区
                flushEnglish(englishBuf, tokens);
                flushChinese(chineseBuf, tokens);
            }
        }

        // flush 尾部
        flushEnglish(englishBuf, tokens);
        flushChinese(chineseBuf, tokens);

        return tokens;
    }

    private void flushEnglish(StringBuilder buf, Set<String> tokens) {
        if (buf.length() > 1) {
            tokens.add(buf.toString().toLowerCase());
        }
        buf.setLength(0);
    }

    private void flushChinese(StringBuilder buf, Set<String> tokens) {
        if (buf.length() >= 2) {
            String str = buf.toString();
            // 保留完整短语（提升短查询的精确匹配）
            tokens.add(str);
            // bi-gram 分词：每两个相邻字组成一个 token
            for (int i = 0; i < str.length() - 1; i++) {
                tokens.add(str.substring(i, i + 2));
            }
        } else if (buf.length() == 1) {
            // 单字也保留，避免丢失短词匹配
            tokens.add(buf.toString());
        }
        buf.setLength(0);
    }

    /**
     * 搜索评分：token 命中率 + 重要性权重
     *
     * <p>评分策略：
     * <ul>
     *   <li>精确 token 命中：按命中比率计分（权重 0.7）+ 重要性加权（权重 0.3）</li>
     *   <li>子串兜底命中：仅当精确 token 命中为 0 时触发，降权计分（权重 0.3）+ 重要性加权（权重 0.2）</li>
     * </ul>
     */
    private double computeScore(IndexEntry entry, Set<String> queryTokens) {
        String contentLower = entry.content.toLowerCase();
        Set<String> contentTokens = getTokens(entry);

        // 阶段一：精确 token 命中
        long tokenHits = queryTokens.stream()
                .filter(contentTokens::contains)
                .count();

        if (tokenHits > 0) {
            double hitRate = (double) tokenHits / queryTokens.size();
            double impWeight = entry.importance / 10.0;

            return hitRate * 0.7 + impWeight * 0.3;
        }

        // 阶段二：子串兜底（降权）
        long substrHits = 0;
        for (String token : queryTokens) {
            if (contentLower.contains(token)) {
                substrHits++;
            }
        }

        if (substrHits == 0) return 0;

        double substrRate = (double) substrHits / queryTokens.size();
        double impWeight = entry.importance / 10.0;

        return substrRate * 0.3 + impWeight * 0.2;
    }

    // ==================== 生命周期管理 ====================

    @Override
    public void close() {
        if (cleanupScheduler != null) {
            cleanupScheduler.shutdownNow();
            cleanupScheduler = null;
        }
    }

    // ==================== 内部数据结构 ====================

    private MemorySearchResult toSearchResult(IndexEntry entry) {
        return new MemorySearchResult(entry.userKey, entry.title, entry.content, entry.importance, entry.time,
                entry.ttl, entry.storedTime, true, expiresAtEpochMs(entry.ttl, entry.storedTime));
    }

    static class MemoryEntry {
        String title;
        String content;
        String time;
        int importance;
        int ttl;
        String storedTime;

        MemoryEntry(String title, String content, String time, int importance, int ttl, String storedTime) {
            this.title = title;
            this.content = content;
            this.time = time;
            this.importance = importance;
            this.ttl = ttl;
            this.storedTime = storedTime;
        }
    }

    static class IndexEntry {
        String userId;
        String userKey;
        String title;
        String content;
        int importance;
        String time;
        int ttl;
        String storedTime;
        /**
         * 分词结果内联缓存（lazy init，随 IndexEntry 生命周期自动释放）
         */
        volatile Set<String> tokens;

        IndexEntry(String userId, String userKey, String title, String content, int importance, String time,
                   int ttl, String storedTime) {
            this.userId = userId;
            this.userKey = userKey;
            this.title = title;
            this.content = content;
            this.importance = importance;
            this.time = time;
            this.ttl = ttl;
            this.storedTime = storedTime;
        }
    }

    static class FrontMatter {
        String storeKey = "";
        String title = "";
        String time = "";
        int importance = 0;
        int ttl = -1;
        String storedTime = "";
        String content = "";
    }

    static class ScoredEntry {
        final IndexEntry entry;
        final double score;

        ScoredEntry(IndexEntry entry, double score) {
            this.entry = entry;
            this.score = score;
        }
    }
}
