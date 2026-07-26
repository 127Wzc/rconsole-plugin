import axios from "axios";
import { COMMON_USER_AGENT } from "../constants/constant.js";

function normalizeApiServer(apiServer = "") {
    return apiServer.replace(/\/+$/, "");
}

function parseSetCookie(setCookie = []) {
    const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookieList
        .filter(Boolean)
        .map(item => item.split(";")[0]?.trim())
        .filter(Boolean)
        .join("; ");
}

function mergeCookies(...cookies) {
    const cookieMap = new Map();
    for (const cookieGroup of cookies.filter(Boolean)) {
        const cookieItems = String(cookieGroup)
            .split(";")
            .map(item => item.trim())
            .filter(Boolean);
        for (const cookieItem of cookieItems) {
            const [key, ...rest] = cookieItem.split("=");
            if (!key || rest.length === 0) {
                continue;
            }
            cookieMap.set(key.trim(), `${key.trim()}=${rest.join("=").trim()}`);
        }
    }
    return Array.from(cookieMap.values()).join("; ");
}

export function extractCookieValue(cookie = "", key = "") {
    if (!cookie || !key) {
        return "";
    }
    const match = String(cookie).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
    return match?.[1]?.trim() || "";
}

function normalizeQrImage(qrimg = "") {
    if (!qrimg) {
        return "";
    }
    if (qrimg.startsWith("base64://") || qrimg.startsWith("http://") || qrimg.startsWith("https://") || qrimg.startsWith("file://")) {
        return qrimg;
    }
    if (qrimg.startsWith("data:image")) {
        return `base64://${qrimg.replace(/^data:image\/[^;]+;base64,/, "")}`;
    }
    return `base64://${qrimg}`;
}

export function getDefaultKugouStatusAvatar() {
    return "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Crect width='240' height='240' rx='120' fill='%23D4F5FE'/%3E%3Ccircle cx='120' cy='120' r='88' fill='%2324BBF9' fill-opacity='0.14'/%3E%3Ctext x='50%25' y='54%25' text-anchor='middle' font-family='Arial' font-size='76' font-weight='700' fill='%2324BBF9'%3EKG%3C/text%3E%3C/svg%3E";
}

export function normalizeKugouStatusImageUrl(url = "") {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
        return getDefaultKugouStatusAvatar();
    }
    if (normalizedUrl.startsWith("//")) {
        return `https:${normalizedUrl}`;
    }
    return normalizedUrl.replace(/^http:\/\//i, "https://");
}

export function formatKugouStatusTime(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "未知";
    }
    return new Date(seconds * 1000).toLocaleString("zh-CN");
}

export function getKugouVipTitle(productType = "") {
    const normalizedType = String(productType || "").trim().toLowerCase();
    if (normalizedType === "tvip") {
        return "TVIP";
    }
    if (normalizedType === "svip") {
        return "SVIP";
    }
    if (normalizedType === "vip") {
        return "VIP";
    }
    return normalizedType ? normalizedType.toUpperCase() : "未开通";
}

export function getKugouVipSubtitle(busiType = "") {
    const normalizedType = String(busiType || "").trim().toLowerCase();
    if (normalizedType === "concept") {
        return "概念版";
    }
    return String(busiType || "").trim() || "当前未检测到会员业务信息";
}

export function parseKugouVipExpireTime(timeText = "") {
    if (!timeText) {
        return 0;
    }
    const normalized = String(timeText).trim().replace(/-/g, "/");
    const timestamp = new Date(normalized).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export function resolveKugouVipDisplay(vipData = {}) {
    const busiVipList = Array.isArray(vipData?.busiVip) ? vipData.busiVip : [];
    const now = Date.now();
    const validVipList = busiVipList
        .filter(item => Number(item?.is_vip) === 1 && parseKugouVipExpireTime(item?.vip_end_time) > now)
        .sort((a, b) => parseKugouVipExpireTime(b?.vip_end_time) - parseKugouVipExpireTime(a?.vip_end_time));
    const expiredVipList = busiVipList
        .filter(item => parseKugouVipExpireTime(item?.vip_end_time) > 0)
        .sort((a, b) => parseKugouVipExpireTime(b?.vip_end_time) - parseKugouVipExpireTime(a?.vip_end_time));

    const activeVip = validVipList[0];
    if (activeVip) {
        return {
            hasActiveVip: true,
            vipTitle: getKugouVipTitle(activeVip.product_type),
            vipSubtitle: getKugouVipSubtitle(activeVip.busi_type),
            vipExpireText: `到期时间：${activeVip.vip_end_time || "未记录"}`,
            vipStateText: "有效中",
        };
    }

    const latestExpiredVip = expiredVipList[0];
    if (latestExpiredVip) {
        return {
            hasActiveVip: false,
            vipTitle: getKugouVipTitle(latestExpiredVip.product_type),
            vipSubtitle: `${getKugouVipSubtitle(latestExpiredVip.busi_type)} · 已过期`,
            vipExpireText: `最近到期：${latestExpiredVip.vip_end_time || "未记录"}`,
            vipStateText: "已过期",
        };
    }

    return {
        hasActiveVip: false,
        vipTitle: "未开通",
        vipSubtitle: "当前未检测到有效酷狗会员",
        vipExpireText: "到期时间：未开通",
        vipStateText: "未开通",
    };
}

export function buildKugouStatusCardData(detailResp = {}, vipResp = {}, kugouCookie = "") {
    const detail = detailResp?.data?.data || {};
    const uid = String(vipResp.userid || detailResp.userid || extractCookieValue(kugouCookie, "userid") || "").trim() || "未知";
    const vipDisplay = resolveKugouVipDisplay(vipResp);

    return {
        nickname: detail.nickname || detail.k_nickname || detailResp.nickname || "酷狗用户",
        avatarUrl: normalizeKugouStatusImageUrl(detail.pic || detail.k_pic || detail.fx_pic || detailResp.avatar),
        uid,
        loginTime: formatKugouStatusTime(detail.logintime),
        hasActiveVip: vipDisplay.hasActiveVip,
        vipTitle: vipDisplay.vipTitle,
        vipSubtitle: vipDisplay.vipSubtitle,
        vipExpireText: vipDisplay.vipExpireText,
        vipStateText: vipDisplay.vipStateText,
        stats: [
            { label: "关注", value: Number(detail.follows) || 0 },
            { label: "粉丝", value: Number(detail.fans) || 0 },
            { label: "访客", value: Number(detail.visitors) || 0 }
        ],
    };
}

function collectObjects(value, result = []) {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectObjects(item, result);
        }
        return result;
    }
    if (value && typeof value === "object") {
        result.push(value);
        for (const item of Object.values(value)) {
            collectObjects(item, result);
        }
    }
    return result;
}

