// 小本子（notebook）的存储层：按人 / 按会话的"流水账"。
//
// 与 src/memory/ 下"提炼印象"的分工：
//   - 印象是**结论**（他是什么样的人），由 consolidation 定期改写，会被覆盖；
//   - 小本子是**事实**（哪天聊了什么、答应过什么、自己发过哪条说说），只追加、可检索。
//
// 为什么单独一个 SQLite 文件：
//   1. 写入节奏与保留期都和印象不同（印象按 6 小时整理，小本子每次会话收尾就落一条）；
//   2. 项目口径是"只有 messages.sqlite 用 WAL，其余库走默认 delete journal"——
//      独立库才能保证 manage.sh backup 的整目录拷贝拿到一致快照（见 core/sqlite.js 注释）；
//   3. 以后换记忆内核（Letta/mem0，甚至换掉 agent）时，这一份库可以整体搬走，
//      不依赖任何运行时状态。
//
// 可见性策略不在这里做：本层只负责"存/取"，哪些条目能给当前会话看由 notebook.js 判。
// 这样以后要加"跨设备同步""按人导出"都不用改存储。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { openDatabase } from '../core/sqlite.js';

// topic = 素材池条目（B 站视频等），带 URL 与过期时间，由素材抓取器写入、暖场/私聊读取。
export const NOTEBOOK_KINDS = ['chat', 'memo', 'self_post', 'self_said', 'topic'];

