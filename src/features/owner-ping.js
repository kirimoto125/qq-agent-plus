// 定时问候：每 2~3 小时，让机器人在私聊里主动给管理员发一条消息。
//
// 为什么单独一个管理器，而不是复用「自主节奏（proactive）」：
//   - proactive 是给群聊冷场用的：概率触发、按静默时长判定、还要看 activeHours；
//   - 这里的语义是"固定间隔、只对一个人、能跨重启、要能在控制台看见下一次时间"；
//   - 两者混在一起后，改一个必然影响另一个（proactive 的每一处判定都在群聊语境里）。
//
// 不直接 send_message：走 orchestrator.scheduleInitiativeWake 的既有唤醒链路，
// 让它带着【小本子】【记忆】【角色卡】正常生成，而不是发一句固定文案。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../core/config.js';

const NOTE_GREET = '【定时问候】到点了：主动给管理员发一条消息。可以说说你此刻在想什么、在做什么，或者问他一句；'
  + '只发一条，别只发"在吗"，也别问"有什么可以帮你"。';
// 先刷再说：给她一个"自己去看看"的机会，有内容才开口。
// 不用虚拟机：browse_bilibili（B 站公开接口）+ web_search / web_fetch 已经够看；
// 真正的差别是"看完之后有没有话"。
const NOTE_BROWSE = '【定时刷手机】到点了：先自己看看，别急着说话。可以用 browse_bilibili 看 B 站热门'
  + '（或按关键词搜），也可以 web_search 搜点你感兴趣的，挑一两页用 web_fetch 读正文。'
  + '看到真有意思的，就用 send_message 跟管理员说一条（带上具体见闻，别复述标题、别像播报）；'
  + '什么都没劲就安静结束，别为了发而发。';

function clampClock(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function hours(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 运行期配置：坏值一律夹回安全区（手改 config.json 不该让定时器变成每分钟一次）。 */
export function ownerPingConfig(cfg = getConfig()) {
  const raw = cfg?.ownerPing || {};
  const minHours = hours(raw.minHours, 2, 0.5, 12);
  return {
    enabled: raw.enabled !== false,
    mode: raw.mode === 'greet' ? 'greet' : 'browse',
    minHours,
    maxHours: Math.max(minHours, hours(raw.maxHours, 3, 0.5, 12)),
    quietStart: clampClock(raw.quietStart, '23:30'),
    quietEnd: clampClock(raw.quietEnd, '08:30'),
    skipIfActiveMinutes: Math.round(hours(raw.skipIfActiveMinutes, 15, 0, 240)),
    note: String(raw.note || '').trim()
  };
}

export function minutesOfClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60) + m;
}

/**
 * 某个时刻是否在静默时段内。
 * 支持跨午夜（默认 23:30 → 08:30）：start > end 时，"晚于 start 或早于 end"都算夜里。
 */
export function inQuietHours(ts, conf = ownerPingConfig()) {
  const date = new Date(ts);
  const nowMin = (date.getHours() * 60) + date.getMinutes();
  const start = minutesOfClock(conf.quietStart);
  const end = minutesOfClock(conf.quietEnd);
  if (start === end) return false;
  return start < end
    ? (nowMin >= start && nowMin < end)
    : (nowMin >= start || nowMin < end);
}

