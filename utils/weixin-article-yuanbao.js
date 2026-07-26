import axios from 'axios';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
    YUANBAO_CHAT,
    YUANBAO_CONVERSATION_CREATE,
    YUANBAO_CONVERSATION_CLEAR,
    YUANBAO_CONVERSATION_UPDATE_MODEL,
} from '../constants/tools.js';
import { SUMMARY_PROMPT } from '../constants/constant.js';

/**
 * 链接总结（走腾讯元宝 Web 端对话接口）
 *
 * 设计思路：
 *   与 utils/weixin-channel.js 视频号解析共用同一个腾讯元宝 Cookie（weixinChannelYuanbaoCookie）。
 *   视频号走 get_parse_result 专用接口拿 playable_url（结构化数据）；
 *   通用链接总结没有专用接口时，走元宝对话接口让元宝抓取并总结。
 *
 * 解析流程（一次性会话）：
 *   1. POST /api/user/agent/conversation/create 新建会话 → 拿 chatId
 *   2. POST /api/user/agent/conversation/updateModel 初始化模型（默认 hunyuan_gpt_175B_0404，可选 deep_seek_v3）
 *   3. POST /api/chat/{chatId} 发送"总结：<文章URL>"消息，接收 SSE 流拼接元宝返回内容
 *   4. POST /api/user/agent/conversation/v1/clear 删除会话（无论成功失败都清理）
 *
 * 鉴权：
 *   - Cookie：腾讯元宝 Web 端登录态
 *   - x-uskey / x-bus-params-md5 / x-timestamp：元宝 Web 前端 Qimei SDK 生成的业务签名头
 *     （2026-07 起 /api/chat 强校验；缺失时会返回“服务繁忙，请稍后再试。”）
 *
 * payload 格式参考：https://github.com/chenwr727/yuanbao-free-api
 */

// 元宝 Web 端公共请求头（设备指纹部分，与视频号 PARSE_HEADERS 保持一致风格）
const COMMON_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh-TW;q=0.9,zh;q=0.8',
    'content-type': 'application/json',
    'origin': 'https://yuanbao.tencent.com',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'sec-ch-ua': `"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"Windows"`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-language': 'zh-CN',
    'x-platform': 'win',
    'x-source': 'web',
    'x-webversion': '2.76.3',
    'x-requested-with': 'XMLHttpRequest',
    'x-webdriver': '0',
    'x-ybuitest': '0',
    'x-instance-id': '5',
    'x-os_version': 'Windows(10)-Blink',
    'x-web-third-source': 'main',
};

// 元宝默认智能体 ID（与视频号解析 referer 里的一致）
const AGENT_ID = 'naQivTmsDa';
// 默认对话模型（混元 175B，元宝网页版默认模型）
const DEFAULT_MODEL = 'hunyuan_gpt_175B_0404';
// 支持的 chatModelId（对齐网页端）
const SUPPORTED_MODELS = new Set([
    'hunyuan_gpt_175B_0404',
    'deep_seek_v3',
]);
// chat 接口里的 model 字段与 chatModelId 不同：混元仍用 gpt_175B_0404，DeepSeek 抓包也继续传 gpt_175B_0404
const CHAT_API_MODEL = 'gpt_175B_0404';
// 元宝前端 Qimei / Beacon appKey（抓包确认，用于 getUSKeySync）
const QIMEI_APP_KEY = '0WEB05U9OEC1ZNRY';
// 元宝前端 getUSKeySync 的固定业务 appId
const USKEY_APP_ID = '7800385';
// 元宝对话页，用于初始化 Qimei SDK
const YUANBAO_CHAT_PAGE = `https://yuanbao.tencent.com/chat/${AGENT_ID}`;

/**
 * uskey 生成会话缓存：
 *   复用同一个 Playwright context/page，避免每次总结都重新打开元宝首页（约 2-5 秒）
 *   Cookie 变化时自动重建
 */
let uskeySession = null;
// 串行化 uskey 会话创建 + page.evaluate，避免并发总结互相关掉对方页面
let uskeyGenerationQueue = Promise.resolve();

