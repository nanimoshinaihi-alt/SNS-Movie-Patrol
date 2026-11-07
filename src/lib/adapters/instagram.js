// Instagram アダプタ。
// PCブラウザのハッシュタグページは新着順でもアカウント絞り込みでもないので使わない。
// 指定アカウントのプロフィールを開いて下へスクロールし、Instagram 自身が読み込む投稿一覧の応答
// (content/instagram-hook.js が控えたもの)から、期間内の動画投稿を本文つきで返す。
// ハッシュタグ・検索ワードでの絞り込みは拡張側(lib/match.js)で行う。
// 投稿時刻は応答に含まれる投稿時刻(taken_at)を使う。
//
// 「ストーリー」(stories)の巡回先は、ストーリーの画面(/stories/アカウント名/)を開き、
// 「〇〇として表示しますか？」の確認画面の時点でページに入っているストーリーの一覧から、動画を拾う。
// 「ストーリーズを見る」は押さない(再生しないので、相手の閲覧者一覧に載らないはず)。
// URL は1つ目も含めて /stories/アカウント名/番号/ の形にする(番号付きで直接開ける)。

// 巡回タブ内(ページ側のJS環境)で実行される。自己完結していること(外側の変数・関数を参照しない)。
async function extract(opts) {
  const { sinceMs, untilMs, maxScrolls } = opts;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 停止ボタンが押されると、拡張側(lib/patrol.js)がこの印を立てる。立ったら、そこまでに取れた分を返して終える
  const stopped = () => window.__snsPatrolStop === true;
  const TIMELINE_KEY = 'xdt_api__v1__feed__user_timeline_graphql_connection';
  const REELS_KEY = 'xdt_api__v1__feed__reels_media';

  if (location.pathname.startsWith('/accounts/login')) {
    return { ok: false, fatal: true, items: [], error: 'Instagramにログインしていません' };
  }
  const store = window.__snsPatrolIg;
  if (!store) {
    return { ok: false, fatal: true, items: [], error: '読み取りの準備ができていません。拡張機能を更新してからやり直してください' };
  }

  // ページ内に埋め込まれたデータ(script[type="application/json"])から、key の値を探す
  const findEmbedded = (key) => {
    const find = (value) => {
      if (!value || typeof value !== 'object') return null;
      if (value[key]) return value[key];
      for (const child of Object.values(value)) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (!script.textContent.includes(key)) continue;
      try {
        const found = find(JSON.parse(script.textContent));
        if (found) return found;
      } catch {}
    }
    return null;
  };

  if (opts.target.stories) {
    // ストーリーの一覧は、ページに埋め込まれているか、通信で届く(content/instagram-hook.js が控える)
    const deadline = Date.now() + 30000;
    let reels = null;
    while (!reels) {
      if (stopped()) return { ok: true, items: [], truncated: true, stopped: true };
      if (location.pathname.startsWith('/accounts/login')) {
        return { ok: false, fatal: true, items: [], error: 'Instagramにログインしていません' };
      }
      if (/ご利用いただけません|isn't available/.test(document.body.innerText)) {
        return { ok: false, fatal: true, items: [], error: 'アカウントが見つかりませんでした' };
      }
      reels = findEmbedded(REELS_KEY) || store.reels;
      if (reels) break;
      // ストーリーがないアカウントは、プロフィールに移される
      if (!location.pathname.startsWith('/stories/')) return { ok: true, items: [] };
      if (Date.now() > deadline) {
        return { ok: false, items: [], error: 'ストーリーの一覧を読み取れませんでした(タイムアウト)' };
      }
      await sleep(500);
    }
    const MEDIA_VIDEO = 2;
    const items = [];
    const account = opts.target.account;
    // 一覧に他のアカウントのストーリーが混ざっていても拾わない
    const isTarget = (reel) => !reel.user || String(reel.user.username).toLowerCase() === account.toLowerCase();
    for (const reel of (reels.reels_media || []).filter(isTarget)) {
      for (const story of reel.items || []) {
        if (!story || !story.pk || story.media_type !== MEDIA_VIDEO) continue;
        // 動画ファイルそのものの URL(音声込み。ログインなしで開けるが、2日ほどで期限が切れる)。一番大きいもの
        const best = [...(story.video_versions || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        items.push({
          key: `instagram-story:${story.pk}`,
          url: `https://www.instagram.com/stories/${account}/${story.pk}/`,
          ...(best && best.url ? { fileUrl: best.url } : {}),
          timeMs: story.taken_at * 1000,
        });
      }
    }
    return { ok: true, items };
  }

  // 初回分が通信ではなくページ内に埋め込まれている場合に備えて、埋め込みデータからも探す
  const loadEmbedded = () => {
    const connection = findEmbedded(TIMELINE_KEY);
    if (connection) store.addConnection(connection);
  };

  // 最初の投稿一覧が届くのを待つ
  const deadline = Date.now() + 30000;
  while (store.pages === 0 && Date.now() < deadline && !stopped()) {
    await sleep(500);
    if (store.pages === 0 && document.readyState === 'complete') loadEmbedded();
  }
  if (store.pages === 0 && stopped()) return { ok: true, items: [], truncated: true, stopped: true };
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
    if (stopped()) break;

    const pagesBefore = store.pages;
    const waitUntil = Date.now() + 20000;
    let nextNudge = 0;
    while (store.pages === pagesBefore && Date.now() < waitUntil && !stopped()) {
      if (Date.now() >= nextNudge) {
        // 読み込みが始まらないことがあるので、少し戻してから最下部へ送り直す
        window.scrollBy(0, -300);
        window.scrollTo(0, document.documentElement.scrollHeight);
        nextNudge = Date.now() + 4000;
      }
      await sleep(300);
    }
    if (stopped()) break;
    if (store.pages === pagesBefore) {
      return {
        ok: false,
        items: [...items.values()],
        error: '続きの読み込みが止まりました(アクセス制限の可能性)',
      };
    }
    await sleep(1000 + Math.random() * 1500);
  }

  return { ok: true, items: [...items.values()], truncated: !finished, stopped: !finished && stopped() };
}

export default {
  id: 'instagram',
  label: 'Instagram',
  world: 'MAIN', // content/instagram-hook.js が控えたデータ(ページ側の window)を読むため

  fields: {
    account: { required: true, placeholder: 'アカウント名(@なし)' },
    hashtags: { required: false, placeholder: '#なし・空白区切り' },
    keyword: { required: false, placeholder: '本文中の語' },
    // ストーリーから動画を拾う。ストーリーには本文がないので、ハッシュタグ・検索ワードとは併用できない
    stories: { label: 'ストーリーズを巡回取得する' },
  },

  normalizeAccount(raw) {
    return raw
      .trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\/(stories\/)?/, '')
      .replace(/^@/, '')
      .split(/[/?]/)[0];
  },

  buildUrl(target) {
    const account = encodeURIComponent(target.account);
    return target.stories ? `https://www.instagram.com/stories/${account}/` : `https://www.instagram.com/${account}/`;
  },

  extract,
};
