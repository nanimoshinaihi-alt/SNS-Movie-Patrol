// サイトごとのアダプタ登録。サイトを増やすときは、アダプタのファイルを追加してここに並べ、
// manifest の host_permissions にそのサイトを足すだけでよい。
//
// 巡回先は { site, account, hashtags: [], keyword } の組み合わせで表す。
//   account  : このアカウントの投稿に限る
//   hashtags : いずれかのハッシュタグを含む投稿に限る(複数はOR)
//   keyword  : 検索ワード
//
// アダプタが持つもの:
//   id, label                : 種別のIDと表示名
//   fields                   : 使える指定項目。{ account: { required, placeholder }, hashtags: {...}, keyword: {...} }
//                              書かなかった項目はそのサイトでは指定できない。
//   normalizeAccount(raw)    : アカウント入力の整形(@ やURLの除去など)
//   buildUrl(target, range)  : 巡回で開くURL。range = { sinceMs, untilMs }
//   extract(opts)            : 巡回タブ内に注入して実行する関数。opts = { sinceMs, untilMs, maxScrolls, target }
//                              { ok, items: [{ key, url, timeMs, text?, tags? }], truncated?, error? } を返す。
//                              text(本文)を付けた投稿は、拡張側(lib/match.js)がハッシュタグ・検索ワードで絞り込む。
//                              サイト側の検索で絞り込み済みなら text を付けない。
//                              失敗時、読み込み直しても直らないもの(未ログインなど)は fatal: true を付ける。
//                              付けなければ、巡回側がページを一度読み込み直してやり直す。
//                              ページ側で単体実行されるので、関数の外の変数や import は使えない。
//   world                    : (任意) 'MAIN' にすると extract をページ自身のJS環境で実行する
import x from './x.js';
import instagram from './instagram.js';
import tiktok from './tiktok.js';

export const adapters = [x, instagram, tiktok];

export function getAdapter(siteId) {
  const adapter = adapters.find((a) => a.id === siteId);
  if (!adapter) throw new Error(`未対応のサイトです: ${siteId}`);
  return adapter;
}

// "#a b、#c" のような入力をハッシュタグ名の配列にする
export function parseHashtags(raw) {
  const tags = raw
    .split(/[\s,、]+/)
    .map((t) => t.replace(/^[#＃]/, ''))
    .filter(Boolean);
  return [...new Set(tags)];
}

// 一覧に出す表示名。例: "@account #tag 「keyword」"
export function describeTarget(target) {
  return [
    target.account && `@${target.account}`,
    ...target.hashtags.map((t) => `#${t}`),
    target.keyword && `「${target.keyword}」`,
  ]
    .filter(Boolean)
    .join(' ');
}
