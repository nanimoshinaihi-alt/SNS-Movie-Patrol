import browser from '../lib/browser.js';
import { openOrFocusTab } from '../lib/tabs.js';
import {
  getSettings,
  saveSettings,
  getTargets,
  saveTargets,
  getState,
  removeState,
  getGroups,
  saveGroups,
  getGroupColors,
  saveGroupColors,
} from '../lib/storage.js';
import {
  ALL_GROUPS,
  UNGROUPED,
  isInGroup,
  validSelection,
  renderGroupTabs,
  groupMark,
  assignGroupColors,
} from '../lib/groups.js';
import { adapters, getAdapter, parseHashtags, describeTarget } from '../lib/adapters/index.js';
import { formatJst } from '../lib/time.js';
import { $, el, notify } from '../lib/ui.js';

// ---- 巡回先 ----

const iconButton = (icon, title) =>
  el('button', { className: 'icon', textContent: icon, title, ariaLabel: title });

async function renderTargets() {
  const targets = await getTargets();
  // 途中で別の描画が始まっても行が混ざらないよう、作り終えてからまとめて差し替える
  const rows = [];
  for (const target of targets) {
    const adapter = getAdapter(target.site);
    const state = await getState(target.id);
    const historyCount = Object.keys(state.history).length;

    const reset = iconButton('↺', '履歴リセット(前回成功時刻と取得済み履歴を消す)');
    reset.addEventListener('click', async () => {
      if (!confirm(`${describeTarget(target)} の前回成功時刻と取得済み履歴を消しますか?`)) return;
      await removeState(target.id);
      renderTargets();
    });

    const edit = iconButton('✏️', '編集');
    edit.addEventListener('click', () => startEdit(target));

    const remove = iconButton('🗑️', '削除');
    remove.addEventListener('click', async () => {
      if (!confirm(`${describeTarget(target)} を巡回先から削除しますか?`)) return;
      await saveTargets((await getTargets()).filter((t) => t.id !== target.id));
      await removeState(target.id);
      if (editingId === target.id) resetForm();
      renderTargets();
    });

    const row = el(
      'div',
      { className: 'target', draggable: true },
      el('span', { className: 'grip', textContent: '⠿', title: 'ドラッグで並べ替え' }),
      el('span', { className: `site site-${target.site}`, textContent: adapter.label }),
      el('span', { className: 'name', textContent: describeTarget(target) }),
      el('span', {
        className: 'muted',
        textContent: `前回: ${formatJst(state.lastSuccessAt)} / 履歴 ${historyCount}件`,
      }),
      groupMark(groups, groupColors, target.group),
      edit,
      reset,
      remove
    );
    row.dataset.targetId = target.id;
    row.dataset.site = target.site;
    row.dataset.group = target.group;
    row.dataset.search = `${describeTarget(target)} ${adapter.label}`.toLowerCase();
    rows.push(row);
  }
  if (rows.length) $('targets').replaceChildren(...rows);
  else $('targets').replaceChildren(el('p', { className: 'hint', textContent: '巡回先はまだありません。' }));

  // 無くなった巡回先を選択から外し、選択中の行に印を付け直す
  const ids = new Set(targets.map((t) => t.id));
  for (const id of [...selectedIds]) if (!ids.has(id)) selectedIds.delete(id);
  showSelection();
  applyFilter();
}

// ---- 巡回先の複数選択 ----
// 行をクリックで選択、Ctrl+クリックで追加・解除、Shift+クリックで範囲選択。
// 選択した行をグループのタブへドラッグすると、まとめてそのグループに移せる。

const selectedIds = new Set();
let anchorId = null; // Shift+クリックの範囲の起点

function showSelection() {
  for (const row of $('targets').querySelectorAll('.target')) {
    row.classList.toggle('selected', selectedIds.has(row.dataset.targetId));
  }
}

