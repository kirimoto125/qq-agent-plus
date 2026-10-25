// 素材抓取：定期从 B 站热门/搜索捞「可能有话聊」的视频，存进小本子的 topic 条目。
//
// 为什么零 token：这一步只发 HTTP、把标题/封面/bvid 存下来，不叫模型。
// 判断「这条值不值得说」留到真正开口那一刻（模型看得到素材本的 top 几条）。
//
// 过期与上限：素材有保鲜期（默认 12 小时）——不然三天前的话题会被当成"刚看到"；
// 池子上限（默认 30）防止无限堆积。两者都在回收时生效（读的时候顺带清）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config.js';
import { sanitizeUserText, safeSlice } from '../core/util.js';

const BILIBILI_POPULAR = 'https://api.bilibili.com/x/web-interface/popular?ps=%d&pn=1';
const BILIBILI_SEARCH = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=%s&page=1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function materialConfig(cfg = getConfig()) {
  const raw = cfg?.material || {};
  const int = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: raw.enabled !== false,
    refreshMinMinutes: int(raw.refreshMinMinutes, 30, 360, 60),
    refreshMaxMinutes: Math.max(
      int(raw.refreshMinMinutes, 30, 360, 60),
      int(raw.refreshMaxMinutes, 30, 720, 90)
    ),
    ttlHours: int(raw.ttlHours, 1, 72, 12),
    maxItems: int(raw.maxItems, 5, 100, 30),
    perRun: int(raw.perRun, 1, 10, 3),
    quietStart: /^\d{1,2}:\d{2}$/.test(String(raw.quietStart || '')) ? raw.quietStart : '23:30',
    quietEnd: /^\d{1,2}:\d{2}$/.test(String(raw.quietEnd || '')) ? raw.quietEnd : '08:30',
    keywords: Array.isArray(raw.keywords) && raw.keywords.length
      ? raw.keywords.map((k) => String(k).slice(0, 20)).slice(0, 6)
      : ['游戏', '单机游戏', '电竞']
  };
}

