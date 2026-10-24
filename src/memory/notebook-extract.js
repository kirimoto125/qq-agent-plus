// 会话收尾的「补记」：把私聊里关于对方的事实抽进小本子。
//
// 为什么需要它（2026-10-24 实测）：
//   notebook_write 是模型主动调用的工具，但它几乎从不主动用 —— 最近 20 个会话里
//   调用 0 次，同期 memory_append（写印象）2 次、notebook_search（翻本子）2 次。
//   结果小本子里 38 条流水、只有 2 条记事，"跟谁聊过啥"记了一堆，"关于他这个人知道什么"几乎为零。
//
// 所以给它一个兜底：私聊结束后，用一次极小的模型调用把"值得留到以后的事实"抽出来。
// 约束（都很重要）：
//   - 只在私聊：群里多人对话的事实归属不清，自动写进跨会话可见的 memo 容易张冠李戴；
//   - 模型这轮已经自己记过（notebook_write）就不重复抽；
//   - 每天有次数上限，超了就不抽（防止刷屏式调用把预算吃掉）；
//   - 任何失败静默：这是锦上添花，不能影响消息发送与会话收口。
import fs from 'node:fs';
import path from 'node:path';
import { todayKey, safeSlice } from '../core/util.js';

export const EXTRACT_VERSION = 'notebook-extract-v1';
export const DEFAULT_DAILY_LIMIT = 30;

const SYSTEM_PROMPT = [
  '你是记忆抽取器。从下面这段私聊里，抽出「关于对方、值得留到以后用」的具体事实：',
  '计划、约定、时间、地点、喜好、身份、正在做的事、他明确要求你记住的事。',
  '不要写评价、不要写情绪判断、不要复述整段对话、不要写"他说了一些话"这种空话。',
  '只输出 JSON 数组，形如 [{"fact":"一句话"}]，最多 2 条；没有值得记的就输出 []。'
].join('\n');

export function extractMessages({ turns = [], peerName = '对方' } = {}) {
  const lines = (Array.isArray(turns) ? turns : [])
    .slice(-14)
    .map((t) => `${t.role === 'me' ? '我' : peerName}：${safeSlice(String(t.text || '').replace(/\s+/g, ' ').trim(), 200)}`)
    .filter((line) => line.replace(/^[^：]*：/, '').trim())
    .join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `对方是「${peerName}」。对话：\n${lines}` }
  ];
}

/** 解析模型输出：优先 JSON 数组，其次按行兜底；最多 2 条，每条 240 字。 */
export function parseFacts(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let items = [];
  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) items = parsed;
  } catch { /* 走行兜底 */ }
  if (!items.length) {
    items = raw.split('\n')
      .map((line) => line.replace(/^[-*\d.\s、]+/, '').trim())
      .filter((line) => line && line !== '[]' && line !== '{}');
  }
  const out = [];
  for (const item of items) {
    const fact = safeSlice(String(item && typeof item === 'object' ? (item.fact ?? item.text ?? '') : item).replace(/\s+/g, ' ').trim(), 240);
    if (fact && !out.includes(fact)) out.push(fact);
    if (out.length >= 2) break;
  }
  return out;
}

function budgetFile(dataDir) {
  return path.join(dataDir, 'notebook-extract.json');
}

export function readBudget(dataDir, now = Date.now()) {
  const day = todayKey(now);
  try {
    const raw = JSON.parse(fs.readFileSync(budgetFile(dataDir), 'utf8'));
    if (raw?.day === day) return { day, count: Number(raw.count) || 0 };
  } catch { /* 没有就按 0 算 */ }
  return { day, count: 0 };
}

function bumpBudget(dataDir, day) {
  try {
    const current = readBudget(dataDir);
    const next = { day, count: (current.day === day ? current.count : 0) + 1 };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${budgetFile(dataDir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, budgetFile(dataDir));
    return next;
  } catch { return null; }
}

/**
 * 抽取并写入小本子。callModel 形如 chatCompletion({messages, temperature, maxTokens, purpose})。
 * 返回 { added, skipped?, facts? }；skipped 用于测试与日志，不影响主流程。
 */
export async function extractNotebookFacts({
  notebook,
  dataDir,
  chatKey = '',
  peerId = '',
  peerName = '',
  turns = [],
  callModel,
  log = () => {},
  now = Date.now(),
  dailyLimit = DEFAULT_DAILY_LIMIT
} = {}) {
  if (!notebook?.remember) return { added: 0, skipped: 'no-notebook' };
  if (!String(chatKey).startsWith('private:')) return { added: 0, skipped: 'not-private' };
  if (typeof callModel !== 'function') return { added: 0, skipped: 'no-model' };

  const usable = (Array.isArray(turns) ? turns : []).filter((t) => String(t?.text || '').trim());
  if (usable.length < 2) return { added: 0, skipped: 'too-short' };

  const budget = readBudget(dataDir, now);
  if (budget.count >= Math.max(1, Number(dailyLimit) || DEFAULT_DAILY_LIMIT)) {
    return { added: 0, skipped: 'daily-limit' };
  }

  bumpBudget(dataDir, budget.day);
  let reply = '';
  try {
    const result = await callModel({
      messages: extractMessages({ turns: usable, peerName: peerName || '对方' }),
      temperature: 0,
      maxTokens: 220,
      purpose: 'memory'
    });
    reply = String(result?.message?.content ?? result?.content ?? '');
  } catch (error) {
    log('[notebook-extract] 抽取调用失败:', error?.message ?? error);
    return { added: 0, skipped: 'model-error' };
  }

  const facts = parseFacts(reply);
  let added = 0;
  for (const fact of facts) {
    try {
      const result = notebook.remember({
        chatKey, personId: peerId, personName: peerName, text: fact, kind: 'memo', source: 'extract'
      });
      if (result?.inserted) added += 1;
    } catch (error) {
      log('[notebook-extract] 写入失败:', error?.message ?? error);
    }
  }
  if (added) log(`[notebook-extract] ${chatKey} 补记 ${added} 条：${facts.join('；').slice(0, 120)}`);
  return { added, facts };
}