/** 把落在静默时段的时刻推到静默结束（今天或明天）。 */
export function shiftOutOfQuiet(ts, conf = ownerPingConfig()) {
  if (!inQuietHours(ts, conf)) return ts;
  const end = minutesOfClock(conf.quietEnd);
  const target = new Date(ts);
  target.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (target.getTime() <= ts) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** 下一次该在什么时候发：min~max 小时内随机，再避开静默时段。 */
export function nextPingAt(now, conf = ownerPingConfig(), random = Math.random) {
  const minMs = conf.minHours * 3600000;
  const maxMs = conf.maxHours * 3600000;
  const delay = minMs + ((maxMs - minMs) * Math.min(1, Math.max(0, Number(random()) || 0)));
  return shiftOutOfQuiet(now + Math.round(delay), conf);
}

export class OwnerPingManager {
  constructor({
    orchestrator = null, dataDir = DATA_DIR, now = Date.now, random = Math.random, log = () => {},
    // 配置读取可注入：测试里要验证"换了模式会换文案"，不该靠改磁盘上的 config.json
    // （config 模块会缓存，写文件不一定读得到）。
    getConfigFn = getConfig
  } = {}) {
    this.orchestrator = orchestrator;
    this.now = now;
    this.random = random;
    this.log = log;
    this.getConfig = typeof getConfigFn === 'function' ? getConfigFn : getConfig;
    this.stateFile = path.join(dataDir, 'owner-ping.json');
    this.timer = null;
    this.state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }

  #save(patch = {}) {
    this.state = { ...this.state, ...patch };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.log('[owner-ping] 保存状态失败:', error?.message ?? error);
    }
  }

  #targetChat() {
    const ownerUin = String(this.getConfig()?.admin?.ownerUin || '').trim();
    if (!/^\d{1,15}$/.test(ownerUin)) return '';
    return `private:${ownerUin}`;
  }

  start() {
    const conf = ownerPingConfig(this.getConfig());
    if (!conf.enabled) {
      this.stop();
      this.#save({ enabled: false });
      return this.status();
    }
    const now = this.now();
    let nextAt = Number(this.state.nextAt) || 0;
    if (!nextAt || nextAt < now) {
      // 重启后不立刻弹：给 2~10 分钟让服务先稳定（否则一次重启就是一条消息）
      nextAt = now + Math.round((2 + this.random() * 8) * 60000);
    }
    this.#arm(nextAt);
    return this.status();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 重新读配置并重排（控制台保存后调用）。 */
  reconfigure() {
    this.stop();
    return this.start();
  }

  status() {
    const conf = ownerPingConfig(this.getConfig());
    return {
      enabled: conf.enabled,
      mode: conf.mode,
      minHours: conf.minHours,
      maxHours: conf.maxHours,
      quietStart: conf.quietStart,
      quietEnd: conf.quietEnd,
      skipIfActiveMinutes: conf.skipIfActiveMinutes,
      nextAt: Number(this.state.nextAt) || 0,
      lastFiredAt: Number(this.state.lastFiredAt) || 0,
      chatKey: this.#targetChat()
    };
  }

  #arm(nextAt) {
    this.stop();
    const delay = Math.max(30000, Number(nextAt) - this.now());
    this.timer = setTimeout(() => {
      try { this.fireNow(); } catch (error) { this.log('[owner-ping] 触发失败:', error?.message ?? error); }
    }, delay);
    if (this.timer.unref) this.timer.unref();
    this.#save({ nextAt });
  }

  /**
   * 立刻发一条（控制台的"现在试一条"也走这里）。
   * 返回 { ok, reason, nextAt }：ok=false 时不排下一次，避免把用户手动试探变成固定节奏。
   */
  fireNow({ reschedule = true } = {}) {
    const conf = ownerPingConfig(this.getConfig());
    if (!conf.enabled) return { ok: false, reason: '已关闭' };
    const chatKey = this.#targetChat();
    if (!chatKey) return { ok: false, reason: '没有可用的管理员 QQ 号（admin.ownerUin）' };
    const orchestrator = this.orchestrator;
    if (!orchestrator?.scheduleInitiativeWake) return { ok: false, reason: '编排器不可用' };

    // 她已经给自己留了话（schedule_wake）：那是单槽，覆盖等于把那句话弄丢
    const pending = orchestrator.scheduledWakes?.get?.(chatKey);
    if (pending && String(pending.note || '').trim()) {
      this.log(`[owner-ping] ${chatKey} 已有待发留言，推迟 20 分钟`);
      if (reschedule) this.#arm(this.now() + 20 * 60000);
      return { ok: false, reason: '她已有待发留言，已推迟' };
    }

    // 刚聊过就别插一句：15 分钟内还有来往就再等 20 分钟
    const activeMin = Number(conf.skipIfActiveMinutes) || 0;
    if (activeMin > 0 && orchestrator.store?.recent) {
      try {
        const last = orchestrator.store.recent(chatKey, { limit: 1 })?.[0];
        if (last && this.now() - Number(last.ts || 0) < activeMin * 60000) {
          this.log(`[owner-ping] ${chatKey} ${activeMin} 分钟内刚聊过，推迟 20 分钟`);
          if (reschedule) this.#arm(this.now() + 20 * 60000);
          return { ok: false, reason: '刚聊过，已推迟' };
        }
      } catch { /* 读不到最近消息就按"没聊过"处理 */ }
    }

    // 两种模式：browse=先刷一会儿再说（默认），greet=直接说一句
    const note = conf.note || (conf.mode === 'browse' ? NOTE_BROWSE : NOTE_GREET);
    orchestrator.scheduleInitiativeWake(chatKey, 60 * 1000, note, { kind: 'ownerPing' });
    const nextAt = reschedule ? nextPingAt(this.now(), conf, this.random) : 0;
    this.#save({ lastFiredAt: this.now(), chatKey });
    if (nextAt) this.#arm(nextAt);
    this.log(`[owner-ping] 已在 ${chatKey} 安排一条${conf.mode === 'browse' ? '「先刷再说」' : '问候'}${nextAt ? `；下一次 ${new Date(nextAt).toLocaleString('zh-CN')}` : ''}`);
    return { ok: true, chatKey, nextAt };
  }
}
