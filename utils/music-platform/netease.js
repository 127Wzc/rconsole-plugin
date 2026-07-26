/**
 * 网易云点歌平台适配器
 * 仅覆盖普通歌曲 / 播客；云盘逻辑仍由 apps/songRequest.js 独占
 */
import axios from "axios";
import { COMMON_USER_AGENT } from "../../constants/constant.js";
import { NETEASE_TEMP_API } from "../../constants/tools.js";
import { formatTime } from "../other.js";
import { createEmptyPlayResult, createSongItem } from "./helpers.js";

const QUALITY_LABEL_MAP = {
    standard: "标准",
    higher: "较高",
    exhigh: "极高",
    lossless: "无损",
    hires: "Hi-Res",
    jyeffect: "高清环绕声",
    sky: "沉浸环绕声",
    dolby: "杜比全景声",
    jymaster: "超清母带",
};

function translateQuality(level = "") {
    return QUALITY_LABEL_MAP[level] || level || "";
}

function bytesToMB(sizeInBytes) {
    const size = Number(sizeInBytes);
    if (!Number.isFinite(size) || size <= 0) {
        return "";
    }
    return (size / (1024 * 1024)).toFixed(2);
}

function isPodcastType(contentType) {
    return String(contentType) === "2" || contentType === "podcast";
}

/**
 * @param {object} context
 * @returns {import('./index.js').MusicPlatformAdapter}
 */
