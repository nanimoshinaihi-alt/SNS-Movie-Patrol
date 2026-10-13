// webextension-polyfill を読み込み、Chrome / Firefox 共通の browser.* を返す。
// 拡張内のモジュールは chrome.* を直接使わず、必ずここから import する。
import '../vendor/browser-polyfill.min.js';

export default globalThis.browser;
