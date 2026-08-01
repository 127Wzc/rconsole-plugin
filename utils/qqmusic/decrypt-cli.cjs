/**
 * QQ 音乐 musics.fcg 响应密文解密 CLI（CommonJS）
 *
 * 从 stdin 读取一行 base64（响应字节的 base64），用同目录 jiemi.js
 * 的全局 encrypt(byteBuffer) 解密，把明文 JSON 输出到 stdout。
 *
 * 用法：`node utils/qqmusic/decrypt-cli.cjs < local-response.b64`
 *
 * 注意：
 * - 本脚本由 utils/qqmusic.js 通过 child_process.spawn 隔离调用，
 *   不要在宿主进程 eval jiemi.js（它会改写 global.crypto / window）。
 * - jiemi.js 的 encrypt 函数名有误导性，实为解密。
 */
const fs = require("fs");
const path = require("path");

const INPUT_TIMEOUT_MS = 20000;

let input = "";
process.stdin.setEncoding("utf8");

function fail(err) {
    process.stderr.write(String((err && err.stack) || err));
    process.exit(1);
}

const timer = setTimeout(() => {
    fail(new Error(`decrypt-cli: stdin 读取超时(${INPUT_TIMEOUT_MS}ms)`));
}, INPUT_TIMEOUT_MS);
timer.unref();

process.stdin.on("data", (chunk) => {
    input += chunk;
});

process.stdin.on("end", () => {
    try {
        // eslint-disable-next-line no-eval
        eval(fs.readFileSync(path.join(__dirname, "jiemi.js"), "utf8"));
        if (typeof encrypt !== "function") {
            throw new Error("jiemi.js 未定义全局 encrypt(byteArray)");
        }
        const b64 = input.replace(/\s+/g, "");
        if (!b64) {
            throw new Error("stdin 为空，未收到 base64 密文");
        }
        const result = encrypt(Buffer.from(b64, "base64"));
        process.stdout.write(JSON.stringify(result));
    } catch (err) {
        fail(err);
    }
});

process.stdin.on("error", fail);
