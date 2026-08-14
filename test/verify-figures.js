// index.html 인라인 스크립트를 최소 DOM 스텁 위에서 그대로 실행해
// 6단계 검증용 실측값을 재현하는지 확인한다.
//
//   실행:  node test/run.js
//
// 🛑 픽스처(test/fixtures/*.tsv)는 시트 실데이터라 커밋하지 않는다(.gitignore).
//    없으면 test/README.md 의 절차대로 다시 뽑는다.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT  = path.join(__dirname, '..');
const SP    = path.join(__dirname, '.tmp');
const SHEET = path.join(__dirname, 'fixtures');

// ── 1. TSV → Apps Script 페이로드 (Code.gs 로직 미러) ────────────────────────
function serialToDate(s) {
  const ms = (Number(s) - 25569) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
function tsv(file) {
  return fs.readFileSync(path.join(SHEET, file), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(l => l.split('\t'));
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/[,$%\s]/g, '')); return isNaN(n) ? 0 : n; };
const pad2 = n => String(Math.round(n || 0)).padStart(2, '0');

const cRows = tsv('commerce.tsv').slice(1).filter(r => r[0]);
const hRows = tsv('channel.tsv').slice(1).filter(r => r[0]);

const commerce = cRows.map(r => ({
  date: serialToDate(r[0]), sku: String(Math.round(num(r[3]))), desc: r[4], name: r[23],
  visits: num(r[5]), sales: num(r[8]), orders: num(r[16]), cvr: num(r[11]),
  year: num(r[19]), month: pad2(num(r[20])), week: (r[21] || '').trim(), anchor: serialToDate(r[22])
}));
let channel = hRows.map(r => ({
  date: serialToDate(r[0]), channel: (r[1] || '').trim(),
  visits: num(r[2]), sales: num(r[5]), cvr: num(r[8]),
  year: num(r[13]), month: pad2(num(r[14])), week: (r[15] || '').trim(), anchor: serialToDate(r[16]),
  filled: false
}));

const EXCLUDED = ['NA'];
const salesByCh = {};
channel.forEach(r => { salesByCh[r.channel] = (salesByCh[r.channel] || 0) + r.sales; });
const channels = Object.keys(salesByCh).sort((a, b) => {
  const ax = EXCLUDED.includes(a), bx = EXCLUDED.includes(b);
  if (ax !== bx) return ax ? 1 : -1;
  return salesByCh[b] - salesByCh[a];
});

// 결측 채널 0 채우기
const byDate = {}, dateMeta = {};
channel.forEach(r => { (byDate[r.date] = byDate[r.date] || {})[r.channel] = true; dateMeta[r.date] = r; });
let added = 0;
Object.keys(byDate).sort().forEach(d => {
  const m = dateMeta[d];
  channels.forEach(ch => {
    if (byDate[d][ch]) return;
    channel.push({ date: d, channel: ch, visits: 0, sales: 0, cvr: 0,
      year: m.year, month: m.month, week: m.week, anchor: m.anchor, filled: true });
    added++;
  });
});

const wk = {};
commerce.concat(channel).forEach(r => {
  if (!r.week || !r.anchor) return;
  if (!wk[r.week]) wk[r.week] = { key: r.week, anchor: r.anchor, start: r.date, end: r.date };
  if (r.date < wk[r.week].start) wk[r.week].start = r.date;
  if (r.date > wk[r.week].end)   wk[r.week].end   = r.date;
});
const weeks = Object.values(wk).sort((a, b) => a.anchor < b.anchor ? -1 : 1);
const allD = [...new Set(commerce.concat(channel).map(r => r.date))].sort();

const payload = {
  ok: true, tz: 'Asia/Seoul', usdToKrw: 1500, excludedChannels: EXCLUDED,
  range: { start: allD[0], end: allD[allD.length - 1], days: allD.length },
  weeks, channels, meta: {}, commerce, channel,
  warnings: added ? [`[RAW_유입] 결측 채널 ${added}행을 0으로 채웠습니다.`] : [],
  updatedAt: new Date().toISOString(), servedFrom: 'test'
};