function buildSummaryPrompt(input, { isContent = false } = {}) {
    const sourceLabel = isContent ? '网页内容' : '链接';
    return `${SUMMARY_PROMPT}

请严格遵循以上角色、规则与输出格式要求，直接总结下面提供的${sourceLabel}，不要输出额外寒暄，也不要重复提示词内容。

${sourceLabel}：${input}`;
}

/**
 * 归一化元宝模型 ID
 * @param {string} [model]
 * @returns {string}
 */
function resolveYuanbaoModel(model) {
    const id = String(model || DEFAULT_MODEL).trim();
    if (SUPPORTED_MODELS.has(id)) return id;
    // 兼容简写
    if (/^deepseek/i.test(id) || id === 'deep_seek' || id === 'ds' || id === 'deepseek_v3') {
        return 'deep_seek_v3';
    }
    if (/hunyuan|混元/i.test(id)) {
        return DEFAULT_MODEL;
    }
    logger.warn(`[R插件][链接总结][元宝] 未知模型 ${id}，回退到 ${DEFAULT_MODEL}`);
    return DEFAULT_MODEL;
}

/**
 * 从 Cookie 字符串提取指定字段
 * @param {string} cookie
 * @param {string} name
 * @returns {string}
 */
function getCookieValue(cookie, name) {
    if (!cookie) return '';
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? match[1] : '';
}

/**
 * 把 Cookie 字符串转成 Playwright cookies
 * @param {string} cookie
 * @returns {Array<object>}
 */
