// 小本子的门面：写入口、读出口、可见性与提示词格式化。
//
// 设计取舍（2026-10-23）：
//   1. **零额外模型调用**：会话流水直接由已经产出的 handoff（话题/摘要/本轮回复）落一条，
//      不再单独叫一次模型做抽取 —— 这个实例一天几十次运行，多一次调用就是白花钱。
//   2. **跨会话靠"记事"，不靠"搬原文"**：`chat` 只在本会话可见；想让别处也知道的事，
//      必须走 `memo`（模型显式记的一条）。这样既满足"记得跟谁聊过啥"，
//      又不会把 A 群的原文漏到 B 群去。
//   3. **说说自动同步**：不挂在发布流程里（那会给发布加失败点），而是读 daily-moments.json
//      的已发布记录按 tid 幂等落库；发布失败/回滚都不会让本子出现幽灵说说。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';
import { safeSlice, sanitizeUserText, todayKey } from '../core/util.js';
import { cappedByTokenSaver, tokenSaverCapsOf } from '../core/token-saver.js';
import { memoryVisibilityOf } from '../core/memory-visibility.js';
import { NotebookStore } from './notebook-store.js';

const SELF_POST_SYNC_MIN_MS = 5 * 60 * 1000;
const MEMO_MAX_CHARS = 400;

