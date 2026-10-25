// 小本子「补记」的单元测试：解析、门控、预算、写入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { extractMessages, extractNotebookFacts, parseFacts, readBudget } = await import('../src/memory/notebook-extract.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-nb-extract-'));
}

test('parseFacts：JSON / 代码块 / 按行兜底 / 空', () => {
  assert.deepEqual(parseFacts('[{"fact":"他下周三考试"}]'), ['他下周三考试']);
  assert.deepEqual(parseFacts('```json\n[{"fact":"他养了只猫"}]\n```'), ['他养了只猫']);
  assert.deepEqual(parseFacts('- 他周六去上海\n- 他讨厌香菜'), ['他周六去上海', '他讨厌香菜']);
  assert.deepEqual(parseFacts('[]'), []);
  assert.deepEqual(parseFacts(''), []);
  // 最多 2 条
  assert.equal(parseFacts('["a","b","c"]').length, 2);
});

test('extractMessages：双方发言都在，且不把空行当内容', () => {
  const messages = extractMessages({
    peerName: '老王',
    turns: [
      { role: 'them', text: '我下周三考试' },
      { role: 'me', text: '那你先别熬夜' },
      { role: 'them', text: '   ' }
    ]
  });
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /老王：我下周三考试/);
  assert.match(messages[1].content, /我：那你先别熬夜/);
  assert.doesNotMatch(messages[1].content, /老王：\s*$/m);
});

test('只对私聊、且对话太短时不抽', async () => {
  const dir = tempDir();
  const calls = [];
  const notebook = { remember: (a) => { calls.push(a); return { inserted: true }; } };
  const callModel = async () => ({ message: { content: '[{"fact":"x"}]' } });

  const group = await extractNotebookFacts({
    notebook, dataDir: dir, chatKey: 'group:1', turns: [{ text: 'a' }, { text: 'b' }], callModel
  });
  assert.equal(group.skipped, 'not-private');

  const short = await extractNotebookFacts({
    notebook, dataDir: dir, chatKey: 'private:1', turns: [{ role: 'them', text: '在吗' }], callModel
  });
  assert.equal(short.skipped, 'too-short');
  assert.equal(calls.length, 0);
  assert.equal(readBudget(dir).count, 0);
});

test('正常抽取：写入 memo，并消耗一次预算', async () => {
  const dir = tempDir();
  const calls = [];
  const notebook = { remember: (a) => { calls.push(a); return { inserted: true }; } };
  const result = await extractNotebookFacts({
    notebook,
    dataDir: dir,
    chatKey: 'private:125',
    peerId: '125',
    peerName: '老王',
    turns: [
      { role: 'them', text: '我下周三考试，考完请你吃饭' },
      { role: 'me', text: '行，那我等你' }
    ],
    callModel: async () => ({ message: { content: '[{"fact":"下周三考试，考完请吃饭"}]' } }),
    now: Date.UTC(2026, 9, 24, 4)
  });
  assert.equal(result.added, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'memo');
  assert.equal(calls[0].personId, '125');
  assert.equal(calls[0].source, 'extract');
  // 读预算时必须带同一个 now：readBudget 的默认参数是真实当前时间，
  // 和写入用的固定时间不在同一天时会返回 0（测试曾因此误报）。
  assert.equal(readBudget(dir, Date.UTC(2026, 9, 24, 4)).count, 1);
});

test('模型失败 / 超日限额时不写，且失败不抛', async () => {
  const dir = tempDir();
  const notebook = { remember: () => ({ inserted: true }) };
  const turns = [{ role: 'them', text: 'a' }, { role: 'me', text: 'b' }];

  const failed = await extractNotebookFacts({
    notebook, dataDir: dir, chatKey: 'private:1', turns,
    callModel: async () => { throw new Error('boom'); }
  });
  assert.equal(failed.added, 0);
  assert.equal(failed.skipped, 'model-error');

  const limited = await extractNotebookFacts({
    notebook, dataDir: dir, chatKey: 'private:1', turns, dailyLimit: 1,
    callModel: async () => ({ message: { content: '[{"fact":"x"}]' } })
  });
  // 上一步已消耗 1 次预算 → 这次直接跳过
  assert.equal(limited.skipped, 'daily-limit');
});
