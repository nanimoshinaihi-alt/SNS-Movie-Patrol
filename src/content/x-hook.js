// X のページ読み込み開始時に、ページ自身のJS環境へ入れるスクリプト(manifest の content_scripts)。
// 検索結果をXが読み込む通信(SearchTimeline)の応答から、ポストの全文とハッシュタグを控えておき、
// あとから注入される抽出関数(lib/adapters/x.js)が window.__snsPatrolX から読む。
// 長文ポストは画面上「さらに表示」で畳まれ、その先のハッシュタグはXの検索にも掛からないため、
// 全文での判定にはこの応答が必要。
(() => {
  if (window.__snsPatrolX) return;

  const MAX_TWEETS = 5000;
  // pages: 受け取った応答の数 / tweets: ポストID → { text, tags }
  const store = (window.__snsPatrolX = { pages: 0, tweets: {} });

  const addTweet = (tweet) => {
    // 長文ポストは note_tweet 側に全文とハッシュタグが入っている
    const note = tweet.note_tweet && tweet.note_tweet.note_tweet_results && tweet.note_tweet.note_tweet_results.result;
    const entities = (note && note.entity_set) || tweet.legacy.entities || {};
    store.tweets[tweet.rest_id] = {
      text: (note && note.text) || tweet.legacy.full_text,
      tags: (entities.hashtags || []).map((h) => h.text).filter(Boolean),
    };
  };

  // 応答の構造は変わりやすいので、場所を決め打ちせずポストらしい要素を探す
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.rest_id && value.legacy && typeof value.legacy.full_text === 'string') addTweet(value);
    for (const [key, child] of Object.entries(value)) {
      // 引用元・リポスト元は別のポストなので辿らない
      if (key === 'quoted_status_result' || key === 'retweeted_status_result') continue;
      walk(child);
    }
  };

  window.__snsPatrolTap('/SearchTimeline', (text) => {
    walk(JSON.parse(text));
    const ids = Object.keys(store.tweets);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TWEETS))) delete store.tweets[id];
    store.pages++;
  });
})();