$('targets').addEventListener('click', (e) => {
  if (e.target.closest('button')) return; // 編集・リセット・削除のボタンは選択に関わらない
  const row = e.target.closest('.target');
  if (!row) return;
  const id = row.dataset.targetId;

  if (e.shiftKey && anchorId) {
    // 表示されている行のうち、起点からクリックした行までを選ぶ
    const visible = [...$('targets').querySelectorAll('.target:not([hidden])')].map((r) => r.dataset.targetId);
    const from = visible.indexOf(anchorId);
    const to = visible.indexOf(id);
    if (from >= 0 && to >= 0) {
      if (!e.ctrlKey && !e.metaKey) selectedIds.clear();
      for (const rangeId of visible.slice(Math.min(from, to), Math.max(from, to) + 1)) selectedIds.add(rangeId);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    anchorId = id;
  } else {
    // 1件だけ選ばれている行をもう一度クリックしたら解除
    const onlyThis = selectedIds.size === 1 && selectedIds.has(id);
    selectedIds.clear();
    if (!onlyThis) selectedIds.add(id);
    anchorId = id;
  }
  showSelection();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedIds.size) {
    selectedIds.clear();
    showSelection();
  }
});

// タブへのドロップ: ドラッグ中の巡回先をそのグループへ移す(「すべて」には移せない)
const dropTab = (e) => {
  const tab = e.target.closest('.tab');
  return tab && draggedIds.length && tab.dataset.kind === 'group' ? tab : null;
};

$('groupTabs').addEventListener('dragover', (e) => {
  const tab = dropTab(e);
  if (!tab) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  tab.classList.add('drop');
});

$('groupTabs').addEventListener('dragleave', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) tab.classList.remove('drop');
});

$('groupTabs').addEventListener('drop', async (e) => {
  const tab = dropTab(e);
  if (!tab) return;
  e.preventDefault();
  droppedOnTab = true;
  const group = tab.dataset.group;
  const ids = new Set(draggedIds);
  const targets = await getTargets();
  for (const t of targets) if (ids.has(t.id)) t.group = group;
  await saveTargets(targets);
  selectedIds.clear();
  notify(`${ids.size}件を「${group || '未分類'}」に移しました`);
  await renderGroups();
  await renderTargets();
});

// ---- グループ(タブ) ----
// 巡回先を歌手・グループ・現役/OGなどに分ける。タブで選んだグループの巡回先だけを一覧に出す。

let groups = [];
let groupColors = {};
let selectedGroup = ALL_GROUPS;

const isNamedGroupTab = (tab) => !!tab && tab.dataset.kind === 'group' && tab.dataset.group !== UNGROUPED;

async function renderGroups() {
  groups = await getGroups();
  // 色の番号をまだ持っていないグループに割り当てて覚えておく(並べ替えても色が変わらないように)
  const storedColors = await getGroupColors();
  groupColors = assignGroupColors(groups, storedColors);
  if (JSON.stringify(groupColors) !== JSON.stringify(storedColors)) await saveGroupColors(groupColors);

  selectedGroup = validSelection(groups, selectedGroup);
  renderGroupTabs($('groupTabs'), groups, groupColors, selectedGroup, (value) => {
    selectedGroup = value;
    renderGroups();
    applyFilter();
  });
  // 名前のあるグループのタブは、ドラッグで並べ替えられる
  for (const tab of $('groupTabs').querySelectorAll('.tab')) tab.draggable = isNamedGroupTab(tab);

  // 名前の変更と削除は、名前のあるグループを選んでいるときだけ
  const named = selectedGroup !== ALL_GROUPS && selectedGroup !== UNGROUPED;
  $('renameGroup').hidden = !named;
  $('deleteGroup').hidden = !named;

  // 追加フォームのグループ欄。新規追加のときは、開いているタブのグループを初期値にする
  const current = editingId ? $('group').value : selectedGroup || UNGROUPED;
  $('group').replaceChildren(
    el('option', { value: UNGROUPED, textContent: '(なし)' }),
    ...groups.map((name) => el('option', { value: name, textContent: name }))
  );
  $('group').value = groups.includes(current) ? current : UNGROUPED;
}

