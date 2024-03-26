import schedule from "node-schedule";
import common from "../../../lib/common/common.js";
import axios from "axios";
import tunnel from "tunnel";
import fs from "node:fs";
import fetch from "node-fetch";
import { mkdirIfNotExists } from "./file.js";
import { TEN_THOUSAND } from "../constants/constant.js";

/**
 * 请求模板
 */
export class jFetch {
    async get(url) {
        const r = await fetch(url);
        return await r.json();
    }

    async post(url, params) {
        const r = await fetch(url, { ...params, method: "POST" });
        return await r.json();
    }
}

/**
 * 每日推送函数
 * @param func 回调函数
 * @param time cron
 * @param isAutoPush 是否推送（开关）
 */
export function autoTask(func, time, groupList, isAutoPush = false) {
    if (isAutoPush) {
        schedule.scheduleJob(time, () => {
            // 正常传输
            if (groupList instanceof Array) {
                for (let i = 0; i < groupList.length; i++) {
                    const group = Bot.pickGroup(groupList[i]);
                    func(group);
                    common.sleep(1000);
                }
                // 防止恶意破坏函数
            } else if (groupList instanceof String) {
                const group = Bot.pickGroup(groupList[i]);
                func(group);
                common.sleep(1000);
            } else {
                throw Error("错误传入每日推送参数！");
            }
        });
    }
}

/**
 * 重试函数（暂时只用于抖音的api）
 * @param func
 * @param maxRetries
 * @param delay
 * @returns {Promise<unknown>}
 */
export function retry(func, maxRetries = 3, delay = 1000) {
    return new Promise((resolve, reject) => {
        const attempt = (remainingTries) => {
            func()
                .then(resolve)
                .catch(error => {
                    if (remainingTries === 1) {
                        reject(error);
                    } else {
                        console.log(`错误: ${ error }. 重试将在 ${ delay / 1000 } 秒...`);
                        setTimeout(() => attempt(remainingTries - 1), delay);
                    }
                });
        };
        attempt(maxRetries);
    });
}

/**
 * 工具：下载pdf文件
 * @param url
 * @param filename
 * @returns {Promise<unknown>}
 */
export function downloadPDF(url, filename) {
    return axios({
        url: url,
        responseType: "stream",
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.97 Safari/537.36",
        },
    }).then(response => {
        const writer = fs.createWriteStream(filename);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on("finish", resolve);
            writer.on("error", reject);
        });
    });
}

/**
 * 找到tiktok的视频id
 * @param url
 * @returns {Promise<string|string|null>}
 */
export async function getIdVideo(url) {
    const matching = url.includes("/video/");
    if (!matching) {
        return null;
    }
    const idVideo = url.substring(url.indexOf("/video/") + 7, url.length);
    return idVideo.length > 19 ? idVideo.substring(0, idVideo.indexOf("?")) : idVideo;
}

export function generateRandomStr(randomlength = 16) {
    const base_str = 'ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789='
    let random_str = ''
    for (let i = 0; i < randomlength; i++) {
        random_str += base_str.charAt(Math.floor(Math.random() * base_str.length))
    }
    return random_str
}

/**
 * 下载mp3
 * @param mp3Url    MP3地址
 * @param path      下载目录
 * @param redirect  是否要重定向
 * @returns {Promise<unknown>}
 */
export async function downloadMp3(mp3Url, path, redirect = "manual") {
    return fetch(mp3Url, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Linux; Android 5.0; SM-G900P Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.25 Mobile Safari/537.36",
        },
        responseType: "stream",
        redirect: redirect,
    }).then(async res => {
        // 如果没有目录就创建一个
        await mkdirIfNotExists(path)

        // 补充保存文件名
        path += "/temp.mp3";
        if (fs.existsSync(path)) {
            console.log(`音频已存在`);
            fs.unlinkSync(path);
        }
        // 开始下载
        const fileStream = fs.createWriteStream(path);
        res.body.pipe(fileStream);
        return new Promise((resolve, reject) => {
            fileStream.on("finish", () => {
                fileStream.close(() => {
                    resolve(path);
                });
            });
            fileStream.on("error", err => {
                fs.unlink(path, () => {
                    reject(err);
                });
            });
        });
    });
}

/**
 * 下载一张网络图片(自动以url的最后一个为名字)
 * @param img
 * @param dir
 * @param fileName
 * @param isProxy
 * @returns {Promise<unknown>}
 */
