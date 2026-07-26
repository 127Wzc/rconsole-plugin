import axios from "axios";
import fs from "node:fs";
import { formatTime, toGBorTB } from '../utils/other.js'
import puppeteer from "../../../lib/puppeteer/puppeteer.js";
import PickSongList from "../model/pick-song.js";
import NeteaseMusicInfo from '../model/neteaseMusicInfo.js'
import { NETEASE_API_CN, NETEASE_SONG_DOWNLOAD, NETEASE_TEMP_API } from "../constants/tools.js";
import { COMMON_USER_AGENT, REDIS_YUNZAI_ISOVERSEA, REDIS_YUNZAI_SONGINFO, REDIS_YUNZAI_CLOUDSONGLIST } from "../constants/constant.js";
import { downloadAudio, retryAxiosReq } from "../utils/common.js";
import { redisExistKey, redisGetKey, redisSetKey } from "../utils/redis-util.js";
import { checkAndRemoveFile, checkFileExists, splitPaths } from "../utils/file.js";
import { sendMusicCard, sendCustomMusicCard, getGroupFileUrl, getReplyMsg } from "../utils/yunzai-util.js";
import {
    createSongItem,
    getMusicPlatform,
    normalizeLegacySongItem,
    normalizeMusicPlatformId,
} from "../utils/music-platform/index.js";
import config from "../model/config.js";
import FormData from 'form-data';
import NodeID3 from 'node-id3';

let FileSuffix = 'flac'

export class songRequest extends plugin {
    constructor() {
        super({
            name: "R插件点歌",
            dsc: "实现快捷点歌",
            priority: 300,
            rule: [
                {
                    reg: '^#点歌\\s*(.+?)(?:\\s+([12]))?$|#听[1-9][0-9]*|#听[1-9]*$',
                    fnc: 'pickSong'
                },
                {
                    reg: "^#播放\\s*(.+?)(?:\\s+([12]))?$",
                    fnc: "playSong"
                },
                {
                    reg: "^#?上传$",
                    fnc: "upLoad"
                },
                {
                    reg: '^#?我的云盘$|^#rnc$|^#RNC$',
                    fnc: 'myCloud',
                    permission: 'master'
                },
                {
                    reg: '^#?云盘更新$|#?更新云盘$',
                    fnc: 'songCloudUpdate',
                    permission: 'master'
                },
                {
                    reg: '^#?上传云盘|#?上传网盘$|#rnu|#RNU',
                    fnc: 'uploadCloud',
                    permission: 'master'
                },
                {
                    reg: '^#?清除云盘缓存$',
                    fnc: 'cleanCloudData',
                    permission: 'master'
                }
            ]
        });
        this.refreshSongRequestConfig();
    }

    /**
     * 热读取点歌相关配置（锅巴改完无需重启）
     * 使用 getYaml(..., false) 避免重复注册 watcher
     */
    refreshSongRequestConfig() {
        this.toolsConfig = config.getYaml("tools", false) || config.getConfig("tools") || {};
        this.neteaseCookie = this.toolsConfig.neteaseCookie;
        this.neteaseCloudCookie = this.toolsConfig.neteaseCloudCookie;
        this.isSendVocal = this.toolsConfig.isSendVocal;
        this.useLocalNeteaseAPI = this.toolsConfig.useLocalNeteaseAPI;
        this.neteaseCloudAPIServer = this.toolsConfig.neteaseCloudAPIServer;
        this.neteaseCloudAudioQuality = this.toolsConfig.neteaseCloudAudioQuality;
        this.identifyPrefix = this.toolsConfig.identifyPrefix;
        // 兼容旧字段名：总开关
        this.useNeteaseSongRequest = this.toolsConfig.useNeteaseSongRequest;
        this.songRequestMaxList = this.toolsConfig.songRequestMaxList || 10;
        this.defaultPath = this.toolsConfig.defaultPath;
        this.uid = this.toolsConfig.neteaseUserId;
        this.cloudUid = this.toolsConfig.neteaseCloudUserId;
        this.songRequestPlatform = normalizeMusicPlatformId(this.toolsConfig.songRequestPlatform || "netease");
        this.kugouApiServer = this.toolsConfig.kugouApiServer || "";
        this.kugouCookie = this.toolsConfig.kugouCookie || "";
        this.kugouAudioQuality = this.toolsConfig.kugouAudioQuality || "flac";
    }

    /**
     * 构造当前平台适配器上下文
     * @param {string} [platform]
     */
    async createPlatformAdapter(platform) {
        const platformId = normalizeMusicPlatformId(platform || this.songRequestPlatform);
        if (platformId === "kugou") {
            return getMusicPlatform("kugou", {
                apiServer: this.kugouApiServer,
                cookie: this.kugouCookie,
                quality: this.kugouAudioQuality,
            });
        }
        // 默认 / 网易云
        const apiServer = await this.pickApi();
        return getMusicPlatform("netease", {
            apiServer,
            cookie: this.neteaseCookie,
            quality: this.neteaseCloudAudioQuality,
        });
    }

    /**
     * 点歌列表 Redis key（按群隔离，避免并发读写整表覆盖）
     * @param {string|number} groupId
     */
    getSongInfoRedisKey(groupId) {
        return `${REDIS_YUNZAI_SONGINFO}:${groupId}`;
    }

