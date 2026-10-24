// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」第二轮：设置域）。
// 设置页渲染与弹窗（renderSettings* 及其分区渲染器、思考控制小件、选择器弹窗）
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（脚本内已核对，勿手改缩进）。
'use strict';


import {
  closeModelModal, currentThinkingRaw, loadSettings, modelModalShell, refreshStatus,
  renderExperimentalSettingsSection, renderSettings, renderThinkingSeg, thinkingStops
} from '../app.js';
import { api } from '../core/api.js';
import {
  MODEL_SERVICES_UI, THEME_VALUES, TIME_DAYS, TIME_RULE_LABELS
} from '../core/constants.js';
import { askForConfirmation, extraBodyText, splitRowsHtml } from '../core/dom-util.js';
import { $, $$, esc } from '../core/dom.js';
import {
  effectivePriceFor, hostOfUrl, initialServiceNote, onebotIssueText, onebotStatusLineHtml, parseList,
  uiServiceOfUrl
} from '../core/format.js';
import { refreshIntervalMs, state } from '../core/state.js';
import { loadChats, renderChatSection } from './chat.js';
import {
  renderDailyMomentsSection, renderGroupGameSection, renderQzoneInteractionSection, renderRemindersSection
} from './moments.js';
import { renderPersonaSection } from './persona.js';
import { hydratePlatformGates, hydratePlatformVoiceSelect, renderPlatformSection } from './platform.js';
import { bindSnowlumaActions, hydrateSnowlumaPanel } from './snowluma.js';
import { applyIcons } from '../core/icons.js';
// 分区菜单的"选中块滑过去"与主导航共用同一份实现（2026-10-08）
import { positionNavPill } from '../core/nav-pill.js';
import { enhanceSeg } from '../core/segment.js';
import { bindAppearanceControls, renderAppearanceBlock } from './settings-appearance.js';
import { loadSessions } from './sessions.js';
import { bindCrossSectionControls, bindSettingsEvents, isSplitThinking } from './settings-bind.js';
import { renderAsrSection } from './settings-voice.js';
import { refreshAutoUpdateStatus, timeControlTargetOptions } from './status.js';
import { loadUsageView } from './usage.js';
/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

