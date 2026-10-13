// TikTok アダプタ。
// 指定アカウントのプロフィールを開いて下へスクロールし、TikTok 自身が読み込む投稿一覧の応答
// (content/tiktok-hook.js が控えたもの)から、期間内の動画投稿を本文つきで返す。
// ハッシュタグ・検索ワードでの絞り込みは拡張側(lib/match.js)で行う。
// 投稿時刻は動画ID(URL内の数字)の上位32ビットから算出する。

// 巡回タブ内(ページ側のJS環境)で実行される。自己完結していること(外側の変数・関数を参照しない)。
async function extract(opts) {
  const { sinceMs, untilMs, maxScrolls, target } = opts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const VIDEO_LINK = 'a[href*="/video/"]';

  const store = window.__snsPatrolTt;
  if (!store) {
    return { ok: false, items: [], error: '読み取りの準備ができていません。拡張機能を更新してからやり直してください' };
  }

  // 最初の投稿一覧が届くのを待つ
  const deadline = Date.now() + 30000;
  while (store.pages === 0 && Date.now() < deadline && !/Access Denied/i.test(document.title)) {
    await sleep(500);
  }
  if (store.pages === 0) {
    // TikTok の手前の防御システムにブラウザごと弾かれた場合の画面
    if (/Access Denied/i.test(document.title)) {
      return {
        ok: false,
        items: [],
        error: 'TikTokにアクセスを拒否されました(Access Denied)。時間をおくか、別のブラウザで巡回してください',
      };
    }
    const visible = document.querySelectorAll(VIDEO_LINK).length;
    return {
      ok: false,
      items: [],
      error: visible
        ? `投稿一覧の通信を読み取れませんでした(画面には動画が${visible}件見えています)`
        : '投稿一覧が表示されませんでした(タイムアウト)。アカウント名の誤り、認証パズルの表示、アクセス制限の可能性があります',
    };
  }

  const items = new Map();
  let nextIndex = 0;
  let olderCount = 0;
  const processNewPosts = () => {
    for (; nextIndex < store.items.length; nextIndex++) {
      const post = store.items[nextIndex];
      // 動画IDの上位32ビットが投稿時刻(秒)
      let timeMs = post.createTime * 1000;
      try {
        timeMs = Number(BigInt(post.id) >> 32n) * 1000;
      } catch {}
      if (timeMs < sinceMs) {
        // 先頭の固定投稿は古くても並ぶので、到達判定には数えない
        if (!post.pinned) olderCount++;
        continue;
      }
      // 写真投稿は動画ではないので対象外
      if (timeMs > untilMs || post.isPhoto) continue;
      items.set(post.id, {
        key: `tiktok:${post.id}`,
        url: `https://www.tiktok.com/@${post.author || target.account}/video/${post.id}`,
        timeMs,
        text: post.desc,
        tags: post.tags,
      });
    }
  };

  // 最下部までスクロールすると、TikTok が続きを読み込む
  let finished = false;
  for (let i = 0; i < maxScrolls; i++) {
    processNewPosts();
    // 範囲より古い投稿が続けて出たら到達、または最後の投稿まで読み切ったら終了
    if (olderCount >= 4 || store.hasMore === false) {
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
        const links = document.querySelectorAll(VIDEO_LINK);
        if (links.length) links[links.length - 1].scrollIntoView({ block: 'end' });
        nextNudge = Date.now() + 4000;
      }
      await sleep(300);
    }
    if (store.pages === pagesBefore) {
      return {
        ok: false,
        items: [...items.values()],
        error: '続きの読み込みが止まりました(認証パズルの表示かアクセス制限の可能性)',
      };
    }
    await sleep(1000 + Math.random() * 1500);
  }

  return { ok: true, items: [...items.values()], truncated: !finished };
}

export default {
  id: 'tiktok',
  label: 'TikTok',
  world: 'MAIN', // content/tiktok-hook.js が控えたデータ(ページ側の window)を読むため

  fields: {
    account: { required: true, placeholder: 'アカウント名(@なし)' },
    hashtags: { required: false, placeholder: '#なし・空白区切り' },
    keyword: { required: false, placeholder: '本文中の語' },
  },

  normalizeAccount(raw) {
    return raw
      .trim()
      .replace(/^https?:\/\/(www\.)?tiktok\.com\//, '')
      .replace(/^@/, '')
      .split(/[/?]/)[0];
  },

  buildUrl(target) {
    return `https://www.tiktok.com/@${encodeURIComponent(target.account)}`;
  },

  extract,
};