    /**
     * 读取当前群点歌会话；兼容旧版整表数组结构并迁移
     * @param {string|number} groupId
     */
    async getGroupSongSession(groupId) {
        const groupKey = this.getSongInfoRedisKey(groupId);
        const direct = await redisGetKey(groupKey);
        if (direct && Array.isArray(direct.data)) {
            return direct;
        }

        // 兼容旧全局数组：[{ group_id, platform, data }]
        const legacy = await redisGetKey(REDIS_YUNZAI_SONGINFO);
        if (Array.isArray(legacy) && legacy.length) {
            const found = legacy.find(item => String(item?.group_id) === String(groupId));
            if (found && Array.isArray(found.data)) {
                const session = {
                    group_id: groupId,
                    platform: found.platform || "netease",
                    updatedAt: found.updatedAt || Date.now(),
                    data: found.data,
                };
                await redisSetKey(groupKey, session);
                return session;
            }
        }
        return null;
    }

    /**
     * 写入当前群点歌会话
     * @param {string|number} groupId
     * @param {object} session
     */
    async setGroupSongSession(groupId, session) {
        await redisSetKey(this.getSongInfoRedisKey(groupId), {
            group_id: groupId,
            platform: session.platform || "netease",
            updatedAt: session.updatedAt || Date.now(),
            data: session.data || [],
        });
    }

