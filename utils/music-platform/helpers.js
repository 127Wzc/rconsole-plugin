/**
 * 点歌适配器共享契约与工具（无平台注册，避免循环依赖）
 */

/**
 * 归一化平台 id（仅做字符串归一，不查注册表）
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizePlatformAlias(platform = "") {
    const value = String(platform || "").trim().toLowerCase();
    if (!value) {
        return "netease";
    }
    if (["网易云", "网易", "wy", "wyy", "ncm", "netease"].includes(value)) {
        return "netease";
    }
    if (["酷狗", "kg", "kugoumusic", "kugou"].includes(value)) {
        return "kugou";
    }
    return value;
}

/**
 * 创建统一 SongItem
 * @param {object} input
 * @returns {object}
 */
export function createSongItem(input = {}) {
    const platform = normalizePlatformAlias(input.platform || "netease");
    const sourceType = input.sourceType || input.type || "song";
    const providerData = {
        ...(input.providerData || {}),
    };
    if (input.id !== undefined && providerData.id === undefined) {
        providerData.id = input.id;
    }
    if (input.programId !== undefined && providerData.programId === undefined) {
        providerData.programId = input.programId;
    }
    if (input.hash !== undefined && providerData.hash === undefined) {
        providerData.hash = input.hash;
    }
    if (input.albumId !== undefined && providerData.albumId === undefined) {
        providerData.albumId = input.albumId;
    }
    if (input.albumAudioId !== undefined && providerData.albumAudioId === undefined) {
        providerData.albumAudioId = input.albumAudioId;
    }

    // 无平台 id 时用 hash / albumAudioId 兜底，方便列表 key 与调试
    const fallbackId = providerData.id
        ?? providerData.hash
        ?? providerData.albumAudioId
        ?? undefined;

    return {
        platform,
        sourceType,
        songName: input.songName || "",
        singerName: input.singerName || "",
        duration: input.duration || "",
        cover: input.cover || "def",
        providerData,
        // 兼容旧模板 / 旧 Redis 读取路径
        type: sourceType,
        id: fallbackId,
        programId: providerData.programId,
        hash: providerData.hash,
        albumId: providerData.albumId,
        albumAudioId: providerData.albumAudioId,
    };
}

/**
 * 将 Redis 中可能过期的旧结构归一化为 SongItem
 * @param {object} raw
 * @param {string} [fallbackPlatform='netease']
 * @returns {object|null}
 */
export function normalizeLegacySongItem(raw, fallbackPlatform = "netease") {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    return createSongItem({
        platform: raw.platform || fallbackPlatform,
        sourceType: raw.sourceType || raw.type || "song",
        songName: raw.songName || "",
        singerName: raw.singerName || "",
        duration: raw.duration || "",
        cover: raw.cover || "def",
        providerData: raw.providerData || {},
        id: raw.id,
        programId: raw.programId,
        hash: raw.hash,
        albumId: raw.albumId,
        albumAudioId: raw.albumAudioId,
    });
}

/**
 * 空播放结果
 * @param {object} [partial]
 * @returns {object}
 */
export function createEmptyPlayResult(partial = {}) {
    return {
        url: "",
        audioType: "mp3",
        size: "",
        qualityLabel: "",
        cover: "def",
        tags: [],
        warnings: [],
        card: null,
        ...partial,
    };
}
