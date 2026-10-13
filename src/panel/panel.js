import browser from '../lib/browser.js';
import {
  getSettings,
  saveSettings,
  getTargets,
  saveTargets,
  getGroups,
  getGroupColors,
  getState,
  getLastRun,
  saveLastRun,
} from '../lib/storage.js';
import { ALL_GROUPS, isInGroup, validSelection, renderGroupTabs, groupMark } from '../lib/groups.js';
import { getAdapter, describeTarget } from '../lib/adapters/index.js';
import { runPatrol } from '../lib/patrol.js';
import { openOrFocusTab } from '../lib/tabs.js';
import { formatJst, toJstInput, parseJstInput, startOfJstDay } from '../lib/time.js';
import { $, el, notify, STATUS_LABEL } from '../lib/ui.js';

const RESULTS_URL = browser.runtime.getURL('results/results.html');
const OPTIONS_URL = browser.runtime.getURL('options/options.html');

let running = false;
let stopRequested = false;
// 直近の実行結果。urls は全体(巡回先をまたぐ重複なし)、rows = [{ name, status, urls, message }] は巡回先ごと。
// storage の lastRun に保存し、URL一覧は結果タブ(results)が表示する。
let run = { at: null, urls: [], rows: [] };

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

async function renderMode() {
  const isRange = selectedMode() === 'range';
  $('rangeBox').hidden = !isRange;
  const { firstRunHours } = await getSettings();
  $('modeHint').textContent = isRange
    ? '指定した期間の投稿を取得します。'
    : `巡回先ごとの前回成功時刻から現在までの新着を取得します。初回は ${firstRunHours} 時間前まで遡ります。`;
}

// 画面の指定から runPatrol に渡す mode を作る。入力に問題があればメッセージを投げる。
function readMode() {
  if (selectedMode() === 'since') return { type: 'since' };
  const sinceMs = parseJstInput($('rangeSince').value);
  const untilMs = parseJstInput($('rangeUntil').value);
  if (sinceMs == null || untilMs == null) throw new Error('開始日時と終了日時を入力してください');
  if (sinceMs >= untilMs) throw new Error('終了日時は開始日時より後にしてください');
  return {
    type: 'range',
    sinceMs,
    untilMs,
    dedupe: $('rangeDedupe').checked,
    updateLastSuccess: $('rangeUpdate').checked,
  };
}

// 表示中のグループ(タブ)。一覧に出ている巡回先だけが、ALL と巡回の対象になる。
const GROUP_KEY = 'panelGroup';
let selectedGroup = ALL_GROUPS;
try {
  selectedGroup = JSON.parse(localStorage.getItem(GROUP_KEY) ?? 'null');
} catch {}

async function renderTargets() {
  const groups = await getGroups();
  const colors = await getGroupColors();
  selectedGroup = validSelection(groups, selectedGroup);
  // グループを作っていなければタブは出さない
  $('groupTabs').hidden = groups.length === 0;
  renderGroupTabs($('groupTabs'), groups, colors, selectedGroup, (value) => {
    selectedGroup = value;
    try {
      localStorage.setItem(GROUP_KEY, JSON.stringify(value));
    } catch {}
    renderTargets();
  });

  const allTargets = await getTargets();
  const targets = allTargets.filter((t) => isInGroup(t, selectedGroup));
  const box = $('targets');
  if (!targets.length) {
    const message = allTargets.length
      ? 'このグループには巡回先がありません。'
      : '巡回先がありません。「設定」から追加してください。';
    box.replaceChildren(el('p', { className: 'hint', textContent: message }));
    syncCheckAll();
    updateTargetsFade();
    return;
  }
  // 途中で別の描画が始まっても行が混ざらないよう、作り終えてからまとめて差し替える
  const rows = [];
  for (const target of targets) {
    const adapter = getAdapter(target.site);
    const state = await getState(target.id);
    const checkbox = el('input', { type: 'checkbox', checked: target.enabled !== false });
    checkbox.dataset.targetId = target.id;
    checkbox.addEventListener('change', () => {
      syncCheckAll();
      saveChecks();
    });
    rows.push(
      el(
        'label',
        { className: 'target' },
        checkbox,
        el('span', { className: `site site-${target.site}`, textContent: adapter.label }),
        el('span', { className: 'name', textContent: describeTarget(target) }),
        el('span', { className: 'muted', textContent: `前回: ${formatJst(state.lastSuccessAt)}` }),
        groupMark(groups, colors, target.group)
      )
    );
  }
  box.replaceChildren(...rows);
  // 描画の途中で巡回が始まっていた場合も、巡回中は操作できない状態にそろえる
  if (running) setRunning(true);
  syncCheckAll();
  updateTargetsFade();
}

