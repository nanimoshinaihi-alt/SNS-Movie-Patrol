// 投稿の本文が、巡回先のハッシュタグ・検索ワードの条件に合うかの判定。全サイト共通。
//   ハッシュタグ : 指定のどれか1つを含む。タグ単位の完全一致(「#猫」で「#猫好き」は拾わない)
//   検索ワード   : 本文への部分一致。空白区切りは「すべて含む」、大文字の OR で区切ると「どれかの組を満たす」
//   両方指定     : 両方を満たす
// 大文字小文字は区別しない。

const TAG_PATTERN = /[#＃][\p{L}\p{N}\p{M}_]+/gu;

// post = { text, tags? }。tags は本文とは別にサイトが持っているハッシュタグ情報(あれば)。
export function matchesTarget(target, { text = '', tags = [] }) {
  const lower = text.toLowerCase();

  if (target.hashtags.length) {
    const found = new Set([
      ...(lower.match(TAG_PATTERN) || []).map((tag) => tag.slice(1)),
      ...tags.map((tag) => tag.toLowerCase()),
    ]);
    if (!target.hashtags.some((tag) => found.has(tag.toLowerCase()))) return false;
  }

  const wordSets = target.keyword
    .split(/\s+OR\s+/)
    .map((set) => set.toLowerCase().split(/\s+/).filter(Boolean))
    .filter((set) => set.length);
  return !wordSets.length || wordSets.some((set) => set.every((word) => lower.includes(word)));
}
