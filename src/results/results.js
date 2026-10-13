// 直近の実行結果(storage の lastRun)を表示する。巡回中も保存のたびに追従する。
import browser from '../lib/browser.js';
import { getLastRun } from '../lib/storage.js';
import { formatJst, jstStamp } from '../lib/time.js';
import { $, el, notify, STATUS_LABEL } from '../lib/ui.js';

let run = { at: null, urls: [], rows: [] };

async function copyUrls(urls, label) {
  if (!urls.length) return notify('コピーするURLがありません');
  await navigator.clipboard.writeText(urls.join('\n'));
  notify(`${label}: ${urls.length}件をコピーしました`);
}

function render() {
  $('summary').textContent = run.at ? `${formatJst(run.at)} 実行` : 'まだ実行結果がありません';
  $('count').textContent = `${run.urls.length}件`;
  $('output').value = run.urls.join('\n');

  $('results').replaceChildren(
    ...run.rows.map((row) => {
      const urls = row.urls || [];
      const head = el(
        'div',
        { className: 'result-head' },
        el('span', { className: 'name', textContent: row.name, title: row.name }),
        el('span', { className: `status-${row.status}`, textContent: STATUS_LABEL[row.status] }),
        el('span', { className: 'muted', textContent: `${urls.length}件` })
      );
      const box = el('div', { className: 'box result' }, head);
      if (row.message) box.append(el('div', { className: 'muted', textContent: row.message }));
      if (urls.length) {
        const copy = el('button', { textContent: 'コピー' });
        copy.addEventListener('click', () => copyUrls(urls, row.name));
        head.append(copy);
        box.append(
          el('textarea', { readOnly: true, rows: Math.min(urls.length, 6), value: urls.join('\n') })
        );
      }
      return box;
    })
  );
}

$('copy').addEventListener('click', () => copyUrls(run.urls, 'すべて'));

$('save').addEventListener('click', () => {
  if (!run.urls.length) return notify('保存するURLがありません');
  const blob = new Blob([run.urls.join('\r\n') + '\r\n'], { type: 'text/plain' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `sns-movie-urls_${jstStamp(run.at || Date.now())}.txt`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

browser.storage.onChanged.addListener((changes) => {
  if (changes.lastRun && changes.lastRun.newValue) {
    run = changes.lastRun.newValue;
    render();
  }
});

(async () => {
  run = (await getLastRun()) || run;
  render();
})();