// チェックの状態を巡回先の enabled として保存し、次回も同じ選択で始められるようにする
async function saveChecks() {
  const checks = new Map(
    [...$('targets').querySelectorAll('input')].map((cb) => [cb.dataset.targetId, cb.checked])
  );
  const targets = await getTargets();
  for (const t of targets) if (checks.has(t.id)) t.enabled = checks.get(t.id);
  await saveTargets(targets);
}

// ALL のチェックは、巡回先がすべて選ばれているときだけ入った状態にする
function syncCheckAll() {
  const boxes = [...$('targets').querySelectorAll('input')];
  const checked = boxes.filter((cb) => cb.checked).length;
  $('checkAll').checked = boxes.length > 0 && checked === boxes.length;
  // 折りたたんでいても選択状況が分かるよう、見出しに件数を出す
  $('targetsSummary').textContent = boxes.length ? `${checked} / ${boxes.length} 件を選択` : '';
}

function setAllChecks(value) {
  for (const cb of $('targets').querySelectorAll('input')) cb.checked = value;
  syncCheckAll();
  saveChecks();
}

// 巡回先の一覧の折りたたみ。開閉の状態はこのブラウザに覚えさせる。
const COLLAPSED_KEY = 'targetsCollapsed';

const isTargetsCollapsed = () => $('targets').closest('.card').classList.contains('collapsed');

// 折りたたみ中、隠れている続きがあるときだけ下端を薄くする
function updateTargetsFade() {
  const list = $('targets');
  list.classList.toggle('faded', isTargetsCollapsed() && list.scrollHeight > list.clientHeight + 1);
}

function setTargetsCollapsed(collapsed) {
  $('targets').closest('.card').classList.toggle('collapsed', collapsed);
  $('toggleTargets').textContent = collapsed ? '▶' : '▼';
  updateTargetsFade();
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '');
  } catch {}
}

// 巡回状況は1巡回先1行。URLそのものは結果タブで見る。
function renderRun() {
  $('results').replaceChildren(
    ...run.rows.flatMap((row) => {
      const line = el(
        'div',
        { className: 'target' },
        el('span', { className: 'name', textContent: row.name, title: row.name }),
        el('span', { className: `status-${row.status}`, textContent: STATUS_LABEL[row.status] }),
        el('span', { className: 'muted', textContent: row.status === 'running' ? '' : `${row.urls.length}件` })
      );
      // うまくいかなかった巡回先だけ理由を出す
      const failed = row.status === 'fail' || row.status === 'partial';
      return failed ? [line, el('div', { className: 'hint', textContent: row.message })] : [line];
    })
  );
  $('runSummary').textContent = run.at ? `${formatJst(run.at)} 実行 / 合計 ${run.urls.length}件` : '';
}

function setRunning(value) {
  running = value;
  $('start').disabled = value;
  $('stop').disabled = !value;
  for (const cb of $('targets').querySelectorAll('input')) cb.disabled = value;
  $('checkAll').disabled = value;
  for (const tab of $('groupTabs').querySelectorAll('button')) tab.disabled = value;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.disabled = value;
  for (const input of $('rangeBox').querySelectorAll('input')) input.disabled = value;
}

// 結果タブ・設定タブは、すでに開いていればそれを前面に出す(なければこのウィンドウに開く)
async function openPage(url) {
  const win = await browser.windows.getCurrent();
  await openOrFocusTab(url, win.id);
}

const openResults = () => openPage(RESULTS_URL);

