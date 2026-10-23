'use strict';
// 小本子页：只读展示 + 单条删除 + 整本导出。
//
// 为什么管理端不提供"写"：小本子是她自己记的东西，写入只走两条真实路径
// （模型工具 notebook_write、会话收尾/说说同步）。这里再开一个写入口，
// 同一份记忆就会有两种口径，以后排查"她为什么记得这个"会变复杂。
//
// 数据来自 /api/notebook（GET 列表 + stats、DELETE 单条、GET /export 导出）。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { askForConfirmation } from '../core/dom-util.js';
import { fmtTime } from '../core/format.js';
import { state } from '../core/state.js';

const KIND_LABEL = { memo: '记事', chat: '流水', self_post: '说说', self_said: '自己的话' };
const KIND_HINT = {
  memo: '她自己记下、值得长期记住的事（可跨会话使用）',
  chat: '每次会话收尾自动记的一条，只在对应会话里可见',
  self_post: '她自己发过的说说，从每日动态按说说 ID 同步',
  self_said: '她自己许下的承诺'
};

let searchTimer = 0;

/** 页面状态统一挂在 state 上（AGENTS.md：跨文件可变状态不许放模块级 let）。 */
function bag() {
  if (!state.notebook) {
    state.notebook = {
      notes: [],
      stats: null,
      selectedId: 0,
      query: '',
      kind: '',
      loading: false,
      bound: false
    };
  }
  return state.notebook;
}

function kindLabel(kind) {
  return KIND_LABEL[kind] || kind || '记录';
}