function findFieldDeep(data, keys = []) {
    const objectList = collectObjects(data, []);
    for (const objectItem of objectList) {
        for (const key of keys) {
            if (objectItem?.[key] !== undefined && objectItem?.[key] !== null && objectItem?.[key] !== "") {
                return objectItem[key];
            }
        }
    }
    return null;
}

function isKugouSongLike(item) {
    return !!(item &&
        (item.hash || item.Hash || item.FileHash || item.fileHash) &&
        (
            item.filename ||
            item.songname ||
            item.song_name ||
            item.audio_name ||
            item.name ||
            item.FileName ||
            item.OriSongName ||
            item.SingerName
        ));
}

function extractKugouDurationText(songCandidate = {}) {
    // 明确区分毫秒字段：duration_ms 无论大小都按毫秒转秒
    const durationFieldCandidates = [
        ["Duration", songCandidate.Duration],
        ["duration", songCandidate.duration],
        ["timelen", songCandidate.timelen],
        ["time_length", songCandidate.time_length],
        ["TimeLength", songCandidate.TimeLength],
        ["duration_ms", songCandidate.duration_ms],
    ];
    let fieldName = "";
    let rawDuration = "";
    for (const [name, value] of durationFieldCandidates) {
        if (value !== undefined && value !== null && value !== "") {
            fieldName = name;
            rawDuration = value;
            break;
        }
    }
    const numeric = Number(rawDuration);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return "";
    }
    // 明确毫秒字段固定 /1000；Duration/duration 等默认秒，>10000 再按毫秒兜底
    // 注意：搜索主路径常用 Duration（秒）；timelen 在酷狗侧多为毫秒
    const alwaysMsFields = new Set(["duration_ms", "timelen"]);
    const totalSeconds = alwaysMsFields.has(fieldName) || numeric > 10000
        ? Math.floor(numeric / 1000)
        : Math.floor(numeric);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 从搜索响应中提取歌曲候选列表（优先 data.lists）
 * @param {any} data
 * @param {number} [limit=20]
 * @returns {object[]}
 */
export function findSongCandidates(data, limit = 20) {
    const max = Math.max(1, Number(limit) || 20);
    const listItems = data?.data?.lists;
    if (Array.isArray(listItems) && listItems.length > 0) {
        return listItems.filter(isKugouSongLike).slice(0, max);
    }

    // 兜底：深度扫描，仅在没有 lists 时使用，避免误抓专辑对象
    const objectList = collectObjects(data, []);
    const seen = new Set();
    const result = [];
    for (const item of objectList) {
        if (!isKugouSongLike(item)) {
            continue;
        }
        const hash = item.hash || item.Hash || item.FileHash || item.fileHash || "";
        if (!hash || seen.has(hash)) {
            continue;
        }
        seen.add(hash);
        result.push(item);
        if (result.length >= max) {
            break;
        }
    }
    return result;
}

function findFirstSongCandidate(data) {
    return findSongCandidates(data, 1)[0] || null;
}

