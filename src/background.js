// ツールバーのボタンで操作画面のウィンドウを開くだけ。巡回処理はここには置かない。
import browser from './lib/browser.js';
import { getSettings } from './lib/storage.js';
import { findExtensionTab } from './lib/tabs.js';

const PANEL_URL = browser.runtime.getURL('panel/panel.html');

browser.action.onClicked.addListener(async () => {
  // すでに開いていればそのウィンドウを前面に出す
  const existing = await findExtensionTab(PANEL_URL);
  if (existing) {
    await browser.windows.update(existing.windowId, { focused: true });
    await browser.tabs.update(existing.id, { active: true });
    return;
  }

  const { window: w } = await getSettings();
  const size = { url: PANEL_URL, type: 'normal', width: w.width, height: w.height };
  try {
    const position = w.left != null && w.top != null ? { left: w.left, top: w.top } : {};
    await browser.windows.create({ ...size, ...position });
  } catch {
    // 記憶した位置が今の画面構成の外にある場合(サブディスプレイを外した等)は位置指定なしで開く
    await browser.windows.create(size);
  }
});
