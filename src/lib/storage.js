import browser from './browser.js';

// storage.local のキー構成
//   settings          : 全体設定
//   targets           : 巡回先の配列 [{ id, site, account, hashtags: [], keyword, group, enabled }]
//   groups            : グループ名の配列(巡回先の group はこの名前、未分類は '')
//   groupColors       : グループ名 → 色の番号
//   state:<targetId>  : 巡回先ごとの状態 { lastSuccessAt, history: { 投稿キー: 投稿時刻ms } }
//   lastRun           : 直近の実行結果(ウィンドウを閉じても一覧を失わないため)

export const DEFAULT_SETTINGS = {
  window: { left: null, top: null, width: 560, height: 800 },
  waitMinSec: 5,
  waitMaxSec: 15,
  firstRunHours: 24, // 前回成功時刻がない巡回先を、何時間前まで遡るか
  maxScrolls: 300, // 1巡回先あたりのスクロール回数の上限
  historyLimit: 5000, // 巡回先ごとに保持する取得済み履歴の件数
};

export async function getSettings() {
  const { settings = {} } = await browser.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    window: { ...DEFAULT_SETTINGS.window, ...(settings.window || {}) },
  };
}

export async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

// 旧形式 { type, value } の巡回先を { account, hashtags, keyword } に読み替える(idは変えないので履歴は引き継がれる)
function migrateTarget(target) {
  if (!('type' in target)) return target;
  const { type, value, ...rest } = target;
  return {
    ...rest,
    account: type === 'account' ? value : '',
    hashtags: type === 'hashtag' ? [value] : [],
    keyword: type === 'search' ? value : '',
  };
}

export async function getTargets() {
  const { targets = [] } = await browser.storage.local.get('targets');
  // group を持たない古い巡回先は未分類('')として扱う
  return targets.map(migrateTarget).map((target) => ({ group: '', ...target }));
}

// グループ名の配列。並び順がそのままタブの並び順になる。
export async function getGroups() {
  const { groups = [] } = await browser.storage.local.get('groups');
  return groups;
}

export async function saveGroups(groups) {
  await browser.storage.local.set({ groups });
}

// グループ名 → 色の番号。並べ替えや改名をしても、グループの色が変わらないように覚えておく。
export async function getGroupColors() {
  const { groupColors = {} } = await browser.storage.local.get('groupColors');
  return groupColors;
}

export async function saveGroupColors(groupColors) {
  await browser.storage.local.set({ groupColors });
}

export async function saveTargets(targets) {
  await browser.storage.local.set({ targets });
}

const stateKey = (targetId) => `state:${targetId}`;

export async function getState(targetId) {
  const key = stateKey(targetId);
  const stored = await browser.storage.local.get(key);
  return { lastSuccessAt: null, history: {}, ...(stored[key] || {}) };
}

export async function saveState(targetId, state) {
  await browser.storage.local.set({ [stateKey(targetId)]: state });
}

export async function removeState(targetId) {
  await browser.storage.local.remove(stateKey(targetId));
}

export async function getLastRun() {
  const { lastRun = null } = await browser.storage.local.get('lastRun');
  return lastRun;
}

export async function saveLastRun(lastRun) {
  await browser.storage.local.set({ lastRun });
}