function parseCookieString(cookie) {
    return String(cookie || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .map(pair => {
            const idx = pair.indexOf('=');
            if (idx <= 0) return null;
            return {
                name: pair.slice(0, idx).trim(),
                value: pair.slice(idx + 1),
                domain: '.yuanbao.tencent.com',
                path: '/',
            };
        })
        .filter(Boolean);
}

/**
 * 判断是否是原生 Playwright Browser（有 newContext）
 * 宿主 puppeteer.js 返回的是 PuppeteerCompatBrowser，只有 newPage，没有 newContext
 * @param {any} browser
 * @returns {boolean}
 */
function isNativePlaywrightBrowser(browser) {
    return !!(browser && typeof browser.newContext === 'function');
}

/**
 * 从宿主 bot 解包真正的 Playwright Browser
 * 兼容路径：
 *   1. renderer.manager.browser（原生 Playwright）
 *   2. puppeteer.browser.browser（PuppeteerCompatBrowser 内部原生实例）
 *   3. puppeteer.browser（仅当它本身就有 newContext）
 * @returns {Promise<import('playwright').Browser|null>}
 */
async function getHostPlaywrightBrowser() {
    try {
        const puppeteer = (await import('../../../lib/puppeteer/puppeteer.js')).default;
        if (typeof puppeteer?.browserInit === 'function') {
            await puppeteer.browserInit();
        }

        // 优先拿渲染器底层 manager 的原生 browser
        const managerBrowser = puppeteer?.manager?.browser;
        if (isNativePlaywrightBrowser(managerBrowser)) {
            return managerBrowser;
        }

        // 其次从兼容层包装对象上解包
        const compat = puppeteer?.browser;
        if (isNativePlaywrightBrowser(compat)) {
            return compat;
        }
        if (isNativePlaywrightBrowser(compat?.browser)) {
            return compat.browser;
        }
    } catch (err) {
        logger.debug(`[R插件][链接总结][元宝] 复用宿主浏览器失败: ${err.message}`);
    }
    return null;
}

/**
 * 获取可用的 Playwright Chromium
 * 优先复用宿主 bot 已启动的原生 Playwright 浏览器，失败时再独立 launch
 * @returns {Promise<{ browser: import('playwright').Browser, owned: boolean }>}
 */
async function getPlaywrightBrowser() {
    // 1) 宿主 bot 原生 Playwright browser
    const hostBrowser = await getHostPlaywrightBrowser();
    if (hostBrowser) {
        return { browser: hostBrowser, owned: false };
    }

    // 2) 插件/工作区独立 Playwright
    try {
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        return { browser, owned: true };
    } catch (err) {
        throw new Error(
            `无法启动 Playwright 浏览器以生成元宝 x-uskey：${err.message}。` +
            `请确认宿主已安装 Chromium（bun run browser:install）`,
        );
    }
}

/**
 * 关闭指定 uskey 会话资源（可传会话对象，避免并发时误清全局指针）
 * @param {object|null} [session]
 */
async function disposeUskeySession(session) {
    if (!session) return;
    try {
        await session.page?.close().catch(() => {});
        // 只关闭我们自己 new 出来的 context；不要动宿主默认 context
        if (session.ownedContext && session.context) {
            await session.context.close().catch(() => {});
        }
        if (session.owned && session.browser) {
            await session.browser.close().catch(() => {});
        }
    } catch (_) {
        // ignore
    }
}

/**
 * 关闭当前全局 uskey 会话
 */
async function closeUskeySession() {
    const session = uskeySession;
    uskeySession = null;
    await disposeUskeySession(session);
}

/**
 * 确保存在可用的元宝页面，用于调用前端 Qimei SDK 生成 x-uskey
 * 注意：调用方需保证串行（见 generateSecurityHeaders 队列），本函数本身不处理并发互斥
 * @param {string} cookie
 * @returns {Promise<{ page: import('playwright').Page }>}
 */
async function ensureUskeySession(cookie) {
    if (uskeySession?.page && uskeySession.cookie === cookie) {
        // 页面可能被外部关闭，做一次轻量探活
        try {
            if (!uskeySession.page.isClosed()) {
                return uskeySession;
            }
        } catch (_) {
            // fallthrough recreate
        }
        await closeUskeySession();
    } else if (uskeySession) {
        await closeUskeySession();
    }

    const { browser, owned } = await getPlaywrightBrowser();
    if (!isNativePlaywrightBrowser(browser)) {
        throw new Error('获取到的浏览器对象不是原生 Playwright Browser（缺少 newContext）');
    }

    let context;
    let page;
    try {
        // 独立 context，避免污染宿主默认 context 的 Cookie/UA
        context = await browser.newContext({
            userAgent: COMMON_HEADERS['user-agent'],
            viewport: { width: 1280, height: 800 },
            locale: 'zh-CN',
        });
        await context.addCookies(parseCookieString(cookie));
        page = await context.newPage();

        // 打开元宝对话页，等待 webpack + Qimei SDK 就绪
        await page.goto(YUANBAO_CHAT_PAGE, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        // 轮询等待 getUSKeySync 可用（通常 1-3 秒）
        const ready = await page.waitForFunction(() => {
            try {
                let webpackRequire = null;
                if (!self.webpackChunk_N_E) return false;
                self.webpackChunk_N_E.push([[`__yb_uskey_ready_${Date.now()}__`], {}, (req) => {
                    webpackRequire = req;
                }]);
                if (!webpackRequire) return false;
                const mod = webpackRequire(12601);
                const inst = mod?.I5?.('0WEB05U9OEC1ZNRY');
                const h38 = inst?.getLocalQimei36?.()?.h38 || localStorage.getItem('_qimei_h38') || '';
                return !!(inst?.getUSKeySync && h38 && String(h38).length === 38);
            } catch (_) {
                return false;
            }
        }, { timeout: 30000 }).then(() => true).catch(() => false);

        if (!ready) {
            throw new Error('元宝页面 Qimei SDK 初始化超时，无法生成 x-uskey（可检查 Cookie 是否失效或网络是否可达 yuanbao.tencent.com）');
        }

        uskeySession = {
            browser,
            owned,
            context,
            ownedContext: true,
            page,
            cookie,
        };
        logger.info('[R插件][链接总结][元宝] x-uskey 生成会话已就绪');
        return uskeySession;
    } catch (err) {
        // 初始化任一步失败都回收已创建资源，避免 context/browser 泄漏
        await page?.close().catch(() => {});
        await context?.close().catch(() => {});
        // 仅关闭我们独立 launch 的 browser；宿主 browser 绝不能关
        if (owned) {
            await browser.close().catch(() => {});
        }
        throw err;
    }
}

/**
 * 实际生成元宝业务签名头（需在串行队列中调用）
 * @param {string} cookie
 * @returns {Promise<object>}
 */
async function generateSecurityHeadersUnsafe(cookie) {
    const session = await ensureUskeySession(cookie);
    const deviceId = getCookieValue(cookie, '_qimei_uuid42');

    const raw = await session.page.evaluate(({ appKey, appId }) => {
        let webpackRequire = null;
        self.webpackChunk_N_E.push([[`__yb_uskey_gen_${Date.now()}__`], {}, (req) => {
            webpackRequire = req;
        }]);
        if (!webpackRequire) {
            throw new Error('webpackRequire unavailable');
        }
        const mod = webpackRequire(12601);
        const inst = mod.I5(appKey);
        const h38 = inst?.getLocalQimei36?.()?.h38 || localStorage.getItem('_qimei_h38') || '';
        if (!h38 || String(h38).length !== 38) {
            throw new Error(`invalid h38: ${h38}`);
        }
        const ts = Date.now();
        const params = `h38=${h38}&timestamp=${ts}&platform=web`;
        const uskey = inst.getUSKeySync(appId, h38, params);
        if (!uskey) {
            throw new Error('empty uskey');
        }
        return { h38, ts, params, uskey };
    }, { appKey: QIMEI_APP_KEY, appId: USKEY_APP_ID });

    const busMd5 = crypto.createHash('md5').update(raw.params).digest('hex');
    return {
        'x-uskey': encodeURIComponent(raw.uskey),
        'x-bus-params-md5': busMd5,
        'x-timestamp': String(raw.ts),
        // 设备指纹：优先 Cookie 中的 _qimei_uuid42
        ...(deviceId ? {
            'x-device-id': deviceId,
            'x-hy93': deviceId,
        } : {}),
    };
}

/**
 * 生成元宝业务签名头：
 *   x-uskey / x-bus-params-md5 / x-timestamp
 *
 * 前端逻辑（_app.js 抓包还原）：
 *   h38 = qimei.getLocalQimei36().h38
 *   params = `h38=${h38}&timestamp=${Date.now()}&platform=web`
 *   x-uskey = encodeURIComponent(qimei.getUSKeySync("7800385", h38, params))
 *   x-bus-params-md5 = md5(params)
 *   x-timestamp = timestamp
 *
 * 并发保护：
 *   多个总结请求可能同时进入；uskeySession 是全局共享页面，
 *   必须串行化“确保会话 + evaluate”，否则会互相 close 对方 page。
 *
 * @param {string} cookie
 * @returns {Promise<object>}
 */
async function generateSecurityHeaders(cookie) {
    const run = uskeyGenerationQueue.then(
        () => generateSecurityHeadersUnsafe(cookie),
    );
    // 前一个失败也不阻塞后续任务
    uskeyGenerationQueue = run.catch(() => undefined);
    return run;
}

/**
 * 构建带 Cookie + referer 的完整请求头
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @param {string} chatId 会话 ID（用于 referer 与 x-agentid）
 * @param {object} extra 额外覆盖的 headers
 * @param {object} [opts]
 * @param {boolean} [opts.chatIdInPath=true] 是否在 referer/x-agentid 路径中带 chatId
 *   - create/updateModel/clear 接口：带 chatId（如 /chat/naQivTmsDa/xxx）
 *   - chat 对话接口：不带 chatId（仅 /chat/naQivTmsDa，实测抓包确认）
 * @returns {object}
 */
function buildHeaders(cookie, chatId, extra = {}, { chatIdInPath = true } = {}) {
    // chatId 为空时强制只使用 agentId，避免生成 naQivTmsDa/ 这种尾斜杠路径
    const path = (chatIdInPath && chatId) ? `${AGENT_ID}/${chatId}` : AGENT_ID;
    return {
        ...COMMON_HEADERS,
        'referer': `https://yuanbao.tencent.com/chat/${path}`,
        'x-agentid': path,
        'cookie': cookie,
        ...extra,
    };
}

/**
 * Step 1: 新建元宝会话
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @returns {Promise<string>} chatId 会话 ID
 */
export async function createConversation(cookie) {
    // create 接口同样在前端 uskey 签名白名单内，需带签名头
    const securityHeaders = await generateSecurityHeaders(cookie);
    // payload 必须带 agentId，实测抓包确认；不带 agentId 也能创建但建议与网页版一致
    const resp = await axios.post(
        YUANBAO_CONVERSATION_CREATE,
        { agentId: AGENT_ID },
        {
            // create 时尚无 chatId，referer/x-agentid 只带 agentId，避免 naQivTmsDa/ 尾斜杠
            headers: buildHeaders(cookie, '', securityHeaders, { chatIdInPath: false }),
            timeout: 15000,
        },
    );
    const chatId = resp.data?.id;
    if (!chatId) {
        throw new Error('元宝接口未返回会话 ID，可能是 Cookie 失效');
    }
    logger.info(`[R插件][链接总结][元宝] 创建会话成功: ${chatId}`);
    return chatId;
}

/**
 * Step 2: 初始化会话模型（支持混元 175B / DeepSeek V3）
 * 不调用此步骤直接发消息有时会返回空，沙箱实测必须先初始化模型
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @param {string} chatId 会话 ID
 * @param {string} [model=DEFAULT_MODEL] chatModelId，如 deep_seek_v3
 */
export async function initConversationModel(cookie, chatId, model = DEFAULT_MODEL) {
    const chatModelId = resolveYuanbaoModel(model);
    const payload = {
        cid: chatId,
        chatModelId,
        // chatModelExtInfo 是嵌套 JSON 字符串（元宝网页版原样格式）
        chatModelExtInfo: JSON.stringify({
            modelId: chatModelId,
            subModelId: '',
            supportFunctions: { internetSearch: 'autoInternetSearch' },
            internetSearch: 'autoInternetSearch',
        }),
    };
    // updateModel 不在 uskey 白名单，但补签名头无副作用
    const securityHeaders = await generateSecurityHeaders(cookie).catch(() => ({}));
    await axios.post(YUANBAO_CONVERSATION_UPDATE_MODEL, payload, {
        headers: buildHeaders(cookie, chatId, securityHeaders),
        timeout: 15000,
    });
    logger.info(`[R插件][链接总结][元宝] 初始化模型成功: ${chatModelId}`);
}

/**
 * Step 4: 删除元宝会话（无论解析成功失败都应调用，避免污染用户会话列表）
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @param {string} chatId 会话 ID
 */
export async function clearConversation(cookie, chatId) {
    try {
        await axios.post(
            YUANBAO_CONVERSATION_CLEAR,
            { conversationIds: [chatId], uiOptions: { noToast: true } },
            {
                headers: buildHeaders(cookie, chatId),
                timeout: 15000,
            },
        );
        logger.info(`[R插件][链接总结][元宝] 删除会话成功: ${chatId}`);
    } catch (err) {
        // 删除失败不影响主流程，仅记录日志
        logger.warn(`[R插件][链接总结][元宝] 删除会话失败（不影响主流程）: ${err.message}`);
    }
}

/**
 * 解析元宝 SSE 流，拼接出最终文本回复
 *
 * 元宝 SSE 真实格式（实测抓包确认，2026-06）：
 *   - 每行形如 `data: {...}` 或 `event: xxx` 或自定义标记行
 *   - 文本增量：`data: {"type":"text","msg":"根据你"}` ← 只提取这种
 *   - 状态提示：`data: {"type":"continue_step","msg":"正在阅读"}` ← 跳过（不是回答内容）
 *   - 文章卡片：`data: {"type":"multimediaParseResult",...}` ← 跳过
 *   - 元信息：`data: {"type":"meta",...}` ← 跳过
 *   - 非 JSON 标记：`data: status` / `data: text` / `data: [plugin: ]` / `data: [MSGINDEX:2]`
 *                   `data: [TRACEID:...]` / `data: [DONE]` ← 全部跳过
 *   - event: 行（如 `event: speech_type`）← 跳过
 *
 * 关键点：必须用 `type === "text" && typeof msg === "string"` 双重过滤，
 * 否则会把"正在阅读"等状态提示误当作回答内容。
 *
 * @param {import('stream').Readable} stream SSE 流
 * @param {object} options
 * @param {function(string): void} [options.onChunk] 收到增量文本回调（可用于实时进度展示）
 * @returns {Promise<string>} 拼接后的完整文本
 */
function parseSSEStream(stream, { onChunk } = {}) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let buffer = '';
        // 使用流式 UTF-8 解码器，避免 chunk 边界切断多字节中文字符导致乱码或 JSON 解析失败
        const decoder = new StringDecoder('utf8');
        let settled = false;

        const settleReject = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        const settleResolve = (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
        };

        const handleLine = (line) => {
            line = line.trim();
            if (!line) return;

            // SSE 注释行 / 事件名行 / id 行，跳过
            if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) return;

            // 提取 data: 后的内容
            let dataStr = line;
            if (line.startsWith('data:')) {
                dataStr = line.slice(5).trim();
            }

            // 空内容或结束标记
            if (!dataStr || dataStr === '[DONE]') return;

            // 非 JSON 的标记行（[plugin:] / [MSGINDEX:] / [TRACEID:] / status / text 等）全部跳过
            // 这些是元宝前端的自定义协议标记，不是回答内容
            if (dataStr.startsWith('[')) return;
            if (dataStr === 'status' || dataStr === 'text') return;

            // 尝试 JSON 解析
            let obj;
            try {
                obj = JSON.parse(dataStr);
            } catch (_) {
                // 非 JSON 行一律跳过（避免把状态文本误当作回答）
                return;
            }

            // 错误事件
            if (obj.type === 'error' || (obj.error && obj.error.code && String(obj.error.code) !== '0')) {
                const msg = obj.error?.message || obj.msg || obj.error?.code || 'unknown';
                // 把“服务繁忙”映射成更可操作的提示（多数是缺 x-uskey 或 Cookie/IP 风控）
                if (String(msg).includes('服务繁忙')) {
                    settleReject(new Error(
                        '元宝接口错误: 服务繁忙，请稍后再试。' +
                        '（常见原因：x-uskey 签名失败 / Cookie 失效 / 部署 IP 与登录 IP 不一致）',
                    ));
                    return;
                }
                settleReject(new Error(`元宝接口错误: ${msg}`));
                return;
            }

            // 只提取 type=text 的 msg 字段作为回答增量
            // 注意：continue_step / multimediaParseResult / meta 等类型也有 msg 或其他字段，必须排除
            if (obj.type === 'text' && typeof obj.msg === 'string' && obj.msg) {
                parts.push(obj.msg);
                if (onChunk) onChunk(obj.msg);
            }
        };

        stream.on('data', (chunk) => {
            // 用 StringDecoder 流式解码，防止 chunk 边界切断多字节 UTF-8 字符
            buffer += decoder.write(chunk);
            // 按换行切分，最后一行可能不完整暂存到 buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) handleLine(line);
        });

        stream.on('end', () => {
            // 刷新解码器残留字节（可能包含不完整字符的尾字节）
            buffer += decoder.end();
            // 处理 buffer 中剩余内容
            if (buffer.trim()) handleLine(buffer);
            if (settled) return;
            const fullText = parts.join('').trim();
            if (!fullText) {
                settleReject(new Error('元宝接口未返回任何文本内容，可能是接口格式变动或 Cookie 失效'));
                return;
            }
            settleResolve(fullText);
        });

        stream.on('error', (err) => settleReject(err));
    });
}