// ── 2. 최소 DOM 스텁 ────────────────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, children: [],
    classList: { _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, v) { v === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (v ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); } },
    querySelectorAll() { return []; },
    querySelector() { return makeEl('sub'); },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener() {}, removeEventListener() {}, closest() { return null; },
    getContext() { return {}; }, setAttribute() {}, getAttribute() { return null; },
    focus() {}
  };
  return el;
}
const els = {};
const chartCaptures = [];

const sandbox = {
  console,
  Date, Math, JSON, Set, Map, Array, Object, String, Number, parseInt, parseFloat, isNaN,
  URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, Promise, fetch,
  document: {
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(t) { return makeEl(t); },
    addEventListener() {}, removeEventListener() {}
  },
  Chart: class Chart {
    constructor(ctx, cfg) { this.cfg = cfg; chartCaptures.push(cfg); }
    destroy() {}
  },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  localStorage:   { getItem: () => null, setItem() {}, removeItem() {} },
  history: { replaceState() {} },
  location: { hash: '', search: '', pathname: '/' }
};
sandbox.Chart.defaults = { color: '#666', font: { family: '' } };
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SP, 'block01.js'), 'utf8'), sandbox, { filename: 'index.html:<script>' });

// ── 3. 검증 ────────────────────────────────────────────────────────────────
// 🛑 기대값을 이 파일에 박지 않는다. 매출·방문은 실데이터라 공개 리포에 올라가면 안 된다.
//    전부 test/fixtures/expected.json (gitignore 대상)에서 읽는다.
const EXP_PATH = path.join(SHEET, 'expected.json');
if (!fs.existsSync(EXP_PATH)) {
  console.error('기대값 파일이 없습니다: test/fixtures/expected.json — test/README.md 참고');
  process.exit(2);
}
const E = JSON.parse(fs.readFileSync(EXP_PATH, 'utf8'));

const fail = [];
function eq(label, got, want) {
  const ok = String(got) === String(want);
  console.log(`${ok ? '  OK ' : '  ✗  '} ${label}: ${got}${ok ? '' : `   (기대 ${want})`}`);
  if (!ok) fail.push(label);
}

sandbox.applyPayload(payload);

console.log('\n── 기간 ──');
eq('시작일', payload.range.start, E.range.start);
eq('종료일', payload.range.end,   E.range.end);
eq('일수',   payload.range.days,  E.range.days);

console.log('\n── 통합 탭 (RAW_commerce) ──');
const cur = sandbox.sumRows(sandbox.mainFiltered());
eq('총 방문',      cur.visits, E.commerce.visits);
eq('총 매출',      cur.sales.toFixed(2), E.commerce.sales);
eq('총 주문 수량', cur.orders, E.commerce.orders);
eq('CVR = 주문/방문', cur.cvr.toFixed(4), (E.commerce.orders / E.commerce.visits * 100).toFixed(4));
// 원본 Conversion TY 를 방문 가중 합산한 값과 같아야 한다 (재계산이 아님을 확인)
const cvrWeighted = payload.commerce.reduce((s, r) => s + r.cvr * r.visits, 0)
                  / payload.commerce.reduce((s, r) => s + r.visits, 0) * 100;
eq('  = 원본 Conversion TY 방문가중', cvrWeighted.toFixed(4), cur.cvr.toFixed(4));

console.log('\n── 일자별 매출 (일 보기) ──');
sandbox.mainPeriod = 'daily';
const daily = sandbox.mainChartData();
eq('일수', daily.length, E.dailySales.length);
daily.forEach((d, i) => eq(`  ${d.label}`, d.sales.toFixed(2), E.dailySales[i]));

console.log('\n── 주차 배분 ──');
sandbox.mainPeriod = 'weekly';
const wkly = sandbox.mainChartData();
eq('주차 개수', wkly.length, E.weekKeys.length);
eq('주차 라벨', wkly.map(w => w.key).join(','), E.weekKeys.join(','));
const cW = {}; payload.commerce.forEach(r => cW[r.week] = (cW[r.week] || 0) + 1);
eq('commerce 주차 행수', E.weekKeys.map(k => cW[k]).join('/'), E.weekKeys.map(k => E.commerce.weeks[k]).join('/'));
const hW = {}; hRows.forEach(r => { const w = (r[15] || '').trim(); hW[w] = (hW[w] || 0) + 1; });
eq('channel  주차 행수', E.weekKeys.map(k => hW[k]).join('/'), E.weekKeys.map(k => E.channel.weeks[k]).join('/'));
eq('주차 라벨 문자열', sandbox.weekLabel(E.weekKeys[0]), E.w1Label);