function normalizeKugouSongCandidate(songCandidate = {}) {
    const hash = songCandidate.hash || songCandidate.Hash || songCandidate.FileHash || songCandidate.fileHash || "";
    // FileName 形如「歌手 - 歌名」，优先用更干净的 OriSongName / songname
    const songName = songCandidate.OriSongName
        || songCandidate.song_name
        || songCandidate.songname
        || songCandidate.name
        || songCandidate.SongName
        || songCandidate.filename
        || songCandidate.FileName
        || "";
    const authorName = songCandidate.author_name
        || songCandidate.singername
        || songCandidate.singer_name
        || songCandidate.SingerName
        || "";
    const audioName = songCandidate.audio_name
        || songCandidate.FileName
        || songCandidate.filename
        || [authorName, songName].filter(Boolean).join(" - ");

    return {
        hash,
        songName,
        authorName,
        audioName,
        albumId: songCandidate.album_id || songCandidate.albumid || songCandidate.AlbumID || "",
        albumAudioId: songCandidate.album_audio_id
            || songCandidate.mixsongid
            || songCandidate.MixSongID
            || songCandidate.audio_id
            || songCandidate.Audioid
            || "",
        duration: extractKugouDurationText(songCandidate),
        cover: normalizeKugouCoverUrl(
            songCandidate.union_cover
            || songCandidate.album_img
            || songCandidate.AlbumImage
            || songCandidate.imgUrl
            || songCandidate.imgurl
            || songCandidate.img
            || songCandidate.Image
            || ""
        ),
        raw: songCandidate,
    };
}

export function getKugouAlternativeCandidates(songCandidate = {}) {
    const candidateList = [];
    const seenHashes = new Set();

    const pushCandidate = (candidate) => {
        const normalized = normalizeKugouSongCandidate(candidate);
        if (!normalized.hash || seenHashes.has(normalized.hash)) {
            return;
        }
        seenHashes.add(normalized.hash);
        candidateList.push(normalized);
    };

    const groupList = Array.isArray(songCandidate?.Grp) ? songCandidate.Grp : [];
    for (const groupItem of groupList) {
        pushCandidate(groupItem);
    }

    pushCandidate(songCandidate);
    return candidateList;
}

function findPlayableUrl(data) {
    if (!data) {
        return "";
    }
    if (typeof data === "string") {
        if (/^https?:\/\//i.test(data) && !/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(data)) {
            return data;
        }
        return "";
    }
    if (Array.isArray(data)) {
        for (const item of data) {
            const url = findPlayableUrl(item);
            if (url) {
                return url;
            }
        }
        return "";
    }
    if (typeof data === "object") {
        const preferredKeys = ["url", "play_url", "audio_url", "src", "sq_url", "hq_url"];
        for (const key of preferredKeys) {
            const url = findPlayableUrl(data[key]);
            if (url) {
                return url;
            }
        }
        for (const value of Object.values(data)) {
            const url = findPlayableUrl(value);
            if (url) {
                return url;
            }
        }
    }
    return "";
}

function formatBytesToMb(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) {
        return "";
    }
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function buildKugouWarning(message, error) {
    return `${message}：${error.message}`;
}

function normalizeKugouQuality(quality = "") {
    const normalizedQuality = String(quality || "").trim();
    const qualityMap = {
        hires: "viper_clear",
        hi_res: "viper_clear",
        sq: "high",
        lossless: "flac",
        standard: "128",
    };
    return qualityMap[normalizedQuality] || normalizedQuality || "viper_clear";
}

function buildKugouQualityFallbackList(quality = "") {
    const qualityOrder = ["viper_clear", "flac", "high", "320", "128"];
    const preferredQuality = normalizeKugouQuality(quality);
    return [preferredQuality, ...qualityOrder.filter(item => item !== preferredQuality)];
}

function getKugouQualityLabel(quality = "") {
    const qualityLabelMap = {
        viper_clear: "Hi-Res",
        flac: "无损 FLAC",
        high: "无损 SQ",
        320: "高品 320K",
        128: "普通 128K",
    };
    return qualityLabelMap[quality] || quality;
}

function pickKugouQualityHash(songInfo = {}, quality = "", fallbackHash = "") {
    const qualityHashes = songInfo.qualityHashes || {};
    const normalizedQuality = normalizeKugouQuality(quality);
    const qualityHashMap = {
        viper_clear: [qualityHashes.high, qualityHashes.sq, qualityHashes[320], qualityHashes[128]],
        flac: [qualityHashes.sq, qualityHashes.high, qualityHashes[320], qualityHashes[128]],
        high: [qualityHashes.sq, qualityHashes.high, qualityHashes[320], qualityHashes[128]],
        320: [qualityHashes[320], qualityHashes[128]],
        128: [qualityHashes[128]],
    };
    return (qualityHashMap[normalizedQuality] || [])
        .find(item => String(item || "").trim()) || fallbackHash;
}

function normalizeHashKey(hash = "") {
    return String(hash).trim().toLowerCase();
}

function pushUniqueHashCandidate(targetList = [], seenHashes = new Set(), candidate = null) {
    if (!candidate?.hash) {
        return;
    }
    const hashKey = normalizeHashKey(candidate.hash);
    if (!hashKey || seenHashes.has(hashKey)) {
        return;
    }
    seenHashes.add(hashKey);
    targetList.push(candidate);
}

function createKugouFileName(songName = "", singerName = "", hash = "") {
    return [singerName, songName].filter(Boolean).join(" - ") || songName || `kugou_${String(hash).slice(0, 8)}`;
}

