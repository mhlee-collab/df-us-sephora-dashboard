// 상호작용 경로(모드 전환·필터·표·탭)를 전부 밟아 런타임 오류를 잡고,
// 규칙 위반(font: 축약형 · sticky 덮어쓰기 · 툴팁 콜백 후행 대입 · 축 offset)을 검사한다.
// node --check 통과는 최소 조건일 뿐이다.
//
//   실행:  node test/run.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SP = path.join(__dirname, '.tmp');

// verify-figures.js 의 페이로드 빌드 부분을 재사용
const buildSrc = fs.readFileSync(path.join(__dirname, 'verify-figures.js'), 'utf8');
const payloadSrc = buildSrc.split('// ── 2. 최소 DOM 스텁')[0];
const payloadMod = { exports: {} };
vm.runInNewContext(payloadSrc + '\nmodule.exports = payload;',
  { module: payloadMod, require, __dirname, console: { log() {} }, process },
  { filename: 'payload.js' });
const payload = payloadMod.exports;

// ── DOM 스텁 ────────────────────────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, children: [],
    classList: { _s: new Set(),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,v){ v===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (v?this._s.add(c):this._s.delete(c)); },
      contains(c){return this._s.has(c);} },
    querySelectorAll(){ return []; },
    querySelector(){ return makeEl('sub'); },
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0) this.children.splice(i,1); return c; },
    addEventListener(){}, removeEventListener(){}, closest(){ return null; },
    getContext(){ return { canvasId: id }; }, setAttribute(){}, getAttribute(){ return null; }, focus(){}
  };
  return el;
}
const els = {};
const charts = [];
// 캔버스가 여러 개(Overview 콤보 · 채널별 차트)라 어느 차트인지 갈라 봐야 한다
const lastChart = (canvasId) => {
  for (let i = charts.length - 1; i >= 0; i--) if (charts[i].__canvas === canvasId) return charts[i];
  return null;
};
const sandbox = {
  console, Date, Math, JSON, Set, Map, Array, Object, String, Number,
  parseInt, parseFloat, isNaN, URLSearchParams, setTimeout, clearTimeout,
  setInterval, clearInterval, Promise, fetch,
  document: {
    getElementById(id){ return els[id] || (els[id] = makeEl(id)); },
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    createElement(t){ return makeEl(t); }, addEventListener(){}, removeEventListener(){}
  },
  Chart: class Chart {
    constructor(c, cfg){ this.cfg = cfg; cfg.__canvas = c && c.canvasId; charts.push(cfg); }
    destroy(){}
  },
  sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  localStorage:   { getItem: () => null, setItem(){}, removeItem(){} },
  history: { replaceState(){} },
  location: { hash: '', search: '', pathname: '/' }
};
sandbox.Chart.defaults = { color: '#666', font: { family: '' } };
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SP, 'block01.js'), 'utf8'), sandbox, { filename: 'index.html' });

const fail = [];
function step(label, fn) {
  try { const r = fn(); console.log(`  OK  ${label}${r !== undefined ? ' → ' + r : ''}`); }
  catch (e) { console.log(`  ✗   ${label}: ${e.message}`); fail.push(label + ': ' + e.message); }
}
function assert(label, cond, detail) {
  if (cond) console.log(`  OK  ${label}${detail !== undefined ? ' → ' + detail : ''}`);
  else { console.log(`  ✗   ${label}${detail !== undefined ? ' → ' + detail : ''}`); fail.push(label); }
}
const btn = () => makeEl('btn');
// 마크업 자체를 봐야 하는 검사가 중간에도 있어 미리 읽어 둔다
const INDEX_HTML_EARLY = fs.readFileSync(process.env.DFUS_INDEX, 'utf8');

sandbox.applyPayload(payload);

console.log('\n── 기본값 (MJ 결정 2026-08-16) ──');
// 🛑 두 탭 모두 기본은 일(day) 보기 · 통화는 KRW(백만원)
assert('통합 탭 기본 기간 = 일', sandbox.mainPeriod === 'daily', sandbox.mainPeriod);
assert('유입 탭 기본 기간 = 일', sandbox.chPeriod === 'daily', sandbox.chPeriod);
assert('기본 통화 = KRW', sandbox.curCurrency === 'KRW', sandbox.curCurrency);
assert('  마크업의 active 도 일에 붙어 있다',
  /data-main-period="daily"/.test(INDEX_HTML_EARLY.match(/class="tgl active" data-main-period="\w+"/)?.[0] || '')
  && /data-ch-period="daily"/.test(INDEX_HTML_EARLY.match(/class="tgl active" data-ch-period="\w+"/)?.[0] || ''), 'ok');