function intIn(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 小本子的运行期配置。坏值一律夹回安全区，不让手改配置把注入撑爆。 */
export function notebookConfig(cfg = getConfig()) {
  const raw = cfg?.memory?.notebook || {};
  return {
    enabled: raw.enabled !== false,
    perPerson: intIn(raw.perPerson, 1, 5, 2),
    recentChat: intIn(raw.recentChat, 0, 8, 3),
    selfPosts: intIn(raw.selfPosts, 0, 5, 2),
    promptMaxChars: intIn(raw.promptMaxChars, 300, 6000, 1200),
    retentionDays: intIn(raw.retentionDays, 7, 3650, 365),
    maxRows: intIn(raw.maxRows, 500, 200000, 20000),
    selfPostSync: raw.selfPostSync !== false
  };
}

/** 与 memory-global 同一个日期口径：今年省年份，往年必须带年份。 */
export function notebookStamp(ts, now = Date.now()) {
  const raw = Number(ts);
  if (!Number.isFinite(raw) || raw <= 0) return '日期未知';
  const key = todayKey(raw);
  const thisYear = todayKey(now).slice(0, 4);
  return key.startsWith(thisYear) ? key.slice(5) : key;
}

/**
 * 某条记录能不能给这个会话看。
 * - self_post：公开内容（说说），哪都能看；
 * - chat / self_said：跨会话可见（这是"跟谁聊过啥"的流水，是她自己的记忆），
 *   但尊重 memory.visibility 的两条策略：perChat 只在本会话；hidePrivateInGroup 时私聊流水不进群；
 * - memo：默认跨会话可见（这正是"记事"的意义），同样尊重两条策略；
 * - 未知类型一律不可见（fail closed）。
 */
export function notebookVisible(note, chatKey = '', vis = null) {
  if (!note) return false;
  const policy = vis || memoryVisibilityOf(getConfig());
  const kind = String(note.kind || '');
  const own = String(note.chatKey || '');
  if (kind === 'self_post') return true;
  if (kind === 'chat' || kind === 'self_said') {
    if (policy.mode === 'perChat') return own === String(chatKey || '');
    if (policy.hidePrivateInGroup
      && String(chatKey || '').startsWith('group:')
      && own.startsWith('private:')) return false;
    return true;
  }
  if (kind === 'memo') {
    if (policy.mode === 'perChat' && own && own !== String(chatKey || '')) return false;
    if (policy.hidePrivateInGroup
      && String(chatKey || '').startsWith('group:')
      && own.startsWith('private:')) return false;
    return true;
  }
  return false;
}

function oneLine(value, max = 300) {
  return safeSlice(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

export class Notebook {
  #lastSelfSyncAt = 0;

  constructor({ store = null, dataDir = DATA_DIR, now = Date.now } = {}) {
    this.dataDir = dataDir;
    this.store = store || new NotebookStore({ dataDir });
    this.now = now;
  }

  get enabled() {
    return notebookConfig().enabled;
  }

  /** 模型显式记的一条（工具 notebook_write 的后端）。同一人同一天同内容不重复记。 */
  remember({
    chatKey = '',
    personId = '',
    personName = '',
    text = '',
    kind = 'memo',
    source = 'model'
  } = {}) {
    const body = safeSlice(sanitizeUserText(String(text || '').replace(/\s+/g, ' ').trim()), MEMO_MAX_CHARS);
    if (!body) return null;
    const pid = String(personId || '').trim();
    if (pid && !/^\d{1,15}$/.test(pid)) return null;
    const wanted = kind === 'self_said' ? 'self_said' : 'memo';
    // 去重键带日期：同一天重复说同一件事只记一次，换一天再说则是新事实。
    const day = todayKey(this.now());
    return this.store.add({
      ts: this.now(),
      kind: wanted,
      chatKey,
      body,
      ref: `${wanted}:${pid || chatKey}:${day}:${hashText(body)}`,
      source,
      importance: 2,
      people: pid ? [{ id: pid, name: personName }] : []
    });
  }

  /** 会话收尾：把 handoff 里已经有的东西落成一条流水，不额外叫模型。 */
  recordSession({
    chatKey = '',
    sessionId = '',
    topic = '',
    summary = '',
    reply = '',
    participants = []
  } = {}) {
    if (!chatKey || !sessionId) return null;
    const parts = [];
    const body = oneLine(sanitizeUserText(summary), 600);
    if (body) parts.push(body);
    const mine = oneLine(sanitizeUserText(reply), 300);
    if (mine) parts.push(`我回：${mine}`);
    if (!parts.length) return null;
    return this.store.add({
      ts: this.now(),
      kind: 'chat',
      chatKey,
      body: parts.join('\n'),
      topic: oneLine(topic, 120),
      ref: `session:${sessionId}`,
      source: 'session',
      people: Array.isArray(participants) ? participants : []
    });
  }

  /**
   * 把 daily-moments 里"已发布"的说说同步进本子（按 tid 幂等）。
   * 读文件失败一律当作没有，不影响聊天主流程。
   */
  syncSelfPosts({ now = this.now(), force = false } = {}) {
    if (!notebookConfig().selfPostSync) return 0;
    if (!force && now - this.#lastSelfSyncAt < SELF_POST_SYNC_MIN_MS) return 0;
    this.#lastSelfSyncAt = now;
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'daily-moments.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch { return 0; }
    const records = Array.isArray(state?.records) ? state.records : [];
    let added = 0;
    for (const record of records) {
      if (record?.status !== 'published' || !record?.tid || !record?.content) continue;
      const body = oneLine(sanitizeUserText(record.content), 300);
      if (!body) continue;
      const result = this.store.add({
        ts: Number(record.publishedAt) || Number(record.endedAt) || now,
        kind: 'self_post',
        chatKey: 'system:daily-moments',
        body,
        topic: oneLine(record.dayKey, 40),
        ref: `qzone:${record.tid}`,
        source: 'qzone'
      });
      if (result?.inserted) added += 1;
    }
    return added;
  }

  /**
   * 组装【小本子】块。
   * 顺序按"这次用得上"排：眼前的人 → 本会话最近 → 自己最近的说说。
   * 每段都可能为空，整块为空时返回 ''（不留空段头占 token）。
   */
  formatForPrompt(chatKey = '', { personIds = [], now = this.now() } = {}) {
    const cfg = getConfig();
    const conf = notebookConfig(cfg);
    if (!conf.enabled) return '';
    try { this.syncSelfPosts({ now }); } catch { /* 同步失败不影响注入 */ }

    const vis = memoryVisibilityOf(cfg);
    const memberNotes = cfg.memberNotes || {};
    const cap = cappedByTokenSaver(conf.promptMaxChars, tokenSaverCapsOf(cfg)?.memoryBlockChars) || conf.promptMaxChars;
    const lines = [];
    let used = 0;
    const push = (line) => {
      const cost = line.length + 1;
      if (used + cost > cap) return false;
      lines.push(line);
      used += cost;
      return true;
    };

    // ① 眼前的人：只取 memo（模型判断"值得记"的），每人最多 perPerson 条
    const ids = [...new Set((personIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 8);
    const personLines = [];
    for (const id of ids) {
      const rows = this.store.query({ kinds: ['memo'], personId: id, limit: conf.perPerson })
        .filter((note) => notebookVisible(note, chatKey, vis));
      if (!rows.length) continue;
      const name = oneLine(memberNotes[id] || rows[0]?.people.find((p) => p.id === id)?.name || id, 40);
      const items = rows.slice(0, conf.perPerson)
        .map((note) => `[${notebookStamp(note.ts, now)}] ${oneLine(note.body, 120)}`)
        .join('；');
      personLines.push(`- ${name}（QQ ${id}）：${items}`);
    }
    if (personLines.length) {
      if (!push('关于眼前这些人（你自己记的）：')) return '';
      for (const line of personLines) if (!push(line)) break;
    }

    // ② 最近跟人聊过什么（含别处，不标来源会话名；跨会话的原文不搬，只留摘要）
    if (conf.recentChat > 0) {
      const rows = this.store.query({ kinds: ['chat'], limit: conf.recentChat * 3 })
        .filter((note) => notebookVisible(note, chatKey, vis))
        .slice(0, conf.recentChat);
      if (rows.length) {
        if (!push('你最近跟人聊过的（别处的内容不要说给这里的人听）：')) return lines.join('\n');
        for (const note of rows) {
          const topic = note.topic ? `（${oneLine(note.topic, 40)}）` : '';
          if (!push(`- [${notebookStamp(note.ts, now)}]${topic} ${oneLine(note.body, 160)}`)) break;
        }
      }
    }

    // ③ 自己最近发过的说说
    if (conf.selfPosts > 0) {
      const rows = this.store.query({ kinds: ['self_post'], limit: conf.selfPosts });
      if (rows.length) {
        if (!push('你自己最近发过的说说：')) return lines.join('\n');
        for (const note of rows) {
          if (!push(`- [${notebookStamp(note.ts, now)}] ${oneLine(note.body, 120)}`)) break;
        }
      }
    }

    if (!lines.length) return '';
    return [
      '【小本子】你自己记下的旧事（不是群友的新消息）：',
      '可以自然提起，但别逐条复述、别当成"刚刚发生"；别把别处的内容说给这里的人听。',
      ...lines
    ].join('\n');
  }

  /**
   * 工具 notebook_search 的后端：按人/关键词/时间翻本子。
   * 返回的每条都过一遍可见性，且不带 chatKey（不向模型暴露"这条来自哪个群"）。
   */
  search({ query = '', personId = '', chatKey = '', days = 30, limit = 10 } = {}) {
    const cfg = getConfig();
    const conf = notebookConfig(cfg);
    if (!conf.enabled) return { notes: [], note: '小本子当前关闭' };
    const span = Math.max(0, Number(days) || 0);
    const since = span > 0 ? this.now() - span * 24 * 60 * 60 * 1000 : 0;
    const rows = this.store.query({
      q: String(query || ''),
      personId: String(personId || ''),
      since,
      limit: Math.min(120, Math.max(3, (Number(limit) || 10) * 4))
    });
    const vis = memoryVisibilityOf(cfg);
    const picked = rows.filter((note) => notebookVisible(note, chatKey, vis)).slice(0, Math.min(50, Math.max(1, Number(limit) || 10)));
    return {
      notes: picked.map((note) => ({
        when: notebookStamp(note.ts, this.now()),
        kind: note.kind,
        text: oneLine(note.body, 300),
        people: note.people.map((p) => p.name || p.id).filter(Boolean)
      })),
      note: picked.length ? `共 ${picked.length} 条` : '本子里没有匹配的记录'
    };
  }

  stats() {
    return this.store.stats();
  }

  exportAll() {
    return this.store.exportAll();
  }

  prune() {
    const conf = notebookConfig();
    return this.store.prune({ now: this.now(), retentionDays: conf.retentionDays, maxRows: conf.maxRows });
  }
}