/**
 * Step 3: 发送链接总结请求并接收 SSE 流
 *
 * payload 与 headers 格式来自元宝网页版实测抓包（2026-06 / 2026-07），
 * 与 yuanbao-free-api 早期版本有差异，以实际抓包为准。
 *
 * 关键字段：
 *   - parsingPromptUrl: 链接 URL 数组，元宝据此抓取正文
 *   - conversationId: 会话 ID（与 URL 路径里的 chatId 一致）
 *   - model: "gpt_175B_0404"（注意无 hunyuan_ 前缀，与 chatModelId 不同）
 *   - supportFunctions: 开启联网搜索与自动搜索开关
 *
 * headers 关键点：
 *   - content-type: text/plain;charset=UTF-8（非 application/json）
 *   - chat_version: v1
 *   - referer / x-agentid 不带 chatId（仅 naQivTmsDa）
 *   - x-uskey / x-bus-params-md5 / x-timestamp：对话接口强校验（缺则返回服务繁忙）
 *
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @param {string} chatId 会话 ID
 * @param {string} input 待总结链接或已抓取内容
 * @param {object} [options]
 * @param {number} [options.timeout=120000] 超时毫秒
 * @param {function(string): void} [options.onChunk] 增量回调
 * @param {boolean} [options.isContent=false] 是否直接总结已抓取内容
 * @returns {Promise<string>} 元宝总结的完整文本
 */