console.log('\n── 색 배분 — 차콜 사이드바 + CI 레드 단일 (MJ 결정 2026-08-16) ──');
// 🛑 ① 큰 면적(사이드바)은 차콜이 받는다  ② 붉은 계열은 #DD061A 한 종류만 쓴다
assert('사이드바 = 차콜 (레드 대면적 제거)', /--sidebar:#22222A/.test(INDEX_HTML_EARLY), 'ok');
['--bar', '--tgl-on-bg', '--tgl-on-bd'].forEach(function(tok){
  assert('  ' + tok + ' = CI 레드', new RegExp(tok + ':#DD061A').test(INDEX_HTML_EARLY), 'ok');
});
assert('  🛑 붉은 계열이 CI 레드 한 종류뿐 (다른 단 없음)',
  !/#C2183A|#C40416|#FDECEF|#F1AEB7/i.test(
    INDEX_HTML_EARLY.split('</style>')[0].replace(/\/\*[\s\S]*?\*\//g, '')), 'ok');
assert('  사용처가 토큰을 본다 (하드코딩 아님)',
  /\.sidebar\{[^}]*background:var\(--sidebar\)/.test(INDEX_HTML_EARLY)
  && /\.tgl\.active\{background:var\(--tgl-on-bg\)/.test(INDEX_HTML_EARLY), 'ok');
assert('  매출 막대 = CI 레드',
  String(lastChart('mainChart').data.datasets[0].hoverBackgroundColor).toUpperCase() === '#DD061A',
  lastChart('mainChart').data.datasets[0].hoverBackgroundColor);
assert('  세포라 상단 보더는 별개로 유지', /--sephora:#c8102e/.test(INDEX_HTML_EARLY), 'ok');

console.log('\n── 통합 탭 컨트롤 ──');
step('기간 토글 월', () => sandbox.setMainPeriod(btn(), 'monthly'));
step('기간 토글 일', () => sandbox.setMainPeriod(btn(), 'daily'));
step('기간 토글 주', () => sandbox.setMainPeriod(btn(), 'weekly'));
step('Visits 토글',   () => sandbox.toggleSeries(btn(), 'visits'));
step('주문 수량 토글', () => sandbox.toggleSeries(btn(), 'orders'));
step('CVR 토글',      () => sandbox.toggleSeries(btn(), 'cvr'));

console.log('\n── 통합 탭 통화 칩 (KRW 백만원 / USD) ──');
// 🛑 기본 선택은 KRW(백만원). 축·툴팁·데이터 테이블이 함께 따라가고 기간·필터는 유지된다.
assert('기본 통화 = KRW', sandbox.curCurrency === 'KRW', sandbox.curCurrency);
assert('  Sales 축 제목이 백만원',
  lastChart('mainChart').options.scales.yS.title.text === 'Sales (백만원)',
  lastChart('mainChart').options.scales.yS.title.text);
// 단위는 기준 열의 지표명이 지고, 셀에는 「백만원」도 소수점도 붙이지 않는다 (MJ 결정 2026-08-16)
const salesCells = () => {
  const m = els['mainTable'].innerHTML.match(/<tr><td>SALES[^<]*<\/td>(.*?)<\/tr>/);
  return m ? m[1] : '';
};
assert('  데이터 테이블 지표명에만 (백만원)',
  /SALES \(백만원\)/.test(els['mainTable'].innerHTML), 'ok');
assert('  🛑 셀 숫자 옆에 「백만원」 텍스트 없음', !/백만원/.test(salesCells()), salesCells());
assert('  🛑 KRW 셀에 소수점 없음', !/\d\.\d/.test(salesCells()), salesCells());
const KRW_SALES_BAR = lastChart('mainChart').data.datasets[0].data.slice();
const PERIOD_BEFORE = sandbox.mainPeriod;
step('통화 USD 로 전환', () => sandbox.setCurrency(btn(), 'USD'));
assert('  Sales 축 제목이 USD',
  lastChart('mainChart').options.scales.yS.title.text === 'Sales (USD)',
  lastChart('mainChart').options.scales.yS.title.text);
const USD_SALES_BAR = lastChart('mainChart').data.datasets[0].data.slice();
assert('  환산 = $1 × 1,500 ÷ 100만 (백만원 단위)',
  KRW_SALES_BAR.every((v, i) => Math.abs(v - USD_SALES_BAR[i] * payload.usdToKrw / 1e6) < 1e-9), 'ok');
assert('  통화만 바뀌고 기간 토글은 유지', sandbox.mainPeriod === PERIOD_BEFORE, sandbox.mainPeriod);
assert('  데이터 테이블도 USD 로 따라감',
  /SALES \(USD\)/.test(els['mainTable'].innerHTML) && !/백만원/.test(els['mainTable'].innerHTML), 'ok');
assert('  🛑 USD 셀도 소수점 없음', !/\d\.\d/.test(salesCells()), salesCells());
step('통화 KRW 로 복귀', () => sandbox.setCurrency(btn(), 'KRW'));

console.log('\n── 통합 탭 데이터 테이블 ──');
assert('그래프 아래 표가 그려진다', /<table class="ch-tbl/.test(els['mainTable'].innerHTML), 'ok');
assert('  4개 지표 행 (SALES · VISITS · ORDERS · CVR)',
  ['SALES', 'VISITS', 'ORDERS', 'CVR'].every(k => els['mainTable'].innerHTML.includes(k)), 'ok');
assert('  열 = 그래프의 기간 수 + 기준 열 1',
  (els['mainTable'].innerHTML.match(/<th>/g) || []).length
    === lastChart('mainChart').data.labels.length + 1,
  (els['mainTable'].innerHTML.match(/<th>/g) || []).length);
step('기간 일로 바꾸면 표도 따라간다', () => sandbox.setMainPeriod(btn(), 'daily'));
assert('  표 열 수가 일 수를 따라감',
  (els['mainTable'].innerHTML.match(/<th>/g) || []).length
    === lastChart('mainChart').data.labels.length + 1, 'ok');
step('기간 주로 복귀', () => sandbox.setMainPeriod(btn(), 'weekly'));

console.log('\n── 통합 탭 필터 (MONTH / WEEK) ──');
const MONTHS = [...new Set(payload.commerce.map(r => r.month))].sort();
const LAST_MONTH = MONTHS[MONTHS.length - 1];
const TOTAL_SALES = payload.commerce.reduce((a, r) => a + r.sales, 0);
step(`MONTH=${LAST_MONTH} 선택`, () => { sandbox.selMonths.add(LAST_MONTH); sandbox.refreshMain(true); });
assert('  필터가 실제로 좁힌다', (() => {
  const got = sandbox.sumRows(sandbox.mainFiltered()).sales;
  const want = payload.commerce.filter(r => r.month === LAST_MONTH).reduce((a, r) => a + r.sales, 0);
  return Math.abs(got - want) < 1e-9 && got < TOTAL_SALES;
})(), 'ok');
step('MONTH 해제', () => sandbox.clearFilter('month'));
assert('  해제하면 전체로 복귀',
  Math.abs(sandbox.sumRows(sandbox.mainFiltered()).sales - TOTAL_SALES) < 1e-9, 'ok');
const WK = payload.weeks.map(w => w.key);          // 전부 데이터 파생 — 라벨을 박지 않는다
step(`WEEK=${WK[1]} 선택`, () => { sandbox.selWeeks.add(WK[1]); sandbox.refreshMain(true); });
assert(`  ${WK[1]} vs ${WK[0]} 비교 배지 생성`, /kpi-badge/.test(els['kpiRow'].innerHTML), 'WoW');
assert('  비교 라벨이 데이터 파생',
  els['kpiRow'].innerHTML.includes(sandbox.weekLabel(WK[0])), sandbox.weekLabel(WK[0]));
step(`WEEK=${WK[0]} 선택 (첫 주)`, () => {
  sandbox.selWeeks.clear(); sandbox.selWeeks.add(WK[0]); sandbox.refreshMain(true);
});
assert('  첫 주는 직전 주가 없어 배지 미표시', !/kpi-badge/.test(els['kpiRow'].innerHTML), 'ok');
step('WEEK 해제', () => sandbox.clearFilter('week'));

console.log('\n── Overview — CHANNEL ALL 이면 합산 콤보 ──');
// ALL 일 때만 Sales=Bar · Visits=Area · CVR=Line. 채널을 고르면 개별 라인으로 간다
// (MJ 결정 2026-08-16 — 지시서 B2 「형태 고정」은 이 결정으로 무효).
step('유입 탭 렌더', () => sandbox.refreshChannel(true));
const overviewShape = () => {
  const c = lastChart('chComboChart');
  return c.data.datasets.map(d => d.label + ':' + d.type).join(' · ');
};
assert('Sales=bar · Visits=line(fill) · CVR=line', (() => {
  const ds = lastChart('chComboChart').data.datasets;
  const s = ds.find(d => d.label === 'Sales'), v = ds.find(d => d.label === 'Visits'),
        r = ds.find(d => d.label === 'CVR');
  return s && s.type === 'bar' && v && v.type === 'line' && v.fill === true && r && r.type === 'line' && !r.fill;
})(), overviewShape());
assert('config.type = bar', lastChart('chComboChart').type === 'bar', lastChart('chComboChart').type);
const SHAPE_BEFORE = overviewShape();

console.log('\n── 채널별 차트 — 지표마다 차트를 따로 (UNOVE 배치) ──');
// 🛑 SALES 축 제목은 통화 칩을 따른다 (기본 KRW → 백만원)
const SPLIT_PANES = [['chSplitVisits', 'Visits'], ['chSplitSales', 'Sales (백만원)'], ['chSplitCvr', 'CVR (%)']];
SPLIT_PANES.forEach(([canvas, title]) => {
  assert(`  ${canvas} 축 제목 = ${title}`,
    lastChart(canvas).options.scales.y.title.text === title,
    lastChart(canvas).options.scales.y.title.text);
  assert('    축 0 고정',
    lastChart(canvas).options.scales.y.min === 0
    && lastChart(canvas).options.scales.y.beginAtZero === true, 'ok');
  assert('    계열 14 (NA 제외)', lastChart(canvas).data.datasets.length === 14,
    lastChart(canvas).data.datasets.length);
  assert('    config.type 명시', lastChart(canvas).type === 'line', lastChart(canvas).type);
});
assert('브랜드 레드가 계열색에 없음',
  !lastChart('chSplitVisits').data.datasets.some(d => String(d.borderColor).toUpperCase() === '#DD061A'), 'ok');
assert('  채널별 차트가 그려져도 Overview 형태는 그대로',
  overviewShape() === SHAPE_BEFORE, overviewShape());

// 🛑 채널 색은 UNOVE 세포라 대시보드와 **완전히 동일한 값**으로 통일한다 (MJ 결정 2026-08-16).
//    두 대시보드를 나란히 보는 사람이 같은 채널을 같은 색으로 인식해야 한다.
const colorOf = (ch) => {
  const d = lastChart('chSplitVisits').data.datasets.find(x => x.label === ch);
  return d && String(d.borderColor).toUpperCase();
};
const UNOVE_COLORS = {
  'Direct':'#2F5496', 'Organic Social':'#6AA84F', 'Push':'#E06666', 'Paid Search':'#9673A6',
  'Affiliate':'#E69138', 'Brand Media':'#CC0000', 'Email':'#F4B942', 'Organic Search':'#3D85C6',
  'Paid Social':'#A64D79', 'SMS':'#45818E', 'Referrer':'#FFD966', 'Internal Referrer':'#B6D7A8',
  'Other Campaigns':'#D5A6BD', 'Display':'#999999'
};
assert('🛑 14색이 UNOVE 값과 완전히 일치',
  Object.keys(UNOVE_COLORS).every(ch => colorOf(ch) === UNOVE_COLORS[ch]),
  Object.keys(UNOVE_COLORS).filter(ch => colorOf(ch) !== UNOVE_COLORS[ch]).join(',') || 'ok');
assert('  전 채널 색이 고유', (() => {
  const cs = lastChart('chSplitVisits').data.datasets.map(d => String(d.borderColor).toUpperCase());
  return new Set(cs).size === cs.length;
})(), 'ok');

console.log('\n── 블록별 채널 드롭다운 (Visits·Sales 와 CVR 이 서로 독립) ──');
step('Visits·Sales 블록만 2개 선택', () => {
  sandbox.selVsChans.add('Affiliate'); sandbox.selVsChans.add('Direct');
  sandbox.refreshChannel(true);
});
assert('  Visits·Sales 차트만 2계열',
  lastChart('chSplitVisits').data.datasets.length === 2
  && lastChart('chSplitSales').data.datasets.length === 2,
  lastChart('chSplitVisits').data.datasets.map(d => d.label).join(','));
assert('  🛑 CVR 블록은 영향 없음 (독립)',
  lastChart('chSplitCvr').data.datasets.length === 14,
  lastChart('chSplitCvr').data.datasets.length);
step('CVR 블록만 1개 선택', () => {
  sandbox.selCvrChans.add('Affiliate'); sandbox.refreshChannel(true);
});
assert('  CVR 차트만 1계열', lastChart('chSplitCvr').data.datasets.length === 1,
  lastChart('chSplitCvr').data.datasets.map(d => d.label).join(','));
assert('  🛑 Visits·Sales 는 그대로 2계열',
  lastChart('chSplitVisits').data.datasets.length === 2,
  lastChart('chSplitVisits').data.datasets.length);
assert('  🛑 Overview 는 언제나 전체 합산 (bar · 3계열)',
  lastChart('chComboChart').type === 'bar'
  && lastChart('chComboChart').data.datasets.length === 3, overviewShape());
step('두 블록 모두 해제 (ALL)', () => {
  sandbox.clearFilter('vsChan'); sandbox.clearFilter('cvrChan');
});
assert('  다시 14계열',
  SPLIT_PANES.every(([c]) => lastChart(c).data.datasets.length === 14),
  SPLIT_PANES.map(([c]) => lastChart(c).data.datasets.length).join(','));

console.log('\n── 유입 채널 탭 기간 ──');
step('기간 일',  () => sandbox.setChPeriod(btn(), 'daily'));
assert('일 축 라벨 세로',
  lastChart('chComboChart').options.scales.x.ticks.minRotation === 90, '90도');
step('기간 월',  () => sandbox.setChPeriod(btn(), 'monthly'));
step('기간 주',  () => sandbox.setChPeriod(btn(), 'weekly'));

console.log('\n── 유입 채널 탭 필터 캐스케이드 ──');
const CH_MONTHS = [...new Set(payload.channel.map(r => r.date.slice(0, 7)))].sort();
const FIRST_MONTH = CH_MONTHS[0];
step(`MONTH=${FIRST_MONTH} 선택`, () => {
  sandbox.selChMonths.add(FIRST_MONTH);
  sandbox.buildChWeekOptions();
  sandbox.refreshChannel(true);
});
assert('  그 달의 주차만 남는다 (캐스케이드)', (() => {
  const inMonth = [...new Set(payload.channel.filter(r => r.date.slice(0,7) === FIRST_MONTH).map(r => r.week))];
  return inMonth.length > 0 && inMonth.length < WK.length;
})(), 'ok');
step('MONTH 해제 → 주 선택도 초기화', () => sandbox.clearFilter('chMonth'));
assert('주 선택 비어 있음', sandbox.selChWeeks.size === 0, sandbox.selChWeeks.size);

console.log('\n── 상단 CHANNEL 필터 제거 (MJ 결정 2026-08-16) ──');
// 🛑 상단 필터를 없앴으므로 Overview 는 언제나 전체 합산 형태로 고정된다.
//    채널 선택은 아래 두 블록이 각자 가진다.
assert('🛑 상단 필터 마크업이 없다', !INDEX_HTML_EARLY.includes('ddPanel-chChan'), 'ok');
assert('  상단 필터는 Month · Week 둘뿐',
  (INDEX_HTML_EARLY.match(/id="ddWrap-(month|week|chMonth|chWeek|vsChan|cvrChan)"/g) || []).length === 6, 'ok');
assert('Overview 는 언제나 합산 콤보 (bar · 3계열)',
  lastChart('chComboChart').type === 'bar'
  && lastChart('chComboChart').data.datasets.length === 3, overviewShape());
assert('  랭킹은 전 채널 대상 (NA 제외)', sandbox.activeChannels().length === 14,
  sandbox.activeChannels().length);
step('NA 만 남기면 (블록 드롭다운으로)', () => {
  sandbox.selVsChans.add('NA'); sandbox.selCvrChans.add('NA'); sandbox.refreshChannel(true);
});
assert('  차트 계열 0', SPLIT_PANES.every(([c]) => lastChart(c).data.datasets.length === 0),
  SPLIT_PANES.map(([c]) => lastChart(c).data.datasets.length).join(','));
assert('  표는 안내로 대체',
  /표시할 채널이 없습니다/.test(els['chVsTable'].innerHTML)
  && /표시할 채널이 없습니다/.test(els['chCvrTable'].innerHTML), 'ok');
assert('  🛑 Overview 는 여전히 전체 합산', lastChart('chComboChart').data.datasets.length === 3,
  overviewShape());
step('블록 드롭다운 해제', () => {
  sandbox.clearFilter('vsChan'); sandbox.clearFilter('cvrChan');
});

console.log('\n── NA 카드의 기준 구간 ──');
// 통화 칩이 유입 탭에도 걸린다 → 달러 수치를 대조하려면 USD 로 맞추고 본다.
step('통화 USD 로 맞춤', () => sandbox.setCurrency(btn(), 'USD'));
// KPI 카드는 「기준 기간」(필터 없으면 최신 기간 1개)이고, 보조줄에 필터 범위 누계를 함께 단다.
// 🛑 NA 비중 경고 배너는 화면에서 제거했다 (MJ 결정 2026-08-16) — 아래에서 그 부재를 고정한다.
step('필터 전부 해제', () => {
  sandbox.selChMonths.clear(); sandbox.selChWeeks.clear();
  sandbox.buildChWeekOptions(); sandbox.refreshChannel(true);
});
const naByWeek = {}, salesByWeek = {};
let naAll = 0, salesAll = 0;
payload.channel.forEach(r => {
  salesByWeek[r.week] = (salesByWeek[r.week] || 0) + r.sales;
  salesAll += r.sales;
  if (r.channel === 'NA') { naByWeek[r.week] = (naByWeek[r.week] || 0) + r.sales; naAll += r.sales; }
});
const LASTW = WK[WK.length - 1];
const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const naHtml = els['chKpiRow'].innerHTML;

assert('NA 카드 본값 = 최신 기간 NA 합계',
  naHtml.includes(usd(naByWeek[LASTW])), usd(naByWeek[LASTW]) + ` (${LASTW})`);
assert('보조줄에 필터 범위 누계도 함께 표시',
  naHtml.includes(usd(naAll)), usd(naAll));
assert('🛑 「전체 매출의」로 오라벨하지 않는다',
  !naHtml.includes('전체 매출의'), 'ok');
assert('  기준을 「기준 기간 매출의」로 명시',
  naHtml.includes('기준 기간 매출의'), 'ok');
assert('카드 비율 = 최신 기간 기준',
  naHtml.includes((naByWeek[LASTW] / salesByWeek[LASTW] * 100).toFixed(2) + '%'),
  (naByWeek[LASTW] / salesByWeek[LASTW] * 100).toFixed(2) + '%');

// 🛑 B1 — NA 비중 문구는 화면에서 완전히 제거했다. 계산 규칙(차트·표 제외 / 매출·KPI 포함)은 유지.
// 렌더 경로에서 #chAlert 를 아예 건드리지 않는다 (스텁은 접근이 있어야만 els 에 생긴다)
assert('🛑 NA 비중 경고 배너를 그리지 않는다', els['chAlert'] === undefined, '미접근');
assert('  「일별 NA 비중」 문구가 코드에서 사라짐',
  !/일별 NA 비중이/.test(fs.readFileSync(path.join(SP, 'block01.js'), 'utf8')), 'ok');
assert('  NA 계산 규칙은 유지 — KPI 매출에 NA 포함',
  naHtml.includes(usd(salesByWeek[LASTW])), usd(salesByWeek[LASTW]));
assert('  NA 는 차트·표에서 여전히 제외', sandbox.activeChannels().indexOf('NA') < 0, 'ok');

console.log('\n── 채널 랭킹 (best 3 / worst 3) ──');
const rankHtml = els['chRankGrid'].innerHTML;
assert('지표 3종 카드', ['VISITS', 'SALES', 'CVR'].every(k => rankHtml.includes(k)), 'ok');
assert('  BEST / WORST 양쪽 존재', /BEST 3/.test(rankHtml) && /WORST 3/.test(rankHtml), 'ok');
assert('  랭킹에 NA 없음', !/rank-nm" title="NA"/.test(rankHtml), 'ok');
// 🛑 영역명에 기간을 박지 않는다 (MJ 결정 2026-08-16)
assert('  영역명은 「유입 채널 랭킹」 고정', els['chRankHdr'].textContent === '유입 채널 랭킹',
  els['chRankHdr'].textContent);
// 랭킹은 전 채널을 대상으로 하므로, 채널 수가 3 미만인 상황은 데이터 쪽에서 만든다
const ALL_CHANS = sandbox.D.channels;
step('채널이 2개뿐일 때 (3개 미만 경로)', () => {
  sandbox.D.channels = ['Email', 'Push', 'NA'];
  sandbox.refreshChannel(true);
});
assert('  채널 3개 미만이면 있는 만큼만 그린다',
  /BEST 2/.test(els['chRankGrid'].innerHTML), 'BEST 2');
step('채널 목록 복구', () => { sandbox.D.channels = ALL_CHANS; sandbox.refreshChannel(true); });

console.log('\n── 블록별 표 (그래프 바로 아래) ──');
let html = els['chVsTable'].innerHTML;
const cvrHtml = els['chCvrTable'].innerHTML;
assert('표에 NA 행 없음', !/>NA</.test(html) && !/>NA</.test(cvrHtml), 'ok');
// 🛑 Visits 와 Sales 를 한 행에 나란히 두지 않는다 — 지표별로 행 블록을 나눈다
// 🛑 셀에 단위를 안 붙이므로 지표명이 단위를 진다 → 통화에 따라 라벨이 바뀐다
assert('🛑 Visits·Sales 표는 지표별 행 블록',
  html.includes('<tr class="grp"><td>Visits TY</td>')
  && /<tr class="grp"><td>Sales TY \((백만원|USD)\)<\/td>/.test(html), 'ok');
assert('  CVR 은 자기 표에 따로', cvrHtml.includes('<tr class="grp"><td>Conversion TY (%)</td>')
  && !html.includes('Conversion TY (%)'), 'ok');
assert('  열은 기간뿐 (지표가 열을 늘리지 않는다)',
  (html.match(/<th>/g) || []).length === lastChart('chComboChart').data.labels.length + 2,
  (html.match(/<th>/g) || []).length + '열');
// 헤더 1행 + 지표 N블록 × (채널 14행 + 합계 1행). 지표 구분행은 <tr class="grp"> 라 안 걸린다.
assert('  Visits·Sales 표 = 헤더 1 + 2블록×15',
  (html.match(/<tr>/g) || []).length === 1 + (14 + 1) * 2, (html.match(/<tr>/g) || []).length);
assert('  CVR 표 = 헤더 1 + 1블록×15',
  (cvrHtml.match(/<tr>/g) || []).length === 1 + (14 + 1), (cvrHtml.match(/<tr>/g) || []).length);
assert('  CVR 블록은 방문 가중 평균 행', /AVG \(방문 가중\) — Conversion TY \(%\)/.test(cvrHtml), 'ok');
// 🛑 표본 과소 표시(·n=)는 걷어냈다 — 전환이 없었으면 그냥 0 으로 보여준다 (MJ 결정 2026-08-16)
assert('🛑 «·n=» 표본 주석이 없다', !/n=\d/.test(html) && !/n=\d/.test(cvrHtml), 'ok');
assert('  방문 0인 칸만 «-»', /class="dash"/.test(cvrHtml), 'ok');

// 🛑 정렬 규칙 고정 — 각 지표 블록은 **가장 최근 기간 값** 기준 내림차순 (MJ 확인 2026-08-16).
//    블록마다 기준 지표가 다르다: Visits 블록은 최근 방문, Sales 블록은 최근 매출, CVR 블록은 최근 CVR.
const blockOrder = (tableHtml, blockIdx) => {
  const rows = tableHtml.split('<tr class="grp">')[blockIdx + 1].split('<tr>').slice(1);
  return rows.filter(r => !/^<td>(TOTAL|AVG)/.test(r)).map(r => {
    const tds = r.split('</td>');
    const last = tds[tds.length - 3] || '';        // 마지막 기간 열 (WoW 앞)
    const num = parseFloat(String(last).replace(/[^0-9.\-]/g, ''));
    return isNaN(num) ? null : num;
  }).filter(v => v !== null);
};
const isDesc = arr => arr.every((v, i) => i === 0 || arr[i - 1] >= v);
assert('🛑 Visits 블록이 최근 기간 값 내림차순', isDesc(blockOrder(html, 0)),
  blockOrder(html, 0).slice(0, 5).join(' ≥ '));
assert('🛑 Sales 블록이 최근 기간 값 내림차순', isDesc(blockOrder(html, 1)),
  blockOrder(html, 1).slice(0, 5).join(' ≥ '));
assert('🛑 CVR 블록이 최근 기간 값 내림차순', isDesc(blockOrder(cvrHtml, 0)),
  blockOrder(cvrHtml, 0).slice(0, 5).join(' ≥ '));

const INDEX_HTML = fs.readFileSync(process.env.DFUS_INDEX, 'utf8');
// 주석에 규칙을 설명해 둔 문장이 정규식에 걸리므로 주석을 걷어내고 판정한다.
const CSS_RAW  = INDEX_HTML.split('</style>')[0];
const CSS_CODE = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const JS_CODE  = fs.readFileSync(path.join(SP, 'block01.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// .ch-tbl td:first-child 를 sticky 로 잡은 뒤 같은 선택자로 position 을 다시 선언하면
// 뒤쪽 선언이 sticky 를 덮어쓴다. 선언이 한 번뿐인지 본다.
const firstChildRules = CSS_CODE.match(/\.ch-tbl td:first-child\s*\{[^}]*\}/g) || [];
assert('.ch-tbl td:first-child 선언 1회', firstChildRules.length === 1, firstChildRules.length + '회');
assert('  그 안에 position:sticky', /position:sticky/.test(firstChildRules[0] || ''), 'ok');
assert('  고정 열 width 명시', /width:\s*\d+px/.test(firstChildRules[0] || ''), 'ok');
assert('CSS font: 축약형 없음', !/[;{]\s*font\s*:/.test(CSS_CODE), 'ok');
assert('html{overflow-y:scroll} 있음', /html\{overflow-y:scroll;?\}/.test(CSS_CODE), 'ok');
assert('비밀값 없음 (client_secret 류)',
  !/client_secret|GOCSPX|api[_-]?key\s*[:=]\s*['"]/i.test(INDEX_HTML), 'ok');
assert('툴팁 콜백 후행 대입 없음', !/\.options\.plugins\.tooltip\.callbacks/.test(JS_CODE), 'ok');
assert('축 offset:true 없음', !/offset\s*:\s*true/.test(JS_CODE), 'ok');
assert('document 리스너 이름 붙여 등록', /window\.__dfusDocClick/.test(JS_CODE), 'ok');
assert('  등록 전 제거', /removeEventListener\('click',\s*window\.__dfusDocClick\)/.test(JS_CODE), 'ok');

console.log('\n── 문구·제목·로고 (C2 · C3 · B5) ──');
assert('문서 제목 = DF_US Sephora Dashboard',
  /<title>DF_US Sephora Dashboard<\/title>/.test(INDEX_HTML), 'ok');
assert('  화면에 노출되는 이름도 같은 값',
  INDEX_HTML.includes('>DF_US<') && INDEX_HTML.includes('>Sephora Dashboard<'), 'ok');
assert('  옛 이름 잔존 없음', !/Dr\.FORHAIR US — Sephora Dashboard/.test(INDEX_HTML), 'ok');
assert('파비콘 · 브랜드 마크가 인라인 data URL',
  /id="favicon"/.test(INDEX_HTML) && /var DF_MARK = 'data:image\/png;base64,/.test(INDEX_HTML), 'ok');
assert('  마크 주입 대상이 존재', (INDEX_HTML.match(/data-df-mark/g) || []).length >= 2,
  (INDEX_HTML.match(/data-df-mark/g) || []).length + '곳');
assert('메인 폰트 Pretendard 유지', /font-family:'Pretendard'/.test(CSS_CODE), 'ok');
// 🛑 영역명에 기간 단위를 박지 않는다 — 월/주/일 토글에 따라 실제 단위가 달라진다
assert('🛑 영역명에 WEEKLY 를 박지 않는다', !/—\s*Weekly/i.test(INDEX_HTML), 'ok');
assert('  블록 영역명 2종 존재',
  INDEX_HTML.includes('Visits · Sales by Channel')
  && INDEX_HTML.includes('Conversion TY (%) by Channel'), 'ok');
assert('  Overview 영역명은 짧게', INDEX_HTML.includes('min-width:180px;">Overview</div>'), 'ok');
assert('  옛 긴 영역명 잔존 없음',
  !INDEX_HTML.includes('Total Visits · Sales · CVR — Overview'), 'ok');

console.log('\n── 통합 탭 하단 주석 제거 (MJ 결정) ──');
assert('🛑 그래프 주석 요소 없음', !INDEX_HTML.includes('id="mainChartNote"'), 'ok');
assert('🛑 표 주석 요소 없음', !INDEX_HTML.includes('id="mainTableNote"'), 'ok');
assert('  설명 문구가 코드에서 사라짐',
  !/매출 원천은 RAW_commerce/.test(JS_CODE) && !/축은 0에서 자르지만 표에는/.test(JS_CODE), 'ok');

console.log('\n── 시트 경고 필터링 (A2) ──');
// 픽스처 페이로드에는 「결측 채널 …행을 0으로 채웠습니다」 경고가 실려 온다.
// 🛑 화면에는 그 문구가 뜨면 안 된다. 다른 시트 경고는 그대로 떠야 한다.
assert('  픽스처가 실제로 그 경고를 싣고 있다',
  payload.warnings.some(w => /결측 채널/.test(w)), payload.warnings.length + '건');
assert('🛑 화면에 「결측 채널」 문구가 없다', !/결측 채널/.test(els['mainNote'].innerHTML), 'ok');
step('데이터 깨짐 경고는 그대로 뜬다', () => {
  const broken = Object.assign({}, payload, { warnings: ['[RAW_commerce] 데이터 행이 0건입니다.'] });
  sandbox.applyPayload(broken);
});
assert('  필수 헤더·행 0건 류 경고는 유지',
  /데이터 행이 0건/.test(els['mainNote'].innerHTML), 'ok');
step('원래 페이로드로 복귀', () => sandbox.applyPayload(payload));

console.log('\n── 탭 전환 ──');
step('유입 탭', () => sandbox.switchTab('channel'));
step('통합 탭', () => sandbox.switchTab('main'));
step('사이드바 접기', () => sandbox.toggleSidebar());

console.log('\n── 데이터 재대입 (강제 재렌더) ──');
step('applyPayload 재호출', () => sandbox.applyPayload(payload));
assert('KPI 다시 그려짐 (전체 합계로 복귀)',
  els['kpiRow'].innerHTML.includes(
    '$' + TOTAL_SALES.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'ok');

console.log('\n' + (fail.length ? `❌ 실패 ${fail.length}건:\n  - ${fail.join('\n  - ')}` : '✅ 전부 통과'));
process.exit(fail.length ? 1 : 0);
