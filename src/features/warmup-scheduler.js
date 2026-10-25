// 暖场调度：从素材池里挑东西，在群里挑话题、在私聊分享或单纯找人说说话。
//
// 三种行为（互不干扰）：
//   1) 群话题：指定群安静够久、且当天次数没用完 → 从素材里挑一条，让她自然带出来
//   2) 私聊分享：素材新鲜 → 分享（复用 owner-ping 的定时器，不另起一套）
//   3) 私聊搭话：没素材但很久没聊 → 只发一句"在干嘛"，一天有上限
//
// 设计约束：
//   - 群话题只认白名单（material.groupWhitelist），默认空 = 完全不开；
//   - 每群独立计数，落盘（重启不清零），避免重启后连环开话题；
//   - 冷场判定用 store.recent 的最后一条消息时间，不依赖会话线程状态；
//   - 所有开口都走 orchestrator.scheduleInitiativeWake，复用既有的静默时段/忙碌重试。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { materialConfig } from './material-pool.js';

export function warmupConfig(cfg = getConfig()) {
  const raw = cfg?.material || {};
  const int = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    ...materialConfig(cfg),
    groupWhitelist: Array.isArray(raw.groupWhitelist)
      ? raw.groupWhitelist.map((v) => String(v).replace(/^group:/, '').trim()).filter((v) => /^\d+$/.test(v))
      : [],
    groupIdleMinutes: int(raw.groupIdleMinutes, 10, 480, 45),
    groupMaxPerDay: int(raw.groupMaxPerDay, 1, 12, 2),
    groupMinGapHours: int(raw.groupMinGapHours, 1, 24, 3),
    privateChatEnabled: raw.privateChatEnabled !== false,
    privateMaxPerDay: int(raw.privateMaxPerDay, 1, 10, 2),
    privateIdleHours: int(raw.privateIdleHours, 1, 48, 3)
  };
}

const STATE_FILE = () => path.join(DATA_DIR, 'material-state.json');

export function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeState(state) {
  try {
    const file = STATE_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* 状态写不进去不影响主流程，只是计数会松一点 */ }
}

/** 对外暴露的原子写（运行器记完计数后调用）。 */
export function writeStateSafe(state) {
  writeState(state);
}

const todayKey = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

/**
 * 群话题是否该开：白名单 + 当天计数 + 最小间隔 + 冷场时长，四个都满足才开。
 * 返回 { ok, reason }，reason 进日志（排查"为什么没开话题"时不用猜）。
 */
export function groupTopicPlan({ groupId, now = Date.now(), lastMessageAt = 0, state = {}, config = warmupConfig() } = {}) {
  const id = String(groupId);
  if (!config.groupWhitelist.includes(id)) return { ok: false, reason: 'not-whitelisted' };
  const day = todayKey(now);
  const bucket = state.groups?.[id];
  if (bucket?.day === day && Number(bucket.count) >= config.groupMaxPerDay) return { ok: false, reason: 'daily-limit' };
  if (bucket?.lastAt && now - Number(bucket.lastAt) < config.groupMinGapHours * 3600000) {
    return { ok: false, reason: 'min-gap' };
  }
  const idleMs = config.groupIdleMinutes * 60000;
  if (!lastMessageAt || now - Number(lastMessageAt) < idleMs) return { ok: false, reason: 'not-idle' };
  return { ok: true, reason: '' };
}

export function markGroupTopic({ groupId, now = Date.now(), state = {} } = {}) {
  const id = String(groupId);
  const day = todayKey(now);
  const next = { ...state, groups: { ...(state.groups || {}) } };
  const bucket = next.groups[id];
  next.groups[id] = {
    day,
    count: (bucket?.day === day ? Number(bucket.count) || 0 : 0) + 1,
    lastAt: now
  };
  return next;
}

export function privateChatPlan({ now = Date.now(), lastMessageAt = 0, state = {}, config = warmupConfig() } = {}) {
  if (!config.privateChatEnabled) return { ok: false, reason: 'disabled' };
  const day = todayKey(now);
  const bucket = state.private;
  if (bucket?.day === day && Number(bucket.count) >= config.privateMaxPerDay) return { ok: false, reason: 'daily-limit' };
  if (!lastMessageAt || now - Number(lastMessageAt) < config.privateIdleHours * 3600000) {
    return { ok: false, reason: 'not-idle' };
  }
  return { ok: true, reason: '' };
}

export function markPrivateChat({ now = Date.now(), state = {} } = {}) {
  const day = todayKey(now);
  const bucket = state.private;
  return {
    ...state,
    private: { day, count: (bucket?.day === day ? Number(bucket.count) || 0 : 0) + 1, lastAt: now }
  };
}

/**
 * 把素材条目渲染成给模型看的一行：标题 + 分区 + UP + 播放 + 链接。
 * 链接必须带上——她要能把卡片/链接发出去。
 */
export function describeMaterial(note) {
  if (!note) return '';
  const bvid = String(note.topic || '').trim();
  const url = bvid ? `https://www.bilibili.com/video/${bvid}` : '';
  return `${note.body}${url ? `｜${url}` : ''}`;
}

/** 从素材池里挑一条：优先没被用过的（usedRefs 由调用方维护）。 */
export function pickMaterial(notes = [], usedRefs = new Set()) {
  const fresh = notes.filter((n) => n?.topic && !usedRefs.has(n.topic));
  return fresh[0] || notes[0] || null;
}
