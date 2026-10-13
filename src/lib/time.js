// 日時の表示・判定はすべて JST(UTC+9) 基準。PCのタイムゾーン設定には依存させない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    mi: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
}

// 例: 2026-10-11 21:05
export function formatJst(ms) {
  if (ms == null) return '未実行';
  const p = jstParts(ms);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`;
}

// <input type="datetime-local"> の値(例: 2026-10-11T21:05)との相互変換。値は日本時間として扱う。
export function toJstInput(ms) {
  const p = jstParts(ms);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}`;
}

export function parseJstInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
}

// JSTでその日の 00:00
export function startOfJstDay(ms) {
  const p = jstParts(ms);
  return Date.UTC(p.y, Number(p.mo) - 1, Number(p.d)) - JST_OFFSET_MS;
}

// ファイル名用。例: 20261011_210500
export function jstStamp(ms) {
  const p = jstParts(ms);
  return `${p.y}${p.mo}${p.d}_${p.h}${p.mi}${p.s}`;
}