// group_concat 的分隔符必须用不可能出现在正文里的控制字符：
// 用 ';' 或 '|' 时，群友名字/正文里带一个就会把解析搞崩。
const SEP_FIELD = String.fromCharCode(31);
const SEP_ITEM = String.fromCharCode(30);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    chat_key TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    ref TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    importance INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL DEFAULT 0
  );
  -- ref 是幂等键：同一条说说/同一次会话重复写入时靠它去重（空串不参与唯一约束）
  CREATE UNIQUE INDEX IF NOT EXISTS notes_ref ON notes(ref) WHERE ref <> '';
  CREATE INDEX IF NOT EXISTS notes_ts ON notes(ts DESC);
  CREATE INDEX IF NOT EXISTS notes_chat ON notes(chat_key, ts DESC);
  CREATE INDEX IF NOT EXISTS notes_kind ON notes(kind, ts DESC);
  CREATE TABLE IF NOT EXISTS note_people (
    note_id INTEGER NOT NULL,
    person_id TEXT NOT NULL,
    person_name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (note_id, person_id),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS note_people_person ON note_people(person_id, note_id DESC);
`;

function parsePeople(raw) {
  if (!raw) return [];
  const out = [];
  for (const item of String(raw).split(SEP_ITEM)) {
    const [id, name = ''] = item.split(SEP_FIELD);
    if (!id) continue;
    out.push({ id, name: name || '' });
  }
  return out;
}

function rowToNote(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    kind: String(row.kind),
    chatKey: String(row.chat_key || ''),
    body: String(row.body || ''),
    topic: String(row.topic || ''),
    ref: String(row.ref || ''),
    source: String(row.source || ''),
    importance: Number(row.importance) || 1,
    expiresAt: Number(row.expires_at) || 0,
    people: parsePeople(row.people_raw)
  };
}

export class NotebookStore {
  constructor({ dataDir = DATA_DIR, filename = null } = {}) {
    this.filename = filename || path.join(dataDir, 'notebook.sqlite');
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = openDatabase(this.filename);
    // 小本子正文与人物关系都是隐私：与 memory/identity 库同一口径（0600）。
    try { fs.chmodSync(this.filename, 0o600); } catch { /* best effort */ }
    this.db.exec(SCHEMA);
  }

  /**
   * 追加一条记录。
   * ref 有值时按它幂等（重复写入返回 inserted:false，不产生重复行）；
   * people 是 [{ id, name }]，用来支持"按人翻本子"。
   */
  add({
    ts = Date.now(),
    kind = 'chat',
    chatKey = '',
    body = '',
    topic = '',
    ref = '',
    source = '',
    importance = 1,
    expiresAt = 0,
    people = []
  } = {}) {
    const text = String(body ?? '').trim();
    if (!text) return null;
    if (!NOTEBOOK_KINDS.includes(kind)) throw new Error(`未知的小本子类型：${kind}`);
    const at = Number(ts) || Date.now();
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO notes (ts, kind, chat_key, body, topic, ref, source, importance, expires_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      at, kind, String(chatKey || ''), text, String(topic || ''), String(ref || ''),
      String(source || ''), Math.max(0, Number(importance) || 0), Math.max(0, Number(expiresAt) || 0)
    );
    if (!Number(result.changes)) {
      // 命中去重：把已有那条找回来，调用方才能知道"早记过了"以及它的 id。
      const existing = ref
        ? this.db.prepare('SELECT id FROM notes WHERE ref = ?').get(String(ref))
        : null;
      return { id: existing ? Number(existing.id) : null, inserted: false };
    }
    const id = Number(result.lastInsertRowid);
    const insertPerson = this.db.prepare(
      'INSERT OR REPLACE INTO note_people (note_id, person_id, person_name) VALUES (?, ?, ?)'
    );
    const seen = new Set();
    for (const person of Array.isArray(people) ? people : []) {
      const pid = String(person?.id ?? person ?? '').trim();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      insertPerson.run(id, pid, String(person?.name ?? '').slice(0, 60));
    }
    return { id, inserted: true };
  }

  /** 通用查询：按类型 / 会话 / 人物 / 时间 / 关键词过滤，按时间倒序。 */
  query({ kinds = null, chatKey = '', personId = '', since = 0, until = 0, q = '', limit = 20 } = {}) {
    const where = [];
    const params = [];
    let from = 'FROM notes n';
    if (personId) {
      from += ' JOIN note_people np ON np.note_id = n.id';
      where.push('np.person_id = ?');
      params.push(String(personId));
    }
    if (Array.isArray(kinds) && kinds.length) {
      where.push(`n.kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds.map(String));
    }
    if (chatKey) { where.push('n.chat_key = ?'); params.push(String(chatKey)); }
    if (Number(since) > 0) { where.push('n.ts >= ?'); params.push(Number(since)); }
    if (Number(until) > 0) { where.push('n.ts <= ?'); params.push(Number(until)); }
    const keyword = String(q || '').trim();
    if (keyword) {
      where.push('(n.body LIKE ? OR n.topic LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like);
    }
    const cap = Math.min(200, Math.max(1, Number(limit) || 20));
    const sql = 'SELECT n.*, (SELECT group_concat(np.person_id || char(31) || np.person_name, char(30))'
      + ` FROM note_people np WHERE np.note_id = n.id) AS people_raw ${from}`
      + `${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
      + ' ORDER BY n.ts DESC, n.id DESC LIMIT ?';
    params.push(cap);
    return this.db.prepare(sql).all(...params).map(rowToNote);
  }

  count({ kinds = null, chatKey = '', personId = '' } = {}) {
    const where = [];
    const params = [];
    let from = 'FROM notes n';
    if (personId) {
      from += ' JOIN note_people np ON np.note_id = n.id';
      where.push('np.person_id = ?');
      params.push(String(personId));
    }
    if (Array.isArray(kinds) && kinds.length) {
      where.push(`n.kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds.map(String));
    }
    if (chatKey) { where.push('n.chat_key = ?'); params.push(String(chatKey)); }
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
    ).get(...params);
    return Number(row?.n) || 0;
  }

  deleteById(id) {
    const result = this.db.prepare('DELETE FROM notes WHERE id = ?').run(Number(id) || 0);
    return Number(result.changes) > 0;
  }

  /**
   * 素材池回收：删掉已过期的 topic，再把超出上限的最旧条目挤掉。
   * 只作用于 kind='topic'，不碰流水/记事——那些有自己的保留期（prune）。
   */
  pruneMaterials({ kind = 'topic', now = Date.now(), maxItems = 30 } = {}) {
    let removed = Number(this.db.prepare(
      'DELETE FROM notes WHERE kind = ? AND expires_at > 0 AND expires_at <= ?'
    ).run(String(kind), Number(now) || Date.now()).changes) || 0;
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE kind = ?').get(String(kind))?.n) || 0;
    const cap = Math.max(1, Number(maxItems) || 30);
    if (count > cap) {
      removed += Number(this.db.prepare(
        'DELETE FROM notes WHERE id IN (SELECT id FROM notes WHERE kind = ? ORDER BY ts ASC, id ASC LIMIT ?)'
      ).run(String(kind), count - cap).changes) || 0;
    }
    return removed;
  }

  /**
   * 保留期 / 容量双重回收。返回被删掉的条数。
   * 用 ts 升序删超出容量的部分：宁可留下最近的，也不让一张老库把磁盘吃满。
   */
  prune({ now = Date.now(), retentionDays = 365, maxRows = 20000 } = {}) {
    const days = Math.max(1, Number(retentionDays) || 365);
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let removed = Number(this.db.prepare('DELETE FROM notes WHERE ts < ?').run(cutoff).changes) || 0;
    const total = this.count();
    const cap = Math.max(1, Number(maxRows) || 20000);
    if (total > cap) {
      const excess = Math.min(100000, total - cap);
      removed += Number(this.db.prepare(
        `DELETE FROM notes WHERE id IN (SELECT id FROM notes ORDER BY ts ASC, id ASC LIMIT ${excess})`
      ).run().changes) || 0;
    }
    return removed;
  }

  stats() {
    const byKind = {};
    for (const row of this.db.prepare('SELECT kind, COUNT(*) AS n FROM notes GROUP BY kind').all()) {
      byKind[String(row.kind)] = Number(row.n) || 0;
    }
    const range = this.db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM notes').get();
    const people = this.db.prepare('SELECT COUNT(DISTINCT person_id) AS n FROM note_people').get();
    return {
      total: this.count(),
      kinds: byKind,
      people: Number(people?.n) || 0,
      firstAt: Number(range?.first) || 0,
      lastAt: Number(range?.last) || 0,
      file: this.filename
    };
  }

  /** 导出整本（换内核 / 迁移时用）：不夹带策略，纯数据。 */
  exportAll() {
    return this.db.prepare(
      'SELECT n.*, (SELECT group_concat(np.person_id || char(31) || np.person_name, char(30))'
      + ' FROM note_people np WHERE np.note_id = n.id) AS people_raw FROM notes n ORDER BY n.ts ASC, n.id ASC'
    ).all().map(rowToNote);
  }

  close() {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }
}
