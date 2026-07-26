/**
 * 点歌平台适配器注册中心
 *
 * 设计目标：
 * 1. apps/songRequest.js 只做编排（配置、Redis、截图、发卡片/文件）
 * 2. 各平台只实现 search / resolve，返回统一 SongItem / PlayResult
 * 3. 后续兼容新平台：新增 provider + registerMusicPlatform 即可
 *
 * @typedef {'netease' | 'kugou' | string} MusicPlatformId
 *
 * @typedef {Object} SongItem
 * @property {MusicPlatformId} platform
 * @property {'song' | 'podcast' | 'cloud'} sourceType
 * @property {string} songName
 * @property {string} singerName
 * @property {string} duration
 * @property {string} cover
 * @property {Object} providerData
 *
 * @typedef {Object} PlayResult
 * @property {string} url
 * @property {string} audioType
 * @property {string} size
 * @property {string} qualityLabel
 * @property {string} cover
 * @property {string[]} tags
 * @property {string[]} warnings
 * @property {object|null} card
 *
 * @typedef {Object} MusicPlatformAdapter
 * @property {MusicPlatformId} platform
 * @property {string} displayName
 * @property {(keyword: string, options?: object) => Promise<SongItem[]>} search
 * @property {(songItem: SongItem, options?: object) => Promise<PlayResult>} resolve
 * @property {(contentType?: string|number) => boolean} [supportsContentType]
 */

import { createNeteasePlatform } from "./netease.js";
import { createKugouPlatform } from "./kugou.js";
import {
    createEmptyPlayResult,
    createSongItem,
    normalizeLegacySongItem,
    normalizePlatformAlias,
} from "./helpers.js";

export {
    createEmptyPlayResult,
    createSongItem,
    normalizeLegacySongItem,
    normalizePlatformAlias,
};

/** @type {Map<string, (context?: object) => MusicPlatformAdapter>} */
const platformFactories = new Map();

/**
 * 注册平台工厂。后续新平台：
 * registerMusicPlatform('qq', (ctx) => createQqPlatform(ctx))
 * @param {string} platformId
 * @param {(context?: object) => MusicPlatformAdapter} factory
 */
export function registerMusicPlatform(platformId, factory) {
    if (!platformId || typeof factory !== "function") {
        throw new Error("[music-platform] registerMusicPlatform 需要 platformId 与 factory");
    }
    platformFactories.set(String(platformId).toLowerCase(), factory);
}

/**
 * 归一化平台 id；未知已注册值时回退 netease
 * @param {string} [platform]
 * @returns {string}
 */
export function normalizeMusicPlatformId(platform = "") {
    const value = normalizePlatformAlias(platform);
    if (platformFactories.has(value)) {
        return value;
    }
    if (value === "netease" || value === "kugou") {
        return value;
    }
    return "netease";
}

/**
 * 获取平台适配器实例
 * @param {string} platform
 * @param {object} [context]
 * @returns {MusicPlatformAdapter}
 */
export function getMusicPlatform(platform, context = {}) {
    const platformId = normalizeMusicPlatformId(platform);
    const factory = platformFactories.get(platformId);
    if (!factory) {
        const fallback = platformFactories.get("netease");
        if (!fallback) {
            throw new Error(`[music-platform] 未注册任何点歌平台，无法处理: ${platform}`);
        }
        if (typeof logger !== "undefined") {
            logger.warn(`[music-platform] 未知平台 ${platform}，回退 netease`);
        }
        return fallback(context);
    }
    return factory(context);
}

/**
 * 列出已注册平台
 * @returns {string[]}
 */
export function listMusicPlatforms() {
    return Array.from(platformFactories.keys());
}

// 内置平台注册
registerMusicPlatform("netease", createNeteasePlatform);
registerMusicPlatform("kugou", createKugouPlatform);