console.log('\n── 유입 채널 탭 (RAW_유입) ──');
const chAll = payload.channel.reduce((a, r) => a + r.sales, 0);
const chNA  = payload.channel.filter(r => r.channel === 'NA').reduce((a, r) => a + r.sales, 0);
eq('채널 매출 합계 (NA 포함)', chAll.toFixed(2), E.channel.sales);
eq('  통합 탭 매출과 일치',    chAll.toFixed(2), cur.sales.toFixed(2));
eq('NA 매출',                  chNA.toFixed(2), E.channel.naSales);
eq('NA 비중',                  (chNA / chAll * 100).toFixed(2) + '%', E.channel.naPct);
eq('채널 수 (NA 포함)',        payload.channels.length, E.channel.channelCount);
eq('차트 대상 채널 수',        sandbox.chartChannels().length, E.channel.chartChannelCount);
eq('유입 방문 (통합과 다름)',  payload.channel.reduce((a, r) => a + r.visits, 0), E.channel.visits);
eq('결측 채널 채움',
   payload.channel.filter(r => r.filled).length,
   E.channel.channelCount * E.range.days - hRows.length);

console.log('\n── 차트·표 렌더 ──');
const periods = sandbox.activePeriods();
const pivot = sandbox.chPivot(periods);
eq('기간 축 (주)', periods.join(','), E.weekKeys.join(','));
const naInPivotChart = sandbox.activeChannels().includes('NA');
eq('차트에서 NA 제외', naInPivotChart, false);
const lastW = E.weekKeys[E.weekKeys.length - 1];
const wChart = sandbox.chartChannels().reduce((s, c) => s + pivot[c][lastW].s, 0);
const wAll = payload.channel.filter(r => r.week === lastW).reduce((a, r) => a + r.sales, 0);
const wNa  = payload.channel.filter(r => r.week === lastW && r.channel === 'NA').reduce((a, r) => a + r.sales, 0);
eq(lastW + ' 차트 매출 = 전체 − NA', wChart.toFixed(2), (wAll - wNa).toFixed(2));

// NA 는 방문 0 → CVR 은 null 이어야 한다 (0 으로 찍지 않는다)
eq('NA 의 CVR', String(sandbox.cellVal(pivot['NA'][lastW], 'cvr')), 'null');

// 15% 경고 대상 일자
const dayNA = {};
payload.channel.forEach(r => {
  dayNA[r.date] = dayNA[r.date] || { t: 0, na: 0 };
  dayNA[r.date].t += r.sales;
  if (r.channel === 'NA') dayNA[r.date].na += r.sales;
});
const over = Object.keys(dayNA).sort().filter(d => dayNA[d].t > 0 && dayNA[d].na / dayNA[d].t * 100 > 15);
eq('일별 NA>15% 인 날', over.join(','), E.naOver15Days.join(','));

console.log('\n── KPI HTML 렌더 ──');
const kpiHtml = els['kpiRow'].innerHTML;
eq('KPI 카드 4장', (kpiHtml.match(/class="kpi"/g) || []).length, 4);
eq('총 매출 표기', kpiHtml.includes('$' + E.commerce.salesFormatted), true);
eq('₩ 환산 표기', kpiHtml.includes(E.commerce.salesKrwFormatted), true);
eq('차트 생성됨', chartCaptures.length > 0, true);
eq('매출축 min:0', chartCaptures[0].options.scales.yS.min, 0);
eq('offset 미사용', JSON.stringify(chartCaptures[0].options.scales).includes('"offset"'), false);

console.log('\n' + (fail.length ? `❌ 실패 ${fail.length}건: ${fail.join(' / ')}` : '✅ 전부 통과'));
process.exit(fail.length ? 1 : 0);