    async pickSong(e) {
        this.refreshSongRequestConfig();
        if (!this.useNeteaseSongRequest) {
            logger.info('当前未开启点歌功能')
            return false
        }
        // 只在群里可以使用
        const group_id = e.group_id
        if (!group_id) return

        const match = e.msg.match(/^#点歌\s*(.+?)(?:\s+([12]))?$/);
        if (match) {
            const songKeyWord = match[1];
            const songType = match[2] || '1';
            const platformId = this.songRequestPlatform;

            if (platformId === 'kugou' && !this.kugouApiServer) {
                e.reply('未配置酷狗 API 地址，请先在锅巴 / tools.yaml 填写 kugouApiServer');
                return true;
            }

            try {
                const adapter = await this.createPlatformAdapter(platformId);
                if (songType === '2' && adapter.supportsContentType && !adapter.supportsContentType(songType)) {
                    e.reply(`当前点歌平台「${adapter.displayName}」不支持播客，请切换到网易云或去掉参数 2`);
                    return true;
                }

                /** @type {any[]} */
                let list = [];

                // 云盘混搜仅网易云
                if (platformId === 'netease') {
                    const cloudSongList = await this.getCloudSong();
                    const searchKeyword = songKeyWord.trim().toLowerCase();
                    const matchedSongs = (cloudSongList || []).filter(({ songName, singerName }) => {
                        const nameMatch = songName && songName.toLowerCase().includes(searchKeyword);
                        const singerMatch = singerName && singerName.toLowerCase().includes(searchKeyword);
                        return nameMatch || singerMatch;
                    });
                    const songListCount = Math.min(matchedSongs.length, this.songRequestMaxList);
                    for (let i = 0; i < songListCount; i++) {
                        list.push(createSongItem({
                            platform: 'netease',
                            sourceType: 'cloud',
                            id: matchedSongs[i].id,
                            songName: matchedSongs[i].songName,
                            singerName: matchedSongs[i].singerName,
                            duration: matchedSongs[i].duration,
                            cover: matchedSongs[i].cover || 'def',
                        }));
                    }
                }

                const searchCount = Math.max(0, this.songRequestMaxList - list.length);
                if (searchCount > 0) {
                    const searched = await adapter.search(songKeyWord, {
                        limit: searchCount,
                        contentType: songType,
                    });
                    list = list.concat(searched || []);
                }

                if (!list.length) {
                    e.reply('暂未找到你想听的歌哦~');
                    return true;
                }

                await this.setGroupSongSession(group_id, {
                    platform: platformId,
                    updatedAt: Date.now(),
                    data: list,
                });

                const data = await new PickSongList(e).getData(list, platformId);
                // saveId/tplFile 已按平台切换（酷狗用 pick-song-kugou）
                let img = await puppeteer.screenshot(data.saveId || "pick-song", data);
                e.reply(img);
            } catch (error) {
                logger.error(`[R插件][点歌][${platformId}] 搜索失败`, error);
                e.reply(`点歌失败：${error.message || '未知错误'}`);
            }
            return true;
        }

        // #听N
        const listenMatch = e.msg.replace(/\s+/g, "").match(/^#听(\d+)/);
        if (!listenMatch) {
            return false;
        }
        const pickNumber = Number(listenMatch[1]) - 1;
        try {
            const session = await this.getGroupSongSession(group_id);
            if (!session?.data?.length) {
                e.reply('请先使用 #点歌 搜索后再选择');
                return true;
            }
            const selectedRaw = session.data[pickNumber];
            if (!selectedRaw) {
                e.reply('序号超出范围，请重新选择');
                return true;
            }
            const selectedSong = normalizeLegacySongItem(selectedRaw, session.platform || 'netease');
            if (!selectedSong) {
                e.reply('歌曲数据异常，请重新点歌');
                return true;
            }
            await this.playSelectedSong(e, selectedSong);
        } catch (error) {
            logger.error(`[R插件][点歌][听] 失败`, error);
            e.reply(`播放失败：${error.message || '未知错误'}`);
        }
        return true;
    }

    // 播放策略
    async playSong(e) {
        this.refreshSongRequestConfig();
        if (!this.useNeteaseSongRequest) {
            logger.info('当前未开启点歌功能')
            return
        }
        // 只在群里可以使用
        const group_id = e.group_id
        if (!group_id) return

        const match = e.msg.match(/^#播放\s*(.+?)(?:\s+([12]))?$/);
        if (!match) return;
        const songKeyWord = match[1];
        const songType = match[2] || '1';
        const platformId = this.songRequestPlatform;
        if (platformId === 'kugou' && !this.kugouApiServer) {
            e.reply('未配置酷狗 API 地址，请先在锅巴 / tools.yaml 填写 kugouApiServer');
            return true;
        }

        try {
            const adapter = await this.createPlatformAdapter(platformId);
            if (songType === '2' && adapter.supportsContentType && !adapter.supportsContentType(songType)) {
                e.reply(`当前点歌平台「${adapter.displayName}」不支持播客，请切换到网易云或去掉参数 2`);
                return true;
            }
            const list = await adapter.search(songKeyWord, {
                limit: 1,
                contentType: songType,
                // 保持历史：#播放 普通歌曲走 cloudsearch
                useCloudSearch: platformId === 'netease' && songType !== '2',
            });
            if (!list?.length) {
                e.reply('暂未找到你想听的歌哦~');
                return true;
            }
            await this.playSelectedSong(e, list[0]);
        } catch (error) {
            logger.error(`[R插件][播放][${platformId}] 失败`, error);
            e.reply(`播放失败：${error.message || '未知错误'}`);
        }
        return true;
    }

    /**
     * 统一播放选中歌曲（#听 / #播放）
     * @param e
     * @param {object} rawSong
     */
    async playSelectedSong(e, rawSong) {
        this.refreshSongRequestConfig();
        const song = normalizeLegacySongItem(rawSong, rawSong?.platform || this.songRequestPlatform);
        if (!song) {
            e.reply('歌曲数据异常，请重新点歌');
            return;
        }
        const platformId = normalizeMusicPlatformId(song.platform || this.songRequestPlatform);
        const isCloudSong = song.sourceType === 'cloud' || song.type === 'cloud';

        let playResult;
        try {
            const adapter = await this.createPlatformAdapter(platformId);
            if (platformId === 'netease') {
                // 云盘使用云盘 Cookie
                const cloudCookie = this.neteaseCloudCookie || this.neteaseCookie;
                playResult = await adapter.resolve(song, {
                    cookie: isCloudSong ? cloudCookie : this.neteaseCookie,
                    cloudCookie,
                    isCloudSong,
                    quality: this.neteaseCloudAudioQuality,
                });
            } else {
                playResult = await adapter.resolve(song, {
                    cookie: this.kugouCookie,
                    quality: this.kugouAudioQuality,
                });
            }
        } catch (error) {
            logger.error(`[R插件][播放][${platformId}] resolve 失败`, error);
            e.reply(`获取音源失败：${error.message || '未知错误'}`);
            return;
        }

        for (const warning of playResult?.warnings || []) {
            logger.warn(`[R插件][播放][${platformId}] ${warning}`);
        }
        await this.sendPlayResult(e, song, playResult);
    }

    /**
     * 发送播放结果：信息卡 + 音乐卡 + 文件/语音兜底
     */
    async sendPlayResult(e, song, playResult = {}) {
        const title = [song.singerName, song.songName].filter(Boolean).join('-') || song.songName || '未知歌曲';
        const musicInfo = {
            cover: playResult.cover || song.cover || 'def',
            songName: song.songName,
            singerName: song.singerName,
            size: playResult.size || playResult.qualityLabel || '',
            musicType: playResult.tags?.length ? playResult.tags : [song.platform || 'music'],
        };

        try {
            const data = await new NeteaseMusicInfo(e).getData(musicInfo);
            const img = await puppeteer.screenshot("neteaseMusicInfo", data);
            await e.reply(img);
        } catch (error) {
            logger.warn(`[R插件][播放] 信息卡截图失败: ${error.message}`);
        }

        let cardSentSuccessfully = false;
        try {
            const card = playResult.card;
            // 原生卡不依赖本地音源 URL（协议端自行拉流）
            if (card?.kind === 'native' && card.id != null) {
                try {
                    await sendMusicCard(e, card.platformType || '163', card.id);
                    cardSentSuccessfully = true;
                } catch (nativeErr) {
                    // 酷狗原生卡失败时，若有音频 URL 再退 custom
                    logger.warn(`[R插件][播放] 原生卡片失败(${card.platformType}:${card.id}): ${nativeErr.message}`);
                    if (card.audioUrl || playResult.url) {
                        const audioUrl = card.audioUrl || playResult.url;
                        await sendCustomMusicCard(
                            e,
                            card.pageUrl || audioUrl,
                            audioUrl,
                            card.title || song.songName || title,
                            card.image || musicInfo.cover,
                            card.musicType || 'custom',
                            card.content || song.singerName || '',
                        );
                        cardSentSuccessfully = true;
                    } else {
                        throw nativeErr;
                    }
                }
            } else if (card?.kind === 'custom' && (card.audioUrl || playResult.url)) {
                const audioUrl = card.audioUrl || playResult.url;
                await sendCustomMusicCard(
                    e,
                    card.pageUrl || audioUrl,
                    audioUrl,
                    card.title || title,
                    card.image || musicInfo.cover,
                    card.musicType || 'custom',
                    card.content || song.singerName || '',
                );
                cardSentSuccessfully = true;
            }
        } catch (error) {
            if (error.message) {
                logger.error("发送卡片错误:", error.message, '将尝试发送文件/语音');
            } else {
                logger.error("发送卡片错误，请查看控制台报错，将尝试发送文件/语音");
                logger.error(error);
            }
            cardSentSuccessfully = false;
        }

        if (!playResult.url) {
            if (!cardSentSuccessfully) {
                e.reply('未获取到可播放音源，请检查 Cookie / API / 会员权限');
            }
            return;
        }

        const musicExt = playResult.audioType || 'mp3';
        FileSuffix = musicExt;
        // 卡片成功时也下载，兼容后续 #上传；失败路径才发文件/语音
        try {
            const path = await downloadAudio(playResult.url, this.getCurDownloadPath(e), title, 'follow', musicExt);
            if (!cardSentSuccessfully) {
                try {
                    await this.uploadGroupFile(e, path);
                    if (musicExt !== 'mp4' && this.isSendVocal) {
                        await e.reply(segment.record(path));
                    }
                } finally {
                    await checkAndRemoveFile(path);
                }
            }
        } catch (err) {
            logger.error(`下载音乐失败，错误信息为: ${err}`);
            if (!cardSentSuccessfully) {
                e.reply('音频下载失败，请稍后重试');
            }
        }
    }


    // 获取云盘信息
    async myCloud(e) {
        const autoSelectNeteaseApi = await this.pickApi()
        const cloudUrl = autoSelectNeteaseApi + '/user/cloud'
        // 云盘数据API
        await axios.get(cloudUrl, {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
                "Cookie": this.getCookie(true)
            },
        }).then(res => {
            const cloudData = {
                'songCount': res.data.count,
                'useSize': toGBorTB(res.data.size),
                'cloudSize': toGBorTB(res.data.maxSize)
            }
            e.reply(`云盘数据\n歌曲数量:${cloudData.songCount}\n云盘容量:${cloudData.cloudSize}\n已使用容量:${cloudData.useSize}\n数据可能有延迟`)
        })
    }

    // 更新云盘
    async songCloudUpdate(e) {
        try {
            await this.cleanCloudData()
            await this.getCloudSong(e, true)
            try {
                await e?.reply('更新成功')
            } catch (error) {
                logger.error('trss又拉屎了？')
            }
            await this.myCloud(e)
        } catch (error) {
            logger.error('更新云盘失败', error)
        }
    }

    // 上传音频文件
    async upLoad(e) {
        let msg = await getReplyMsg(e);
        // 检查消息数据有效性
        const msgData = msg?.message?.[0]?.data?.data;
        if (!msgData) {
            e.reply('请回复一条网易云音乐卡片消息再使用此命令');
            return;
        }
        const autoSelectNeteaseApi = await this.pickApi()
        const musicUrlReg = /(http:|https:)\/\/music.163.com\/song\/media\/outer\/url\?id=(\d+)/;
        const musicUrlReg2 = /(http:|https:)\/\/y.music.163.com\/m\/song\?(.*)&id=(\d+)/;
        const musicUrlReg3 = /(http:|https:)\/\/music.163.com\/m\/song\/(\d+)/;
        let id =
            musicUrlReg2.exec(msgData)?.[3] ||
            musicUrlReg.exec(msgData)?.[2] ||
            musicUrlReg3.exec(msgData)?.[2] ||
            /(?<!user)id=(\d+)/.exec(msgData)?.[1] || "";
        let title = msgData.match(/"title":\s*"([^"]+)"/)?.[1]
        let desc = msgData.match(/"desc":\s*"([^"]+)"/)?.[1]
        const jumpUrl = msgData.match(/"jumpUrl":\s*"([^"]+)"/)?.[1];
        const isPodcast = /dj\?id=/.test(jumpUrl);
        if (id === "") return
        if (isPodcast) {
            const programDetailUrl = `${autoSelectNeteaseApi}/dj/program/detail?id=${id}`;
            try {
                const programRes = await axios.get(programDetailUrl);
                const mainSong = programRes.data.program.mainSong;
                id = mainSong.id;
                title = mainSong.name;
                desc = mainSong.artists[0].name || '喵喵~';
            } catch (error) {
                logger.error('出现错误，无法上传', error);
                e.reply('出现错误，无法上传');
                return;
            }
        }
        let path = this.getCurDownloadPath(e) + '/' + desc + '-' + title + '.' + FileSuffix;
        let fileExists = await checkFileExists(path);