export async function chatSummarize(cookie, chatId, input, options = {}) {
    const { timeout = 120000, onChunk, isContent = false, model = DEFAULT_MODEL } = options;
    const chatModelId = resolveYuanbaoModel(model);

    const prompt = buildSummaryPrompt(input, { isContent });
    // payload 字段对齐元宝网页版实测抓包格式
    // 注意：body.model 固定 gpt_175B_0404；真正切换模型靠 chatModelId / chatModelExtInfo.modelId
    const body = {
        model: CHAT_API_MODEL,
        prompt,
        plugin: '',
        displayPrompt: prompt,
        displayPromptType: 1,
        agentId: AGENT_ID,
        isTemporary: false,
        projectId: '',
        chatModelId,
        supportFunctions: ['openAutoSearchSwitch', 'autoInternetSearch'],
        docOpenid: '',
        options: {
            imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true },
        },
        multimedia: [],
        supportHint: 1,
        chatModelExtInfo: JSON.stringify({
            modelId: chatModelId,
            subModelId: '',
            supportFunctions: { internetSearch: '' },
            internetSearch: 'autoInternetSearch',
        }),
        applicationIdList: [],
        version: 'v2',
        extReportParams: null,
        isAtomInput: false,
        // 关键：链接 URL 数组，元宝据此抓取正文（实测抓包确认）
        parsingPromptUrl: isContent ? [] : [input],
        // 关键：会话 ID，与 URL 路径里的 chatId 一致
        conversationId: chatId,
        offsetOfHour: 8,
        offsetOfMinute: 0,
    };

    // 每次对话都重新生成签名头（timestamp 绑定 uskey，不可复用）
    const securityHeaders = await generateSecurityHeaders(cookie);

    const resp = await axios.post(`${YUANBAO_CHAT}${chatId}`, body, {
        // chat 接口 referer/x-agentid 不带 chatId（实测抓包确认）
        headers: buildHeaders(cookie, chatId, {
            accept: '*/*',
            'content-type': 'text/plain;charset=UTF-8',
            'chat_version': 'v1',
            'x-input-type': 'text',
            'x-event-input-type': '11',
            ...securityHeaders,
        }, { chatIdInPath: false }),
        timeout,
        responseType: 'stream',
        // SSE 流不解析为 JSON
        transformResponse: [(data) => data],
    });

    if (resp.status !== 200) {
        throw new Error(`元宝对话接口返回 HTTP ${resp.status}`);
    }

    logger.info(`[R插件][链接总结][元宝] 对话流已建立，开始接收 SSE`);
    let summary = await parseSSEStream(resp.data, { onChunk });

    // 清洗元宝富文本标记（QQ 群里显示会很怪）：
    //   [](@mark_underline=N)  ← 高亮下划线标记
    //   [](@mark_*)            ← 其他 mark 标记
    //   [citation:N]           ← 联网搜索引用编号标记
    summary = summary
        .replace(/\[\]\(@mark_[a-z_]+=\d+\)/g, '')
        .replace(/\[citation:\d+\]/g, '');

    return summary;
}

