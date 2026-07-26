/**
 * 酷狗点歌平台适配器
 * 协议细节复用 utils/kugou.js，这里只做契约映射
 */
import {
    getKugouSongUrl,
    searchKugouSongs,
} from "../kugou.js";
import { createEmptyPlayResult, createSongItem } from "./helpers.js";

/**
 * @param {object} context
 * @returns {import('./index.js').MusicPlatformAdapter}
 */
export function createKugouPlatform(context = {}) {
    const {
        apiServer = "",
        cookie = "",
        quality = "flac",
    } = context;

    async function search(keyword, options = {}) {
        const limit = Math.max(1, Number(options.limit) || 10);
        if (!keyword?.trim()) {
            return [];
        }
        if (!apiServer) {
            throw new Error("未配置酷狗 API 地址（tools.kugouApiServer）");
        }
        if (String(options.contentType) === "2" || options.contentType === "podcast") {
            // 明确不支持，由编排层提示用户
            return [];
        }

        const result = await searchKugouSongs(apiServer, keyword, {
            cookie: options.cookie ?? cookie,
            limit,
        });

        return (result.list || []).map(item => createSongItem({
            platform: "kugou",
            sourceType: "song",
            songName: item.songName || "",
            singerName: item.authorName || "",
            duration: item.duration || "",
            cover: item.cover || "def",
            providerData: {
                hash: item.hash || "",
                albumId: item.albumId || "",
                albumAudioId: item.albumAudioId || "",
            },
            // 兼容顶层读取
            hash: item.hash || "",
            albumId: item.albumId || "",
            albumAudioId: item.albumAudioId || "",
            id: item.hash || item.albumAudioId || "",
        }));
    }

    async function resolve(songItem, options = {}) {
        const item = createSongItem({
            ...songItem,
            platform: "kugou",
        });
        const hash = item.providerData?.hash || item.hash;
        if (!hash) {
            return createEmptyPlayResult({
                warnings: ["缺少酷狗 hash"],
            });
        }
        if (!apiServer) {
            return createEmptyPlayResult({
                warnings: ["未配置酷狗 API 地址"],
            });
        }

        const warnings = [];
        const useCookie = options.cookie ?? cookie;
        const useQuality = options.quality || quality;

        let urlResult;
        try {
            urlResult = await getKugouSongUrl(apiServer, {
                hash,
                albumId: item.providerData?.albumId || item.albumId || "",
                albumAudioId: item.providerData?.albumAudioId || item.albumAudioId || "",
                cookie: useCookie,
                quality: useQuality,
            });
        } catch (error) {
            return createEmptyPlayResult({
                cover: item.cover || "def",
                warnings: [`获取酷狗音源失败: ${error.message}`],
            });
        }

        if (urlResult?.error) {
            warnings.push(String(urlResult.error));
        }

        const url = urlResult?.url || "";
        const cover = urlResult?.cover || item.cover || "def";
        const songTitle = item.songName || "酷狗音乐";
        const singerName = item.singerName || "";
        const albumAudioId = String(item.providerData?.albumAudioId || item.albumAudioId || "").trim();
        // 优先用分享页；无 albumAudioId 时退回 hash 页
        const pageUrl = albumAudioId
            ? `https://www.kugou.com/mixsong/${albumAudioId}.html`
            : `https://www.kugou.com/song/#hash=${hash}`;
        const image = cover && cover !== "def"
            ? cover
            : "https://webimg.kgimg.com/f226621fa64d1994ce819f1f0d80b26b.png";

        // 卡片策略（按可靠性）：
        // 1) 有 mixsongid/albumAudioId → NapCat 原生 music type=kugou
        // 2) 否则 → custom music（可播放，标签可能显示自定义/QQ）
        // 不要手写无 token 的 tuwen.lua JSON，客户端会提示「发送者版本过低」
        let card = null;
        if (albumAudioId) {
            card = {
                kind: "native",
                platformType: "kugou",
                id: albumAudioId,
                // 原生卡失败时的 custom 兜底字段
                pageUrl,
                audioUrl: url,
                title: songTitle,
                content: singerName ? `${singerName} · 酷狗音乐` : "酷狗音乐",
                image,
                musicType: "custom",
            };
        } else if (url) {
            card = {
                kind: "custom",
                pageUrl,
                audioUrl: url,
                title: songTitle,
                content: singerName ? `${singerName} · 酷狗音乐` : "酷狗音乐",
                image,
                musicType: "custom",
            };
        }

        return createEmptyPlayResult({
            url,
            audioType: urlResult?.audioType || "mp3",
            size: urlResult?.size || "",
            qualityLabel: urlResult?.qualityLabel || "",
            cover,
            tags: ["酷狗音乐", urlResult?.qualityLabel].filter(Boolean),
            warnings,
            card,
        });
    }

    return {
        platform: "kugou",
        displayName: "酷狗音乐",
        supportsContentType(contentType) {
            // 酷狗暂不支持播客
            return !["2", "podcast"].includes(String(contentType || "1"));
        },
        search,
        resolve,
    };
}