function askGroupName(message, initial = '') {
  const name = (prompt(message, initial) || '').trim();
  if (!name || name === initial) return null;
  if (groups.includes(name) || name === 'すべて' || name === '未分類') {
    notify('その名前は使えません(同じ名前のグループがあります)');
    return null;
  }
  return name;
}

$('addGroup').addEventListener('click', async () => {
  const name = askGroupName('新しいグループの名前');
  if (!name) return;
  await saveGroups([...groups, name]);
  selectedGroup = name;
  await renderGroups();
  applyFilter();
});

$('renameGroup').addEventListener('click', async () => {
  const oldName = selectedGroup;
  const name = askGroupName('グループの新しい名前', oldName);
  if (!name) return;
  await saveGroupColors({ ...groupColors, [name]: groupColors[oldName] }); // 色は新しい名前に引き継ぐ
  await saveGroups(groups.map((g) => (g === oldName ? name : g)));
  const targets = await getTargets();
  for (const t of targets) if (t.group === oldName) t.group = name;
  await saveTargets(targets);
  selectedGroup = name;
  await renderGroups();
  await renderTargets();
});

$('deleteGroup').addEventListener('click', async () => {
  const name = selectedGroup;
  if (!confirm(`グループ「${name}」を削除しますか?\n中の巡回先は消えず、「未分類」に移ります。`)) return;
  await saveGroups(groups.filter((g) => g !== name));
  const targets = await getTargets();
  for (const t of targets) if (t.group === name) t.group = UNGROUPED;
  await saveTargets(targets);
  selectedGroup = ALL_GROUPS;
  await renderGroups();
  await renderTargets();
});

// ---- グループのタブの並べ替え(ドラッグ&ドロップ) ----
// 名前のあるグループのタブ同士を入れ替えられる。「すべて」は先頭、「未分類」は末尾のまま。

let draggingTab = null;

$('groupTabs').addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!isNamedGroupTab(tab)) return;
  draggingTab = tab;
  tab.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', tab.dataset.group); // Firefox はこれがないとドラッグが始まらない
});

$('groupTabs').addEventListener('dragover', (e) => {
  if (!draggingTab) return;
  e.preventDefault();
  const over = e.target.closest('.tab');
  if (!isNamedGroupTab(over) || over === draggingTab) return;
  // 重なったタブの左半分なら前に、右半分なら後ろに入れる
  const rect = over.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  over.parentNode.insertBefore(draggingTab, before ? over : over.nextSibling);
});

$('groupTabs').addEventListener('dragend', async () => {
  if (!draggingTab) return;
  draggingTab.classList.remove('dragging');
  draggingTab = null;
  const order = [...$('groupTabs').querySelectorAll('.tab')].filter(isNamedGroupTab).map((tab) => tab.dataset.group);
  if (order.join('\n') !== groups.join('\n')) await saveGroups(order);
  await renderGroups();
});

// ---- 巡回先の絞り込み(サイト・文字) ----
// 一覧の表示を絞るだけで、保存されている巡回先や並び順には影響しない。

const filterSites = new Set(); // 選んだサイトのID。空ならすべて

