// 巡回の司令塔。サービスワーカーではなく操作画面(panel)のページ内で動かす。
import browser from './browser.js';
import { getAdapter } from './adapters/index.js';
import { getState, saveState } from './storage.js';
import { matchesTarget } from './match.js';

// 検索への反映遅れで取りこぼさないよう、前回成功時刻より少し前から取り直す(重複は履歴で除外)
const OVERLAP_MS = 10 * 60 * 1000;
const TAB_LOAD_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    // Firefox は新しいタブがまず about:blank として読み込み完了になるので、目的のページかどうかも見る
    const isLoaded = (tab) => tab.status === 'complete' && /^https?:/.test(tab.url || '');
    const onUpdated = (id, info, tab) => {
      if (id === tabId && isLoaded(tab)) {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) {
        cleanup();
        reject(new Error('巡回タブが閉じられました'));
      }
    };
    // 読み込み完了にならないページもあるので、時間切れは失敗にせず抽出側の判定に任せる
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.get(tabId).then((tab) => {
      if (isLoaded(tab)) {
        cleanup();
        resolve();
      }
    }, () => {});
  });
}

// 巡回タブで抽出を1回行う。失敗も { ok: false, ... } の形で返す(タブが閉じられた場合だけ例外)。
async function extractInTab(adapter, tabId, target, range, settings) {
  await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
  let injection;
  try {
    [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: adapter.extract,
      args: [{ sinceMs: range.sinceMs, untilMs: range.untilMs, maxScrolls: settings.maxScrolls, target }],
      ...(adapter.world ? { world: adapter.world } : {}),
    });
  } catch (e) {
    await browser.tabs.get(tabId); // タブ自体が閉じられていたら、ここで例外になって巡回先の失敗になる
    return { ok: false, items: [], error: `抽出を実行できませんでした(${e.message || e})` };
  }
  // 抽出の途中でページが転送・再読み込みされると、結果が返らずに終わる
  // (TikTok は初回アクセス時に、Cookie を設定して読み込み直すことがある)
  if (!injection || !injection.result) {
    return { ok: false, items: [], error: '抽出の途中でページが切り替わりました' };
  }
  return injection.result;
}

// 巡回ウィンドウを前面に出す。最小化されていたら元に戻す(最大化などの状態は変えない)。
async function bringWindowToFront(windowId) {
  try {
    const win = await browser.windows.get(windowId);
    await browser.windows.update(windowId, win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true });
  } catch {
    // 前面に出せなくても巡回は続ける(失敗した場合は抽出側の診断に出る)
  }
}

// 専用ウィンドウに1タブ開いて抽出し、閉じる
async function openAndExtract(adapter, target, range, windowId, settings) {
  // ページが画面に表示されていないと投稿一覧を返さないサイト(TikTok)は、開く前にウィンドウを前面に出す。
  // ウィンドウが他のウィンドウに完全に覆われていると、Chrome はページを「表示されていない」扱いにする。
  if (adapter.needsVisiblePage) await bringWindowToFront(windowId);
  const tab = await browser.tabs.create({ windowId, url: adapter.buildUrl(target, range), active: true });
  try {
    return await extractInTab(adapter, tab.id, target, range, settings);
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

// 失敗したら一度だけ、新しいタブで開き直してやり直す。サイトによっては、開いた直後にページが切り替わったり、
// 投稿一覧の読み込みに失敗したりすることがある(例: TikTok を巡回の先頭に置くと失敗する)。
// 読み込み直しではなく新しいタブにするのは、新しいタブを開くと隠れていた巡回ウィンドウが前面に出るため。
// (巡回開始の直後はウィンドウがすでに前面にあるので、その後ほかのウィンドウで覆われると隠れたままになる)
// 未ログインやアクセス拒否のように、やり直しても直らない失敗(fatal)はやり直さない。
async function fetchItems(adapter, target, range, windowId, settings) {
  const first = await openAndExtract(adapter, target, range, windowId, settings);
  if (first.ok || first.fatal) return first;

  await sleep(1000);
  const second = await openAndExtract(adapter, target, range, windowId, settings);
  if (second.ok) return second;
  // どちらも失敗なら、取れた投稿が多い方を返す(取れた分は一覧と履歴に残る)
  const kept = second.items.length >= first.items.length ? second : first;
  return { ...kept, error: `${kept.error}(開き直しても失敗)` };
}

function trimHistory(history, limit) {
  const entries = Object.entries(history);
  if (entries.length <= limit) return history;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, limit));
}