export function createNeteasePlatform(context = {}) {
    const {
        apiServer = "",
        cookie = "",
        quality = "exhigh",
    } = context;

    async function requestJson(url, options = {}) {
        if (!apiServer) {
            throw new Error("未配置网易云 API 地址");
        }
        const response = await axios.get(url, {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
                ...(options.cookie ? { Cookie: options.cookie } : {}),
            },
            timeout: 15000,
            validateStatus: () => true,
        });
        if (response.status >= 400) {
            throw new Error(`网易云请求失败，状态码：${response.status}`);
        }
        return response.data;
    }

    async function enrichSongDetails(songItems = []) {
        const ids = songItems
            .filter(item => item.sourceType === "song" && item.providerData?.id)
            .map(item => item.providerData.id);
        if (!ids.length) {
            return songItems;
        }
        try {
            const detailUrl = `${apiServer}/song/detail?ids=${ids.join(",")}&time=${Date.now()}`;
            const detailData = await requestJson(detailUrl);
            const songs = detailData?.songs || [];
            const detailMap = new Map();
            for (const songDetail of songs) {
                let cover = songDetail?.al?.picUrl || "def";
                if (String(cover).includes("109951169484091680.jpg")) {
                    cover = "def";
                }
                detailMap.set(String(songDetail.id), {
                    songName: songDetail.name,
                    singerName: songDetail.ar?.[0]?.name,
                    cover,
                });
            }
            return songItems.map(item => {
                if (item.sourceType !== "song" || !item.providerData?.id) {
                    return item;
                }
                const detail = detailMap.get(String(item.providerData.id));
                if (!detail) {
                    return item;
                }
                return createSongItem({
                    ...item,
                    songName: detail.songName || item.songName,
                    singerName: detail.singerName || item.singerName,
                    cover: detail.cover || item.cover,
                });
            });
        } catch (error) {
            logger?.warn?.(`[music-platform][netease] 补全封面失败: ${error.message}`);
            return songItems;
        }
    }

    async function search(keyword, options = {}) {
        const limit = Math.max(1, Number(options.limit) || 10);
        const contentType = options.contentType || "1";
        if (!keyword?.trim()) {
            return [];
        }
        if (!apiServer) {
            throw new Error("未配置网易云 API 地址");
        }

        let searchUrl;
        if (isPodcastType(contentType)) {
            searchUrl = `${apiServer}/search?keywords=${encodeURIComponent(keyword)}&type=2000&limit=${limit}`;
        } else if (options.useCloudSearch) {
            // #播放 历史行为：cloudsearch 首条
            searchUrl = `${apiServer}/cloudsearch?keywords=${encodeURIComponent(keyword)}&limit=${limit}`;
        } else {
            searchUrl = `${apiServer}/search?keywords=${encodeURIComponent(keyword)}&limit=${limit}`;
        }

        const data = await requestJson(searchUrl);
        const results = isPodcastType(contentType)
            ? data?.data?.resources
            : (data?.result?.songs || data?.songs || []);

        if (!Array.isArray(results) || results.length === 0) {
            return [];
        }

        /** @type {import('./index.js').SongItem[]} */
        const songItems = [];
        for (const info of results.slice(0, limit)) {
            if (isPodcastType(contentType)) {
                songItems.push(createSongItem({
                    platform: "netease",
                    sourceType: "podcast",
                    programId: info?.baseInfo?.id,
                    id: info?.baseInfo?.mainSong?.id,
                    songName: info?.baseInfo?.mainSong?.name || "",
                    singerName: info?.baseInfo?.dj?.nickname || "",
                    duration: formatTime(info?.baseInfo?.duration || 0),
                    cover: info?.baseInfo?.coverUrl || "def",
                }));
            } else {
                // search 与 cloudsearch 字段略有差异
                const durationMs = info.duration ?? info.dt ?? 0;
                const singerName = info.artists?.[0]?.name || info.ar?.[0]?.name || "";
                const cover = info.al?.picUrl || info.album?.picUrl || "def";
                songItems.push(createSongItem({
                    platform: "netease",
                    sourceType: "song",
                    id: info.id,
                    songName: info.name || "",
                    singerName,
                    duration: formatTime(durationMs),
                    cover,
                }));
            }
        }

        if (!isPodcastType(contentType) && !options.skipDetail) {
            return enrichSongDetails(songItems);
        }
        return songItems;
    }

    async function fetchWikiTags(songId) {
        const tags = [];
        if (!songId || !apiServer) {
            return tags;
        }
        try {
            const wikiData = await requestJson(`${apiServer}/song/wiki/summary?id=${songId}`);
            const creatives = wikiData?.data?.blocks?.[1]?.creatives || [];
            if (!creatives[0]) {
                return tags;
            }
            const first = creatives[0]?.resources?.[0]?.uiElement?.mainTitle?.title;
            if (first) {
                tags.push(first);
            }
            const recTags = creatives[1];
            if (recTags?.resources?.[0]) {
                for (let i = 0; i < Math.min(3, recTags.resources.length); i++) {
                    const title = recTags.resources[i]?.uiElement?.mainTitle?.title;
                    if (title) {
                        tags.push(title);
                    }
                }
            } else if (recTags?.uiElement?.textLinks?.[0]?.text) {
                tags.push(recTags.uiElement.textLinks[0].text);
            }
            if (creatives[2]?.uiElement?.mainTitle?.title === "BPM") {
                const bpm = creatives[2]?.uiElement?.textLinks?.[0]?.text;
                if (bpm) {
                    tags.push(`BPM ${bpm}`);
                }
            } else if (creatives[2]?.uiElement?.textLinks?.[0]?.text) {
                tags.push(creatives[2].uiElement.textLinks[0].text);
            }
        } catch (error) {
            logger?.debug?.(`[music-platform][netease] wiki 标签获取失败: ${error.message}`);
        }
        return tags;
    }

    async function checkCookieAlive(requestCookie = cookie) {
        if (!requestCookie || !apiServer) {
            return false;
        }
        try {
            const data = await requestJson(`${apiServer}/login/status`, { cookie: requestCookie });
            return !!data?.data?.profile;
        } catch {
            return false;
        }
    }

    async function resolveTempUrl(title) {
        // 保留「- -> 空格」（与历史一致只替换首个），并对整段 title 做 URL 编码
        const queryTitle = encodeURIComponent(String(title || "").replace("-", " "));
        const response = await axios.get(NETEASE_TEMP_API.replace("{}", queryTitle), {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
            },
            timeout: 15000,
            validateStatus: () => true,
        });
        return {
            url: response.data?.music_url || "",
            sizeHint: response.data?.id
                ?? response.data?.data?.quality
                ?? response.data?.pay
                ?? "",
        };
    }

    async function resolve(songItem, options = {}) {
        const item = createSongItem({
            ...songItem,
            platform: "netease",
        });
        const songId = item.providerData?.id;
        if (!songId) {
            return createEmptyPlayResult({
                warnings: ["缺少网易云歌曲 id"],
            });
        }

        const useCookie = options.cookie ?? cookie;
        const useQuality = options.quality || quality;
        const isCloudSong = item.sourceType === "cloud" || options.isCloudSong === true;
        const requestCookie = options.cloudCookie && isCloudSong
            ? options.cloudCookie
            : useCookie;

        const downloadUrl = `${apiServer}/song/url/v1?id=${songId}&level=${useQuality}`;
        let level = "";
        let size = "";
        let audioType = "mp3";
        let url = "";
        const warnings = [];

        try {
            const data = await requestJson(downloadUrl, { cookie: requestCookie });
            const audio = data?.data?.[0];
            url = audio?.url || "";
            level = translateQuality(audio?.level);
            size = bytesToMB(audio?.size);
            audioType = audio?.type || "mp3";
        } catch (error) {
            warnings.push(`获取音源失败: ${error.message}`);
        }

        const tags = await fetchWikiTags(songId);
        if (level) {
            tags.push(level);
        }

        // 校验必须用实际请求 Cookie（云盘场景用 cloudCookie），避免误判后覆盖已解析音源
        const cookieAlive = options.cookieAlive !== undefined
            ? options.cookieAlive
            : await checkCookieAlive(requestCookie);

        // 与历史行为一致：ck 无效或无 url 时走临时接口
        if (!cookieAlive || !url) {
            try {
                const title = `${item.singerName}-${item.songName}`;
                const temp = await resolveTempUrl(title);
                if (temp.url) {
                    url = temp.url;
                    if (temp.sizeHint) {
                        size = String(temp.sizeHint);
                    }
                    // 临时接口时去掉末尾音质标签（历史 musicTempApi 行为）
                    if (tags.length) {
                        tags.pop();
                    }
                    warnings.push("已使用临时音源接口");
                }
            } catch (error) {
                warnings.push(`临时音源失败: ${error.message}`);
            }
        }

        const cover = item.cover && item.cover !== "def"
            ? item.cover
            : "https://p2.music.126.net/UeTuwE7pvjBpypWLudqukA==/3132508627578625.jpg";

        let card = null;
        if (item.sourceType === "podcast") {
            card = {
                kind: "custom",
                pageUrl: `https://music.163.com/dj?id=${item.providerData.programId || songId}&userid=`,
                audioUrl: url,
                title: `声音：${item.songName}`,
                image: cover,
                musicType: "163",
            };
        } else if (item.sourceType === "cloud") {
            card = {
                kind: "custom",
                pageUrl: `https://music.163.com/song?id=${songId}`,
                audioUrl: url,
                title: item.songName,
                image: cover,
                musicType: "163",
            };
        } else {
            card = {
                kind: "native",
                platformType: "163",
                id: songId,
            };
        }

        return createEmptyPlayResult({
            url,
            audioType,
            size: size ? `${size}${String(size).includes("MB") || /[^\d.]/.test(String(size)) ? "" : " MB"}` : "",
            qualityLabel: level,
            cover: item.cover || "def",
            tags,
            warnings,
            card,
        });
    }

    return {
        platform: "netease",
        displayName: "网易云音乐",
        supportsContentType(contentType) {
            // 1 歌曲，2 播客
            return ["1", "2", "song", "podcast"].includes(String(contentType || "1"));
        },
        search,
        resolve,
    };
}
