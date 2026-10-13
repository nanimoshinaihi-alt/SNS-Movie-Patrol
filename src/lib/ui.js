// 操作画面・設定・結果の3ページで共通の、画面まわりの小さな部品。

export const $ = (id) => document.getElementById(id);

// 要素を作る。props はそのままプロパティに入れ、children は中身として追加する(null や '' は無視)。
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child != null && child !== ''));
  return node;
}

// id="notice" の要素に短いお知らせを出し、数秒で消す
export function notify(text) {
  const notice = $('notice');
  notice.textContent = text;
  setTimeout(() => {
    if (notice.textContent === text) notice.textContent = '';
  }, 4000);
}

// 巡回先ごとの結果の状態(lib/patrol.js の status)の表示名
export const STATUS_LABEL = { running: '巡回中…', ok: '成功', partial: '一部取得', fail: '失敗' };
