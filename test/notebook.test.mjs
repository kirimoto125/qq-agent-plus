// 小本子（notebook）单元测试。
//
// 覆盖四件事：
//   ① 存储层的幂等与按人检索（ref 去重、note_people 关联）；
//   ② 可见性矩阵（chat 只在本会话、memo 可跨会话、self_post 公开、两条 visibility 策略）；
//   ③ 提示词块：该带的带、不该带的（别的会话原文）不带；
//   ④ 说说同步：按 tid 幂等，重复同步不长行；保留期回收能删老记录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// config 在模块加载期就会读盘：先定数据目录再动态 import（与既有测试同一写法）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-notebook-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ runtime: { mode: 'active' } }));

const { Notebook, notebookVisible, notebookConfig } = await import('../src/memory/notebook.js');
const { NotebookStore } = await import('../src/memory/notebook-store.js');

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);   // 2026-10-23 20:00 CST

function makeNotebook(now = NOW) {
  return new Notebook({ dataDir, now: () => now });
}

test('store: ref 幂等、按人可查、删除与统计', () => {
  const store = new NotebookStore({ dataDir });
  try {
    const first = store.add({
      ts: NOW, kind: 'memo', chatKey: 'group:1', body: '他下周三考试',
      ref: 'memo:125:2026-10-23:abc', people: [{ id: '125', name: '老王' }]
    });
    assert.equal(first.inserted, true);
    const again = store.add({
      ts: NOW, kind: 'memo', chatKey: 'group:1', body: '他下周三考试',
      ref: 'memo:125:2026-10-23:abc', people: [{ id: '125', name: '老王' }]
    });
    assert.equal(again.inserted, false);
    assert.equal(store.count({ kinds: ['memo'] }), 1);

    const rows = store.query({ personId: '125' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, '他下周三考试');
    assert.deepEqual(rows[0].people, [{ id: '125', name: '老王' }]);

    // 按会话与关键词
    assert.equal(store.query({ chatKey: 'group:1' }).length, 1);
    assert.equal(store.query({ q: '考试' }).length, 1);
    assert.equal(store.query({ q: '不存在的词' }).length, 0);

    assert.equal(store.deleteById(rows[0].id), true);
    assert.equal(store.count(), 0);
  } finally {
    store.close();
  }
});

test('可见性：chat 隔离、memo 跨会话、self_post 公开、尊重两条策略', () => {
  const chat = { kind: 'chat', chatKey: 'group:1' };
  const memo = { kind: 'memo', chatKey: 'private:125' };
  const post = { kind: 'self_post', chatKey: 'system:daily-moments' };

  assert.equal(notebookVisible(chat, 'group:1', { mode: 'global', hidePrivateInGroup: false }), true);
  assert.equal(notebookVisible(chat, 'group:2', { mode: 'global', hidePrivateInGroup: false }), false);
  assert.equal(notebookVisible(memo, 'group:2', { mode: 'global', hidePrivateInGroup: false }), true);
  assert.equal(notebookVisible(memo, 'group:2', { mode: 'perChat', hidePrivateInGroup: false }), false);
  assert.equal(notebookVisible(memo, 'group:2', { mode: 'global', hidePrivateInGroup: true }), false);
  assert.equal(notebookVisible(memo, 'private:125', { mode: 'global', hidePrivateInGroup: true }), true);
  assert.equal(notebookVisible(post, 'group:9', { mode: 'perChat', hidePrivateInGroup: true }), true);
  assert.equal(notebookVisible({ kind: 'unknown', chatKey: '' }, 'group:1', { mode: 'global' }), false);
  assert.equal(notebookVisible(null, 'group:1', { mode: 'global' }), false);
});

test('formatForPrompt：本会话流水不外泄，记事与说说照带', () => {
  const notebook = makeNotebook();
  notebook.remember({ chatKey: 'group:1', personId: '125', personName: '老王', text: '他下周三考试，考完请客' });
  notebook.recordSession({
    chatKey: 'group:1', sessionId: 's1', topic: '考试',
    summary: '他说下周三考试，压力挺大', reply: '那你先别熬夜了',
    participants: [{ id: '125', name: '老王' }]
  });
  fs.writeFileSync(path.join(dataDir, 'daily-moments.json'), JSON.stringify({
    records: [{
      status: 'published', tid: 'm-1', dayKey: '2026-10-22',
      content: '今天试了家新面馆，一般', publishedAt: NOW - 86400000
    }, {
      status: 'publish-unknown', tid: '', content: '这条没发出去', publishedAt: NOW
    }]
  }));

  const inGroup = notebook.formatForPrompt('group:1', { personIds: ['125'], now: NOW });
  assert.match(inGroup, /【小本子】/);
  assert.match(inGroup, /老王（QQ 125）/);
  assert.match(inGroup, /下周三考试/);
  assert.match(inGroup, /这个会话最近聊过的/);
  assert.match(inGroup, /那你先别熬夜了/);
  assert.match(inGroup, /今天试了家新面馆/);
  assert.doesNotMatch(inGroup, /没发出去/);   // publish-unknown 不能被当成发过的说说

  // 换一个会话：只能看到跨会话的 memo 与公开说说，看不到 group:1 的聊天原文
  const otherGroup = notebook.formatForPrompt('group:2', { personIds: ['125'], now: NOW });
  assert.match(otherGroup, /下周三考试/);
  assert.doesNotMatch(otherGroup, /压力挺大/);
  assert.doesNotMatch(otherGroup, /先别熬夜/);

  // 无关会话 + 无关的人：别人的事与别的会话原文都不出现，但"自己发过的说说"是公开内容，照带
  const unrelated = notebook.formatForPrompt('group:3', { personIds: ['999'], now: NOW });
  assert.doesNotMatch(unrelated, /老王/);
  assert.doesNotMatch(unrelated, /压力挺大/);
  assert.match(unrelated, /今天试了家新面馆/);

  // 一条记录都没有时整块为空，不留空段头
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-notebook-empty-'));
  const empty = new Notebook({ dataDir: emptyDir, now: () => NOW });
  try {
    assert.equal(empty.formatForPrompt('group:1', { personIds: ['125'], now: NOW }), '');
  } finally {
    empty.store.close();
  }
});

test('remember：同一天同内容只记一次，换一天再说是新事实', () => {
  const notebook = makeNotebook();
  const first = notebook.remember({ chatKey: 'group:1', personId: '42', text: '他养了只猫叫豆豆' });
  const dup = notebook.remember({ chatKey: 'group:1', personId: '42', text: '他养了只猫叫豆豆' });
  assert.equal(first.inserted, true);
  assert.equal(dup.inserted, false);

  const tomorrow = new Notebook({ dataDir, now: () => NOW + 86400000 });
  const again = tomorrow.remember({ chatKey: 'group:1', personId: '42', text: '他养了只猫叫豆豆' });
  assert.equal(again.inserted, true);
});

test('syncSelfPosts：按 tid 幂等，重复同步不增长', () => {
  // 独立数据目录：说说同步读的是 dataDir 下的 daily-moments.json，
  // 用共享目录会和上一组测试互相污染（本来就该验证"重复同步不长行"）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-notebook-sync-'));
  fs.writeFileSync(path.join(dir, 'daily-moments.json'), JSON.stringify({
    records: [{
      status: 'published', tid: 'p-1', dayKey: '2026-10-22',
      content: '第一条说说', publishedAt: NOW
    }]
  }));
  const notebook = new Notebook({ dataDir: dir, now: () => NOW });
  try {
    assert.equal(notebook.syncSelfPosts({ now: NOW, force: true }), 1);
    assert.equal(notebook.syncSelfPosts({ now: NOW, force: true }), 0);
    assert.equal(notebook.stats().total, 1);
  } finally {
    notebook.store.close();
  }
});

test('search：只返回当前会话可见的记录，且不带来源会话', () => {
  const notebook = makeNotebook();
  notebook.remember({ chatKey: 'private:125', personId: '125', text: '他怕黑' });
  const result = notebook.search({ personId: '125', chatKey: 'group:9', days: 0 });
  assert.ok(result.notes.length >= 1);
  assert.ok(result.notes.every((n) => !('chatKey' in n)));
  assert.match(result.notes.map((n) => n.text).join('\n'), /怕黑/);
});

test('prune：超保留期的记录会被回收', () => {
  const store = new NotebookStore({ dataDir });
  try {
    store.add({ ts: NOW - 400 * 86400000, kind: 'memo', body: '很久以前的事' });
    const removed = store.prune({ now: NOW, retentionDays: 365, maxRows: 20000 });
    assert.ok(removed >= 1);
    assert.equal(store.query({ q: '很久以前' }).length, 0);
  } finally {
    store.close();
  }
});

test('notebookConfig：坏值夹回安全区', () => {
  const cfg = notebookConfig({ memory: { notebook: { perPerson: -3, promptMaxChars: 999999, retentionDays: 0 } } });
  assert.equal(cfg.perPerson, 1);
  assert.equal(cfg.promptMaxChars, 6000);
  assert.equal(cfg.retentionDays, 7);
  assert.equal(cfg.enabled, true);
  assert.equal(notebookConfig({ memory: { notebook: { enabled: false } } }).enabled, false);
});