        if (!fileExists) {
            logger.mark(`[R插件][上传群文件] 未检测到本地文件，尝试自动下载...`);
            const AUTO_NETEASE_SONG_DOWNLOAD = autoSelectNeteaseApi + "/song/url/v1?id=" + id + "&level=" + this.neteaseCloudAudioQuality;
            try {
                const resp = await axios.get(AUTO_NETEASE_SONG_DOWNLOAD, {
                    headers: {
                        "User-Agent": COMMON_USER_AGENT,
                        "Cookie": this.getCookie(false)
                    }
                });
                let url = resp.data.data?.[0]?.url;
                let musicExt = resp.data.data?.[0]?.type || FileSuffix;
                path = await downloadAudio(url, this.getCurDownloadPath(e), desc + '-' + title, 'follow', musicExt);
            } catch (err) {
                logger.error('获取歌曲下载链接失败', err);
                e.reply('获取歌曲下载链接失败，无法上传');
                return;
            }
        }
        try {
            // 上传群文件
            await this.uploadGroupFile(e, path);
            // 删除文件
            await checkAndRemoveFile(path);
        } catch (error) {
            logger.error(error);
        }
    }

    // 上传云盘
    async uploadCloud(e) {
        const autoSelectNeteaseApi = await this.pickApi()
        let uploadFilePath = null;
        let matchSongId = null;
        let msg = null;

        if (e.message?.[0]?.type === 'reply') {
            msg = await getReplyMsg(e);
        }
        // 检查消息数据有效性
        const msgData = msg?.message?.[0]?.data?.data;
        if (!msgData) {
            // 没有匹配到卡片消息数据 使用群文件上传逻辑
            const result = await getGroupFileUrl(e);
            if (!result || !result.cleanPath) {
                e.reply('请回复一条网易云音乐卡片消息，或在发送音频文件后使用此命令');
                return;
            }

            let { cleanPath, file_id, fileName: extractedFileName, fileFormat: extractedFormat } = result;
            // NapCat 和 LLBot 解决方案
            if (cleanPath.startsWith("https")) {
                const songName = extractedFileName || file_id.match(/\.(.*?)\.(\w+)$/)?.[1];
                const format = extractedFormat || file_id.match(/\.(.*?)\.(\w+)$/)?.[2];
                const path = `${this.getCurDownloadPath(e)}/${songName}.${format}`;
                // 检测文件是否存在 已提升性能
                if (await checkFileExists(path)) {
                    // 如果文件已存在
                    logger.mark(`[R插件][云盘] 上传路径审计：已存在下载文件`);
                    cleanPath = path;
                } else {
                    // 如果文件不存在
                    logger.mark(`[R插件][云盘] 上传路径审计：不存在下载文件，将进行下载...`);
                    cleanPath = await downloadAudio(cleanPath, this.getCurDownloadPath(e), songName, "manual", format);
                }
            }
            logger.info(`[R插件][云盘] 上传路径审计： ${cleanPath}`);
            // 使用 splitPaths 提取信息
            const [{ dir: dirPath, fileName, extension, baseFileName }] = splitPaths(cleanPath);
            // 文件名拆解为两部分
            const parts = baseFileName.trim().match(/^([\s\S]+)\s*-\s*([\s\S]+)$/);
            // 命令不规范检测
            if (parts == null || parts.length < 2) {
                logger.warn("[R插件][云盘] 上传路径审计：命名不规范");
                e.reply("请规范上传文件的命名：歌手-歌名，例如：梁静茹-勇气");
                return true;
            }
            // 直接提取歌手和歌名
            const title = parts[2].replace(/^\s+|\s+$/g, '');
            const artist = parts[1].replace(/^\s+|\s+$/g, '');
            // 规范化拼接出：歌手-歌名.后缀（去掉可能存在的多余空格）
            const normalizedFileName = `${dirPath}/${artist}-${title}${extension}`;
            const tags = {
                title: title,
                artist: artist
            };
            // 写入元数据
            let success = NodeID3.write(tags, cleanPath); // 如果不是mp3可能会有问题？需要测试 暂时先摸了
            if (success) logger.info('[R插件][云盘] 写入元数据成功');
            // 重命名为规范的 歌手-歌名 格式
            if (cleanPath !== normalizedFileName) {
                if (fs.existsSync(normalizedFileName)) {
                    fs.unlinkSync(normalizedFileName);
                }
                fs.renameSync(cleanPath, normalizedFileName);
            }

            uploadFilePath = normalizedFileName;
        } else {
            // 解析卡片消息数据
            const musicUrlReg = /(http:|https:)\/\/music\.163\.com\/song\/media\/outer\/url\?id=(\d+)/;
            const musicUrlReg2 = /(http:|https:)\/\/y\.music\.163\.com\/m\/song\?(.*)&id=(\d+)/;
            const musicUrlReg3 = /(http:|https:)\/\/music\.163\.com\/m\/song\/(\d+)/;
            let id =
                musicUrlReg2.exec(msgData)?.[3] ||
                musicUrlReg.exec(msgData)?.[2] ||
                musicUrlReg3.exec(msgData)?.[2] ||
                /(?<!user)id=(\d+)/.exec(msgData)?.[1] || "";
            let title = msgData.match(/"title":\s*"([^"]+)"/)?.[1]
            let desc = msgData.match(/"desc":\s*"([^"]+)"/)?.[1]
            const jumpUrl = msgData.match(/"jumpUrl":\s*"([^"]+)"/)?.[1];
            const isPodcast = /dj\?id=/.test(jumpUrl);
            if (id === "") return
            if (isPodcast) {
                const programDetailUrl = `${autoSelectNeteaseApi}/dj/program/detail?id=${id}`;
                try {
                    const programRes = await axios.get(programDetailUrl);
                    const mainSong = programRes.data.program.mainSong;
                    id = mainSong.id;
                    title = mainSong.name;
                    desc = mainSong.artists[0].name || '喵喵~';
                } catch (error) {
                    logger.error('出现错误，无法上传', error);
                    e.reply('出现错误，无法上传');
                    return;
                }
            }

            // 优先判断本地是否有文件
            let path = this.getCurDownloadPath(e) + '/' + desc + '-' + title + '.' + FileSuffix;
            let fileExists = await checkFileExists(path);

            if (!fileExists) {
                logger.mark(`[R插件][云盘] 未检测到本地文件，尝试自动下载...`);
                const AUTO_NETEASE_SONG_DOWNLOAD = autoSelectNeteaseApi + "/song/url/v1?id=" + id + "&level=" + this.neteaseCloudAudioQuality;
                try {
                    const resp = await axios.get(AUTO_NETEASE_SONG_DOWNLOAD, {
                        headers: {
                            "User-Agent": COMMON_USER_AGENT,
                            "Cookie": this.getCookie(false)
                        }
                    });
                    let url = resp.data.data?.[0]?.url;
                    let musicExt = resp.data.data?.[0]?.type || FileSuffix;
                    path = await downloadAudio(url, this.getCurDownloadPath(e), desc + '-' + title, 'follow', musicExt);
                } catch (err) {
                    logger.error('获取歌曲下载链接失败', err);
                    e.reply('获取歌曲下载链接失败，无法上传');
                    return;
                }
            }

            uploadFilePath = path;
            matchSongId = id;
        }

        if (!uploadFilePath) return;

        const tryUpload = async () => {
            let formData = new FormData();
            formData.append('songFile', fs.createReadStream(uploadFilePath));
            const headers = {
                ...formData.getHeaders(),
                'Cookie': this.getCookie(true),
            };
            const updateUrl = `${autoSelectNeteaseApi}/cloud?time=${Date.now()}`;
            try {
                const res = await axios({
                    method: 'post',
                    url: updateUrl,
                    headers: headers,
                    data: formData,
                });
                if (res.data.code == 200) {
                    let matchUrl = `${autoSelectNeteaseApi}/cloud/match?uid=${this.cloudUid || this.uid}&sid=${res.data.privateCloud.songId}&asid=${matchSongId}`;
                    try {
                        await axios.get(matchUrl, {
                            headers: {
                                "User-Agent": COMMON_USER_AGENT,
                                "Cookie": this.getCookie(true)
                            },
                        });
                        logger.info('歌曲信息匹配成功');
                    } catch (error) {
                        logger.error('歌曲信息匹配错误', error);
                    }
                    this.songCloudUpdate(e);
                    return res;

                } else {
                    throw new Error('上传失败，响应不正确');
                }
            } catch (error) {
                throw error;
            }
        };
        await retryAxiosReq(() => tryUpload())
        await checkAndRemoveFile(uploadFilePath)
    }

    // 获取云盘歌单
    async getCloudSong(e, cloudUpdate = false) {
        let songList = await redisGetKey(REDIS_YUNZAI_CLOUDSONGLIST) || []
        if (!songList[0] || cloudUpdate) {
            const autoSelectNeteaseApi = await this.pickApi();
            const limit = 100;
            let offset = 0;
            let cloudUrl = autoSelectNeteaseApi + `/user/cloud?limit=${limit}&offset=${offset}&timestamp=${Date.now()}`;
            while (true) {
                try {
                    const res = await axios.get(cloudUrl, {
                        headers: {
                            "User-Agent": COMMON_USER_AGENT,
                            "Cookie": this.getCookie(true)
                        }
                    });
                    const songs = res.data.data.map(({ songId, songName, artist, simpleSong }) => ({
                        'songName': songName,
                        'id': songId,
                        'singerName': artist || '喵喵~',
                        'duration': formatTime(simpleSong.dt),
                        'cover': simpleSong.al.picUrl || 'def',
                        'type': 'cloud'
                    }));
                    songList.push(...songs);
                    if (!res.data.hasMore) {
                        break;
                    }
                    offset += limit;
                    cloudUrl = autoSelectNeteaseApi + `/user/cloud?limit=${limit}&offset=${offset}`;
                } catch (error) {
                    console.error("获取歌单失败", error);
                    break;
                }
            }
            await redisSetKey(REDIS_YUNZAI_CLOUDSONGLIST, songList)
            return songList;
        } else {
            return songList;
        }
    }

    // 清除缓存
    async cleanCloudData(e) {
        await redisSetKey(REDIS_YUNZAI_CLOUDSONGLIST, [])
    }

    // 判断是否海外服务器
    async isOverseasServer() {
        // 如果第一次使用没有值就设置
        if (!(await redisExistKey(REDIS_YUNZAI_ISOVERSEA))) {
            await redisSetKey(REDIS_YUNZAI_ISOVERSEA, {
                os: false,
            })
            return true;
        }
        // 如果有就取出来
        return (await redisGetKey(REDIS_YUNZAI_ISOVERSEA)).os;
    }

    // API选择
    async pickApi() {
        const isOversea = await this.isOverseasServer();
        let autoSelectNeteaseApi
        if (this.useLocalNeteaseAPI) {
            // 使用自建 API
            return autoSelectNeteaseApi = this.neteaseCloudAPIServer
        } else {
            // 自动选择 API
            return autoSelectNeteaseApi = isOversea ? NETEASE_SONG_DOWNLOAD : NETEASE_API_CN;
        }
    }

    // 检测cooike活性
    async checkCooike(statusUrl, cookieType = 'song') {
        const cookie = cookieType === 'cloud' ? this.neteaseCloudCookie : this.neteaseCookie
        let status
        await axios.get(statusUrl, {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
                "Cookie": cookie
            },
        }).then(async res => {
            const userInfo = res.data.data.profile
            if (cookieType === 'song') {
                await config.updateField("tools", "neteaseUserId", res.data.data.profile.userId);
            } else if (cookieType === 'cloud') {
                await config.updateField("tools", "neteaseCloudUserId", res.data.data.profile.userId);
            }
            if (userInfo) {
                logger.info(`[R插件][ncm-Cookie检测][${cookieType}]ck活着，使用ck进行高音质下载`)
                status = true
            } else {
                logger.info(`[R插件][ncm-Cookie检测][${cookieType}]ck失效，将启用临时接口下载`)
                status = false
            }
        })
        return status
    }

    // 网易云音乐下载策略
    neteasePlay(e, pickSongUrl, songWikiUrl, songInfo, pickNumber = 0, isCkExpired, isCloudSong = false) {
        axios.get(pickSongUrl, {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
                "Cookie": this.getCookie(isCloudSong)
            },
        }).then(async resp => {
            // 国内解决方案，替换API后这里也需要修改

            // 英转中字典匹配
            const translationDict = {
                'standard': '标准',
                'higher': '较高',
                'exhigh': '极高',
                'lossless': '无损',
                'hires': 'Hi-Res',
                'jyeffect': '高清环绕声',
                'sky': '沉浸环绕声',
                'dolby': '杜比全景声',
                'jymaster': '超清母带'
            };

            // 英转中
            function translateToChinese(word) {
                return translationDict[word] || word;  // 如果找不到对应翻译，返回原词
            }

            // 字节转MB
            function bytesToMB(sizeInBytes) {
                const sizeInMB = sizeInBytes / (1024 * 1024);  // 1 MB = 1024 * 1024 bytes
                return sizeInMB.toFixed(2);  // 保留两位小数
            }
            let url = await resp.data.data?.[0]?.url || null;
            const AudioLevel = translateToChinese(resp.data.data?.[0]?.level)
            const AudioSize = bytesToMB(resp.data.data?.[0]?.size)

            // 获取歌曲标题
            let title = songInfo[pickNumber].singerName + '-' + songInfo[pickNumber].songName
            let typelist = []
            // 歌曲百科API
            await axios.get(songWikiUrl, {
                headers: {
                    "User-Agent": COMMON_USER_AGENT,
                    // "Cookie": this.neteaseCookie
                },
            }).then(res => {
                const wikiData = res.data.data.blocks[1]?.creatives || []
                if (wikiData[0]) {
                    typelist.push(wikiData[0]?.resources?.[0]?.uiElement?.mainTitle?.title)
                    // 防止数据过深出错
                    const recTags = wikiData[1]
                    if (recTags?.resources?.[0]) {
                        for (let i = 0; i < Math.min(3, recTags.resources.length); i++) {
                            if (recTags.resources[i]?.uiElement?.mainTitle?.title) {
                                typelist.push(recTags.resources[i].uiElement.mainTitle.title)
                            }
                        }
                    } else {
                        if (recTags?.uiElement?.textLinks?.[0]?.text) typelist.push(recTags.uiElement.textLinks[0].text)
                    }
                    if (wikiData[2]?.uiElement?.mainTitle?.title == 'BPM') {
                        typelist.push('BPM ' + wikiData[2]?.uiElement?.textLinks?.[0]?.text)
                    } else {
                        typelist.push(wikiData[2]?.uiElement?.textLinks?.[0]?.text)
                    }
                }
                typelist.push(AudioLevel)
            })
            let musicInfo = {
                'cover': songInfo[pickNumber].cover,
                'songName': songInfo[pickNumber].songName,
                'singerName': songInfo[pickNumber].singerName,
                'size': AudioSize + ' MB',
                'musicType': typelist
            }
            // 一般这个情况是VIP歌曲 (如果没有url或者是国内,公用接口暂时不可用，必须自建并且ck可用状态才能进行高质量解析)
            if (!isCkExpired || url == null) {
                url = await this.musicTempApi(e, musicInfo, title);
            } else {
                // 拥有ck，并且有效，直接进行解析
                let audioInfo = AudioLevel;
                if (AudioLevel == '杜比全景声') {
                    audioInfo += '\n(杜比下载文件为MP4，编码格式为AC-4，需要设备支持才可播放)';
                }
                const data = await new NeteaseMusicInfo(e).getData(musicInfo)
                let img = await puppeteer.screenshot("neteaseMusicInfo", data);
                e.reply(img);
            }
            // 动态判断后缀名
            let musicExt = resp.data.data?.[0]?.type
            FileSuffix = musicExt
            let cardSentSuccessfully = false;
            try {
                // 发送卡片
                const song = songInfo[pickNumber];
                if (song.type === 'podcast') { // 播客声音貌似只能用自定义音乐卡片
                    const musicurl = `https://music.163.com/dj?id=${song.programId}&userid=`; // 暂时不知道怎么弄到userid(似乎也用不上)
                    const musicaudio = resp.data.data[0].url;
                    const musictitle = `声音：${song.songName}`;
                    const musicimage = song.cover;
                    await sendCustomMusicCard(e, musicurl, musicaudio, musictitle, musicimage, '163');
                } else if (song.type === 'cloud') { // 云盘可能不为官方歌曲 也使用自定义音乐卡片
                    const musicurl = `https://music.163.com/song?id=${song.id}`; // 由于可能不为官方歌曲 所以id指向不一定正确
                    const musicaudio = resp.data.data[0].url;
                    const musictitle = song.songName;
                    const musicimage = (song.cover && song.cover !== 'def') ? song.cover : 'https://p2.music.126.net/UeTuwE7pvjBpypWLudqukA==/3132508627578625.jpg';
                    await sendCustomMusicCard(e, musicurl, musicaudio, musictitle, musicimage, '163');
                } else {
                    await sendMusicCard(e, '163', song.id);
                }
                cardSentSuccessfully = true;
            } catch (error) {
                if (error.message) {
                    logger.error("发送卡片错误错误:", error.message, '将尝试发送文件/语音');
                } else {
                    logger.error("发送卡片错误错误，请查看控制台报错，将尝试发送文件/语音")
                    logger.error(error)
                }
                cardSentSuccessfully = false;
            }
            // 下载音乐
            downloadAudio(url, this.getCurDownloadPath(e), title, 'follow', musicExt)
                .then(async path => {
                    if (!cardSentSuccessfully) {
                        try {
                            // 发送群文件
                            await this.uploadGroupFile(e, path);
                            // 发送语音
                            if (musicExt != 'mp4' && this.isSendVocal) {
                                await e.reply(segment.record(path));
                            }
                        } finally {
                            // 删除文件
                            await checkAndRemoveFile(path);
                        }
                    }
                })
                .catch(err => {
                    logger.error(`下载音乐失败，错误信息为: ${err}`);
                });
        });
    }

    async musicTempApi(e, musicInfo, title) {
        let musicReqApi = NETEASE_TEMP_API;
        // 临时接口，title经过变换后搜索到的音乐质量提升
        const vipMusicData = await axios.get(musicReqApi.replace("{}", title.replace("-", " ")), {
            headers: {
                "User-Agent": COMMON_USER_AGENT,
            },
        });
        const url = vipMusicData.data?.music_url
        const id = vipMusicData.data?.id ?? vipMusicData.data?.data?.quality ?? vipMusicData.data?.pay;
        musicInfo.size = id
        musicInfo.musicType = musicInfo.musicType.slice(0, -1)
        const data = await new NeteaseMusicInfo(e).getData(musicInfo)
        let img = await puppeteer.screenshot("neteaseMusicInfo", data);
        e.reply(img);
        return url;
    }

    /**
 * 根据操作类型获取对应的Cookie
 * @param {boolean} isCloud - 是否为云盘相关操作
 * @returns {string} - 返回相应的Cookie字符串
 */
    getCookie(isCloud = false) {
        if (isCloud) {
            // 云盘操作，优先使用云盘Cookie，否则回退到通用Cookie
            return this.neteaseCloudCookie || this.neteaseCookie;
        }
        // 非云盘操作，使用通用Cookie
        return this.neteaseCookie;
    }

    /**
  * 获取当前发送人/群的下载路径
  * @param e Yunzai 机器人事件
  * @returns {string}
  */
    getCurDownloadPath(e) {
        return `${this.defaultPath}${e.group_id || e.user_id}`
    }

    /**
     * 上传到群文件
     * @param e             交互事件
     * @param path          上传的文件所在路径
     * @return {Promise<void>}
     */
    async uploadGroupFile(e, path) {
        // 判断是否是ICQQ
        if (e.bot?.sendUni) {
            await e.group.fs.upload(path);
        } else {
            await e.group.sendFile(path);
        }
    }

    /**
     * 等待文件出现在指定路径并确认下载完成
     * @param {string} path 文件路径
     * @param {object} e 事件对象，用于回复
     * @param {number} timeoutSeconds 超时时间（秒），默认为60秒
     * @returns {Promise<boolean>} 文件是否在超时前出现并下载完成
     */
    async waitForFile(path, e, timeoutSeconds = 60) {
        let attempts = 0;
        let lastSize = -1;
        let stableChecks = 0;
        const maxAttempts = timeoutSeconds;
        const requiredStableChecks = 2;
        while (attempts < maxAttempts) {
            if (await checkFileExists(path)) {
                try {
                    const stats = fs.statSync(path);
                    const currentSize = stats.size;

                    if (currentSize > 0 && currentSize === lastSize) {
                        stableChecks++;
                    } else {
                        stableChecks = 0;
                    }

                    lastSize = currentSize;

                    if (stableChecks >= requiredStableChecks) {
                        logger.info(`文件已发现: ${path}，开始上传。`);
                        return true;
                    }
                } catch (error) {
                    logger.warn(`获取文件状态时出错: ${error.message}`);
                    lastSize = -1;
                    stableChecks = 0;
                }
            } else {
                lastSize = -1;
                stableChecks = 0;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }
        logger.error(`超时: ${maxAttempts}秒后文件仍未下载完成: ${path}`);
        e.reply(`等待文件下载${maxAttempts}秒超时，上传任务已取消。`);
        return false;
    }
}