function fmtCount(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function toItem(v) {
  const bvid = String(v?.bvid || '');
  const title = sanitizeUserText(String(v?.title || '').replace(/<[^>]+>/g, '')).trim();
  if (!bvid || !title) return null;
  return {
    title: safeSlice(title, 80),
    zone: sanitizeUserText(String(v?.tname || '')),
    author: sanitizeUserText(String(v?.owner?.name || v?.author || '')),
    play: fmtCount(v?.stat?.view ?? v?.play),
    like: fmtCount(v?.stat?.like ?? v?.like),
    bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    // 封面走 https 并去掉尺寸后缀（接口默认给的是带 @ 参数的缩略图，去掉拿原图）
    cover: String(v?.pic || '').replace(/^http:/, 'https:').replace(/@[^/]*$/, '')
  };
}

async function fetchJson(url, signal) {
  const timeout = AbortSignal.timeout(15000);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (Number(data?.code) !== 0) throw new Error(`B站接口 ${data?.code}：${data?.message || ''}`);
  return data;
}

/** 抓一批候选（不写库）。返回 [{title, zone, author, play, like, bvid, url, cover}]。 */
export async function fetchCandidates({ keywords = [], perRun = 3, signal } = {}) {
  const out = [];
  try {
    const data = await fetchJson(BILIBILI_POPULAR.replace('%d', String(Math.max(perRun, 3))), signal);
    for (const v of (data?.data?.list || []).slice(0, perRun)) {
      const item = toItem(v);
      if (item) out.push(item);
    }
  } catch { /* 热门失败就靠搜索 */ }

  for (const keyword of keywords) {
    if (out.length >= perRun * 2) break;
    try {
      const data = await fetchJson(BILIBILI_SEARCH.replace('%s', encodeURIComponent(keyword)), signal);
      for (const v of (data?.data?.result || []).slice(0, 2)) {
        const item = toItem(v);
        if (item) out.push(item);
      }
    } catch { /* 单个关键词失败不影响其它 */ }
  }
  return out;
}

/**
 * 抓取并写入小本子（topic 条目）。返回 {added, skipped}。
 * 用 bvid 作为 ref 去重：同一个视频今天刷到多次只存一条。
 */
export async function refreshMaterials({ notebook, config = materialConfig(), now = Date.now(), signal } = {}) {
  if (!notebook?.store) return { added: 0, skipped: 'no-notebook' };
  if (!config.enabled) return { added: 0, skipped: 'disabled' };

  const items = await fetchCandidates({ keywords: config.keywords, perRun: config.perRun, signal });
  if (!items.length) return { added: 0, skipped: 'empty' };

  const expiresAt = now + config.ttlHours * 3600000;
  let added = 0;
  for (const item of items) {
    // 同一天同一视频只记一次：ref 带日期，跨天允许再次出现（当天热点隔天可能还在）
    const day = new Date(now).toISOString().slice(0, 10);
    const result = notebook.store.add({
      ts: now,
      kind: 'topic',
      chatKey: '',
      body: `${item.title}｜${item.zone}｜UP:${item.author}｜播放${item.play}`,
      topic: item.bvid,
      ref: `bili:${day}:${item.bvid}`,
      source: 'bilibili',
      importance: 2,
      expiresAt
    });
    if (result?.inserted) added += 1;
  }

  // 回收：过期条目 + 超出上限的最旧条目（只作用于 topic，不碰流水/记事）
  try {
    notebook.store.pruneMaterials?.({ now, maxItems: config.maxItems });
  } catch { /* 回收失败不影响本次写入 */ }

  return { added, fetched: items.length };
}

/** 读取可用素材（未过期、最新的在前）。 */
export function listMaterials({ notebook, limit = 8, now = Date.now() } = {}) {
  if (!notebook?.store) return [];
  try {
    return notebook.store.query({ kinds: ['topic'], limit })
      .filter((note) => !note.expiresAt || note.expiresAt > now);
  } catch { return []; }
}

/**
 * 素材服务：给工具（share_topic）与调度器共用的薄门面。
 * resolve 支持按 id 或按 url（从 topic 字段里的 bvid 反查），找不到返回 null。
 */
export class MaterialService {
  constructor({ notebook, now = Date.now } = {}) {
    this.notebook = notebook;
    this.now = now;
  }

  list(limit = 8) {
    return listMaterials({ notebook: this.notebook, limit, now: this.now() });
  }

  refresh({ signal } = {}) {
    return refreshMaterials({ notebook: this.notebook, now: this.now(), signal });
  }

  /** 把 note 转成工具能用的形状：{ id, title, url, cover, zone }。 */
  static toMaterial(note) {
    if (!note) return null;
    const bvid = String(note.topic || '').trim();
    const title = String(note.body || '').split('｜')[0] || '';
    // 封面不在 notes 表里：从抓取时写入的 body 末尾取不到，改为按 bvid 现查一次接口太重。
    // 这里返回 bvid + url，封面由 resolve 时按 bvid 记忆化补（见 #coverCache）。
    return {
      id: note.id,
      title,
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
      cover: '',
      bvid
    };
  }

  async resolve({ id, url } = {}) {
    const notes = this.list(200);
    let note = null;
    if (id !== undefined && id !== null && String(id).trim() !== '') {
      note = notes.find((n) => String(n.id) === String(id).trim()) || null;
    }
    if (!note && url) {
      const bvid = String(url).match(/BV[0-9A-Za-z]+/)?.[0] || '';
      note = notes.find((n) => String(n.topic || '') === bvid) || null;
    }
    if (!note) return null;
    const material = MaterialService.toMaterial(note);
    if (!material.cover && material.bvid) {
      material.cover = await this.#coverOf(material.bvid);
    }
    return material;
  }

  async #coverOf(bvid) {
    try {
      const data = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
      const pic = String(data?.data?.pic || '');
      return pic.replace(/^http:/, 'https:').replace(/@[^/]*$/, '');
    } catch { return ''; }
  }
}