function applyFilter() {
  const words = $('targetSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = [...$('targets').querySelectorAll('.target')];
  let shown = 0;
  for (const row of rows) {
    const visible =
      isInGroup({ group: row.dataset.group }, selectedGroup) &&
      (!filterSites.size || filterSites.has(row.dataset.site)) &&
      words.every((w) => row.dataset.search.includes(w));
    row.hidden = !visible;
    if (visible) shown++;
  }
  $('filterCount').textContent = rows.length ? `${shown} / ${rows.length} 件` : '';
}

function renderSiteFilter() {
  const options = [{ id: '', label: 'すべて' }, ...adapters];
  $('siteFilter').replaceChildren(
    ...options.map((option) => {
      const chip = el('button', {
        type: 'button',
        className: `chip${(option.id ? filterSites.has(option.id) : !filterSites.size) ? ' active' : ''}`,
        textContent: option.label,
      });
      chip.addEventListener('click', () => {
        // サイトは押すたびに選択・解除を切り替え(複数選べる)。「すべて」は選択を空に戻す
        if (!option.id) filterSites.clear();
        else if (!filterSites.delete(option.id)) filterSites.add(option.id);
        // 全サイトを選んだら「すべて」と同じなので空に戻す
        if (filterSites.size === adapters.length) filterSites.clear();
        renderSiteFilter();
        applyFilter();
      });
      return chip;
    })
  );
}

$('targetSearch').addEventListener('input', applyFilter);

// ---- 巡回先の並べ替え(ドラッグ&ドロップ) ----
// ドラッグ中は行をその場で入れ替えて見せ、離したときの並び順を保存する。
// この順番が操作画面の一覧と巡回の順番になる。

let draggingRow = null;
let draggedIds = []; // ドラッグ中の巡回先。選択中の行をつかんだら選択中の全部、そうでなければその1件
let droppedOnTab = false;

$('targets').addEventListener('dragstart', (e) => {
  draggingRow = e.target.closest('.target');
  if (!draggingRow) return;
  const id = draggingRow.dataset.targetId;
  draggedIds = selectedIds.has(id) ? [...selectedIds] : [id];
  droppedOnTab = false;
  for (const row of $('targets').querySelectorAll('.target')) {
    if (draggedIds.includes(row.dataset.targetId)) row.classList.add('dragging');
  }
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', draggingRow.dataset.targetId); // Firefox はこれがないとドラッグが始まらない
});

$('targets').addEventListener('dragover', (e) => {
  // 並べ替えは1件をつかんでいるときだけ。複数つかんでいるときはタブへの移動専用
  if (!draggingRow || draggedIds.length !== 1) return;
  e.preventDefault();
  const over = e.target.closest('.target');
  if (!over || over === draggingRow) return;
  // 重なった行の上半分なら前に、下半分なら後ろに入れる
  const rect = over.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  over.parentNode.insertBefore(draggingRow, before ? over : over.nextSibling);
});

$('targets').addEventListener('drop', (e) => e.preventDefault());

$('targets').addEventListener('dragend', async () => {
  if (!draggingRow) return;
  for (const row of $('targets').querySelectorAll('.dragging')) row.classList.remove('dragging');
  for (const tab of $('groupTabs').querySelectorAll('.drop')) tab.classList.remove('drop');
  draggingRow = null;
  draggedIds = [];
  // タブへ落とした場合は並び順を変えない(タブへ運ぶ途中で入れ替わって見えた分は描き直しで戻る)
  if (droppedOnTab) return;
  const order = [...$('targets').querySelectorAll('.target')].map((row) => row.dataset.targetId);
  const targets = await getTargets();
  targets.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  await saveTargets(targets);
});

const FIELD_IDS = ['account', 'hashtags', 'keyword'];

// 選んだサイトで使える指定項目だけを出す
function renderFields() {
  const { fields } = getAdapter($('site').value);
  for (const id of FIELD_IDS) {
    const field = fields[id];
    $(`${id}Field`).hidden = !field;
    $(id).required = !!(field && field.required);
    $(id).placeholder = field ? field.placeholder : '';
  }
}

// 編集中の巡回先のid。null なら新規追加
let editingId = null;

function resetForm() {
  editingId = null;
  $('formTitle').textContent = '巡回先を追加';
  $('submitTarget').textContent = '追加';
  $('cancelEdit').hidden = true;
  $('site').disabled = false;
  for (const id of FIELD_IDS) $(id).value = '';
  $('group').value = groups.includes(selectedGroup) ? selectedGroup : UNGROUPED;
}

// 編集してもidは変わらないので、前回成功時刻と取得済み履歴はそのまま引き継がれる
function startEdit(target) {
  editingId = target.id;
  $('formTitle').textContent = `巡回先を編集: ${describeTarget(target)}`;
  $('submitTarget').textContent = '更新';
  $('cancelEdit').hidden = false;
  $('site').value = target.site;
  $('site').disabled = true; // 履歴がサイトごとなので、サイトの変更は作り直しで行う
  renderFields();
  $('account').value = target.account;
  $('hashtags').value = target.hashtags.join(' ');
  $('keyword').value = target.keyword;
  $('group').value = groups.includes(target.group) ? target.group : UNGROUPED;
  $('addForm').scrollIntoView({ block: 'nearest' });
}

$('site').append(...adapters.map((a) => el('option', { value: a.id, textContent: a.label })));
$('site').addEventListener('change', renderFields);
$('cancelEdit').addEventListener('click', resetForm);

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const site = $('site').value;
  const adapter = getAdapter(site);
  const input = {
    account: adapter.fields.account ? adapter.normalizeAccount($('account').value) : '',
    hashtags: adapter.fields.hashtags ? parseHashtags($('hashtags').value) : [],
    keyword: adapter.fields.keyword ? $('keyword').value.trim() : '',
  };
  const group = $('group').value;
  if (!input.account && !input.hashtags.length && !input.keyword) {
    return notify('アカウント・ハッシュタグ・検索ワードのどれかを入力してください');
  }

  const sameAs = (t) =>
    t.id !== editingId &&
    t.site === site &&
    t.account === input.account &&
    t.keyword === input.keyword &&
    t.hashtags.join(' ') === input.hashtags.join(' ');
  const targets = await getTargets();
  if (targets.some(sameAs)) return notify('同じ巡回先がすでにあります');

  const editing = targets.find((t) => t.id === editingId);
  if (editing) Object.assign(editing, input, { group });
  else targets.push({ id: crypto.randomUUID(), site, ...input, group, enabled: true });
  await saveTargets(targets);
  resetForm();
  renderTargets();
});

