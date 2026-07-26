import axios from "axios";
import { COMMON_USER_AGENT } from "../constants/constant.js";
import { IG_TEMP_PARSE_API } from "../constants/tools.js";

/**
 * Instagram 解析 util
 *
 * ⚠️ 当前实现依赖第三方临时解析接口（downloader-api.bhwa233.com），非 Instagram 官方接口，
 * 该服务随时可能下架、限流或失效，届时需要更换接口或自建解析服务。
 *
 * 这里只负责：链接抽取 / 接口请求 / 返回结构归一化等纯业务逻辑，
 * apps/tools.js 只做开关判断、回复用户、发送媒体等宿主交互。
 */

// 匹配 Instagram 分享链接：/p/{id}（图文）、/reel/{id}（视频）、/reels/{id}（视频）
const INSTAGRAM_URL_REGEX = /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels)\/[A-Za-z0-9_-]+[^\s]*/;

/**
 * 从消息文本中提取 Instagram 分享链接
 * @param {string} msg 原始消息文本
 * @returns {string|null}
 */
export function extractInstagramUrl(msg = "") {
    if (!msg) return null;
    const match = msg.match(INSTAGRAM_URL_REGEX);
    return match ? match[0] : null;
}

/**
 * 请求第三方临时解析接口，返回原始 JSON
 * @param {string} url Instagram 分享链接
 * @returns {Promise<object>}
 */
export async function fetchInstagramMedia(url) {
    const apiUrl = IG_TEMP_PARSE_API.replace("{}", encodeURIComponent(url));
    const resp = await axios.get(apiUrl, {
        headers: {
            "User-Agent": COMMON_USER_AGENT,
        },
        timeout: 30000,
    });
    return resp.data;
}

/**
 * 把第三方接口的返回结构归一化成稳定的数据结构，供 apps 层消费
 *
 * 归一化后的字段：
 * - noteType: "image" | "video"
 * - title: 标题/文案
 * - cover: 封面图地址
 * - videoUrl: 视频直链（仅 video 类型）
 * - images: 图片地址数组（仅 image 类型）
 *
 * @param {object} raw fetchInstagramMedia 返回的原始数据
 * @returns {object|null}
 */
export function normalizeInstagramMedia(raw) {
    if (!raw || raw.success !== true || !raw.data) {
        return null;
    }

    const data = raw.data;
    const title = String(data.title || data.desc || "").trim();
    // 封面统一做 https 归一化
    const cover = normalizeUrl(data.cover);

    // 图文类型：收集 images 数组里的地址
    const images = Array.isArray(data.images)
        ? data.images
            .map(item => normalizeUrl(item?.url || item?.downloadUrl))
            .filter(Boolean)
        : [];

    // ⚠️ 这里只能依赖 noteType 区分图文/视频：
    // 第三方接口的 data.type 字段不可靠——图文帖也会返回 type:"video"，
    // data.downloadUrl 同样会带 type=video 参数（实为 API 包装地址，非媒体直链），
    // 一旦误判会把图文当成视频下载，发出错误的「视频」消息。
    // 真正可靠的只有 noteType：image=图文，video=视频。
    const isVideo = data.noteType === "video" && hasRealVideoUrl(data);

    if (isVideo) {
        // 视频直链优先取 CDN 原始地址（originDownloadVideoUrl），
        // downloadVideoUrl/videoDownloadUrl/downloadUrl 都是 API 包装地址，仅作兜底。
        const videoUrl = normalizeUrl(
            data.originDownloadVideoUrl
            || data.downloadVideoUrl
            || data.videoDownloadUrl
            || data.downloadUrl
        );
        return {
            noteType: "video",
            title,
            cover,
            videoUrl,
            images: [],
        };
    }

    // 既没有视频直链，也没有图片，说明接口结构异常
    if (images.length === 0) {
        return null;
    }

    return {
        noteType: "image",
        title,
        cover: cover || images[0] || "",
        videoUrl: "",
        images,
    };
}

/**
 * 判断是否存在真正的视频媒体直链
 * 仅当 noteType=video 且存在 CDN 直链（originDownloadVideoUrl）时视为视频，
 * 避免图文帖因 type=video / downloadUrl(type=video) 被误判。
 * @param {object} data
 * @returns {boolean}
 */
function hasRealVideoUrl(data) {
    return Boolean(data.originDownloadVideoUrl)
        || Boolean(data.videoDownloadUrl && data.videoDownloadUrl !== data.downloadUrl);
}

/**
 * URL 归一化：http -> https
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
    if (!url || typeof url !== "string") return "";
    return url.replace(/^http:\/\//i, "https://");
}
