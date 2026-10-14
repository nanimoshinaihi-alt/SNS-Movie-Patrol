// X (x.com) アダプタ。
// アカウント/ハッシュタグ/検索ワードの組み合わせを検索式にして、「動画付き投稿に絞った検索の最新タブ」を開いて取得する。
// 期間は検索演算子 since_time / until_time で絞り、さらに投稿IDから算出した時刻で判定し直す。
//
// アカウント指定のある巡回先は、ハッシュタグと検索ワードをXの検索に渡さず、そのアカウントの動画投稿を
// すべて検索して、ポストの全文(content/x-hook.js が控えたもの)を付けて返し、拡張側(lib/match.js)が絞り込む。
// 長文ポストの「さらに表示」より後ろにあるハッシュタグは、Xの検索では見つからないため。
// アカウント指定のない巡回先は全ポストを読むわけにいかないので、従来どおりXの検索に任せる。

// X がホストする動画だけに絞る。外部サイトの動画リンクも拾いたい場合は 'filter:videos' にする。
const VIDEO_FILTER = 'filter:native_video';

// 例: from:account / (#tagA OR #tagB) keyword
function buildQuery(target) {
  if (target.account) return `from:${target.account}`; // 絞り込みは拡張側(lib/match.js)で行う
  const parts = [];
  const tags = target.hashtags.map((t) => `#${t}`);
  if (tags.length === 1) parts.push(tags[0]);
  if (tags.length > 1) parts.push(`(${tags.join(' OR ')})`);
  if (target.keyword) parts.push(target.keyword);
  return parts.join(' ');
}

// 巡回タブ内(ページ側のJS環境)で実行される。自己完結していること(外側の変数・関数を参照しない)。
async function extract(opts) {
  const { sinceMs, maxScrolls, target } = opts;
  // buildQuery と同じ条件: アカウント指定があれば、ハッシュタグ・検索ワードは拡張側(lib/match.js)が全文に対して判定する
  const filterLocally = !!target.account && (target.hashtags.length > 0 || !!target.keyword);
  const store = window.__snsPatrolX;
  if (filterLocally && !store) {
    return { ok: false, fatal: true, items: [], error: '読み取りの準備ができていません。拡張機能を更新してからやり直してください' };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TWITTER_EPOCH = 1288834974657n;
  const TWEET = 'article[data-testid="tweet"]';
  const EMPTY = '[data-testid="emptyState"], [data-testid="empty_state_header_text"]';
  const isLoginPage = () => /^\/(i\/flow\/login|login)/.test(location.pathname);

  const items = new Map();
  const domText = new Map();
  let reachedOlder = false;

  const collect = () => {
    for (const article of document.querySelectorAll(TWEET)) {
      // 投稿時刻のリンクがその投稿自身のURL。広告には無く、引用元はリンクになっていないので拾わない。
      const time = article.querySelector('a[href*="/status/"] time');
      const link = time && time.closest('a');
      const m = link && link.getAttribute('href').match(/^\/([^/]+)\/status\/(\d+)/);
      if (!m) continue;
      const [, user, id] = m;
      // 投稿ID(Snowflake)の上位ビットが投稿時刻
      const timeMs = Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
      if (timeMs < sinceMs) reachedOlder = true;
      // 画面上の本文は、全文を控えられなかったポストの判定用(長文は途中までしか入らない)
      const body = article.querySelector('[data-testid="tweetText"]');
      domText.set(id, body ? body.textContent : '');
      items.set(id, { key: `x:${id}`, url: `https://x.com/${user}/status/${id}`, timeMs });
    }
  };

  // 拡張側で絞り込む巡回先では、本文を付けて返す(本文のない投稿は絞り込みの対象外として扱われる)
  const result = () => {
    const all = [...items.entries()];
    if (!filterLocally) return all.map(([, item]) => item);
    return all.map(([id, item]) => {
      const tweet = store.tweets[id];
      return tweet
        ? { ...item, text: tweet.text, tags: tweet.tags }
        : { ...item, text: domText.get(id) || '' };
    });
  };

  // 最初の表示待ち: 投稿が出る / 0件表示が出る / ログイン画面に飛ばされる のいずれか
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (isLoginPage()) return { ok: false, fatal: true, items: [], error: 'Xにログインしていません' };
    if (document.querySelector(TWEET)) {
      ready = true;
      break;
    }
    if (document.querySelector(EMPTY)) return { ok: true, items: [] };
    await sleep(500);
  }
  if (!ready) {
    return { ok: false, items: [], error: '検索結果が表示されませんでした(タイムアウト)' };
  }

  // 少しずつスクロールして読み込む。Xは画面外の投稿をDOMから外すので、一気に最下部へは飛ばさない。
  let idle = 0;
  let stalled = 0;
  let finished = false;
  for (let i = 0; i < maxScrolls; i++) {
    collect();
    if (reachedOlder) {
      finished = true;
      break;
    }
    const before = items.size;
    window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
    await sleep(800 + Math.random() * 400);
    collect();

    const column = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    const retry = [...column.querySelectorAll('button')].find((b) =>
      /^(Retry|再試行|やりなおす)$/.test(b.textContent.trim())
    );
    if (retry) {
      return {
        ok: false,
        items: result(),
        error: '読み込みエラーが表示されました(アクセス制限の可能性)',
      };
    }

    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    // 続きを読み込み中のクルクルだけを見る。ポスト内の動画の読み込み中表示も同じ種類の要素なので除く
    // (動画が読み込み中のまま画面に残ると、いつまでも「読み込み中」と判定して先へ進めなくなる)
    const loading = [...column.querySelectorAll('[role="progressbar"]')].some((bar) => !bar.closest(TWEET));
    if (!loading) stalled = 0;
    // 続きの読み込みが20回(約20秒)続けて終わらない場合も、待つのをやめて終わりの判定に進む
    const waiting = loading && ++stalled < 20;
    if (atBottom && !waiting && items.size === before) {
      // 最下部で6回続けて増えなければ、検索結果の終わりとみなす
      if (++idle >= 6) {
        finished = true;
        break;
      }
    } else {
      idle = 0;
    }
  }

  // 全文を1件も控えられていないなら、絞り込みの結果を信用できないので失敗にする
  if (filterLocally && store.pages === 0) {
    return { ok: false, items: [], error: 'ポストの本文を読み取れませんでした' };
  }
  return { ok: true, items: result(), truncated: !finished };
}

export default {
  id: 'x',
  label: 'X',
  world: 'MAIN', // content/x-hook.js が控えたデータ(ページ側の window)を読むため
  // どれも任意だが、最低1つは必要(設定画面側で確認する)
  fields: {
    account: { required: false, placeholder: 'アカウント名(@なし)' },
    hashtags: { required: false, placeholder: '#なし・空白区切り' },
    keyword: { required: false, placeholder: '本文中の語' },
  },

  normalizeAccount(raw) {
    return raw
      .trim()
      .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, '')
      .replace(/^@/, '')
      .split(/[/?]/)[0];
  },

  buildUrl(target, { sinceMs, untilMs }) {
    const q = [
      buildQuery(target),
      VIDEO_FILTER,
      `since_time:${Math.floor(sinceMs / 1000)}`,
      `until_time:${Math.ceil(untilMs / 1000)}`,
    ].join(' ');
    return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
  },

  extract,
};
