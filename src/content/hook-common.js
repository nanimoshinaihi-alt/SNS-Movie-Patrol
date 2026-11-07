// 各サイトの *-hook.js より先に、ページ自身のJS環境へ入れる共通部品(manifest の content_scripts)。
// window.__snsPatrolTap(urlPart, onText) で、ページが行う通信のうち URL に urlPart を含むものの
// 応答本文を onText に渡す。通信の中身は変えず、読むだけ。
// fetch と XHR の差し替えは1回だけ行い、登録された読み取りをまとめて呼ぶ(登録のたびに重ねて差し替えない)。
(() => {
  if (window.__snsPatrolTap) return;
  const taps = [];
  window.__snsPatrolTap = (urlPart, onText) => taps.push({ urlPart, onText });

  const matching = (url) => taps.filter((tap) => String(url).includes(tap.urlPart));
  const deliver = (matched, text) => {
    if (typeof text !== 'string') return;
    for (const tap of matched) {
      try {
        tap.onText(text);
      } catch {
        // 応答の形式が変わっていても、ページ側の動作は止めない
      }
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const matched = matching(url);
      if (matched.length) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') deliver(matched, this.responseText);
            else if (this.responseType === 'json') deliver(matched, JSON.stringify(this.response));
          } catch {}
        });
      }
    } catch {}
    return originalOpen.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    try {
      // URL は文字列・URL オブジェクト・Request のいずれかで渡される
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      const matched = matching(url);
      if (matched.length) {
        promise.then((res) => res.clone().text()).then((text) => deliver(matched, text)).catch(() => {});
      }
    } catch {}
    return promise;
  };
})();