/**
 * 端到端总结：新建会话 → 初始化模型 → 对话总结 → 删除会话
 *
 * 无论解析成功或失败都会尝试删除会话，避免污染用户元宝账号的会话列表。
 *
 * @param {string} url 待总结链接
 * @param {string} cookie 腾讯元宝 Web 端 Cookie（与视频号解析共用）
 * @param {object} [options]
 * @param {function(string): void} [options.onChunk] SSE 增量回调（可用于实时进度展示）
 * @param {number} [options.timeout=120000] 对话接口超时毫秒
 * @returns {Promise<string>} 元宝总结的完整文本
 */
export async function summarizeLink(url, cookie, options = {}) {
    if (!cookie) {
        throw new Error('未配置腾讯元宝 Cookie，请联系管理员设置（#设置视频号Cookie）');
    }
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
        throw new Error('请提供有效的链接地址');
    }
    const normalizedUrl = url.trim();

    let chatId = '';
    try {
        const model = resolveYuanbaoModel(options.model);
        // Step 1: 新建会话
        chatId = await createConversation(cookie);
        // Step 2: 初始化模型（混元 / DeepSeek 等）
        await initConversationModel(cookie, chatId, model);
        // Step 3: 发送总结请求
        const summary = await chatSummarize(cookie, chatId, normalizedUrl, { ...options, model });
        logger.info(`[R插件][链接总结][元宝] 总结成功，文本长度: ${summary.length}`);
        return summary;
    } catch (err) {
        // 401 通常意味着 Cookie 失效或部署服务器 IP 与元宝登录 IP 不一致（沙箱实测确认此风控存在）
        const status = err?.response?.status;
        if (status === 401) {
            throw new Error('元宝对话接口返回 401 未授权，可能是 Cookie 失效或部署服务器 IP 与元宝登录 IP 不一致（元宝对话接口有 IP 风控）');
        }
        // uskey 会话异常时下次重建
        if (/x-uskey|Qimei|Playwright|webpackRequire|h38/i.test(err.message || '')) {
            await closeUskeySession();
        }
        throw err;
    } finally {
        // Step 4: 无论成败都清理会话
        if (chatId) {
            await clearConversation(cookie, chatId);
        }
    }
}

