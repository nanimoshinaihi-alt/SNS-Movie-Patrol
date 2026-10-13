// Instagram のページ読み込み開始時に、ページ自身のJS環境へ入れるスクリプト(manifest の content_scripts)。
// プロフィールの投稿一覧をInstagramが読み込む通信の応答を控えておき、
// あとから注入される抽出関数(lib/adapters/instagram.js)が window.__snsPatrolIg から読む。
(() => {
  if (window.__snsPatrolIg) return;

  const TIMELINE_KEY = 'xdt_api__v1__feed__user_timeline_graphql_connection';
  const MEDIA_VIDEO = 2;
  // pages: 受け取った応答の数 / hasNext: まだ続きがあるか / nodes: 投稿(必要な項目だけ)
  const store = (window.__snsPatrolIg = { pages: 0, hasNext: null, nodes: [] });

  // 抽出関数からも使う(ページに埋め込まれた初回分の取り込み用)
  store.addConnection = (connection) => {
    if (!connection || !Array.isArray(connection.edges)) return;
    for (const { node } of connection.edges) {
      if (!node || !node.code) continue;
      store.nodes.push({
        code: node.code,
        timeMs: node.taken_at * 1000,
        caption: (node.caption && node.caption.text) || '',
        isVideo:
          node.media_type === MEDIA_VIDEO ||
          (node.carousel_media || []).some((m) => m.media_type === MEDIA_VIDEO),
        isReel: node.product_type === 'clips',
        pinned: Array.isArray(node.timeline_pinned_user_ids) && node.timeline_pinned_user_ids.length > 0,
      });
    }
    if (connection.page_info) store.hasNext = !!connection.page_info.has_next_page;
    store.pages++;
  };

  window.__snsPatrolTap('/graphql', (text) => {
    if (!text.includes(TIMELINE_KEY)) return;
    const json = JSON.parse(text.split('\n')[0]);
    store.addConnection(json.data && json.data[TIMELINE_KEY]);
  });
})();
