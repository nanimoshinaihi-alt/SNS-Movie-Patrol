// TikTok のページ読み込み開始時に、ページ自身のJS環境へ入れるスクリプト(manifest の content_scripts)。
// プロフィールの投稿一覧をTikTokが読み込む通信(/api/post/item_list/)の応答を控えておき、
// あとから注入される抽出関数(lib/adapters/tiktok.js)が window.__snsPatrolTt から読む。
(() => {
  if (window.__snsPatrolTt) return;

  // pages: 読めた応答の数 / hasMore: まだ続きがあるか / items: 投稿(必要な項目だけ)
  // responses: 届いた応答の数(読めなかったものも含む) / lastBad: 読めなかった応答の先頭(失敗時の診断用)
  const store = (window.__snsPatrolTt = { pages: 0, hasMore: null, items: [], responses: 0, lastBad: null });

  window.__snsPatrolTap('/api/post/item_list', (text) => {
    store.responses++;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      store.lastBad = text.slice(0, 60) || '(空)';
      return;
    }
    if (!json || !Array.isArray(json.itemList)) {
      store.lastBad = text.slice(0, 60);
      return;
    }
    for (const item of json.itemList) {
      if (!item || !item.id) continue;
      store.items.push({
        id: String(item.id),
        author: (item.author && item.author.uniqueId) || '',
        desc: item.desc || '',
        // 本文に展開されていないハッシュタグもあるので、タグ情報も控える
        tags: [
          ...(item.textExtra || []).map((t) => t.hashtagName),
          ...(item.challenges || []).map((c) => c.title),
        ].filter(Boolean),
        createTime: Number(item.createTime) || 0,
        isPhoto: !!item.imagePost,
        pinned: !!item.isPinnedItem,
      });
    }
    store.hasMore = !!json.hasMore;
    store.pages++;
  });
})();