function startListPoller() {
  if (state.listPoller) clearInterval(state.listPoller);
  state.listPoller = setInterval(() => {
    if (state.tab === 'control') refreshAutoUpdateStatus();
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
// ── 两栏悬停下拉：左供应商 / 右模型 ──
// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  // 分组（2026-10-08）：18 个分区平铺一长条最劝退，按"对话 / 记忆与人设 / 运行 / 平台 /
  // 系统"五组归位，每组一个小标题。分组只影响侧栏观感，分区 id 与行为一个都没动
  // （ui-smoke 断言 .settings-menu-item[data-section=...] 仍在，锚点不受影响）。
  const menu = [
    ['对话与人格', [['persona', '人设'], ['chat', '聊天设置'], ['messageTypes', '消息类型'], ['allow', '聊天白名单'], ['memory', '记忆']]],
    ['模型与服务', [['api', '模型 API'], ['search', '搜索服务'], ['asr', '语音转文字'], ['token-saver', '省 Token']]],
    ['自动行为', [['moments', '每日动态'], ['qzone-interactions', '动态互动'], ['reminders', '定时提醒'], ['owner-ping', '定时问候'], ['groupGame', '群游戏'], ['time-control', '时间控制'], ['experiments', '实验功能']]],
    ['平台', [['platform', '平台能力'], ['onebot', 'OneBot']]],
    ['系统', [['appearance', '外观'], ['desktop', '系统']]]
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row" ${s?.onebot?.connected ? '' : `title="${esc(onebotIssueText(s?.onebot) || '正在等待首次连接')}"`}><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([group, items]) => `
        <div class="settings-menu-group">${esc(group)}</div>
        ${items.map(([id, label]) => {
          const on = state.settingsSection === id;
          // aria-current="page"：一组同类元素里只标一个"当前项"（Primer/MDN 的口径）
          return `<button class="settings-menu-item ${on ? 'active' : ''}" data-section="${id}"${on ? ' aria-current="page"' : ''}>${label}</button>`;
        }).join('')}
      `).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
  syncMenuPill();
  bindMenuPillResync();
  revealActiveMenuItem();
}

/**
 * 分区菜单的滑块。与主导航同一份实现（ui/core/nav-pill.js），这里多一步：把**上一个滑块节点**
 * 接回来 —— 这个菜单每次点击都会重建整块 DOM，节点若不回收，动画就变成"直接出现在终点"。
 */
let menuPill = null;
function syncMenuPill() {
  const menu = document.querySelector('#settings-sidebar .settings-menu');
  if (!menu) return;
  menuPill = positionNavPill(menu, {
    activeSelector: ':scope > .settings-menu-item.active',
    previous: menuPill
  });
}

/** 外观一变（换字体/密度 → 菜单行高变了）滑块要重新对位，与主导航同一口径。只注册一次。 */
let menuPillResyncBound = false;
function bindMenuPillResync() {
  if (menuPillResyncBound) return;
  menuPillResyncBound = true;
  document.addEventListener('qqa:appearance', () => {
    try { syncMenuPill(); } catch { /* 菜单不在这一页，忽略 */ }
  });
}

/**
 * 把当前分区带进视野，只滚这根侧栏自己（不动外面那层表单的滚动位置）。
 * 语义对齐 scrollIntoView({ block: 'nearest' })：只在跑出视野时滚、且滚最小距离 ——
 * 不给它加这一步时，点「外观」「系统」这种靠后的分区，高亮会落在折叠线以下，等于没有指示。
 * 只在"分区真的换了"时执行一次：否则每次保存/外观变更都会把用户手动滚到的位置拽回来。
 */
let revealedSection = null;
/** 进设置页时清掉"这个分区已经露过脸"的记忆：用户手动把菜单滚走、离开再回来时，
 *  当前项可能又跑到折叠线外了 —— 那种情况下应该再带一次进视野。 */
function resetMenuReveal() {
  revealedSection = null;
}
function revealActiveMenuItem() {
  const sec = state.settingsSection || 'api';
  if (sec === revealedSection) return;
  revealedSection = sec;
  const sidebar = $('#settings-sidebar');
  const item = sidebar?.querySelector('.settings-menu-item.active');
  if (!sidebar || !item) return;
  sidebar.scrollTop += revealDelta(sidebar.getBoundingClientRect(), item.getBoundingClientRect());
}

/**
 * "把 item 带进 box 的视野"要滚多少像素（0 ＝ 已经在视野里，正数往下滚、负数往上）。
 * 抽成纯函数是为了能测：happy-dom 没有布局引擎，只能用假几何喂它（见 test/console-side-nav）。
 * 语义与 scrollIntoView({ block: 'nearest' }) 一致：只在跑出视野时滚、且滚最小距离。
 */
function revealDelta(box, item, pad = 8) {
  if (item.top < box.top + pad) return -(box.top + pad - item.top);
  if (item.bottom > box.bottom - pad) return item.bottom - box.bottom + pad;
  return 0;
}

function renderSettingsImpl() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  // 主题选择器等静态节点上的 data-icon 在这里注入 SVG（幂等）
  applyIcons(box);
  // 分段控件（思考档位、外观页的十来组）：插滑块并定位到当前档
  enhanceSeg(box);
  bindAppearanceControls();
  bindSettingsEvents(c);
  bindCrossSectionControls();
  // 「平台能力」页的异步补全：语音音色目录、每项的工具清单、闸门用量、按群覆盖编辑器
  // （不在这一页时各自 no-op）
  hydratePlatformVoiceSelect();
  hydratePlatformGates();
  // OneBot 页的「协议端（SnowLuma）」面板：读版本 + 绑按钮（不在这一页时各自 no-op）
  hydrateSnowlumaPanel();
  bindSnowlumaActions();
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    asr: () => renderAsrSection(c),
    memory: () => renderMemorySettingsSection(c),
    experiments: () => renderExperimentalSettingsSection(c),
    groupGame: () => renderGroupGameSection(c),
    moments: () => renderDailyMomentsSection(c),
    reminders: () => renderRemindersSection(c),
    'owner-ping': () => renderOwnerPingSection(c),
    'qzone-interactions': () => renderQzoneInteractionSection(c),
    'time-control': () => renderTimeControlSection(c),
    'token-saver': () => renderTokenSaverSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    messageTypes: () => renderMessageTypesSection(c),
    platform: () => renderPlatformSection(c),
    appearance: () => renderAppearanceBlock(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  // 保存条放在内容**末尾**并 sticky 贴底：长页面（人设页能滚好几屏）里从顶部就能看到它，
  // 一直悬在视口底部，滚到底时正好落在内容末尾。以前它渲染在最前面，既不悬浮又容易
  // 和分区里自己的保存按钮撞车（人设页就多过一个"保存人设修改"，其实调的是同一个保存）。
  // 定时问候有自己的保存按钮（走 /api/owner-ping），不参与通用配置收集：
  // 挂一条"保存设置"在这里只会让人以为它也能存，其实什么都不会发生。
  if (sec === 'owner-ping') return render();
  return `
    ${render()}
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>`;
}

/**
 * 定时问候（owner-ping）：每 2~3 小时让她主动私聊管理员一条。
 * 字段读写都走 /api/owner-ping，与通用配置表单解耦 —— 这个开关的生效方式是
 * "重排定时器"，跟其它字段"保存到 config 等下次运行"不是一回事。
 */
function renderOwnerPingSection(c) {
  const p = c.ownerPing || {};
  const enabled = p.enabled !== false;
  const min = Number(p.minHours) || 2;
  const max = Number(p.maxHours) || 3;
  const quietStart = String(p.quietStart || '23:30');
  const quietEnd = String(p.quietEnd || '08:30');
  return `
    <h3 id="settings-owner-ping">定时问候</h3>
    <div class="hint">每隔一段时间，让她在私聊里主动给你发一条消息。内容由她自己生成（会带上角色卡、记忆和小本子），不是固定文案。</div>
    <div class="field">
      <label>开关</label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="cfg-op-enabled" ${enabled ? 'checked' : ''} />
        <span>启用定时问候</span>
      </label>
      <div class="hint">关闭后不再发送；已经排好的那一次会取消。</div>
    </div>
    <div class="field-row">
      <div class="field"><label>最短间隔（小时）</label>
        <input type="number" id="cfg-op-min" min="0.5" max="12" step="0.5" value="${min}" />
      </div>
      <div class="field"><label>最长间隔（小时）</label>
        <input type="number" id="cfg-op-max" min="0.5" max="12" step="0.5" value="${max}" />
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>静默开始</label>
        <input type="time" id="cfg-op-quiet-start" value="${esc(quietStart)}" />
      </div>
      <div class="field"><label>静默结束</label>
        <input type="time" id="cfg-op-quiet-end" value="${esc(quietEnd)}" />
      </div>
    </div>
    <div class="hint">静默时段内不发，顺延到结束（默认 23:30–08:30）。另外：15 分钟内刚聊过、或她自己已经安排了话，这轮会推迟，不会插嘴。</div>
    <div class="field" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" type="button" id="op-save-btn">保存定时问候</button>
      <button class="btn btn-small" type="button" id="op-test-btn">现在试一条</button>
      <span class="muted" id="op-status"></span>
    </div>
    <div class="hint" id="op-next"></div>`;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>当前模型（点击切换）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field"><label>服务预设</label>
      <select id="new-service-preset">${modelServiceOptionsHtml(c.api?.baseUrl)}</select>
      <div class="hint" id="new-service-note">${esc(initialServiceNote(c))}</div>
    </div>
    <div class="field-row">
      <div class="field"><label>Base URL（可改）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" placeholder="例如 https://api.deepseek.com/v1 或自建网关" value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空/掩码 = 保持原 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="hint" id="model-fetch-note">有的服务需要先填好这家的 API Key，「获取列表」才拉得到（换服务后请填这家的 Key）；如果填了 Key 仍拉不到，就是该服务不提供模型列表，直接在下面「模型 id」手填一行或多行，点「确认添加 / 保存」即可。</div>
    <div class="field"><label>模型 id（拉不到列表时手填；已有的模型用上面「当前模型」切换）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">先点「获取列表」从服务商官网拉；拉不到（或清单里没有想要的）就在这里手填一行或多行，点「确认添加 / 保存」加进当前服务的模型列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加 / 保存</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint">${esc(state.lastProviderHint || '')}</div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
      <div class="field"><label>单次运行累计 Token 上限</label><input type="number" id="cfg-max-run-tokens" min="20000" max="1000000" step="10000" value="${esc(c.api.maxRunTokens ?? 160000)}" /></div>
      <div class="field"><label>模型上下文窗口（Token）</label><input type="number" id="cfg-context-window-tokens" min="16000" max="2000000" step="10000" value="${esc(c.api.contextWindowTokens ?? 1000000)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size: var(--fs-sm);align-self:center"></span></div>
    <details class="collapsible settings-advanced" id="thinking-advanced">
      <summary>高级：思考模式${esc(thinkingAdvancedSummary(c))}</summary>
      <div style="padding-top:8px">
        <div class="field" id="thinking-controls">
          <label>思考模式</label>
          <div id="thinking-seg-slot">${isSplitThinking(c) ? splitRowsHtml(c).inner : thinkingSegHtml(c)}</div>
          <div id="thinking-split-note">${isSplitThinking(c) ? splitRowsHtml(c).note : ''}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;font-size: var(--fs-md);font-weight:normal">
              <input class="sw" type="checkbox" id="cfg-thinking-split" ${isSplitThinking(c) ? 'checked' : ''} />
              <span>按任务分别设档（聊天 / 判断总结 / 写作 / 其他）</span>
            </label>
            <label id="cfg-thinking-default-row" style="display:${isSplitThinking(c) ? 'none' : 'flex'};align-items:center;gap:6px;font-size: var(--fs-md);font-weight:normal">
              <input class="sw" type="checkbox" id="cfg-thinking-default" ${thinkingIsDefault(c) ? 'checked' : ''} />
              <span>跟随服务商默认（不干预）</span>
            </label>
            <button class="btn btn-small" id="probe-thinking-btn" type="button" style="flex:none">测试思考能力</button>
          </div>
          <div class="hint" id="thinking-hint">${esc(thinkingHintText(c))}</div>
          <div class="hint" id="probe-thinking-result" style="${state.lastProbeNote ? '' : 'display:none'}">${esc(state.lastProbeNote || '')}</div>
        </div>
        <div class="field">
          <label>自定义档位映射（JSON，表外/自定义渠道用）</label>
          <textarea id="cfg-thinking-params" rows="3" style="width:100%" placeholder='例如 {"low":{"reasoning_effort":"low"},"high":{"reasoning_effort":"high"}}。填了这里，档位条就会按这些键出现（仅对表外/自定义渠道生效）。'>${esc(extraBodyText(c.api?.thinkingParams))}</textarea>
          <div class="hint" id="cfg-thinking-params-hint">键是档位（off/low/medium/high/max），值是请求里要带的字段；内置预设渠道走内置形状，不受这里影响。　<strong>密钥类字段（如 authorization）在下面显示为 hasXxx 占位，明文不下发；不改这两个框＝原样保留，动了就会按你看到的存。</strong></div>
        </div>
        <div class="field">
          <label>额外请求参数（JSON）</label>
          <textarea id="cfg-extra-body" rows="3" style="width:100%" placeholder='例如 {"reasoning":{"enabled":false}}。留空 = 不附加。'>${esc(extraBodyText(c.api?.extraBody))}</textarea>
          <div class="hint" id="cfg-extra-body-hint">填了就以最高优先级合并进每次请求（JSON 对象）；服务商文档里的怪参数都填这里，不用等适配。注意 stream 会被强制回非流式；model / messages / tools 会整段替换对应字段，排查异常时先清空这里。　<strong>密钥类字段（如 authorization）在下面显示为 hasXxx 占位，明文不下发；不改这两个框＝原样保留，动了就会按你看到的存。</strong></div>
        </div>
      </div>
    </details>
    <div class="settings-divider"></div>

    <h3>每日花费上限</h3>
    <div class="field">
      <label class="checkbox-row"><input type="checkbox" id="cfg-budget-enabled" ${c.api?.budget?.enabled === true ? 'checked' : ''} />
        <span>启用（按估算价累计当日用量；仅本地开关，不产生任何实际扣费动作）</span></label>
    </div>
    <div class="field-row">
      <div class="field"><label>每日上限（元）</label>
        <input type="number" id="cfg-budget-daily" min="0" step="1" value="${esc(c.api?.budget?.dailyYuan ?? 20)}" style="width:120px" /></div>
      <div class="field"><label>超限后</label>
        <select id="cfg-budget-onexceed">
          <option value="degrade" ${(c.api?.budget?.onExceed || 'degrade') === 'degrade' ? 'selected' : ''}>降级：只回应 @（私聊与手动唤醒不受限）</option>
          <option value="block" ${c.api?.budget?.onExceed === 'block' ? 'selected' : ''}>停止：新消息不处理</option>
        </select></div>
    </div>
    <div class="hint">通知需要先配好管理员 QQ；跨日自动重置。未定价的运行不计入金额，但会在用量状态里标出次数，避免"没价＝永远不超限"。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-budget-notify" ${c.api?.budget?.notify !== false ? 'checked' : ''} />
      <label for="cfg-budget-notify">超限时私聊通知管理员一次</label></div>

    <div class="settings-divider"></div>

    <h3>成本怎么算</h3>
    <div class="hint" style="margin-bottom:8px">选一个就行，不用逐个模型配。默认第一项。</div>
    <div id="cost-mode-block">
      <label class="radio-row"><input type="radio" name="cost-mode" value="official"
        ${(!c.api.costMode || c.api.costMode === 'official') ? 'checked' : ''} />
        <span>按模型官方价估（数字是估算，不是你的账单）</span></label>
      <label class="radio-row"><input type="radio" name="cost-mode" value="multiplier"
        ${c.api.costMode === 'multiplier' ? 'checked' : ''} />
        <span>我按渠道价：官方价 ×
          <input type="number" id="cfg-cost-multiplier" step="0.01" min="0" value="${esc(c.api.costMultiplier ?? 1)}" style="width:80px" />
          （例如 0.5 = 打五折；中转站常用；填 0 = 这个渠道不花钱）</span></label>
      <label class="radio-row"><input type="radio" name="cost-mode" value="subscription"
        ${c.api.costMode === 'subscription' ? 'checked' : ''} />
        <span>我按月付 ¥
          <input type="number" id="cfg-cost-monthly" step="1" min="0" value="${esc(c.api.costMonthlyFee ?? 0)}" style="width:90px" />
          /月（订阅套餐、本地自建；不按 token 算）</span></label>
      <label class="checkbox-row" style="margin-top:6px"><input type="checkbox" id="cfg-fallback-current"
        ${c.api.fallbackToCurrentModel !== false ? 'checked' : ''} />
        <label for="cfg-fallback-current">没有价格的模型按「当前模型」的价估算（推荐：避免出现"未定价"）</label></label>
      <div class="hint" id="cost-mode-status" style="margin-top:4px"></div>
    </div>

    <details class="collapsible settings-advanced" id="price-advanced">
      <summary>高级：逐模型定价 / 渠道价目表 / 远程价格表</summary>
      <div class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
        <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

      <div class="field" style="margin-top:6px"><label>远程价格表 URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-price-remote-url" placeholder="留空 = 项目默认价格表；none = 关闭" value="${esc(c.api.priceRemoteUrl || '')}" style="flex:1" />
          <button class="btn btn-small" id="price-feed-refresh-btn" title="不等定时，立即拉一次">立即拉取</button>
        </div>
        <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
      </div>

      <!-- 从渠道自动拉价（探测）：把中转站/自建渠道公布的价格拉下来，写成"渠道价" -->
      <div class="settings-divider"></div>
      <h3>从渠道自动拉价</h3>
    <div class="field">
      <label>渠道地址（默认用上面的 Base URL；one-api / new-api 站会读它的 /api/pricing 倍率）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="probe-url" placeholder="https://api.example.com/provider/v1"
          value="${esc(c.api.baseUrl || '')}" style="flex:1" />
        <button class="btn btn-small" id="probe-btn">探测</button>
      </div>
      <div class="hint" id="probe-status" style="margin-top:4px">探测只做预览，不会改动任何配置；确认后才写成"渠道价"。</div>
      <div id="probe-result" class="hidden" style="margin-top:8px"></div>
    </div>

    <!-- 渠道价目表：每个渠道一份，自动拉取（配置里的 channelPriceFeeds） -->
    <div class="field" style="margin-top:10px"><label>渠道价目表（每个渠道一份，启动时自动刷新）</label>
      <div id="channel-feeds"></div>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
        <input type="text" id="channel-feed-vendor" placeholder="渠道名（留空用当前渠道）" style="flex:1;min-width:160px" />
        <input type="text" id="channel-feed-url" placeholder="价目表 URL（http(s)://…/pricing.json）" style="flex:2;min-width:200px" />
        <button class="btn btn-small" id="channel-feed-add">添加并拉取</button>
      </div>
      <div class="hint" id="channel-feed-hint" style="margin-top:4px">拉到的价只在该渠道的调用上生效；手填的价仍然优先。</div>
    </div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">生效价</span>
          <span class="pc-effective" id="pc-effective">—</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
      <div class="pc-subhead">自填单价（元/百万 token）</div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-input-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="pc-price-btn">给这个模型定价</button>
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size: var(--fs-sm);align-self:center">填你的渠道实付价（覆盖官方价）；也可为多个模型分别设定</span>
    </div>
    </details>

`;
}

function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        <option value="doubao" ${prov === 'doubao' ? 'selected' : ''}>豆包搜索（火山 Agent Plan）</option>
        <option value="tavily" ${prov === 'tavily' ? 'selected' : ''}>Tavily</option>
        <option value="aggregate" ${prov === 'aggregate' ? 'selected' : ''}>聚合搜索（多源并发）</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size: var(--fs-sm)"></span>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-chat')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="doubao-search-fields" style="${prov === 'doubao' ? '' : 'display:none'}">
      <label>豆包搜索 API Key（火山 Agent Plan 搜索服务 Key / 环境变量 DOUBAO_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-doubao-key" value="${esc(c.webSearch?.doubao?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-doubao-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="tavily-search-fields" style="${prov === 'tavily' ? '' : 'display:none'}">
      <label>Tavily API Key（免费档 1000 次/月 / 环境变量 TAVILY_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-tavily-key" value="${esc(c.webSearch?.tavily?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-tavily-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="aggregate-search-fields" style="${prov === 'aggregate' ? '' : 'display:none'}">
      <label>聚合源列表（逗号分隔，按优先级排序；可选 tavily / doubao / bing / baidu / zhipu / bocha / metaso，选中的源需已配好 Key）</label>
      <input type="text" id="cfg-aggregate-sources" value="${esc((c.webSearch?.aggregate?.sources || ['tavily', 'doubao', 'bing']).join(','))}" placeholder="tavily,doubao,bing" style="flex:1" />
      <label>每源结果条数（2~6）</label>
      <input type="number" id="cfg-aggregate-count" min="2" max="6" value="${esc(c.webSearch?.aggregate?.count || 4)}" style="width:100px" />
    </div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="new-sp-apikey-peek" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size: var(--fs-sm)"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const vis = mem.visibility || {};   // #13 可见性策略（默认 global + 不隐藏）
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-handoff" ${mem.handoffEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-handoff">允许模型自动写「会话交接」（下次唤醒时带上）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>
    <div class="field-row" style="align-items:start">
      <div class="field"><label>发现新人的最少发言条数</label>
        <input type="number" id="cfg-mem-discover-min" min="1" max="500" value="${esc(mem.discoverMinMessages ?? 20)}" /></div>
      <div class="field"><label>单次最多发现几人</label>
        <input type="number" id="cfg-mem-discover-max" min="1" max="20" value="${esc(mem.discoverMaxMembers ?? 3)}" /></div>
    </div>
    <div class="hint">整理（含自动整理与「整理本群记忆」）时，把"最近 2000 条里发言达到这个条数、且还没有任何印象"的群友挑出来，读他的发言提炼新印象（单次最多挑上面那个人数）。<b>门槛越高，新人越难进入记忆</b>：高于群里多数人的发言量时，这些人可能永远不会有印象。模型自己很少主动记，这里是主要入口。默认 20 条 / 3 人。</div>
    <div class="field"><label>记忆可见性</label>
      <select id="cfg-mem-visibility">
        <option value="global" ${vis.mode === 'global' ? 'selected' : ''}>全局（默认）：所有会话的印象都注入</option>
        <option value="perChat" ${vis.mode === 'perChat' ? 'selected' : ''}>仅本会话：只注入来源含当前会话的印象</option>
      </select>
      <div class="hint">改成「仅本会话」后，模型在群里只看得到这个群里观察到的印象；控制台人物记忆页仍可查全部（来源不交给模型）。</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-hideprivate" ${vis.hidePrivateInGroup ? 'checked' : ''} />
      <label for="cfg-mem-hideprivate">群聊里隐藏「私聊来源」的印象</label></div>`;
}

function renderTimeControlSection(c) {
  if (state.timeControlConfig !== c) {
    state.timeControlConfig = c;
    state.timeControlDraft = structuredClone(c.timeControl || {
      enabled: false, schedule: { mode: 'deepseek-offpeak', windows: [] }, overrides: {}
    });
  }
  state.timeControlTarget ||= '';
  return `
    <section class="time-control-settings">
      <h3>时间控制</h3>
      <div class="checkbox-row">
        <input type="checkbox" id="tc-enabled" ${state.timeControlDraft.enabled ? 'checked' : ''} />
        <label for="tc-enabled">启用时间控制</label>
      </div>
      <div class="time-control-summary">
        <span>Asia/Shanghai · UTC+8</span><span id="tc-live-state"></span>
      </div>
      <div class="field"><label for="tc-target">配置对象</label>
        <select id="tc-target">${timeControlTargetOptions()}</select>
      </div>
      <div id="tc-rule-editor">${renderTimeRuleEditor()}</div>
      <div class="time-control-summary" id="tc-next-change"></div>
    </section>`;
}

function renderTimeRuleEditor() {
  const draft = state.timeControlDraft;
  const key = state.timeControlTarget;
  const rule = key ? draft.overrides[key] || { mode: 'inherit', windows: [] } : draft.schedule;
  const modes = key ? Object.keys(TIME_RULE_LABELS) : Object.keys(TIME_RULE_LABELS).filter((mode) => mode !== 'inherit');
  const preset = rule.mode === 'deepseek-offpeak' ? `
    <dl class="time-control-preset">
      <dt>周一至周五</dt><dd>00:00–09:00 / 12:00–14:00 / 18:00–24:00</dd>
      <dt>周六、周日</dt><dd>全天</dd>
    </dl>` : '';
  return `
    <div class="field"><label for="tc-mode">活跃规则</label>
      <select id="tc-mode">${modes.map((mode) =>
        `<option value="${mode}" ${rule.mode === mode ? 'selected' : ''}>${TIME_RULE_LABELS[mode]}</option>`
      ).join('')}</select>
    </div>
    ${preset}
    ${rule.mode === 'custom' ? `
      <div id="tc-windows">
        ${(rule.windows || []).map((window, index) => `
          <div class="tc-window" data-index="${index}">
            <div class="tc-days">${TIME_DAYS.map((label, i) =>
              `<label><input type="checkbox" data-day="${i + 1}" ${(window.days || []).includes(i + 1) ? 'checked' : ''} />${label}</label>`
            ).join('')}</div>
            <div class="field"><label>开始</label><input class="tc-start" type="time" value="${esc(window.start)}" /></div>
            <div class="field"><label>结束</label><input class="tc-end" type="text" inputmode="numeric" value="${esc(window.end)}" placeholder="24:00" /></div>
            <button type="button" class="icon-btn tc-remove" data-index="${index}" title="删除时间段" aria-label="删除时间段">×</button>
          </div>`).join('')}
      </div>
      <button type="button" class="icon-btn" id="tc-add" title="添加时间段" aria-label="添加时间段">+</button>
    ` : ''}`;
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>`;
}

function modelServiceOptionsHtml(currentUrl) {
  // 默认选中"当前地址对应的那家"（认不出来就选「自定义」）——避免下拉停在第一项、
  // 与实际在用的服务不一致（2026-09-27 控制台实测发现：实际用 Command Code，
  // 下拉却默认停在 DeepSeek 官方，容易被误读）。
  const matched = currentUrl ? uiServiceOfUrl(currentUrl) : null;
  const sel = matched ? matched.id : (currentUrl ? 'custom' : 'deepseek');
  return MODEL_SERVICES_UI.map((s) => `<option value="${s.id}"${s.id === sel ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
}

/** 思考区随界面上的 Base URL 联动（未保存也要跟着变）：切换供应商后段位与提示必须换家。 */
function syncThinkingUi(url, paramsOverride, splitOverride) {
  const fake = {
    api: {
      ...(state.config?.api || {}),
      baseUrl: String(url || ''),
      ...(paramsOverride !== undefined ? { thinkingParams: paramsOverride } : {})
    },
    providers: state.providers || []
  };
  // 分设开关：优先用显式传参；否则以"界面上勾选状态"为准（用户刚勾的先生效，不用等保存）；再退回配置。
  const splitCbNow = document.getElementById('cfg-thinking-split');
  const split = splitOverride !== undefined
    ? Boolean(splitOverride)
    : (splitCbNow ? splitCbNow.checked : isSplitThinking(fake));
  if (splitCbNow) splitCbNow.checked = split;
  const rows = split ? splitRowsHtml(fake) : null;
  const slot = document.getElementById('thinking-seg-slot');
  if (slot) {
    slot.innerHTML = split ? rows.inner : thinkingSegHtml(fake);
    // 整块 innerHTML 会连**滑块**一起换掉（滑块是 enhanceSeg 插进去的子元素），
    // 而选中态现在完全靠滑块托底（.seg-item.selected 是"白字 + 透明底"）。
    // 不补这一次，重画之后选中档就是白字贴浅色轨道 —— 看不见。
    // 必须用 enhanceSeg（幂等）：它除了插滑块、定位，还会挂上"点击后重新对位"与方向键/Home/End
    // 两个监听 —— refreshSeg 只定位不挂监听，重建出来的新节点上这些全是缺的（方向键按了没反应、
    // 点别的档位滑块不动）。2026-10-08 审查修正。
    enhanceSeg(slot);
  }
  const splitNote = document.getElementById('thinking-split-note');
  if (splitNote) splitNote.innerHTML = split ? rows.note : '';
  const defRow = document.getElementById('cfg-thinking-default-row');
  if (defRow) defRow.style.display = split ? 'none' : 'flex';
  const hint = document.getElementById('thinking-hint');
  if (hint) hint.textContent = thinkingHintText(fake);
  const seg = document.getElementById('thinking-seg');
  const cb = document.getElementById('cfg-thinking-default');
  if (seg && cb && !split) seg.classList.toggle('dim', cb.checked);
  const summary = document.querySelector('#thinking-advanced summary');
  if (summary) summary.textContent = `高级：思考模式${thinkingAdvancedSummary(fake)}`;
  // 探测结论文案只在"当前地址确实有实测记录"时保留：换了供应商/地址还挂着上一家的
  // 实测结论，会和提示行的「未实测」自相矛盾（审查 2026-09-28）。
  const noteNode = document.getElementById('probe-thinking-result');
  if (noteNode && state.lastProbeNote) {
    const urlHost = hostOfUrl(fake.api.baseUrl);
    const probeP = (fake.providers || []).find((x) => x.id === fake.api?.provider);
    const probeAlive = (probeP && probeP.thinkingProbe && probeP.thinkingProbe.ok !== false
        && hostOfUrl(probeP.baseURL) === urlHost)
      || (fake.api?.thinkingProbe && fake.api.thinkingProbe.ok !== false
        && hostOfUrl(fake.api.thinkingProbe.baseUrl) === urlHost);
    if (!probeAlive) {
      state.lastProbeNote = '';
      noteNode.style.display = 'none';
    }
  }
}

function thinkingIsDefault(c) {
  const v = currentThinkingRaw(c);
  return v === 'on' || v === true || v == null;
}

/** 折叠行摘要：不展开也能看到当前思考设置（默认视图保持一行，不打扰）。 */
function thinkingAdvancedSummary(c) {
  const v = currentThinkingRaw(c);
  const level = { low: '低', medium: '中', high: '高', max: '最高' }[v];
  const label = v && typeof v === 'object' ? '按用途分设'
    : v === 'off' ? '关闭' : level || '跟随服务商默认';
  const extra = c.api?.extraBody && Object.keys(c.api.extraBody || {}).length ? ' · 额外参数已设置' : '';
  // 探测结论只在"记录的地址与当前地址同一家"时显示（与提示行同口径）——否则换了供应商还挂着"已实测"。
  const probeRec = c.api?.thinkingProbe && c.api.thinkingProbe.ok !== false
    && hostOfUrl(c.api.thinkingProbe.baseUrl) === hostOfUrl(c.api?.baseUrl) ? c.api.thinkingProbe : null;
  const probe = probeRec ? ' · 已实测' : '';
  return `（当前：${label}${extra}${probe}）`;
}

/** 统一模式（一条管全部任务，配「跟随服务商默认」勾选）。 */
function thinkingSegHtml(c) {
  const service = uiServiceOfUrl(c.api?.baseUrl);
  const stops = thinkingStops(c);
  const rawNow = currentThinkingRaw(c);
  const isPerPurpose = Boolean(rawNow && typeof rawNow === 'object' && !Array.isArray(rawNow));
  if (stops.length < 2 && !isPerPurpose) {
    return `<div class="hint" style="margin:2px 0 0">${service && service.canDisable === false
      ? '这条渠道没有可调的思考档位（该服务不支持调整/关闭思考）。'
      : '未实测：先点「测试思考能力」探明可用档位，或用下方「额外请求参数」自定义。'}</div>`;
  }
  const cur = typeof rawNow === 'string' && stops.includes(rawNow)
    ? rawNow
    : (stops.includes('off') ? 'off' : stops[0]);
  const tips = isPerPurpose
    ? `<div class="hint" style="margin:2px 0 0">当前为按用途分别设置（${esc(Object.entries(rawNow).map(([k, v3]) => `${k}=${v3}`).join(' / '))}）；勾下面的「聊天单独设档」可继续按用途调整，或点档位改为统一值。</div>`
    : '';
  return `${tips}${renderThinkingSeg('thinking-seg', stops, cur, service, false)}`;
}

function thinkingHintText(c) {
  const service = uiServiceOfUrl(c.api?.baseUrl);
  // 探测结果只在"记录的地址与当前地址同一家"时展示——换了供应商就该显示"未实测"。
  const urlHost = hostOfUrl(c.api?.baseUrl);
  const providerProbe = (() => {
    const p = (c.providers || []).find((x) => x.id === c.api?.provider);
    return p && p.thinkingProbe?.ok !== false && hostOfUrl(p.baseURL) === urlHost ? p.thinkingProbe : null;
  })();
  const apiProbe = c.api?.thinkingProbe && c.api.thinkingProbe.ok !== false
    && hostOfUrl(c.api.thinkingProbe.baseUrl) === urlHost ? c.api.thinkingProbe : null;
  const probe = providerProbe || apiProbe || null;
  const bits = [];
  const hasParams = c.api?.thinkingParams && Object.keys(c.api.thinkingParams || {}).length > 0;
  bits.push(service
    ? `渠道：${service.label}${service.defaultNote ? `（${service.defaultNote}）` : ''}。${service.note}`
    : (hasParams
      ? `渠道未识别：档位来自你的「自定义档位映射」（${Object.keys(c.api.thinkingParams).join('/')}）。`
      : '渠道未识别：在下面「自定义档位映射」里填 {\"low\":{\"reasoning_effort\":\"low\"}, …} 就能用档位条；或用「额外请求参数」整体自定义。'));
  bits.push('每个供应商各自一条设置：这里改的只对当前这家生效。');
  bits.push('勾「按任务分别设档」：聊天（含其中的工具调用）/ 判断 · 总结（记忆整理、身份与关系评估、收不收表情）/ 写作（每日动态、空间互动文案）/ 其他任务，各选各的档；每行选「默认」= 跟随服务商默认。');
  if (probe) {
    const when = probe.checkedAt ? new Date(probe.checkedAt).toLocaleDateString() : '';
    bits.push(probe.canDisable === true ? `已实测（${when}）：可关闭。`
      : probe.canDisable === false ? `已实测（${when}）：忽略关闭参数，思考仍在发生。`
        : `已实测（${when}）：未配置关闭参数，无法据此断定。`);
  } else {
    bits.push('未实测：点右侧「测试思考能力」按真实请求探明。');
  }
  return bits.join(' ');
}

// 消息类型：按类型决定机器人读不读这类内容。关掉只是不让内容进提示词/不进模型 ——
// 消息本身照常进聊天记录，存档、检索、金句墙都不受影响（2026-10-15 issue #34）。
function renderMessageTypesSection(c) {
  const mt = c.messageTypes || {};
  const visionOn = c.api?.vision !== false;
  return `
    <h3 id="settings-message-types">消息类型</h3>
    <div class="hint" style="margin-bottom:8px">按类型决定机器人<b>读不读</b>这类内容。关掉不影响消息进聊天记录，
      只是不让它进提示词、不进模型 —— 省的是 token 与上下文窗口。
      （合并转发那条要注意：<b>展开后的文本就是存档里的那一行</b>，关掉后存档与控制台里留的是占位符，
      等内容被按需读取时才补上。）</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-expand-forward" ${mt.expandForward !== false ? 'checked' : ''} />
      <label for="cfg-expand-forward">自动展开合并转发 / 聊天记录卡片</label></div>
    <div class="hint" style="margin-left:26px">关掉后正文只留一行占位符，模型需要时自己调 read_forward 展开；
      <b>被 @ 的那条仍会自动展开</b>。一条 20 条的记录展开后是几千字符，还会跟着进存档和之后每一轮的上下文。</div>
    <div class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="cfg-mt-images" ${mt.images !== false ? 'checked' : ''} />
      <label for="cfg-mt-images">查看消息里的图片与表情包</label></div>
    <div class="hint" style="margin-left:26px">关掉后看图工具（get_message_images）从工具表摘掉，提示词改成"看不到图片内容"；
      消息本身照常存档。<b>视频画面也依赖这个工具</b>，关掉后视频只保留声音。
      表情包的<b>自动收藏</b>由「聊天设置 → 表情包」里的收藏开关单独控制，不受这里影响。</div>
    <div class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="cfg-mt-stickers" ${mt.stickers !== false ? 'checked' : ''} />
      <label for="cfg-mt-stickers">查看表情库里没备注的图</label></div>
    <div class="hint" style="margin-left:26px">只影响"看"：按备注名发送表情（send_sticker）不受影响；
      关掉后 get_sticker_image 从工具表摘掉，模型只能按备注名挑选。</div>
    <div class="hint" style="margin-top:8px">以上两项叠加在「模型 API」页的「图片输入」开关之上 —— 当前<b>${visionOn ? '开' : '关'}</b>
      （关掉时看图工具会一律摘掉，这里的两项不起作用）。</div>
    <div class="checkbox-row" style="margin-top:8px"><input type="checkbox" id="cfg-video-frames" ${mt.videoFrames !== false ? 'checked' : ''} />
      <label for="cfg-video-frames">查看视频画面（抽 4 帧拼 2×2）</label></div>
    <div class="hint" style="margin-left:26px">关掉后视频只剩声音（get_message_audio 转写），
      省一次抽帧和一次视觉调用；提示词会同步改成"你只能拿到声音"。</div>`;
}

function renderTokenSaverSection(c) {
  const mode = ['off', 'balanced', 'aggressive'].includes(c.tokenSaver?.mode) ? c.tokenSaver.mode : 'off';
  const saver = state.status?.tokenSaver || null;
  const caps = saver?.capsByMode || {};
  // 档位条数按 被艾特/关键词/随机 三档说明（allCount 与被艾特档同值），数字全部来自服务端上限表
  const summarize = (m) => {
    const k = caps[m];
    if (!k) return '';
    return `档位读 ${k.atCount}/${k.keywordCount}/${k.randomCount} 条，轮数 ≤${k.maxRounds}、单次预算 ≤${Math.round(k.maxRunTokens / 10000)} 万 token，`
      + `交接 ≤${k.handoffMaxChars} 字符、印象 ≤${k.memoryBlockChars} 字符、表情清单 ≤${k.promptMaxStickers} 条`;
  };
  const rows = (saver?.rows || []).map((row) => `<tr>
      <td>${esc(row.label)}</td>
      <td class="muted">${esc(row.user)}</td>
      <td>${row.clamped ? `<strong>${esc(row.effective)}</strong> <span class="muted">（被夹住）</span>` : esc(row.effective)}</td>
    </tr>`).join('');
  return `
    <h3 id="settings-token-saver">省 Token</h3>
    <div class="hint" style="margin-bottom:8px">开启后只给下面这些项<b>夹上限</b>，不改写你在各分区填的值 —— 关掉立刻恢复原样。
      每次模型调用的固定底（系统提示 + 工具定义，约 1.2 万-1.5 万 token）不受此影响，
      想再省就配合「聊天设置」的响应概率与「搜索服务 / 图片输入」开关。</div>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="off" ${mode === 'off' ? 'checked' : ''} />
      <span>关闭：完全按你自己的设置</span></label>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="balanced" ${mode === 'balanced' ? 'checked' : ''} />
      <span>省：${esc(summarize('balanced') || '档位条数、轮数、预算、交接/印象、表情清单都收一档')}</span></label>
    <label class="radio-row"><input type="radio" name="token-saver-mode" value="aggressive" ${mode === 'aggressive' ? 'checked' : ''} />
      <span>很省：${esc(summarize('aggressive') || '再收一档，接话更省但读的历史更少')}</span></label>
    <div class="settings-divider"></div>
    <h3>实际生效值</h3>
    ${rows
      ? `<div class="table-wrap"><table class="usage-table"><thead><tr><th>项目</th><th>你的设置</th><th>当前生效</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="hint">正在读取生效值…（刷新页面后显示）</div>'}
    <div class="hint" style="margin-top:8px">改完点底部「保存设置」生效；效果在「用量」页按天看得到。</div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>控制台安全</h3>
    <div class="field-row">
      <div class="field"><label>当前 Token</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-console-token-current" autocomplete="current-password" style="flex:1"
            placeholder="${c.server?.hasToken ? '输入当前 Token' : '当前未设置 Token'}" />
          <button class="btn btn-small" id="cfg-console-token-current-peek" type="button">显示</button>
        </div></div>
      <div class="field"><label>新 Token</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-console-token-new" autocomplete="new-password" style="flex:1"
            placeholder="16-128 位字母、数字或 . _ ~ -" />
          <button class="btn btn-small" id="cfg-console-token-new-peek" type="button">显示</button>
        </div></div>
      <div class="field"><label>确认新 Token</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-console-token-confirm" autocomplete="new-password" style="flex:1"
            placeholder="再次输入新 Token" />
          <button class="btn btn-small" id="cfg-console-token-confirm-peek" type="button">显示</button>
        </div></div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:18px">
      <button type="button" class="btn btn-small" id="change-console-token-btn">更新控制台 Token</button>
      <span class="hint" id="console-token-result">更新后旧 Token 和其他已登录会话立即失效。</span>
    </div>
    <h3>界面</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>`;
}

function renderOnebotSection(c) {
  const containerMode = c?.runtime?.container === true;
  const hb = ['auto', 'on', 'off'].includes(c.onebot?.wsHeartbeat) ? c.onebot.wsHeartbeat : 'auto';
  const windowMin = Math.max(0, Math.round(Number(c.onebot?.catchupReplyWindowMs ?? 30 * 60 * 1000) / 60000));
  return `
    <h3 id="settings-onebot">外部 OneBot v11 服务</h3>
    <div class="hint" style="margin-bottom:10px">协议端由 Linux 运维独立管理。本服务只连接正向 WebSocket 和 HTTP API。</div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.onebot.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.onebot.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obtoken" placeholder="${c.onebot.hasAccessToken ? '已保存；留空保持不变' : '未设置'}"
            autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
        </div>
        <div class="hint">「显示」取回已保存的令牌明文；再点「隐藏」输入框回到空 —— 这个字段的「保持不变」就是留空。</div></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obhttptoken" placeholder="${c.onebot.hasHttpAccessToken ? '已保存；留空保持不变' : '未设置'}"
            autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>WebSocket 心跳策略</label>
        <select id="cfg-wsheartbeat">
          <option value="auto"${hb === 'auto' ? ' selected' : ''}>自动（推荐）</option>
          <option value="on"${hb === 'on' ? ' selected' : ''}>始终发送 ping</option>
          <option value="off"${hb === 'off' ? ' selected' : ''}>从不发送 ping</option>
        </select>
        <div class="hint">心跳用来发现"连接已死但事件没到"。NapCat 收到 PING 会直接断开连接（Issue #22），
        自动模式下一次这种断开后就不再发送。</div></div>
      <div class="field"><label>补课回复窗口（分钟）</label>
        <input type="number" id="cfg-catchup-window" min="0" step="5" value="${windowMin}" />
        <div class="hint">断线/重启后补回的消息，超过这个时长的只入库不回复（避免回来就刷屏回一小时前的话）；
        填 0 = 一律只补记录。默认 30 分钟。</div></div>
    </div>
    <div id="onebot-status-line">${onebotStatusLineHtml()}</div>
    <div class="hint">改完 OneBot 地址、令牌或心跳策略后，执行 <code>${containerMode ? 'docker compose restart agent' : 'manage.sh restart'}</code> 生效（连接只在启动时建立一次，改完不重启还是旧配置）。</div>

    <div class="settings-divider"></div>
    <h3>协议端（SnowLuma）</h3>
    <div id="snowluma-version-box" class="hint">正在读取协议端版本…</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 6px">
      <button type="button" class="btn btn-small" id="snowluma-check-btn">重新检查</button>
      <button type="button" class="btn btn-primary btn-small" id="snowluma-update-btn">更新协议端</button>
      <button type="button" class="btn btn-small" id="snowluma-rollback-btn">回滚到上一版</button>
      <span class="hint muted" id="snowluma-action-note" style="margin:0"></span>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowluma-auto" ${c.autoUpdate?.snowluma?.enabled === true ? 'checked' : ''} ${containerMode ? 'disabled' : ''} />
      <label for="cfg-snowluma-auto">自动更新协议端（落后于项目基线就自动升级，每 6 小时检查一次；失败自动回滚）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowluma-follow-baseline" ${c.autoUpdate?.snowluma?.followBaseline === false ? '' : 'checked'} ${containerMode ? 'disabled' : ''} />
      <label for="cfg-snowluma-follow-baseline">随智能体版本对齐协议端（推荐：更新到新版本时，若新版带的协议端基线更高就自动升级一次；<b>设了自定义镜像的不受影响</b>）</label></div>
    <div class="hint">${containerMode
      ? '容器模式：协议端由 compose 管理，上面两个开关不会执行；升级请改 compose 里的镜像 tag 后重建容器。'
      : '升级只改协议端目录 .env 里的镜像 tag 再重建容器：端口与数据卷都不动，所以 <b>QQ 登录态保留</b>；更新期间机器人会短暂离线（约 10~30 秒）。协议端低于 1.14.20 时，表情包在 QQ 里会显示成图片。'}</div>`;
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '还没有模型：请先在「模型 API」里选服务预设或填地址，再点「获取列表」添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size: var(--fs-sm);white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size: var(--fs-xs)">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size: var(--fs-xs)">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!await askForConfirmation(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  // 打开前的文案先快照：取消失败/取消关闭时要还原回去。
  // 以前"取消"只做了 overlay.remove()，标签就一直停在"拉取中…"（2026-09-29 用户实测）
  const resultEl = $('#pick-result');
  const prevLabel = resultEl ? resultEl.textContent : '';
  if (resultEl) resultEl.textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    if (resultEl) resultEl.textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    if (resultEl) resultEl.textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // 关闭（「取消」或点弹窗外的空白）：还原到打开前的文案，别把"拉取中…"留在页面上
  const closePicker = () => {
    overlay.remove();
    if (resultEl) resultEl.textContent = prevLabel;
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePicker();
  });
  $('#pick-cancel', overlay).addEventListener('click', closePicker);
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    if (resultEl) resultEl.textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

// ── 屏蔽名单 ──
// 左栏选白名单群聊，右栏拉取群成员逐个勾选；勾选 = 屏蔽。
// 弹窗内的改动只落在 pending 工作副本上，点「保存设置」才一次性 POST。
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  const selfId = String(cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size: var(--fs-sm);flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size: var(--fs-sm)"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size: var(--fs-xs)">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }

  // 只重画列表：搜索框（工具栏）留在重绘区之外 —— 输入时它不会被重建、焦点不丢。
  // 原来输入回调直接调 renderRight()，而它把含搜索框自己的整栏都 innerHTML 重画了，
  // 每敲一个字输入框就被换掉一次，表现就是"只能输一个字"（2026-10-02 用户反馈）。
  function renderList() {
    const listEl = right.querySelector('#bl-list');
    if (!listEl) return;
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      return `<label class="bl-member">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size: var(--fs-xs)">${esc(m.userId)}</span>
      </label>`;
    }).join('');
    listEl.innerHTML = rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>';
    listEl.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
  }

  // 整栏初始化（首次进入 / 切群后）：工具栏只在这里渲染一次，之后输入只走 renderList()
  function renderRight() {
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list"></div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => { kw = e.target.value.trim().toLowerCase(); renderList(); });
    renderList();
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（OneBot 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      // __replace__：清空的群要从配置里真删掉，深合并做不到
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ blocklist: { __replace__: pending } }) });
      state.config = data.config;
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

// 由 ui/core/widgets.js 机械拆出（2026-10-01，同一次「UI 结构治理」：把混装的叶子按域归位）。
// 从 app.js 机械切出（只切不改，语句逐字节一致）；跨文件引用走 import，可变状态挂 state。

/** 计费方式切换时：包月只显示"金额"，token 只显示三档单价。 */
function syncPriceDialogBilling() {
  const billing = String($('#price-dialog-billing')?.value || 'token');
  const flatRow = $('#price-dialog-flat-row');
  for (const id of ['#price-dialog-token-row', '#price-dialog-token-row-2', '#price-dialog-token-row-3']) {
    const el = $(id);
    if (el) el.style.display = billing === 'flat' ? 'none' : '';
  }
  if (flatRow) flatRow.style.display = billing === 'flat' ? '' : 'none';
  const hint = $('#price-dialog-hint');
  if (hint) {
    hint.textContent = billing === 'flat'
      ? '包月/订阅：这些调用不按 token 计价，面板把它作为固定支出单列（不计入按量成本）。'
      : billing === 'none'
        ? '本地/自建模型：只统计 token，不计费（也不再算"未定价"）。'
        : '只写这一条价：同一个模型在不同渠道可以分别定价；官方价格表不会被改动，用量页会立刻按新价重算。';
  }
}

/**
 * 打开「给这个模型定价」弹窗。
 * 渠道下拉：当前渠道（默认）→ 全部渠道 → 配置里已出现过的渠道。
 * 预填当前生效价；保存只写这一条（官方表不动）。
 */
function openPriceDialog({ model, vendor } = {}) {
  const dlg = $('#price-dialog');
  if (!dlg) return;
  const cfg = state.config || {};
  const api = cfg.api || {};
  const customMap = api.modelPrices || {};
  const currentVendor = String(vendor || state.modelPrices?.currentVendor || '');
  const modelId = String(model || api.model || '').trim();
  state.priceDialogState = { model: modelId, vendor: currentVendor };

  const channels = new Set();
  for (const key of Object.keys(customMap)) {
    const i = key.indexOf('：');
    if (i > 0) channels.add(key.slice(0, i));
  }
  if (currentVendor) channels.delete(currentVendor);
  const options = [];
  if (currentVendor) options.push({ value: currentVendor, label: `当前渠道（${currentVendor}）` });
  options.push({ value: '', label: '全部渠道（不分渠道）' });
  for (const v of [...channels].sort()) options.push({ value: v, label: v });
  const select = $('#price-dialog-channel');
  if (select) {
    select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    select.value = currentVendor;
  }

  const eff = effectivePriceFor(modelId, currentVendor);
  for (const [id, value] of [['#price-dialog-in', eff.in], ['#price-dialog-out', eff.out], ['#price-dialog-cached', eff.cached]]) {
    const el = $(id);
    if (el) el.value = Number(value) || 0;
  }
  const billingSel = $('#price-dialog-billing');
  if (billingSel) billingSel.value = eff.billing === 'flat' ? 'flat' : (eff.billing === 'none' ? 'none' : 'token');
  const amountEl = $('#price-dialog-amount');
  if (amountEl) amountEl.value = Number(eff.amount) || '';
  const periodEl = $('#price-dialog-period');
  if (periodEl) periodEl.value = eff.period === 'day' ? 'day' : 'month';
  syncPriceDialogBilling();

  const title = $('#price-dialog-title');
  if (title) title.textContent = modelId ? `给「${modelId}」定价` : '给模型定价';
  const sub = $('#price-dialog-sub');
  if (sub) {
    sub.textContent = eff.kind === 'unpriced'
      ? '这个模型现在没有价（成本算 0）。填一条只影响它，官方价格表不会被改动。'
      : `当前生效价来自：${eff.via || eff.source}。保存后这条价优先于官方价。`;
  }
  const result = $('#price-dialog-result');
  if (result) { result.textContent = ''; result.className = 'control-result muted'; }
  const delBtn = $('#price-dialog-delete');
  if (delBtn) delBtn.style.display = (eff.source === 'channel' || eff.source === 'custom') ? '' : 'none';
  if (!dlg.open) dlg.showModal();
}


export {
  openBlocklistModal, openModelAddModal, openModelDeleteModal, openModelPicker, openPriceDialog,
  openWhitelistPicker, renderSettingsImpl, renderTimeRuleEditor, resetMenuReveal, resolveTheme,
  startListPoller, syncPriceDialogBilling, syncThinkingUi
};