// 巡回先1件。戻り値: { status: 'ok' | 'partial' | 'fail', urls, message, range }
async function patrolTarget(target, mode, nowMs, windowId, settings) {
  const state = await getState(target.id);
  const isRange = mode.type === 'range';
  const range = isRange
    ? { sinceMs: mode.sinceMs, untilMs: mode.untilMs }
    : {
        sinceMs:
          state.lastSuccessAt != null
            ? state.lastSuccessAt - OVERLAP_MS
            : nowMs - settings.firstRunHours * 60 * 60 * 1000,
        untilMs: nowMs,
      };
  const dedupe = isRange ? mode.dedupe : true;
  const updateLastSuccess = isRange ? mode.updateLastSuccess : true;

  let extracted;
  try {
    extracted = await fetchItems(getAdapter(target.site), target, range, windowId, settings);
  } catch (e) {
    return { status: 'fail', urls: [], message: e.message || String(e), range };
  }

  const fresh = extracted.items
    .filter((item) => item.timeMs >= range.sinceMs && item.timeMs <= range.untilMs)
    // 本文つきで返ってきた投稿は、ここでハッシュタグ・検索ワードの条件を判定する
    .filter((item) => item.text === undefined || matchesTarget(target, item))
    .filter((item) => !dedupe || !(item.key in state.history))
    .sort((a, b) => a.timeMs - b.timeMs);

  // 取得できた分は失敗時も一覧に出して履歴に残す。前回成功時刻は完全に成功したときだけ進める。
  for (const item of fresh) state.history[item.key] = item.timeMs;
  state.history = trimHistory(state.history, settings.historyLimit);
  const complete = extracted.ok && !extracted.truncated;
  if (complete && updateLastSuccess) state.lastSuccessAt = Math.min(range.untilMs, nowMs);
  await saveState(target.id, state);

  const urls = fresh.map((item) => item.url);
  if (!extracted.ok) return { status: 'fail', urls, message: extracted.error, range };
  if (extracted.truncated) {
    return {
      status: 'partial',
      urls,
      message: 'スクロール上限に達したため、古い投稿が残っている可能性があります',
      range,
    };
  }
  return { status: 'ok', urls, message: '', range };
}

// 巡回先を順に1つずつ処理する。
//   mode                            : { type: 'since' } 前回成功時刻から現在まで
//                                     { type: 'range', sinceMs, untilMs, updateLastSuccess, dedupe } 範囲指定
//   shouldStop()                   : true を返すと次の巡回先に進まず終了
//   onStart(index, target)          : 巡回先の処理開始
//   onResult(index, target, result) : 巡回先の処理終了
//   onWait(seconds)                 : 次の巡回先までの待機開始
export async function runPatrol({ targets, mode, windowId, settings, shouldStop, onStart, onResult, onWait }) {
  const nowMs = Date.now();
  for (let i = 0; i < targets.length; i++) {
    if (shouldStop()) break;
    onStart(i, targets[i]);
    const result = await patrolTarget(targets[i], mode, nowMs, windowId, settings);
    onResult(i, targets[i], result);

    if (i < targets.length - 1 && !shouldStop()) {
      const min = Math.min(settings.waitMinSec, settings.waitMaxSec);
      const max = Math.max(settings.waitMinSec, settings.waitMaxSec);
      const waitMs = (min + Math.random() * (max - min)) * 1000;
      onWait(Math.round(waitMs / 1000));
      const end = Date.now() + waitMs;
      while (Date.now() < end && !shouldStop()) await sleep(250);
    }
  }
}
