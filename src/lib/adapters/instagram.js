// Instagram アダプタ。
// PCブラウザのハッシュタグページは新着順でもアカウント絞り込みでもないので使わない。
// 指定アカウントのプロフィールを開いて下へスクロールし、Instagram 自身が読み込む投稿一覧の応答
// (content/instagram-hook.js が控えたもの)から、期間内の動画投稿を本文つきで返す。
// ハッシュタグ・検索ワードでの絞り込みは拡張側(lib/match.js)で行う。
// 投稿時刻は応答に含まれる投稿時刻(taken_at)を使う。

// 巡回タブ内(ページ側のJS環境)で実行される。自己完結していること(外側の変数・関数を参照しない)。
async function extract(opts) {
  const { sinceMs, untilMs, maxScrolls } = opts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TIMELINE_KEY = 'xdt_api__v1__feed__user_timeline_graphql_connection';

  if (location.pathname.startsWith('/accounts/login')) {
    return { ok: false, fatal: true, items: [], error: 'Instagramにログインしていません' };
  }
  const store = window.__snsPatrolIg;
  if (!store) {
    return { ok: false, fatal: true, items: [], error: '読み取りの準備ができていません。拡張機能を更新してからやり直してください' };
  }

  // 初回分が通信ではなくページ内に埋め込まれている場合に備えて、埋め込みデータからも探す
  const loadEmbedded = () => {
    const find = (value) => {
      if (!value || typeof value !== 'object') return null;
      if (value[TIMELINE_KEY]) return value[TIMELINE_KEY];
      for (const child of Object.values(value)) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.textContent.includes(TIMELINE_KEY)) continue;
      try {
        const connection = find(JSON.parse(script.textContent));
        if (connection) return store.addConnection(connection);
      } catch {}
    }
  };

  // 最初の投稿一覧が届くのを待つ
  const deadline = Date.now() + 30000;
  while (store.pages === 0 && Date.now() < deadline) {
    await sleep(500);
    if (store.pages === 0 && document.readyState === 'complete') loadEmbedded();
  }
  if (store.pages === 0) {
    return {
      ok: false,
      items: [],
      error: '投稿一覧を読み取れませんでした(タイムアウト)。アカウント名とログイン状態を確認してください',
    };
  }

  const items = new Map();
  let nextIndex = 0;
  let olderCount = 0;
  const processNewNodes = () => {
    for (; nextIndex < store.nodes.length; nextIndex++) {
      const node = store.nodes[nextIndex];
      if (node.timeMs < sinceMs) {
        // 先頭の固定投稿は古くても並ぶので、到達判定には数えない
        if (!node.pinned) olderCount++;
        continue;
      }
      if (node.timeMs > untilMs || !node.isVideo) continue;
      items.set(node.code, {
        key: `instagram:${node.code}`,
        url: `https://www.instagram.com/${node.isReel ? 'reel' : 'p'}/${node.code}/`,
        timeMs: node.timeMs,
        text: node.caption,
      });
    }
  };

  // 最下部までスクロールすると、Instagram が続きの12件を読み込む
  let finished = false;
  for (let i = 0; i < maxScrolls; i++) {
    processNewNodes();
    // 範囲より古い投稿が続けて出たら到達、または最後の投稿まで読み切ったら終了
    if (olderCount >= 4 || store.hasNext === false) {
      finished = true;
      break;
    }

    const pagesBefore = store.pages;
    const waitUntil = Date.now() + 20000;
    let nextNudge = 0;
    while (store.pages === pagesBefore && Date.now() < waitUntil) {
      if (Date.now() >= nextNudge) {
        // 読み込みが始まらないことがあるので、少し戻してから最下部へ送り直す
        window.scrollBy(0, -300);
        window.scrollTo(0, document.documentElement.scrollHeight);
        nextNudge = Date.now() + 4000;
      }
      await sleep(300);
    }
    if (store.pages === pagesBefore) {
      return {
        ok: false,
        items: [...items.values()],
        error: '続きの読み込みが止まりました(アクセス制限の可能性)',
      };
    }
    await sleep(1000 + Math.random() * 1500);
  }

  return { ok: true, items: [...items.values()], truncated: !finished };
}

export default {
  id: 'instagram',
  label: 'Instagram',
  world: 'MAIN', // content/instagram-hook.js が控えたデータ(ページ側の window)を読むため

  fields: {
    account: { required: true, placeholder: 'アカウント名(@なし)' },
    hashtags: { required: false, placeholder: '#なし・空白区切り' },
    keyword: { required: false, placeholder: '本文中の語' },
  },

  normalizeAccount(raw) {
    return raw
      .trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
      .replace(/^@/, '')
      .split(/[/?]/)[0];
  },

  buildUrl(target) {
    return `https://www.instagram.com/${encodeURIComponent(target.account)}/`;
  },

  extract,
};