export async function downloadImg(img, dir, fileName = "", isProxy = false) {
    if (fileName === "") {
        fileName = img.split("/").pop();
    }
    const filepath = `${ dir }/${ fileName }`;
    await mkdirIfNotExists(dir)
    const writer = fs.createWriteStream(filepath);
    const axiosConfig = {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Linux; Android 5.0; SM-G900P Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.25 Mobile Safari/537.36",
        },
        responseType: "stream",
    };

    if (isProxy) {
        axiosConfig.httpAgent = tunnel.httpOverHttp({
            proxy: { host: this.proxyAddr, port: this.proxyPort },
        });
        axiosConfig.httpsAgent = tunnel.httpOverHttp({
            proxy: { host: this.proxyAddr, port: this.proxyPort },
        });
    }
    try {
        const res = await axios.get(img, axiosConfig);
        res.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on("finish", () => {
                writer.close(() => {
                    resolve(filepath);
                });
            });
            writer.on("error", err => {
                fs.unlink(filepath, () => {
                    reject(err);
                });
            });
        });
    } catch (err) {
        logger.error("图片下载失败");
    }
}

/**
 * 千位数的数据处理
 * @param data
 * @return {string|*}
 */
const dataProcessing = data => {
    return Number(data) >= TEN_THOUSAND ? (data / TEN_THOUSAND).toFixed(1) + "万" : data;
};

/**
 * 哔哩哔哩解析的数据处理
 * @param data
 * @return {string}
 */
export function formatBiliInfo(data) {
    return Object.keys(data).map(key => `${ key }：${ dataProcessing(data[key]) }`).join(' | ');
}

/**
 * 数字转换成具体时间
 * @param seconds
 * @return {string}
 */
export function secondsToTime(seconds) {
    const pad = (num, size) => num.toString().padStart(size, '0');

    let hours = Math.floor(seconds / 3600);
    let minutes = Math.floor((seconds % 3600) / 60);
    let secs = seconds % 60;

    // 如果你只需要分钟和秒钟，你可以返回下面这行：
    // return `${pad(minutes, 2)}:${pad(secs, 2)}`;

    // 完整的 HH:MM:SS 格式
    return `${ pad(hours, 2) }:${ pad(minutes, 2) }:${ pad(secs, 2) }`;
}

/**
 * 判断字符串是否是中文（全局判断）
 * @param str
 * @returns {boolean}
 */
export function isChinese(str) {
    return /^[\u4e00-\u9fff]+$/.test(str);
}

/**
 * 判断字符串是否包含中文
 * @param str
 * @returns {boolean}
 */
export function containsChinese(str) {
    return /[\u4e00-\u9fff]/.test(str);
}

/**
 * 判断字符串是否包含中文 &&   检测标点符号
 * @param str
 * @returns {boolean}
 */
export function containsChineseOrPunctuation(str) {
    return /[\u4e00-\u9fff\uff00-\uffef]/.test(str);
}

/**
 * 超过某个长度的字符串换为...
 * @param inputString
 * @param maxLength
 * @returns {*|string}
 */
export function truncateString(inputString, maxLength = 50) {
    if (maxLength === 0 || maxLength === -1) {
        return inputString;
    } else if (inputString.length <= maxLength) {
        return inputString;
    } else {
        // 截取字符串，保留前面 maxLength 个字符
        let truncatedString = inputString.substring(0, maxLength);
        // 添加省略号
        truncatedString += '...';
        return truncatedString;
    }
}

/**
 * 测试当前是否存在🪜
 * @returns {Promise<Boolean>}
 */
export async function testProxy() {
    // 配置代理服务器
    const proxyOptions = {
        host: '127.0.0.1',
        port: 7890,
        // 如果你的代理服务器需要认证
        // auth: 'username:password', // 取消注释并提供实际的用户名和密码
    };

    // 创建一个代理隧道
    const httpsAgent = tunnel.httpsOverHttp({
        proxy: proxyOptions
    });

    try {
        // 通过代理服务器发起请求
        await axios.get('https://google.com.hk', { httpsAgent });
        logger.mark('[R插件][梯子测试模块] 检测到梯子');
        return true;
    } catch (error) {
        logger.error('[R插件][梯子测试模块] 检测不到梯子');
        return false;
    }
}

export function formatSeconds(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}分${remainingSeconds}秒`;
}