function normalizeKugouCoverUrl(url = "", size = 480) {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl) {
        return "";
    }
    return normalizedUrl
        .replace(/^http:\/\//i, "https://")
        .replace(/\{size\}/g, String(size));
}

function parseShareMetaFromUrl(url = "", fallbackInfo = null) {
    const normalizedUrl = url.replace(/^http:\/\//i, "https://");
    const hash = normalizedUrl.match(/[?&]hash=([A-Fa-f0-9]{32})/)?.[1];
    const albumId = normalizedUrl.match(/[?&]album_id=(\d+)/)?.[1];
    const albumAudioId = normalizedUrl.match(/[?&]album_audio_id=(\d+)/)?.[1];

    if (!hash) {
        return null;
    }
    return {
        ...fallbackInfo,
        hash,
        albumId,
        albumAudioId,
    };
}

async function fetchKugouPage(url) {
    const response = await axios.get(url, {
        headers: {
            "User-Agent": COMMON_USER_AGENT,
        },
        responseType: "text",
        transformResponse: [data => data],
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        throw new Error(`请求失败，状态码：${response.status}`);
    }
    return String(response.data || "");
}

async function searchKugouSongWithFallback(apiServer, keyword, kugouCookie = "") {
    try {
        return await searchKugouSong(apiServer, keyword, kugouCookie);
    } catch (error) {
        return {
            result: null,
            warning: buildKugouWarning("使用 kugou.js 搜索音源失败", error),
        };
    }
}

async function tryKugouSongCandidates(apiServer, candidateList = [], defaultCookie = "", quality = "") {
    const warnings = [];
    const dedupedCandidates = [];
    const seenHashes = new Set();

    for (const candidate of candidateList) {
        if (!candidate?.hash) {
            continue;
        }
        pushUniqueHashCandidate(dedupedCandidates, seenHashes, candidate);
    }

    for (const candidate of dedupedCandidates) {
        try {
            const urlResult = await getKugouSongUrl(apiServer, {
                hash: candidate.hash,
                albumId: candidate.albumId || "",
                albumAudioId: candidate.albumAudioId || "",
                cookie: candidate.cookie || defaultCookie,
                quality,
            });
            if (urlResult.url) {
                return {
                    resolvedSong: {
                        candidate,
                        urlResult,
                    },
                    warnings,
                };
            }
        } catch (error) {
            warnings.push(buildKugouWarning(`候选音源 ${candidate.hash} 获取失败`, error));
        }
    }

    return {
        resolvedSong: null,
        warnings,
    };
}

async function requestKugouApi(apiServer, endpoint, params = {}, cookie = "") {
    const baseUrl = normalizeApiServer(apiServer);
    if (!baseUrl) {
        throw new Error("未配置酷狗API地址");
    }
    const response = await axios.get(`${baseUrl}${endpoint}`, {
        params,
        headers: {
            "User-Agent": COMMON_USER_AGENT,
            ...(cookie ? { "Cookie": cookie } : {}),
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        throw new Error(`请求失败，状态码：${response.status}`);
    }

    return {
        data: response.data,
        cookie: mergeCookies(cookie, parseSetCookie(response.headers["set-cookie"])),
    };
}

export async function registerKugouDevice(apiServer) {
    const response = await requestKugouApi(apiServer, "/register/dev");
    return {
        ...response,
        dfid: findFieldDeep(response.data, ["dfid"]),
    };
}

/**
 * 酷狗多结果搜索
 * @param {string} apiServer
 * @param {string} keyword
 * @param {{ cookie?: string, limit?: number, page?: number }} [options]
 * @returns {Promise<{ list: object[], cookie: string, raw: any }>}
 */
export async function searchKugouSongs(apiServer, keyword, options = {}) {
    const {
        cookie: kugouCookie = "",
        limit = 10,
        page = 1,
    } = options;
    const pageSize = Math.max(1, Math.min(50, Number(limit) || 10));
    const params = {
        keywords: keyword,
        type: "song",
        page,
        pagesize: pageSize,
        ...(kugouCookie ? { cookie: kugouCookie } : {}),
    };
    const response = await requestKugouApi(apiServer, "/search", params, kugouCookie);
    const candidates = findSongCandidates(response.data, pageSize);
    const seen = new Set();
    const list = [];
    for (const candidate of candidates) {
        const normalized = normalizeKugouSongCandidate(candidate);
        if (!normalized.hash || seen.has(normalized.hash)) {
            continue;
        }
        seen.add(normalized.hash);
        // 点歌缓存不需要 raw，避免 Redis 膨胀
        const { raw, ...rest } = normalized;
        list.push(rest);
        if (list.length >= pageSize) {
            break;
        }
    }
    return {
        list,
        cookie: response.cookie,
        raw: response.data,
    };
}

/**
 * 兼容旧签名：只返回第一条搜索结果
 * @param {string} apiServer
 * @param {string} keyword
 * @param {string} [kugouCookie=""]
 */
export async function searchKugouSong(apiServer, keyword, kugouCookie = "") {
    const result = await searchKugouSongs(apiServer, keyword, {
        cookie: kugouCookie,
        limit: 1,
    });
    if (!result.list?.length) {
        return null;
    }
    // 兼容旧调用链：保留候选 raw，供 getKugouAlternativeCandidates(searchResult.raw) 使用
    // searchKugouSongs 列表项本身剥离了 raw，这里从响应 candidates 再取一次
    const firstCandidate = findFirstSongCandidate(result.raw) || {};
    return {
        ...result.list[0],
        raw: firstCandidate,
        cookie: result.cookie,
    };
}

export async function getKugouSongUrl(apiServer, { hash, albumId = "", albumAudioId = "", cookie = "", freePart = 0, quality = "" }) {
    const registerResp = await registerKugouDevice(apiServer);
    const requestCookie = mergeCookies(cookie, registerResp.cookie);
    const qualityList = buildKugouQualityFallbackList(quality);
    const errors = [];
    let requestAlbumId = albumId;
    let requestAlbumAudioId = albumAudioId;
    let songInfo = null;

    try {
        songInfo = await getKugouSongInfoByHash(hash, albumId, albumAudioId);
        requestAlbumId = songInfo?.albumId || albumId;
        requestAlbumAudioId = songInfo?.albumAudioId || albumAudioId;
    } catch {}

    for (const qualityItem of qualityList) {
        const currentRequestHash = songInfo
            ? pickKugouQualityHash(songInfo, qualityItem, hash)
            : hash;
        const params = {
            hash: currentRequestHash,
            free_part: freePart,
            quality: qualityItem,
            ...(requestAlbumId ? { album_id: requestAlbumId } : {}),
            ...(requestAlbumAudioId ? { album_audio_id: requestAlbumAudioId } : {}),
        };

        let response = null;
        try {
            response = await requestKugouApi(apiServer, "/song/url", params, requestCookie);
        } catch (error) {
            errors.push(`${getKugouQualityLabel(qualityItem)}：${error.message}`);
            continue;
        }
        const url = findPlayableUrl(response.data);
        if (!url) {
            const errorMessage = findFieldDeep(response.data, ["error", "msg", "message"]) || "未返回音源地址";
            errors.push(`${getKugouQualityLabel(qualityItem)}：${errorMessage}`);
            continue;
        }

        const size = formatBytesToMb(findFieldDeep(response.data, ["filesize", "fileSize", "size"]));
        const cover = normalizeKugouCoverUrl(
            findFieldDeep(response.data, ["union_cover", "album_img", "imgUrl", "imgurl", "img", "cover"])
        );

        return {
            url,
            size,
            cover,
            audioType: url ? (url.split("?")[0].split(".").pop() || "mp3") : "mp3",
            quality: qualityItem,
            qualityLabel: getKugouQualityLabel(qualityItem),
            cookie: response.cookie,
            requestHash: currentRequestHash,
            error: findFieldDeep(response.data, ["error", "msg", "message"]),
        };
    }

    return {
        url: "",
        size: "",
        cover: "",
        audioType: "mp3",
        quality: normalizeKugouQuality(quality),
        qualityLabel: getKugouQualityLabel(normalizeKugouQuality(quality)),
        cookie: requestCookie,
        raw: null,
        error: errors.join("；"),
    };
}

export async function getKugouSongInfoByHash(hash, albumId = "", albumAudioId = "") {
    if (!hash) {
        return null;
    }

    const response = await axios.get("https://m.kugou.com/app/i/getSongInfo.php", {
        params: {
            cmd: "playInfo",
            hash,
            ...(albumId ? { album_id: albumId } : {}),
            ...(albumAudioId ? { album_audio_id: albumAudioId } : {}),
        },
        headers: {
            "User-Agent": COMMON_USER_AGENT,
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        throw new Error(`官方歌曲信息请求失败，状态码：${response.status}`);
    }

    const data = response.data || {};
    const extra = data.extra || {};
    const qualityHashes = {
        128: extra["128hash"] || data.hash || hash,
        320: extra["320hash"],
        sq: extra["sqhash"],
        high: extra["highhash"],
    };
    const alternativeHashes = [
        qualityHashes[128],
        qualityHashes[320],
        qualityHashes.sq,
        qualityHashes.high,
    ].filter(Boolean);

    return {
        hash: String(data.hash || hash || "").trim(),
        songName: String(data.songName || "").trim(),
        authorName: String(data.author_name || data.singerName || "").trim(),
        audioName: String(data.fileName || "").trim(),
        albumId: String(data.albumid || data.req_albumid || albumId || "").trim(),
        albumAudioId: String(data.album_audio_id || albumAudioId || "").trim(),
        cover: normalizeKugouCoverUrl(data.trans_param?.union_cover || data.album_img || data.imgUrl || ""),
        qualityHashes,
        alternativeHashes: Array.from(new Set(alternativeHashes.map(item => String(item).trim()).filter(Boolean))),
        raw: data,
    };
}

export function normalizeKugouQrImage(qrimg = "") {
    return normalizeQrImage(qrimg);
}

export async function buildKugouLoginCookie(apiServer, { loginToken = "", initialCookie = "" } = {}) {
    const warnings = [];
    let kugouCookie = normalizeKugouCookie(initialCookie, loginToken ? `token=${loginToken}` : "");

    let userid = extractCookieValue(kugouCookie, "userid");
    let dfid = extractCookieValue(kugouCookie, "dfid");
    let token = extractCookieValue(kugouCookie, "token") || loginToken;
    let nickname = "";

    try {
        const userDetail = await getKugouUserDetail(apiServer, kugouCookie);
        userid = String(userDetail.userid || userid || "").trim();
        nickname = userDetail.nickname || "";
        kugouCookie = normalizeKugouCookie(
            kugouCookie,
            userDetail.cookie,
            userid ? `userid=${userid}` : ""
        );
    } catch (error) {
        warnings.push(buildKugouWarning("获取酷狗用户信息失败", error));
    }

    if (token && userid) {
        try {
            const refreshResp = await refreshKugouToken(apiServer, {
                token,
                userid,
                cookie: kugouCookie,
            });
            token = refreshResp.token || token;
            userid = String(refreshResp.userid || userid || "").trim();
            kugouCookie = normalizeKugouCookie(
                kugouCookie,
                refreshResp.cookie,
                token ? `token=${token}` : "",
                userid ? `userid=${userid}` : ""
            );
        } catch (error) {
            warnings.push(buildKugouWarning("刷新酷狗登录态失败", error));
        }
    }

    try {
        const deviceInfo = await registerKugouDevice(apiServer);
        dfid = String(deviceInfo.dfid || dfid || "").trim();
        kugouCookie = normalizeKugouCookie(
            kugouCookie,
            deviceInfo.cookie,
            dfid ? `dfid=${dfid}` : ""
        );
    } catch (error) {
        warnings.push(buildKugouWarning("获取酷狗 dfid 失败", error));
    }

    token = extractCookieValue(kugouCookie, "token") || token;
    userid = extractCookieValue(kugouCookie, "userid") || userid;
    dfid = extractCookieValue(kugouCookie, "dfid") || dfid;

    return {
        cookie: kugouCookie,
        token,
        userid,
        dfid,
        nickname,
        isComplete: Boolean(token && userid && dfid),
        warnings,
    };
}

export async function parseKugouMusicInfo(message = "") {
    let fallbackInfo = null;
    const shareTextMatch = message.match(/分享(.+?)的单曲《(.+?)》/);
    if (shareTextMatch) {
        const authorName = shareTextMatch[1]?.trim();
        const songName = shareTextMatch[2]?.trim();
        fallbackInfo = {
            authorName,
            songName,
            audioName: [authorName, songName].filter(Boolean).join(" - "),
        };
    }

    const kugouUrl = message.match(/https?:\/\/(?:t1\.kugou\.com\/[A-Za-z0-9]+|m\.kugou\.com\/share\/song\.html\?[^\s]+|(?:www\.)?kugou\.com\/share\/[A-Za-z0-9]+\.html|h5\.kugou\.com\/v2\/[^\s]+)/)?.[0];
    if (!kugouUrl) {
        return fallbackInfo;
    }

    const t1ChainCode = kugouUrl.match(/t1\.kugou\.com\/([A-Za-z0-9]+)/)?.[1];
    let resolvedUrl = kugouUrl;
    if (t1ChainCode) {
        resolvedUrl = `https://m.kugou.com/share/song.html?chain=${t1ChainCode}`;
    } else if (kugouUrl.includes("m.kugou.com/share/song.html")) {
        resolvedUrl = await resolveKugouRedirect(kugouUrl);
    }

    const directMeta = parseShareMetaFromUrl(resolvedUrl, fallbackInfo);
    if (directMeta) {
        return directMeta;
    }

    try {
        const html = await fetchKugouPage(resolvedUrl.replace(/^http:\/\//i, "https://"));
        const smartyMatch = html.match(/var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*,?\s*\/\/当前页面歌曲信息/);

        if (smartyMatch?.[1]) {
            const shareData = JSON.parse(smartyMatch[1]);
            const firstSong = shareData?.[0];
            if (firstSong) {
                const authorName = firstSong.author_name?.trim();
                const songName = firstSong.song_name?.trim();
                const audioName = firstSong.audio_name?.trim() || [authorName, songName].filter(Boolean).join(" - ");
                return {
                    authorName,
                    songName,
                    audioName,
                    hash: firstSong.hash?.trim(),
                    albumId: firstSong.album_id?.toString()?.trim(),
                    albumAudioId: firstSong.mixsongid?.toString()?.trim() || firstSong.encode_album_audio_id?.toString()?.trim(),
                };
            }
        }

        if (t1ChainCode) {
            const redirectMeta = parseShareMetaFromUrl(await resolveKugouRedirect(kugouUrl), fallbackInfo);
            if (redirectMeta) {
                return redirectMeta;
            }
        }

        const titleMatch = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
        const cleanTitle = titleMatch?.replace(/\s+/g, " ").trim();
        if (!cleanTitle || cleanTitle === "酷狗音乐") {
            return fallbackInfo;
        }

        const [songName, authorName] = cleanTitle.split("_");
        return {
            authorName: authorName?.trim(),
            songName: songName?.trim(),
            audioName: [authorName?.trim(), songName?.trim()].filter(Boolean).join(" - "),
        };
    } catch {
        return fallbackInfo;
    }
}

export async function resolveKugouRedirect(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
            },
            maxRedirects: 0,
            responseType: "text",
            transformResponse: [data => data],
            validateStatus: () => true,
        });
        return response.headers.location || response.request?.res?.responseUrl || response.config?.url || url;
    } catch {
        return url;
    }
}

export async function resolveKugouMusicSource(apiServer, { message = "", kugouCookie = "", quality = "" } = {}) {
    const warnings = [];
    const kugouInfo = await parseKugouMusicInfo(message);
    let musicInfo = kugouInfo?.audioName || [kugouInfo?.authorName, kugouInfo?.songName].filter(Boolean).join(" - ");

    let url = "";
    let audioType = "mp3";
    let cover = kugouInfo?.cover || "";
    let size = kugouInfo?.size || "";
    let singerName = kugouInfo?.authorName || "";
    let songName = kugouInfo?.songName || musicInfo;
    let hash = kugouInfo?.hash || "";
    let albumId = kugouInfo?.albumId || "";
    let albumAudioId = kugouInfo?.albumAudioId || "";
    let officialSongInfo = null;
    let qualityLabel = "";

    if (hash) {
        try {
            const urlResult = await getKugouSongUrl(apiServer, {
                hash,
                albumId,
                albumAudioId,
                cookie: kugouCookie,
                quality,
            });
            url = urlResult.url || "";
            hash = urlResult.requestHash || hash;
            audioType = urlResult.audioType || audioType;
            qualityLabel = urlResult.qualityLabel || qualityLabel;
            size = urlResult.size || size;
            cover = urlResult.cover || cover;
            songName = songName || urlResult.raw?.fileName || "";
            musicInfo = musicInfo || createKugouFileName(songName, singerName, hash);
        } catch (error) {
            warnings.push(buildKugouWarning("根据分享链接信息获取音源失败", error));
        }
    }

    if (hash && (!musicInfo || !songName || !singerName || !cover || !albumId || !albumAudioId)) {
        try {
            officialSongInfo = await getKugouSongInfoByHash(hash, albumId, albumAudioId);
            singerName = singerName || officialSongInfo?.authorName || "";
            songName = songName || officialSongInfo?.songName || "";
            cover = cover || officialSongInfo?.cover || "";
            albumId = albumId || officialSongInfo?.albumId || "";
            albumAudioId = albumAudioId || officialSongInfo?.albumAudioId || "";
            musicInfo = officialSongInfo?.audioName || musicInfo || createKugouFileName(songName, singerName, hash);
        } catch (error) {
            warnings.push(buildKugouWarning("根据官方歌曲信息补全元数据失败", error));
        }
    }

    if (!url && officialSongInfo?.alternativeHashes?.length > 0) {
        const officialCandidates = [];
        const seenHashes = new Set();
        for (const candidateHash of officialSongInfo.alternativeHashes) {
            pushUniqueHashCandidate(officialCandidates, seenHashes, {
                hash: candidateHash,
                albumId: officialSongInfo.albumId || albumId || "",
                albumAudioId: officialSongInfo.albumAudioId || albumAudioId || "",
                authorName: officialSongInfo.authorName || singerName || "",
                songName: officialSongInfo.songName || songName || "",
                audioName: officialSongInfo.audioName || musicInfo || "",
                cover: officialSongInfo.cover || cover || "",
                cookie: kugouCookie,
            });
        }
        const candidateResult = await tryKugouSongCandidates(apiServer, officialCandidates, kugouCookie, quality);
        warnings.push(...candidateResult.warnings);
        if (candidateResult.resolvedSong) {
            const { candidate, urlResult } = candidateResult.resolvedSong;
            hash = candidate.hash || hash;
            albumId = candidate.albumId || albumId;
            albumAudioId = candidate.albumAudioId || albumAudioId;
            singerName = candidate.authorName || singerName;
            songName = candidate.songName || songName || urlResult.raw?.fileName || "";
            cover = urlResult.cover || candidate.cover || cover;
            url = urlResult.url || "";
            audioType = urlResult.audioType || audioType;
            qualityLabel = urlResult.qualityLabel || qualityLabel;
            size = urlResult.size || size;
            musicInfo = candidate.audioName || createKugouFileName(songName, singerName, hash);
        }
    }

    if (!url && kugouCookie) {
        const searchKeyword = [kugouInfo?.authorName, kugouInfo?.songName].filter(Boolean).join(" - ") || musicInfo;
        const searchResponse = await searchKugouSongWithFallback(apiServer, searchKeyword, kugouCookie);
        if (searchResponse?.warning) {
            warnings.push(searchResponse.warning);
        }
        const searchResult = searchResponse?.result || searchResponse;
        if (searchResult?.hash) {
            const candidateList = [];
            const seenHashes = new Set();
            for (const candidate of getKugouAlternativeCandidates(searchResult.raw || {})) {
                pushUniqueHashCandidate(candidateList, seenHashes, {
                    ...candidate,
                    cookie: searchResult.cookie || kugouCookie,
                });
            }
            if (candidateList.length === 0) {
                pushUniqueHashCandidate(candidateList, seenHashes, {
                    hash: searchResult.hash,
                    albumId: searchResult.albumId,
                    albumAudioId: searchResult.albumAudioId,
                    authorName: searchResult.authorName,
                    songName: searchResult.songName,
                    audioName: searchResult.audioName,
                    cover: searchResult.cover,
                    cookie: searchResult.cookie || kugouCookie,
                });
            }
            const candidateResult = await tryKugouSongCandidates(apiServer, candidateList, searchResult.cookie || kugouCookie, quality);
            warnings.push(...candidateResult.warnings);
            if (candidateResult.resolvedSong) {
                const { candidate, urlResult } = candidateResult.resolvedSong;
                hash = candidate.hash || hash;
                albumId = candidate.albumId || albumId;
                albumAudioId = candidate.albumAudioId || albumAudioId;
                singerName = candidate.authorName || singerName;
                songName = candidate.songName || songName || urlResult.raw?.fileName || "";
                cover = urlResult.cover || candidate.cover || cover;
                url = urlResult.url || "";
                audioType = urlResult.audioType || audioType;
                qualityLabel = urlResult.qualityLabel || qualityLabel;
                size = urlResult.size || size;
                musicInfo = candidate.audioName || createKugouFileName(songName, singerName, hash);
            }
        }
    }

    return {
        kugouInfo,
        musicInfo,
        url,
        audioType,
        qualityLabel,
        cover,
        size,
        singerName,
        songName,
        hash,
        albumId,
        albumAudioId,
        warnings,
    };
}

export async function createKugouQrKey(apiServer) {
    const response = await requestKugouApi(apiServer, "/login/qr/key", {
        timestamp: Date.now(),
    });
    return {
        ...response,
        key: findFieldDeep(response.data, ["key", "unikey", "qrcode"]),
        qrimg: findFieldDeep(response.data, ["qrimg", "qrcode_img", "base64", "img"]),
        qrurl: findFieldDeep(response.data, ["qrurl", "url"]),
    };
}

export async function createKugouQrCode(apiServer, key) {
    const response = await requestKugouApi(apiServer, "/login/qr/create", {
        key,
        qrimg: true,
        timestamp: Date.now(),
    });
    return {
        ...response,
        qrimg: findFieldDeep(response.data, ["qrimg", "qrcode_img", "base64", "img"]),
        qrurl: findFieldDeep(response.data, ["qrurl", "url"]),
    };
}

export async function checkKugouQrLogin(apiServer, key, kugouCookie = "") {
    const response = await requestKugouApi(apiServer, "/login/qr/check", {
        key,
        timestamp: Date.now(),
    }, kugouCookie);

    const status = Number(
        response.data?.data?.status ??
        response.data?.status ??
        findFieldDeep(response.data, ["status", "code"])
    );
    const token = response.data?.data?.token
        || response.data?.token
        || findFieldDeep(response.data, ["token"])
        || extractCookieValue(response.cookie, "token");

    return {
        ...response,
        status,
        token,
    };
}

export async function refreshKugouToken(apiServer, { token = "", userid = "", cookie = "" } = {}) {
    const response = await requestKugouApi(apiServer, "/login/token", {
        ...(token ? { token } : {}),
        ...(userid ? { userid } : {}),
        timestamp: Date.now(),
    }, cookie);

    return {
        ...response,
        token: findFieldDeep(response.data, ["token"]) || extractCookieValue(response.cookie, "token") || token,
        userid: findFieldDeep(response.data, ["userid", "user_id", "uid", "id"]) || extractCookieValue(response.cookie, "userid") || userid,
    };
}

export async function getKugouUserDetail(apiServer, kugouCookie = "") {
    const response = await requestKugouApi(apiServer, "/user/detail", {
        timestamp: Date.now(),
    }, kugouCookie);

    return {
        ...response,
        userid: findFieldDeep(response.data, ["userid", "user_id", "uid", "id"]) || extractCookieValue(response.cookie, "userid"),
        nickname: findFieldDeep(response.data, ["nickname", "name", "username"]),
        avatar: findFieldDeep(response.data, ["avatar", "img", "pic"]),
    };
}

export async function getKugouUserVipDetail(apiServer, kugouCookie = "") {
    const response = await requestKugouApi(apiServer, "/user/vip/detail", {
        timestamp: Date.now(),
    }, kugouCookie);

    return {
        ...response,
        userid: findFieldDeep(response.data, ["userid", "user_id", "uid", "id"]) || extractCookieValue(response.cookie, "userid"),
        busiVip: Array.isArray(response.data?.data?.busi_vip) ? response.data.data.busi_vip : [],
    };
}

export function normalizeKugouCookie(...cookies) {
    return mergeCookies(...cookies);
}
