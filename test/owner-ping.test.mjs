// 定时问候（owner-ping）单元测试。
//
// 重点不是"能不能发"，而是三个容易出事的边界：
//   ① 静默时段（跨午夜）不能把人吵醒；
//   ② 间隔必须落在 2~3 小时，坏配置要被夹回安全区；
//   ③ 她自己用 schedule_wake 留了话时，不能把那个单槽顶掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-owner-ping-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  admin: { ownerUin: '1255810349' }
}));

const {
  OwnerPingManager, inQuietHours, nextPingAt, ownerPingConfig, shiftOutOfQuiet
} = await import('../src/features/owner-ping.js');

const CONF = { minHours: 2, maxHours: 3, quietStart: '23:30', quietEnd: '08:30' };
const at = (h, m = 0) => new Date(2026, 9, 24, h, m, 0, 0).getTime();

test('配置：坏值夹回安全区', () => {
  const c = ownerPingConfig({ ownerPing: { minHours: -1, maxHours: 0, quietStart: '25:00', quietEnd: 'x', skipIfActiveMinutes: -5 } });
  assert.equal(c.minHours, 0.5);
  assert.equal(c.maxHours, 0.5);
  assert.equal(c.quietStart, '23:30');
  assert.equal(c.quietEnd, '08:30');
  assert.equal(c.skipIfActiveMinutes, 0);
  assert.equal(ownerPingConfig({ ownerPing: { enabled: false } }).enabled, false);
  // max 小于 min 时抬到 min
  assert.equal(ownerPingConfig({ ownerPing: { minHours: 4, maxHours: 1 } }).maxHours, 4);
});

test('静默时段：跨午夜与白天窗口', () => {
  assert.equal(inQuietHours(at(23, 45), CONF), true);
  assert.equal(inQuietHours(at(0, 30), CONF), true);
  assert.equal(inQuietHours(at(8, 0), CONF), true);    // 08:30 才结束，08:00 仍在静默
  assert.equal(inQuietHours(at(10, 0), CONF), false);
  assert.equal(inQuietHours(at(23, 0), CONF), false);
  // 白天窗口（不跨午夜）
  const day = { ...CONF, quietStart: '13:00', quietEnd: '14:00' };
  assert.equal(inQuietHours(at(13, 30), day), true);
  assert.equal(inQuietHours(at(14, 30), day), false);
});

test('静默时段：顺延到结束时刻', () => {
  const shifted = shiftOutOfQuiet(at(23, 45), CONF);
  const d = new Date(shifted);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 30);
  assert.equal(d.getDate(), 25);   // 次日
  // 白天不在静默 → 原样返回
  assert.equal(shiftOutOfQuiet(at(15, 0), CONF), at(15, 0));
});

test('下一次时间：落在 2~3 小时且避开静默', () => {
  const now = at(10, 0);
  const early = nextPingAt(now, CONF, () => 0);
  assert.equal(early - now, 2 * 3600000);
  const late = nextPingAt(now, CONF, () => 1);
  assert.equal(late - now, 3 * 3600000);
  // 22:00 + 2h = 次日 00:00 落在静默 → 顺延到 08:30
  const night = nextPingAt(at(22, 0), CONF, () => 0);
  const d = new Date(night);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 30);
});

function fakeOrchestrator() {
  const calls = [];
  return {
    calls,
    scheduledWakes: new Map(),
    store: { recent: () => [] },
    scheduleInitiativeWake: (chatKey, delayMs, note, opts) => {
      calls.push({ chatKey, delayMs, note, opts });
      return Date.now() + delayMs;
    }
  };
}

test('立即发一条：排给管理员私聊，并落盘下一次', () => {
  const orchestrator = fakeOrchestrator();
  const mgr = new OwnerPingManager({ orchestrator, dataDir, now: () => at(10, 0), random: () => 0.5 });
  const result = mgr.fireNow();
  assert.equal(result.ok, true);
  assert.equal(orchestrator.calls.length, 1);
  const call = orchestrator.calls[0];
  assert.equal(call.chatKey, 'private:1255810349');
  assert.match(call.note, /【定时问候】/);
  assert.equal(call.opts.kind, 'ownerPing');
  assert.equal(call.delayMs, 60000);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'owner-ping.json'), 'utf8'));
  assert.ok(saved.nextAt > at(10, 0));
  assert.ok(saved.lastFiredAt > 0);
  mgr.stop();
});

test('她自己留了话时不抢槽位', () => {
  const orchestrator = fakeOrchestrator();
  orchestrator.scheduledWakes.set('private:1255810349', { note: '我过会儿问问他在干嘛', at: Date.now() + 60000 });
  const mgr = new OwnerPingManager({ orchestrator, dataDir, now: () => at(10, 0) });
  const result = mgr.fireNow();
  assert.equal(result.ok, false);
  assert.match(result.reason, /待发留言/);
  assert.equal(orchestrator.calls.length, 0);
  mgr.stop();
});

test('刚聊过就推迟，不插话', () => {
  const orchestrator = fakeOrchestrator();
  orchestrator.store.recent = () => [{ ts: at(10, 0) - 5 * 60000 }];
  const mgr = new OwnerPingManager({ orchestrator, dataDir, now: () => at(10, 0) });
  const result = mgr.fireNow();
  assert.equal(result.ok, false);
  assert.match(result.reason, /刚聊过/);
  assert.equal(orchestrator.calls.length, 0);
  mgr.stop();
});

test('重启后沿用磁盘上的下一次时间；过期则 2~10 分钟内补', () => {
  const stateFile = path.join(dataDir, 'owner-ping.json');
  fs.writeFileSync(stateFile, JSON.stringify({ nextAt: at(12, 0) }));
  const orchestrator = fakeOrchestrator();
  const mgr = new OwnerPingManager({ orchestrator, dataDir, now: () => at(10, 0), random: () => 0.5 });
  const status = mgr.start();
  assert.equal(status.nextAt, at(12, 0));
  mgr.stop();

  fs.writeFileSync(stateFile, JSON.stringify({ nextAt: at(9, 0) }));   // 已过期
  const mgr2 = new OwnerPingManager({ orchestrator, dataDir, now: () => at(10, 0), random: () => 0.5 });
  const status2 = mgr2.start();
  assert.ok(status2.nextAt > at(10, 0));
  assert.ok(status2.nextAt <= at(10, 0) + 10 * 60000);
  mgr2.stop();
});
