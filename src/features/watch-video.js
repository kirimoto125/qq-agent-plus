// 看视频：把 B 站视频的音频下载下来、本地 whisper 转成文字，再交给模型。
//
// 为什么是独立进程调 Python：whisper 是 Python 生态，硬塞进 Node 进程要跑子进程管理；
// 独立脚本更容易限时、限并发、失败隔离（转写崩了不影响聊天主流程）。
//
// 约束：
//   - 只处理 B 站（BV 号 / 视频链接）；其它站点 yt-dlp 也能下，但先不做承诺；
//   - 时长上限（默认 20 分钟）：再长就逐字看完的成本不划算，直接拒绝并说明；
//   - 单飞：同一时间只转一条（4 核机器上 whisper 会吃满 CPU，并发会把聊天卡住）；
//   - 结果缓存 7 天：同一条视频不重复转写。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../core/config.js';

// 从本文件位置推脚本路径（src/features/ → 仓库根/scripts/），不依赖 DATA_DIR 的布局
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', '..', 'scripts', 'watch_video.py');
const CACHE_FILE = path.join(DATA_DIR, 'watch-cache.json');
const MAX_SECONDS = 1200;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

let running = null;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeCache(cache) {
  try {
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* 缓存写不进去不影响本次结果 */ }
}

export function watchCacheGet(bvid, now = Date.now()) {
  const cache = readCache();
  const hit = cache[bvid];
  if (!hit || !hit.text) return null;
  if (now - Number(hit.at || 0) > CACHE_TTL_MS) return null;
  return hit;
}

export function watchCacheSet(bvid, payload, now = Date.now()) {
  const cache = readCache();
  cache[bvid] = { ...payload, at: now };
  // 最多留 50 条：转写结果一条几千字，攒太多会把 JSON 撑大
  const keys = Object.keys(cache);
  if (keys.length > 50) {
    keys.sort((a, b) => Number(cache[a].at || 0) - Number(cache[b].at || 0));
    for (const key of keys.slice(0, keys.length - 50)) delete cache[key];
  }
  writeCache(cache);
}

/** 跑一次 watch_video.py；同时间只允许一个。 */
export function watchVideo(target, { timeoutMs = 300000 } = {}) {
  if (running) return running.then(() => watchVideo(target, { timeoutMs })).catch(() => watchVideo(target, { timeoutMs }));
  running = new Promise((resolve, reject) => {
    execFile('python3', [SCRIPT, String(target), '--max-seconds', String(MAX_SECONDS)], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1' }
    }, (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error((stderr || error.message || '转写失败').slice(0, 400)));
        return;
      }
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
      } catch (parseError) {
        reject(new Error(`转写输出解析失败：${String(stdout).slice(0, 200)}`));
      }
    });
  }).finally(() => { running = null; });
  return running;
}

/** 给模型看的文本：太长就截断，并标出这是"转写"不是画面。 */
export function formatTranscript(result, { limit = 6000 } = {}) {
  if (!result?.ok) return '';
  const text = String(result.text || '');
  const head = `《${result.title || result.bvid}》（${Math.round((result.durationSec || 0) / 60)} 分钟，语音转写，可能有个别错字或语气词）`;
  const body = text.length > limit ? `${text.slice(0, limit)}…（后面还有，已截断）` : text;
  return `${head}\n${body}`;
}
