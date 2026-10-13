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

// 専用ウィンドウに1タブ開いて抽出し、閉じる
async function fetchItems(adapter, target, range, windowId, settings) {
  const tab = await browser.tabs.create({
    windowId,
    url: adapter.buildUrl(target, range),
    active: true,
  });
  try {
    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: adapter.extract,
      args: [
        { sinceMs: range.sinceMs, untilMs: range.untilMs, maxScrolls: settings.maxScrolls, target },
      ],
      ...(adapter.world ? { world: adapter.world } : {}),
    });
    if (!injection || !injection.result) throw new Error('抽出結果を取得できませんでした');
    return injection.result;
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
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