/**
 * 端到端总结：直接使用已抓取网页内容进行元宝总结
 *
 * @param {string} content 已抓取的网页正文
 * @param {string} cookie 腾讯元宝 Web 端 Cookie
 * @param {object} [options]
 * @param {function(string): void} [options.onChunk] SSE 增量回调
 * @param {number} [options.timeout=120000] 对话接口超时毫秒
 * @returns {Promise<string>} 元宝总结的完整文本
 */
export async function summarizeContent(content, cookie, options = {}) {
    if (!cookie) {
        throw new Error('未配置腾讯元宝 Cookie，请联系管理员设置（#设置视频号Cookie）');
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
        throw new Error('请提供有效的网页内容');
    }
    const normalizedContent = content.trim();

    let chatId = '';
    try {
        const model = resolveYuanbaoModel(options.model);
        chatId = await createConversation(cookie);
        await initConversationModel(cookie, chatId, model);
        const summary = await chatSummarize(cookie, chatId, normalizedContent, {
            ...options,
            isContent: true,
            model,
        });
        logger.info(`[R插件][链接总结][元宝] 内容总结成功，文本长度: ${summary.length}`);
        return summary;
    } catch (err) {
        const status = err?.response?.status;
        if (status === 401) {
            throw new Error('元宝对话接口返回 401 未授权，可能是 Cookie 失效或部署服务器 IP 与元宝登录 IP 不一致（元宝对话接口有 IP 风控）');
        }
        if (/x-uskey|Qimei|Playwright|webpackRequire|h38/i.test(err.message || '')) {
            await closeUskeySession();
        }
        throw err;
    } finally {
        if (chatId) {
            await clearConversation(cookie, chatId);
        }
    }
}

/**
 * 兼容旧接口：保留原有微信文章命名，内部复用通用链接总结。
 *
 * @param {string} articleUrl 微信文章 URL
 * @param {string} cookie 腾讯元宝 Web 端 Cookie（与视频号解析共用）
 * @param {object} [options]
 * @returns {Promise<string>} 元宝总结的完整文本
 */
export async function summarizeArticle(articleUrl, cookie, options = {}) {
    return summarizeLink(articleUrl, cookie, options);
}