// ---- 全体設定 ----

const numberOr = (id, fallback) => {
  const raw = $(id).value.trim();
  const n = Number(raw);
  return raw === '' || !Number.isFinite(n) ? fallback : n;
};

async function renderSettings() {
  const s = await getSettings();
  $('waitMinSec').value = s.waitMinSec;
  $('waitMaxSec').value = s.waitMaxSec;
  $('firstRunHours').value = s.firstRunHours;
  $('maxScrolls').value = s.maxScrolls;
  $('winLeft').value = s.window.left ?? '';
  $('winTop').value = s.window.top ?? '';
  $('winWidth').value = s.window.width;
  $('winHeight').value = s.window.height;
}

$('saveSettings').addEventListener('click', async () => {
  const s = await getSettings();
  await saveSettings({
    ...s,
    waitMinSec: Math.max(0, numberOr('waitMinSec', s.waitMinSec)),
    waitMaxSec: Math.max(0, numberOr('waitMaxSec', s.waitMaxSec)),
    firstRunHours: Math.max(1, numberOr('firstRunHours', s.firstRunHours)),
    maxScrolls: Math.max(10, numberOr('maxScrolls', s.maxScrolls)),
    window: {
      left: numberOr('winLeft', null),
      top: numberOr('winTop', null),
      width: Math.max(400, numberOr('winWidth', s.window.width)),
      height: Math.max(400, numberOr('winHeight', s.window.height)),
    },
  });
  // 保存したら操作画面に戻り、この設定タブは閉じる
  const self = await browser.tabs.getCurrent();
  await openOrFocusTab(browser.runtime.getURL('panel/panel.html'));
  if (self) await browser.tabs.remove(self.id);
});

renderFields();
renderSiteFilter();
renderGroups().then(renderTargets);
renderSettings();
