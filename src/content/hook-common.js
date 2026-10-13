// 各サイトの *-hook.js より先に、ページ自身のJS環境へ入れる共通部品(manifest の content_scripts)。
// ページが行う通信のうち、URLに urlPart を含むものの応答本文を onText に渡す。
// 通信の中身は変えず、読むだけ。
window.__snsPatrolTap = (urlPart, onText) => {
  const deliver = (text) => {
    try {
      if (typeof text === 'string') onText(text);
    } catch {
      // 応答の形式が変わっていても、ページ側の動作は止めない
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes(urlPart)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') deliver(this.responseText);
          else if (this.responseType === 'json') deliver(JSON.stringify(this.response));
        } catch {}
      });
    }
    return originalOpen.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
      if (String(url).includes(urlPart)) {
        promise.then((res) => res.clone().text()).then(deliver).catch(() => {});
      }
    } catch {}
    return promise;
  };
};
