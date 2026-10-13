import browser from './browser.js';

// 拡張のページ(操作画面・設定・結果)が開いているタブを探す。
// Firefox は tabs.query の url 条件に拡張ページのURLを指定できないので、全タブから探す。
export async function findExtensionTab(url) {
  const tabs = await browser.tabs.query({});
  return tabs.find((tab) => tab.url && tab.url.split(/[?#]/)[0] === url) || null;
}

// すでに開いていればそのタブを前面に出し、なければ指定ウィンドウに新しく開く
export async function openOrFocusTab(url, windowId) {
  const tab = await findExtensionTab(url);
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
  } else {
    await browser.tabs.create({ windowId, url, active: true });
  }
}
