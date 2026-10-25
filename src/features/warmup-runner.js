// 暖场运行器：定时刷素材 + 群里冷场时挑一条开口 + 私聊分享/搭话。
//
// 它只做"什么时候该开口"，不负责说话——开口一律交给 orchestrator.scheduleInitiativeWake，
// 由模型带着素材、角色卡、记忆去生成。这样她说的每句话都还是她自己的，不是模板。
import { getConfig } from '../core/config.js';
import { materialConfig, listMaterials } from './material-pool.js';
import {
  describeMaterial, groupTopicPlan, markGroupTopic, pickMaterial,
  privateChatPlan, markPrivateChat, readState, warmupConfig, writeStateSafe
} from './warmup-scheduler.js';

const NIGHT_START = '23:30';

function minuteOfClock(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function inQuiet(now, config) {
  const date = new Date(now);
  const cur = date.getHours() * 60 + date.getMinutes();
  const start = minuteOfClock(config.quietStart || NIGHT_START);
  const end = minuteOfClock(config.quietEnd || '08:30');
  if (start === end) return false;
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

export class WarmupRunner {
  constructor({
    orchestrator, notebook, materials, store,
    now = Date.now, random = Math.random, log = () => {}
  } = {}) {
    this.orchestrator = orchestrator;
    this.notebook = notebook;
    this.materials = materials;
    this.store = store;
    this.now = now;
    this.random = random;
    this.log = log;
    this.refreshTimer = null;
    this.checkTimer = null;
    this.state = readState();
    this.nextRefreshAt = 0;
  }

  start() {
    const config = warmupConfig();
    if (!config.enabled) return this.status();
    this.#scheduleRefresh();
    this.checkTimer = setInterval(() => {
      try { this.tick(); } catch (error) { this.log('[warmup] tick 失败:', error?.message ?? error); }
    }, 60 * 1000);
    if (this.checkTimer.unref) this.checkTimer.unref();
    // 立刻跑一次：重启后不该等一小时才有素材
    setTimeout(() => {
      try { this.tick(); } catch { /* 忽略 */ }
    }, 20000).unref?.();
    return this.status();
  }

  stop() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.refreshTimer = null;
    this.checkTimer = null;
  }

  status() {
    const config = warmupConfig();
    return {
      enabled: config.enabled,
      materials: this.materials?.list?.(200)?.length ?? 0,
      whitelist: config.groupWhitelist,
      groupIdleMinutes: config.groupIdleMinutes,
      groupMaxPerDay: config.groupMaxPerDay,
      privateChatEnabled: config.privateChatEnabled,
      nextRefreshAt: this.nextRefreshAt,
      groups: this.state.groups || {},
      private: this.state.private || {}
    };
  }

  #scheduleRefresh() {
    const config = warmupConfig();
    const min = config.refreshMinMinutes * 60000;
    const max = config.refreshMaxMinutes * 60000;
    const delay = min + Math.round((max - min) * this.random());
    this.nextRefreshAt = this.now() + delay;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      try { await this.refreshMaterials(); } catch (error) { this.log('[warmup] 刷新素材失败:', error?.message ?? error); }
      this.#scheduleRefresh();
    }, delay);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  async refreshMaterials() {
    const config = warmupConfig();
    if (!config.enabled) return { added: 0, skipped: 'disabled' };
    if (inQuiet(this.now(), config)) return { added: 0, skipped: 'quiet' };
    const result = await this.materials.refresh();
    if (result?.added) this.log(`[warmup] 素材 +${result.added}（共 ${result.fetched} 条候选）`);
    return result;
  }

  /** 每分钟调用：先看群，再看私聊。 */
  tick() {
    const config = warmupConfig();
    if (!config.enabled) return;
    const now = this.now();
    if (inQuiet(now, config)) return;

    // 素材用完了就补一次（不等到刷新点）
    if ((this.materials.list(200)?.length || 0) === 0) {
      this.refreshMaterials().catch(() => {});
    }

    this.#tickGroups(config, now);
  }

  #tickGroups(config, now) {
    const whitelist = config.groupWhitelist;
    if (!whitelist.length) return;
    for (const groupId of whitelist) {
      const chatKey = `group:${groupId}`;
      let lastMessageAt = 0;
      try {
        lastMessageAt = Number(this.store?.recent?.(chatKey, { limit: 1 })?.[0]?.ts) || 0;
      } catch { lastMessageAt = 0; }
      const plan = groupTopicPlan({ groupId, now, lastMessageAt, state: this.state, config });
      if (!plan.ok) continue;
      const notes = this.materials.list(20);
      const used = new Set(this.state.usedRefs || []);
      const picked = pickMaterial(notes, used);
      if (!picked) continue;
      const materialText = describeMaterial(picked);
      const note = `【群话题】群已经安静了一阵子。这是一条你觉得可以拿出来聊的素材：${materialText}\n`
        + '想聊就自然带出来（先说你自己的话，再用 share_topic 把素材分享出来，materialId 用上面那条的 id）；'
        + '觉得不适合这个群就安静结束，别硬找话题。';
      this.orchestrator?.scheduleInitiativeWake?.(chatKey, 60 * 1000, note, { kind: 'groupTopic' });
      this.state = markGroupTopic({ groupId, now, state: this.state });
      this.state.usedRefs = [...new Set([...(this.state.usedRefs || []), String(picked.topic)])].slice(-200);
      writeStateSafe(this.state);
      this.log(`[warmup] ${chatKey} 冷场 ${config.groupIdleMinutes} 分钟，安排一条话题：${String(picked.body).slice(0, 40)}`);
      break;   // 一次 tick 只开一个群，避免多处同时冒泡
    }
  }

  /**
   * 构造一条"群话题"唤醒指令（不排程、不计数）。
   * 控制台的「试一条（只生成不发送）」直接拿它跑一次 wake，保证预览和真实开口用同一套文案。
   */
  buildPreviewNote(chatKey) {
    const notes = this.materials.list(20);
    if (!notes.length) return '';
    const picked = pickMaterial(notes, new Set(this.state.usedRefs || []));
    if (!picked) return '';
    return `【群话题】群已经安静了一阵子。这是一条你觉得可以拿出来聊的素材：${describeMaterial(picked)}\n`
      + '想聊就自然带出来（先说你自己的话，再用 share_topic 把素材分享出来，materialId 用上面那条的 id）；'
      + '觉得不适合这个群就安静结束，别硬找话题。';
  }

  /** 手动触发一次群话题（控制台"试一条"用）：绕过冷场与白名单判定，但仍受素材池约束。 */
  forceGroupTopic(groupId, { ignoreWhitelist = false } = {}) {
    const config = warmupConfig();
    if (!ignoreWhitelist && !config.groupWhitelist.includes(String(groupId))) {
      return { ok: false, reason: 'not-whitelisted' };
    }
    const notes = this.materials.list(20);
    if (!notes.length) return { ok: false, reason: 'no-materials' };
    const chatKey = `group:${groupId}`;
    const picked = pickMaterial(notes, new Set(this.state.usedRefs || []));
    const note = `【群话题】这是你挑的一条素材（手动测试）：${describeMaterial(picked)}\n`
      + '想聊就自然带出来（先说你自己的话，再用 share_topic 分享，materialId 用上面那条的 id）；'
      + '觉得不适合这个群就安静结束。';
    this.orchestrator?.scheduleInitiativeWake?.(chatKey, 60 * 1000, note, { kind: 'groupTopic' });
    this.state = markGroupTopic({ groupId, now: this.now(), state: this.state });
    writeStateSafe(this.state);
    return { ok: true, chatKey, materialId: picked.id, title: String(picked.body || '').slice(0, 60) };
  }

  /** 私聊：没素材但很久没聊 → 允许"无聊找你说话"（由 owner-ping 的定时器触发时判断）。 */
  canPrivateChat(now = this.now()) {
    const config = warmupConfig();
    if (!config.privateChatEnabled) return { ok: false, reason: 'disabled' };
    const ownerUin = String(getConfig()?.admin?.ownerUin || '');
    if (!ownerUin) return { ok: false, reason: 'no-owner' };
    const chatKey = `private:${ownerUin}`;
    let lastMessageAt = 0;
    try { lastMessageAt = Number(this.store?.recent?.(chatKey, { limit: 1 })?.[0]?.ts) || 0; } catch { lastMessageAt = 0; }
    return privateChatPlan({ now, lastMessageAt, state: this.state, config });
  }

  markPrivateChat(now = this.now()) {
    this.state = markPrivateChat({ now, state: this.state });
    writeStateSafe(this.state);
  }
}