async function start() {
  const checkedIds = new Set(
    [...$('targets').querySelectorAll('input:checked')].map((cb) => cb.dataset.targetId)
  );
  const targets = (await getTargets()).filter((t) => checkedIds.has(t.id));
  if (!targets.length) {
    $('progress').textContent = '巡回先を1つ以上選んでください';
    return;
  }
  let mode;
  try {
    mode = readMode();
  } catch (e) {
    $('progress').textContent = e.message;
    return;
  }

  const settings = await getSettings();
  const win = await browser.windows.getCurrent();
  const panelTab = await browser.tabs.getCurrent();
  const seen = new Set();
  run = { at: Date.now(), urls: [], rows: [] };
  stopRequested = false;
  setRunning(true);
  renderRun();

  try {
    await runPatrol({
      targets,
      mode,
      windowId: win.id,
      settings,
      shouldStop: () => stopRequested,
      onStart(index, target) {
        const name = `${getAdapter(target.site).label} ${describeTarget(target)}`;
        run.rows.push({ name, status: 'running', urls: [], message: '' });
        $('progress').textContent = `${index + 1} / ${targets.length} : ${name}`;
        renderRun();
      },
      onResult(index, target, result) {
        // 複数の巡回先で同じ投稿が見つかったら、巡回先ごとの一覧には両方に、全体の一覧には1回だけ載せる
        for (const url of result.urls) {
          if (!seen.has(url)) {
            seen.add(url);
            run.urls.push(url);
          }
        }
        Object.assign(run.rows[index], {
          status: result.status,
          urls: result.urls,
          message:
            result.message ||
            `${formatJst(result.range.sinceMs)} 〜 ${formatJst(result.range.untilMs)}`,
        });
        renderRun();
        saveLastRun(run);
        // 巡回タブを閉じると隣のタブが前面に来てしまうので、待機中は操作画面に戻す
        browser.tabs.update(panelTab.id, { active: true }).catch(() => {});
      },
      onWait(seconds) {
        $('progress').textContent = `次の巡回先まで ${seconds} 秒待機中…`;
      },
    });
    const failed = run.rows.filter((r) => r.status !== 'ok').length;
    $('progress').textContent =
      (stopRequested ? '停止しました' : '完了') +
      ` : ${run.urls.length}件` +
      (failed ? ` / 成功以外 ${failed}件` : '');
  } catch (e) {
    $('progress').textContent = `エラーで中断しました: ${e.message || e}`;
  } finally {
    await saveLastRun(run);
    setRunning(false);
    await renderTargets();
    if (run.rows.length) await openResults();
  }
}

$('start').addEventListener('click', async () => {
  // Firefox系はサイトへのアクセス権限が最初は付いていないので、ここで許可を求める(許可済みなら何も出ない)。
  // Firefox はクリック直後でないと許可ダイアログを出せないため、他の処理より先に呼ぶ。
  const origins = browser.runtime.getManifest().host_permissions;
  let granted;
  try {
    granted = await browser.permissions.request({ origins });
  } catch {
    granted = await browser.permissions.contains({ origins });
  }
  if (!granted) {
    $('progress').textContent = '巡回先のサイトへのアクセスが許可されていないため、巡回できません';
    return;
  }
  start();
});

$('stop').addEventListener('click', () => {
  stopRequested = true;
  $('stop').disabled = true;
  $('progress').textContent = '現在の巡回先が終わり次第、停止します…';
});

$('openResults').addEventListener('click', openResults);
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  openPage(OPTIONS_URL);
});
$('checkAll').addEventListener('change', () => setAllChecks($('checkAll').checked));
$('toggleTargets').addEventListener('click', () => setTargetsCollapsed(!isTargetsCollapsed()));

$('saveBounds').addEventListener('click', async () => {
  const win = await browser.windows.getCurrent();
  const settings = await getSettings();
  settings.window = { left: win.left, top: win.top, width: win.width, height: win.height };
  await saveSettings(settings);
  notify('ウィンドウの位置とサイズを記憶しました');
});

// 設定画面で巡回先が変わったら一覧に反映する(巡回中は触らない)
browser.storage.onChanged.addListener((changes) => {
  if (running) return;
  if (changes.targets || changes.groups || changes.groupColors) renderTargets();
  if (changes.settings) renderMode();
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', renderMode);
}

window.addEventListener('beforeunload', (e) => {
  if (running) e.preventDefault();
});

(async () => {
  const lastRun = await getLastRun();
  if (lastRun) {
    // 巡回中に閉じられた場合の「巡回中…」は残さない
    lastRun.rows = lastRun.rows
      .filter((r) => r.status !== 'running')
      .map((r) => ({ ...r, urls: r.urls || [] })); // urls を持たない旧形式の保存データ対策
    run = lastRun;
  }
  // 範囲指定の初期値: 今日の0時 〜 現在
  $('rangeSince').value = toJstInput(startOfJstDay(Date.now()));
  $('rangeUntil').value = toJstInput(Date.now());
  let collapsed = false;
  try {
    collapsed = !!localStorage.getItem(COLLAPSED_KEY);
  } catch {}
  setTargetsCollapsed(collapsed);
  renderRun();
  await renderMode();
  await renderTargets();
})();