function previewOf(note) {
  const text = String(note.body || '').replace(/\s+/g, ' ').trim();
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function peopleText(note) {
  return (note.people || [])
    .map((p) => (p.name ? `${p.name}（${p.id}）` : String(p.id)))
    .join('、');
}

function renderHeader() {
  const s = bag();
  const box = $('#notebook-count');
  if (!box) return;
  const stats = s.stats || {};
  const kinds = stats.kinds || {};
  const parts = Object.entries(kinds)
    .filter(([, n]) => Number(n) > 0)
    .map(([kind, n]) => `${kindLabel(kind)} ${n}`);
  box.textContent = stats.total
    ? `· 共 ${stats.total} 条${parts.length ? `（${parts.join(' / ')}）` : ''}`
    : '';
}

function renderList() {
  const s = bag();
  const box = $('#notebook-items');
  if (!box) return;
  if (s.loading && !s.notes.length) {
    box.innerHTML = '<div class="list-head muted">加载中…</div>';
    return;
  }
  if (!s.notes.length) {
    box.innerHTML = `<div class="list-head muted">${s.query || s.kind ? '没有匹配的记录' : '小本子还是空的 —— 等她下次聊天或发说说后就会有记录'}</div>`;
    return;
  }
  box.innerHTML = s.notes.map((note) => {
    const selected = note.id === s.selectedId ? ' selected' : '';
    const people = peopleText(note);
    return `
      <div class="chat-item${selected}" data-id="${Number(note.id) || 0}" role="button" tabindex="0">
        <div class="chat-item-title">
          <span class="session-chat">${esc(kindLabel(note.kind))}</span>
          <span class="muted">${esc(fmtTime(note.ts))}</span>
        </div>
        <div class="chat-item-sub">${esc(previewOf(note))}</div>
        <div class="session-meta">
          <span>${esc(note.chatKey || '（无来源会话）')}</span>
          ${people ? `<span>${esc(people)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderDetail() {
  const s = bag();
  const box = $('#notebook-detail');
  if (!box) return;
  const note = s.notes.find((item) => Number(item.id) === Number(s.selectedId));
  if (!note) {
    box.innerHTML = '<div class="empty-hint">← 选择左边一条记录查看</div>';
    return;
  }
  const people = peopleText(note);
  box.innerHTML = `
    <div class="chat-item-title" style="margin-bottom:8px">
      <span class="session-chat">${esc(kindLabel(note.kind))}</span>
      <span class="muted">${esc(fmtTime(note.ts))}</span>
    </div>
    <div class="muted" style="margin-bottom:16px;font-size:var(--fs-sm);line-height:1.6">
      ${esc(KIND_HINT[note.kind] || '')}
      ${people ? `<br />涉及：${esc(people)}` : ''}
      ${note.chatKey ? `<br />来源会话：${esc(note.chatKey)}` : ''}
      ${note.source ? `<br />写入路径：${esc(note.source)}` : ''}
    </div>
    <div style="white-space:pre-wrap;line-height:1.75">${esc(note.body)}</div>
    <div style="margin-top:24px">
      <button class="btn btn-small" type="button" data-act="delete" data-id="${Number(note.id) || 0}">删除这条</button>
    </div>`;
}

async function refreshNotebook() {
  const s = bag();
  s.loading = true;
  renderList();
  try {
    const qs = new URLSearchParams();
    if (s.query) qs.set('q', s.query);
    if (s.kind) qs.set('kind', s.kind);
    qs.set('limit', '120');
    const data = await api(`/api/notebook?${qs.toString()}`);
    s.notes = Array.isArray(data.notes) ? data.notes : [];
    s.stats = data.stats || null;
    if (s.selectedId && !s.notes.some((n) => Number(n.id) === Number(s.selectedId))) {
      s.selectedId = 0;
    }
  } catch (error) {
    s.notes = [];
    const box = $('#notebook-items');
    if (box) box.innerHTML = `<div class="list-head muted">加载失败：${esc(error?.message || error)}</div>`;
  } finally {
    s.loading = false;
    renderHeader();
    renderList();
    renderDetail();
  }
}

async function deleteNote(id) {
  if (!id) return;
  const ok = await askForConfirmation('删除这条小本子记录？删掉后她也不会再想起这条。');
  if (!ok) return;
  try {
    await api(`/api/notebook/${id}`, { method: 'DELETE' });
    const s = bag();
    if (Number(s.selectedId) === Number(id)) s.selectedId = 0;
    await refreshNotebook();
  } catch (error) {
    const box = $('#notebook-detail');
    if (box) box.innerHTML = `<div class="empty-hint">删除失败：${esc(error?.message || error)}</div>`;
  }
}

async function exportNotebook() {
  try {
    const data = await api('/api/notebook/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `notebook-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    const box = $('#notebook-detail');
    if (box) box.innerHTML = `<div class="empty-hint">导出失败：${esc(error?.message || error)}</div>`;
  }
}

function bindNotebook() {
  const s = bag();
  if (s.bound) return;
  s.bound = true;

  const search = $('#notebook-search');
  if (search) {
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      // 300ms 防抖：每敲一个字都打一次 /api/notebook 没必要，而且会让列表闪
      searchTimer = setTimeout(() => {
        s.query = String(search.value || '').trim();
        refreshNotebook();
      }, 300);
    });
  }

  const kind = $('#notebook-kind');
  if (kind) {
    kind.addEventListener('change', () => {
      s.kind = String(kind.value || '');
      refreshNotebook();
    });
  }

  const exportBtn = $('#notebook-export');
  if (exportBtn) exportBtn.addEventListener('click', exportNotebook);

  const list = $('#notebook-items');
  if (list) {
    list.addEventListener('click', (event) => {
      const item = event.target.closest('.chat-item');
      if (!item) return;
      s.selectedId = Number(item.dataset.id) || 0;
      renderList();
      renderDetail();
    });
    // 键盘可达：列表项是 role=button/tabindex=0，回车与空格要能打开
    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('.chat-item');
      if (!item) return;
      event.preventDefault();
      item.click();
    });
  }

  const detail = $('#notebook-detail');
  if (detail) {
    detail.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act="delete"]');
      if (!btn) return;
      deleteNote(Number(btn.dataset.id) || 0);
    });
  }
}

async function loadNotebookView() {
  bag();
  bindNotebook();
  await refreshNotebook();
}

// 导出必须走底部具名清单：test/ui-module-graph 只认 ExportNamedDeclaration 的 specifiers
// （`export function foo(){}` 这种声明式导出它看不见，会被判成"没导出"）。
export { loadNotebookView };
