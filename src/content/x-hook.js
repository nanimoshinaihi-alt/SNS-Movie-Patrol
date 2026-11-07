// X のページ読み込み開始時に、ページ自身のJS環境へ入れるスクリプト(manifest の content_scripts)。
// Xが投稿一覧を読み込む通信の応答から、ポストの全文とハッシュタグを控えておき、
// あとから注入される抽出関数(lib/adapters/x.js)が window.__snsPatrolX から読む。
//   SearchTimeline : 検索結果。長文ポストは画面上「さらに表示」で畳まれ、その先のハッシュタグはXの検索にも
//                    掛からないため、全文での判定にはこの応答が必要。
//   UserOriginalsTimeline : プロフィールのポスト欄。検索に出ないアカウントは、ここから動画付きのポストを拾う。
(() => {
  if (window.__snsPatrolX) return;

  const MAX_TWEETS = 20000; // ポスト欄はスクロール上限(300回)まで読むと6000件ほどになる
  // pages: 検索結果の応答の数 / tweets: ポストID → { text, tags, video }
  // profilePages: ポスト欄の応答の数 / profileIds: ポスト欄に出たポストID(読み込んだ順) / lastProfilePage: 直近の応答の分
  const store = (window.__snsPatrolX = { pages: 0, tweets: {}, profilePages: 0, profileIds: [], lastProfilePage: [] });

  const addTweet = (tweet) => {
    // 長文ポストは note_tweet 側に全文とハッシュタグが入っている
    const note = tweet.note_tweet && tweet.note_tweet.note_tweet_results && tweet.note_tweet.note_tweet_results.result;
    const entities = (note && note.entity_set) || tweet.legacy.entities || {};
    const media = (tweet.legacy.extended_entities && tweet.legacy.extended_entities.media) || [];
    store.tweets[tweet.rest_id] = {
      text: (note && note.text) || tweet.legacy.full_text,
      tags: (entities.hashtags || []).map((h) => h.text).filter(Boolean),
      // リポストは元の投稿の動画を持っていても、そのアカウントの投稿ではないので数えない
      video: !tweet.legacy.retweeted_status_result && media.some((m) => m.type === 'video'),
    };
  };

  // 応答の構造は変わりやすいので、場所を決め打ちせずポストらしい要素を探す
  const walk = (value, found) => {
    if (!value || typeof value !== 'object') return;
    if (value.rest_id && value.legacy && typeof value.legacy.full_text === 'string') {
      addTweet(value);
      found.push(value.rest_id);
    }
    for (const [key, child] of Object.entries(value)) {
      // 引用元・リポスト元は別のポストなので辿らない
      if (key === 'quoted_status_result' || key === 'retweeted_status_result') continue;
      walk(child, found);
    }
  };

  const read = (text) => {
    const found = [];
    walk(JSON.parse(text), found);
    const ids = Object.keys(store.tweets);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TWEETS))) delete store.tweets[id];
    return found;
  };

  window.__snsPatrolTap('/SearchTimeline', (text) => {
    read(text);
    store.pages++;
  });
  // プロフィールの「ポスト」欄。2026-11 時点では UserOriginalsTimeline で読み込まれる(以前の名前は UserTweets)。
  const readProfile = (text) => {
    store.lastProfilePage = read(text);
    store.profileIds.push(...store.lastProfilePage);
    store.profileIds = store.profileIds.slice(-MAX_TWEETS);
    store.profilePages++;
  };
  window.__snsPatrolTap('/UserOriginalsTimeline', readProfile);
  window.__snsPatrolTap('/UserTweets', readProfile);
})();
