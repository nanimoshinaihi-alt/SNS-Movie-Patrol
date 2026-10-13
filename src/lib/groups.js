// 巡回先のグループ(歌手・グループ・現役/OGなど)をタブで切り替えるための共通処理。
// タブの選択値: null = すべて / '' = 未分類 / それ以外 = グループ名

export const ALL_GROUPS = null;
export const UNGROUPED = '';

// タブに並べる選択肢。グループが1つもなければ「すべて」だけ。
export function groupTabOptions(groups) {
  return [
    { value: ALL_GROUPS, label: 'すべて' },
    ...groups.map((name) => ({ value: name, label: name })),
    ...(groups.length ? [{ value: UNGROUPED, label: '未分類' }] : []),
  ];
}

export function isInGroup(target, selected) {
  return selected === ALL_GROUPS || (target.group || '') === selected;
}

// 選択中のグループが削除・改名で無くなっていたら「すべて」に戻す
export function validSelection(groups, selected) {
  return groupTabOptions(groups).some((option) => option.value === selected) ? selected : ALL_GROUPS;
}

// グループの色。作った順(タブの並び順)に自動で割り当てる。
const GROUP_COLORS = [
  '#e5484d',
  '#2f8fe0',
  '#2fa56b',
  '#f08a24',
  '#7a5af8',
  '#12a5b5',
  '#d94fb8',
  '#c49a0a',
  '#8d6e63',
  '#607d8b',
];

// colors は「グループ名 → 色の番号」(storage の groupColors)。
// 番号を覚えていないグループは、並び順の番号で代用する。
export function groupColor(groups, colors, name) {
  if (!groups.includes(name)) return null;
  const index = colors[name] ?? groups.indexOf(name);
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

// 色の番号をまだ持っていないグループに番号を割り当て、無くなったグループの番号を捨てた対応表を返す。
// 新しいグループには、まだ使われていない色を優先して割り当てる。
export function assignGroupColors(groups, colors) {
  const assigned = {};
  // 番号を覚えていない既存のグループは、これまでの見た目(並び順の色)を引き継ぐ
  groups.forEach((name, position) => {
    if (name in colors) assigned[name] = colors[name];
    else if (!Object.keys(colors).length) assigned[name] = position;
  });
  for (const name of groups) {
    if (name in assigned) continue;
    const used = new Set(Object.values(assigned).map((index) => index % GROUP_COLORS.length));
    const free = GROUP_COLORS.findIndex((_, index) => !used.has(index));
    assigned[name] = free >= 0 ? free : Object.keys(assigned).length;
  }
  return assigned;
}

// グループの色の ◆。グループに入っていない巡回先には null を返す。
export function groupMark(groups, colors, name) {
  const color = groupColor(groups, colors, name);
  if (!color) return null;
  const mark = document.createElement('span');
  mark.className = 'group-mark';
  mark.textContent = '◆';
  mark.title = name;
  mark.style.color = color;
  return mark;
}

// タブの列を container に描く。onSelect(value) はタブを押したときに呼ばれる。
// グループのタブはそのグループの色で、未選択なら縁取り、選択中なら塗りつぶしになる(色は ui.css の --tab-color)。
// 「すべて」「未分類」は色を持たないので、カードの色になる。
export function renderGroupTabs(container, groups, colors, selected, onSelect) {
  // タブの列の下線も、選択中のタブの色に合わせる
  const selectedColor = groupColor(groups, colors, selected);
  if (selectedColor) container.style.setProperty('--tab-color', selectedColor);
  else container.style.removeProperty('--tab-color');

  container.replaceChildren(
    ...groupTabOptions(groups).map((option) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `tab${option.value === selected ? ' active' : ''}`;
      // ドロップ先の判定用(設定画面で巡回先をタブへドラッグして移す)
      tab.dataset.kind = option.value === ALL_GROUPS ? 'all' : 'group';
      tab.dataset.group = option.value ?? '';
      // 色を持たないタブは、列の下線用に継承した色を打ち消してカードの色に戻す
      tab.style.setProperty('--tab-color', groupColor(groups, colors, option.value) || 'var(--accent)');
      tab.textContent = option.label;
      tab.addEventListener('click', () => onSelect(option.value));
      return tab;
    })
  );
}
