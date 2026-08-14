// ═══════════════════════════════════════════════════════════════════════════════
//  [DF_US] 세포라 대시보드 API — Google Apps Script 백엔드
//
//  · 스프레드시트 컨테이너 바인딩 프로젝트 「DF_US 대시보드 API」
//  · 배포 = 실행: MJ 계정 / 액세스: wyattcorp.com 도메인 내 사용자
//  · 재배포는 「배포 관리 → 연필 → 새 버전」만. 「새 배포」는 /exec 주소를 새로 발급한다.
//    ★ 30분 트리거가 저장된 최신 코드로 캐시를 굽기 때문에 캐시 경로는 재배포 없이도 반영된다.
//      단 ?only= / doPost 처럼 캐시를 안 거치는 경로는 배포된 버전의 코드로 도니
//      그쪽을 고쳤으면 반드시 새 버전 배포.
//
//  설계 규칙 (UNOVE Code.gs에서 실제로 터진 것들의 반작용)
//   1. 열 찾기는 **완전 일치 헤더명 한 가지 방식**으로 통일한다.
//      부분 일치 함수는 만들지 않는다 — 문자열 인자를 한 글자씩 순회해 조용히
//      엉뚱한 열을 잡는 사고가 UNOVE에서 있었다.
//   2. 모든 시트에 **열 개수 · 필수 헤더 검증**을 건다. 실패하면 실제 헤더 목록을
//      에러 메시지에 실어 즉시 원인이 보이게 한다.
//   3. 날짜 포맷은 반드시 ss.getSpreadsheetTimeZone(). 'GMT' 고정은 시트 시간대가
//      Asia/Seoul일 때 하루 앞으로 밀린다.
//   4. 프리워밍 캐시를 처음부터 넣는다 (라이브 파싱 → Drive JSON → doGet은 원문 전달).
//
//  🛑 시트 열 추가는 언제나 맨 오른쪽. 중간 삽입은 파서를 깨뜨린다.
// ═══════════════════════════════════════════════════════════════════════════════

// 🛑 리포지토리가 공개다. 시트 ID를 코드에 박지 않는다.
//    · 1순위 — 스크립트 속성 SPREADSHEET_ID (프로젝트 설정 → 스크립트 속성)
//    · 2순위 — 컨테이너 바인딩 폴백 (이 프로젝트는 RAW 시트에 바인딩돼 있다)
//    속성이 비어 있어도 바인딩 덕에 그대로 돈다. 속성은 시트를 갈아끼울 때만 쓴다.
var SPREADSHEET_PROP_KEY = 'SPREADSHEET_ID';
var ALLOWED_DOMAIN = 'wyattcorp.com';
var USD_TO_KRW     = 1500;               // 환율 기준: $1 = 1,500원 (수동 갱신)

var CACHE_FILE_NAME = 'dfus_dashboard_cache.json';
var CACHE_PROP_KEY  = 'DFUS_CACHE_FILE_ID';

// 차트·표에서 제외하는 채널 (미귀속 매출). 매출 합계·KPI에는 포함한다.
var EXCLUDED_CHANNELS = ['NA'];

// ── 시트 스펙 ─────────────────────────────────────────────────────────────────
// cols = 기준 열 개수. 이보다 적으면 에러(열이 사라졌다), 많으면 경고(오른쪽에 추가됨).
// required = 파서가 실제로 읽는 열. 완전 일치 헤더명.
// ⚠️ RAW_유입 M열은 헤더 없는 상수(1500) 셀이라 required에 넣지 않는다.
var SHEET_SPEC = {
  meta: {
    tab: '구분자', cols: 9,
    required: ['Sku Number', 'Product Page Name', 'Sku Description', '친숙명 (표시용)', '닷컴전용']
  },
  commerce: {
    tab: 'RAW_commerce', cols: 24,
    required: ['날짜', 'Product Page Name', 'Sku Number', 'Sku Description',
               'Visits TY', 'Sales TY', 'Conversion TY',
               '주문 수량', '년', '월', '주차', '주차앵커', '제품명_소비자 표시명']
  },
  channel: {
    tab: 'RAW_유입', cols: 17,
    required: ['Date', 'Last Touch Channel', 'Visits TY', 'Sales TY', 'Conversion TY',
               '년', '월', '주차', '주차앵커']
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  엔드포인트
//    /exec?token=…            현재 캐시 반환 (라이브 파싱 아님)
//    /exec?token=…&fresh=1    캐시 우회 + 라이브 파싱 + 캐시 재작성
//    /exec?token=…&only=키    단일 섹션 경량 경로 (meta|commerce|channel)
// ═══════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};

  // ── 1. 토큰 인증 ───────────────────────────────────────────────────────────
  var token = p.token || '';
  if (!token) return jsonOut_({ error: 'NO_TOKEN' });

  var email;
  try {
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v2/tokeninfo?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    var info = JSON.parse(res.getContentText());
    if (res.getResponseCode() !== 200 || !info.email) return jsonOut_({ error: 'INVALID_TOKEN' });
    if (!endsWith_(info.email, '@' + ALLOWED_DOMAIN))
      return jsonOut_({ error: 'UNAUTHORIZED_DOMAIN', email: info.email });
    email = info.email;
  } catch (err) {
    return jsonOut_({ error: 'TOKEN_VERIFY_FAILED', detail: err.message });
  }

  // ── 2. 단일 섹션 경량 경로 (캐시 미경유 — 수정 시 새 버전 배포 필요) ────────
  var only = String(p.only || '').trim();
  if (only) {
    try {
      var ss1 = openSS_();
      var warn = [];
      var section;
      if      (only === 'meta')     section = parseMeta_(ss1, warn);
      else if (only === 'commerce') section = parseCommerce_(ss1, warn);
      else if (only === 'channel')  section = parseChannel_(ss1, warn);
      else return jsonOut_({ error: 'UNKNOWN_SECTION', detail: only });
      return jsonOut_({
        ok: true, servedFrom: 'only:' + only, only: only, data: section,
        warnings: warn, user: email,
        tz: ss1.getSpreadsheetTimeZone(), updatedAt: nowIso_()
      });
    } catch (err) {
      return jsonOut_({ error: 'SECTION_READ_FAILED', detail: err.message });
    }
  }

  // ── 3. 캐시 우선 반환 (프리워밍된 Drive JSON) ─────────────────────────────
  var forceFresh = String(p.fresh || '') === '1';
  if (!forceFresh) {
    try {
      var cachedStr = readCache_();
      if (cachedStr) return jsonOutRaw_(cachedStr);   // 파싱 없이 원문 그대로
    } catch (ce) {
      Logger.log('캐시 읽기 실패 → 라이브 폴백: ' + ce.message);
    }
  }

  // ── 4. 폴백 / fresh: 라이브 파싱 ──────────────────────────────────────────
  try {
    var payload = buildPayload_();
    payload.servedFrom = 'live';
    payload.user = email;
    if (forceFresh) {
      try { writeCache_(payload); } catch (we) { Logger.log('캐시 쓰기 실패: ' + we.message); }
    }
    return jsonOut_(payload);
  } catch (err) {
    return jsonOut_({ error: 'DATA_READ_FAILED', detail: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  페이로드 빌드
// ═══════════════════════════════════════════════════════════════════════════════
function buildPayload_() {
  var ss = openSS_();
  var warnings = [];

  var meta     = parseMeta_(ss, warnings);
  var commerce = parseCommerce_(ss, warnings);
  var channel  = parseChannel_(ss, warnings);

  // ── 채널 목록 (표시 순서 = 매출 큰 순, NA는 항상 맨 뒤) ────────────────────
  var salesByCh = {};
  channel.forEach(function (r) { salesByCh[r.channel] = (salesByCh[r.channel] || 0) + r.sales; });
  var channels = Object.keys(salesByCh).sort(function (a, b) {
    var aEx = EXCLUDED_CHANNELS.indexOf(a) >= 0, bEx = EXCLUDED_CHANNELS.indexOf(b) >= 0;
    if (aEx !== bEx) return aEx ? 1 : -1;
    return salesByCh[b] - salesByCh[a];
  });

  // ── 결측 채널 0 채우기 ────────────────────────────────────────────────────
  // 값 0인 채널은 원본에서 행 자체가 빠진다(일별 13~15행) → 계열이 끊기지 않게 채운다.
  channel = fillMissingChannelRows_(channel, channels, warnings);

  // ── 주차 목록 (전부 데이터 파생 — 화면 문구에 주차 수를 박지 않기 위함) ────
  var weeks = buildWeeks_(commerce.concat(channel));

  // ── 기간 ──────────────────────────────────────────────────────────────────
  var allDates = {};
  commerce.forEach(function (r) { allDates[r.date] = 1; });
  channel.forEach(function (r) { allDates[r.date] = 1; });
  var dates = Object.keys(allDates).sort();

  return {
    ok:        true,
    tz:        ss.getSpreadsheetTimeZone(),
    usdToKrw:  USD_TO_KRW,
    excludedChannels: EXCLUDED_CHANNELS,
    range:     { start: dates[0] || null, end: dates[dates.length - 1] || null, days: dates.length },
    weeks:     weeks,
    channels:  channels,
    meta:      meta,
    commerce:  commerce,
    channel:   channel,
    warnings:  warnings,
    updatedAt: nowIso_()
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  파서
// ═══════════════════════════════════════════════════════════════════════════════

// ── 구분자 — SKU 매핑 정본 ───────────────────────────────────────────────────
// 🛑 조인 키는 언제나 Sku Number. Product Page Name은 FS/JS/TS 용량 차이를
//    구분하지 못한다(동명 3쌍).
function parseMeta_(ss, warnings) {
  var spec  = SHEET_SPEC.meta;
  var g     = openAndValidate_(ss, spec, warnings);
  var rows  = g.rows, hdrs = g.hdrs;

  var iSku  = col_(hdrs, 'Sku Number',        spec.tab);
  var iPage = col_(hdrs, 'Product Page Name', spec.tab);
  var iDesc = col_(hdrs, 'Sku Description',   spec.tab);
  var iFrnd = col_(hdrs, '친숙명 (표시용)',    spec.tab);
  var iDot  = col_(hdrs, '닷컴전용',           spec.tab);

  var out = {};
  for (var i = 1; i < rows.length; i++) {
    var r   = rows[i];
    var sku = String(toNum_(r[iSku]) || '').trim();
    if (!sku || sku === '0') continue;
    var friendly = String(r[iFrnd] || '').trim();
    out[sku] = {
      sku:      sku,
      page:     String(r[iPage] || '').trim(),
      desc:     String(r[iDesc] || '').trim(),
      friendly: friendly || String(r[iPage] || '').trim(),   // 친숙명 없으면 페이지명으로 폴백
      dotcom:   String(r[iDot] || '').trim().toUpperCase() === 'Y'
    };
  }
  if (!Object.keys(out).length) warnings.push('[구분자] 매핑 행이 0건입니다.');
  return out;
}

// ── RAW_commerce — SKU × 일별 ────────────────────────────────────────────────
// 🛑 Sales 파싱 · 매출(현지 통화)는 UNOVE 잔재다. Dr.FORHAIR의 Sales TY는 처음부터
//    숫자라 값이 같다. 파서는 참조하지 않는다.
// 🛑 LY · YoY 열은 전 기간 0(미국 첫 해)이라 읽지 않는다.
// 🛑 7/29 · 7/30은 매출 0 · 방문 정상 — 세포라 입점일이라 정상값이다. 결측 처리하지 않는다.
function parseCommerce_(ss, warnings) {
  var spec = SHEET_SPEC.commerce;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iDate = col_(hdrs, '날짜',                spec.tab);
  var iSku  = col_(hdrs, 'Sku Number',          spec.tab);
  var iDesc = col_(hdrs, 'Sku Description',     spec.tab);
  var iVis  = col_(hdrs, 'Visits TY',           spec.tab);
  var iSal  = col_(hdrs, 'Sales TY',            spec.tab);
  var iCvr  = col_(hdrs, 'Conversion TY',       spec.tab);
  var iOrd  = col_(hdrs, '주문 수량',            spec.tab);
  var iYear = col_(hdrs, '년',                  spec.tab);
  var iMon  = col_(hdrs, '월',                  spec.tab);
  var iWk   = col_(hdrs, '주차',                spec.tab);
  var iAnc  = col_(hdrs, '주차앵커',             spec.tab);
  var iName = col_(hdrs, '제품명_소비자 표시명',  spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r    = rows[i];
    var date = fmtDate_(r[iDate], tz);
    if (!date) continue;
    var sku = String(toNum_(r[iSku]) || '').trim();
    if (!sku || sku === '0') continue;
    out.push({
      date:    date,
      sku:     sku,
      desc:    String(r[iDesc] || '').trim(),
      name:    String(r[iName] || '').trim(),
      visits:  toNum_(r[iVis]),
      sales:   toNum_(r[iSal]),          // USD
      orders:  toNum_(r[iOrd]),
      cvr:     toNum_(r[iCvr]),          // 소수 (0.0284 = 2.84%) — 원본 그대로. 재계산하지 않는다.
      year:    toNum_(r[iYear]),
      month:   pad2_(toNum_(r[iMon])),   // 🛑 일자 기준. 주 기준으로 자르면 월 합계가 어긋난다.
      week:    String(r[iWk] || '').trim(),
      anchor:  fmtDate_(r[iAnc], tz)
    });
  }
  if (!out.length) warnings.push('[RAW_commerce] 데이터 행이 0건입니다.');
  return out;
}

// ── RAW_유입 — 채널 × 일별 ───────────────────────────────────────────────────
// 🛑 NA 채널(방문 0 · 매출만 있는 미귀속 매출)은 여기서 제외하지 않는다.
//    매출 합계에서 빼면 통합 탭과 13.6% 어긋난다. 차트·표 제외는 프런트에서 처리.
// ⚠️ 방문 정의가 RAW_commerce와 다르다(집계 단위 차이) → 방문당 매출·전환율은
//    반드시 같은 탭 안에서 계산할 것. 교차 계산 금지.
function parseChannel_(ss, warnings) {
  var spec = SHEET_SPEC.channel;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iDate = col_(hdrs, 'Date',               spec.tab);
  var iCh   = col_(hdrs, 'Last Touch Channel', spec.tab);
  var iVis  = col_(hdrs, 'Visits TY',          spec.tab);
  var iSal  = col_(hdrs, 'Sales TY',           spec.tab);
  var iCvr  = col_(hdrs, 'Conversion TY',      spec.tab);
  var iYear = col_(hdrs, '년',                 spec.tab);
  var iMon  = col_(hdrs, '월',                 spec.tab);
  var iWk   = col_(hdrs, '주차',               spec.tab);
  var iAnc  = col_(hdrs, '주차앵커',            spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r    = rows[i];
    var date = fmtDate_(r[iDate], tz);
    var ch   = String(r[iCh] || '').trim();
    if (!date || !ch) continue;
    out.push({
      date:    date,
      channel: ch,
      visits:  toNum_(r[iVis]),
      sales:   toNum_(r[iSal]),          // USD
      cvr:     toNum_(r[iCvr]),          // 소수. 방문 0인 NA는 0으로 오지만 프런트에서 '-' 처리.
      year:    toNum_(r[iYear]),
      month:   pad2_(toNum_(r[iMon])),
      week:    String(r[iWk] || '').trim(),
      anchor:  fmtDate_(r[iAnc], tz),
      filled:  false
    });
  }
  if (!out.length) warnings.push('[RAW_유입] 데이터 행이 0건입니다.');
  return out;
}

// ── 결측 채널 0 채우기 ───────────────────────────────────────────────────────
// 값 0인 채널은 원본에서 행 자체가 빠진다 → 날짜 × 채널 격자를 0으로 메워
// 차트 계열이 중간에 끊기지 않게 한다. 채워 넣은 행은 filled:true 로 표시한다.
function fillMissingChannelRows_(rows, channels, warnings) {
  var byDate = {}, dateMeta = {};
  rows.forEach(function (r) {
    if (!byDate[r.date]) { byDate[r.date] = {}; dateMeta[r.date] = r; }
    byDate[r.date][r.channel] = true;
  });

  var added = 0;
  var dates = Object.keys(byDate).sort();
  dates.forEach(function (d) {
    var m = dateMeta[d];
    channels.forEach(function (ch) {
      if (byDate[d][ch]) return;
      rows.push({
        date: d, channel: ch, visits: 0, sales: 0, cvr: 0,
        year: m.year, month: m.month, week: m.week, anchor: m.anchor,
        filled: true
      });
      added++;
    });
  });
  if (added) warnings.push('[RAW_유입] 결측 채널 ' + added + '행을 0으로 채웠습니다 (원본은 값 0인 채널의 행을 생략함).');

  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.channel < b.channel ? -1 : (a.channel > b.channel ? 1 : 0);
  });
  return rows;
}

// ── 주차 목록 — 전부 데이터에서 파생한다 ─────────────────────────────────────
// 🛑 화면 문구에 주차 수·개수를 새로 박지 않는다. 회차 라벨은 이 배열에서만 나온다.
function buildWeeks_(rows) {
  var byKey = {};
  rows.forEach(function (r) {
    if (!r.week || !r.anchor) return;
    if (!byKey[r.week]) byKey[r.week] = { key: r.week, anchor: r.anchor, start: r.date, end: r.date };
    var w = byKey[r.week];
    if (r.date < w.start) w.start = r.date;
    if (r.date > w.end)   w.end   = r.date;
  });
  return Object.keys(byKey)
    .map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return a.anchor < b.anchor ? -1 : (a.anchor > b.anchor ? 1 : 0); });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  시트 열기 · 검증 · 열 찾기
// ═══════════════════════════════════════════════════════════════════════════════

// 스크립트 속성 → 컨테이너 바인딩 순으로 스프레드시트를 연다.
function openSS_() {
  var id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_PROP_KEY);
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  throw new Error('스프레드시트를 찾지 못했습니다. '
    + '프로젝트 설정 → 스크립트 속성에 ' + SPREADSHEET_PROP_KEY + ' 를 추가하세요.');
}

function openAndValidate_(ss, spec, warnings) {
  var sheet = ss.getSheetByName(spec.tab);
  if (!sheet) throw new Error('시트 탭 없음: ' + spec.tab);

  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) throw new Error('[' + spec.tab + '] 데이터가 없습니다 (행 ' + rows.length + ').');

  var hdrs = rows[0].map(normHdr_);

  // ── 열 개수 검증 ──────────────────────────────────────────────────────────
  var n = hdrs.length;
  if (n < spec.cols) {
    throw new Error('[' + spec.tab + '] 열 개수가 줄었습니다: ' + n + '개 (기준 ' + spec.cols + '개). '
                  + '실제 헤더: ' + hdrs.join(' | '));
  }
  if (n > spec.cols) {
    warnings.push('[' + spec.tab + '] 열이 ' + (n - spec.cols) + '개 늘었습니다 (' + n + '/' + spec.cols + '). '
                + '오른쪽 추가라면 정상입니다. 추가 헤더: ' + hdrs.slice(spec.cols).join(' | '));
  }

  // ── 필수 헤더 검증 ────────────────────────────────────────────────────────
  var missing = spec.required.filter(function (h) { return hdrs.indexOf(h) < 0; });
  if (missing.length) {
    throw new Error('[' + spec.tab + '] 필수 헤더 없음: ' + missing.join(', ')
                  + ' — 실제 헤더: ' + hdrs.join(' | '));
  }

  return { sheet: sheet, rows: rows, hdrs: hdrs, tz: ss.getSpreadsheetTimeZone() };
}

// 🛑 완전 일치 한 가지 방식. 부분 일치 함수는 만들지 않는다.
//    인자는 반드시 문자열 하나 — 배열을 넘기면 즉시 던진다(조용한 오작동 방지).
function col_(hdrs, name, tab) {
  if (typeof name !== 'string') {
    throw new Error('col_(): 헤더명은 문자열이어야 합니다. 받은 값: ' + JSON.stringify(name));
  }
  var i = hdrs.indexOf(name);
  if (i < 0) {
    throw new Error('[' + tab + '] 헤더 "' + name + '" 를 찾지 못했습니다. 실제 헤더: ' + hdrs.join(' | '));
  }
  return i;
}

function normHdr_(h) {
  return String(h == null ? '' : h)
    .replace(/ /g, ' ')   // NBSP → 일반 공백
    .replace(/\s+/g, ' ')
    .trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  유틸
// ═══════════════════════════════════════════════════════════════════════════════

// 🛑 시트 시간대로 포맷한다. 'GMT' 고정은 Asia/Seoul(UTC+9)에서 하루 앞으로 밀린다.
function fmtDate_(val, tz) {
  if (val === '' || val === null || val === undefined) return null;
  var d = (val instanceof Date) ? val : new Date(val);
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  var s = Utilities.formatDate(d, tz || 'Asia/Seoul', 'yyyy-MM-dd');
  var y = parseInt(s.slice(0, 4), 10);
  if (y < 2000 || y > 2100) return null;
  return s;
}

function toNum_(val) {
  if (typeof val === 'number') return val;
  if (val === '' || val === null || val === undefined) return 0;
  var n = parseFloat(String(val).replace(/[,$%\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function pad2_(n) {
  var s = String(Math.round(n || 0));
  return s.length < 2 ? '0' + s : s;
}

function endsWith_(s, suffix) {
  s = String(s || '');
  return s.length >= suffix.length && s.slice(s.length - suffix.length) === suffix;
}

function nowIso_() { return new Date().toISOString(); }

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 파싱 없이 원문 그대로 반환 (캐시 경로)
function jsonOutRaw_(str) {
  return ContentService.createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  프리워밍 캐시 — 30분 트리거가 백그라운드로 전 섹션을 파싱해 Drive JSON에 굽는다.
//  doGet은 그 파일을 파싱 없이 그대로 반환한다. (UNOVE 실측 62.7초 → 2.6초)
// ═══════════════════════════════════════════════════════════════════════════════
function getCacheFile_(createIfMissing) {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty(CACHE_PROP_KEY);

  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* 아래에서 재탐색 */ }
  }
  // 이름으로 재탐색 (파일 ID 유실 대비)
  var it = DriveApp.getFilesByName(CACHE_FILE_NAME);
  if (it.hasNext()) {
    var found = it.next();
    props.setProperty(CACHE_PROP_KEY, found.getId());
    return found;
  }
  if (!createIfMissing) return null;

  var nf = DriveApp.createFile(CACHE_FILE_NAME, '', MimeType.PLAIN_TEXT);
  props.setProperty(CACHE_PROP_KEY, nf.getId());
  return nf;
}

// 캐시 읽기: JSON 문자열 or null (없음/손상 시 null → 라이브 파싱 폴백)
function readCache_() {
  var f = getCacheFile_(false);
  if (!f) return null;
  var s = f.getBlob().getDataAsString();
  if (!s || s.length < 100) return null;   // 빈/미완성 파일 방어
  if (s.charAt(0) !== '{') return null;    // 손상 방어
  return s;
}

function writeCache_(payload) {
  payload.servedFrom   = 'cache';
  payload.cacheBuiltAt = nowIso_();
  var str = JSON.stringify(payload);
  getCacheFile_(true).setContent(str);
  return str.length;
}

// 트리거 진입점 — 30분마다 캐시 재생성
// 「실행이 완료됨」은 성공이 아니다. 로그에 「캐시 갱신 완료: N bytes, N초」가 떠야 진짜.
function refreshCache() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {              // 동시 빌드 방지
    Logger.log('다른 빌드 진행 중 → 건너뜀');
    return;
  }
  try {
    var t0    = new Date().getTime();
    var bytes = writeCache_(buildPayload_());
    Logger.log('캐시 갱신 완료: ' + bytes + ' bytes, ' +
               Math.round((new Date().getTime() - t0) / 1000) + '초');
  } catch (err) {
    Logger.log('캐시 갱신 실패: ' + err.message);   // 기존 캐시는 보존된다
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// 최초 1회 실행 — 30분 트리거 등록 (중복 제거 포함) + 첫 캐시 생성
function setupCacheTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshCache').timeBased().everyMinutes(30).create();
  refreshCache();
  Logger.log('트리거 등록 완료 (30분 주기) + 첫 캐시 생성');
}

// 점검용 — 캐시 상태 확인
function checkCacheStatus() {
  var s = readCache_();
  if (!s) { Logger.log('캐시 없음'); return; }
  var j = JSON.parse(s);
  Logger.log('크기: ' + s.length + ' bytes\n' +
             'builtAt: ' + j.cacheBuiltAt + '\n' +
             '기간: ' + (j.range ? j.range.start + ' ~ ' + j.range.end + ' (' + j.range.days + '일)' : '—') + '\n' +
             'commerce: ' + (j.commerce || []).length + '행 / channel: ' + (j.channel || []).length + '행\n' +
             '주차: ' + (j.weeks || []).map(function (w) { return w.key; }).join(', ') + '\n' +
             '채널: ' + (j.channels || []).join(', ') + '\n' +
             '경고: ' + ((j.warnings || []).length ? '\n  - ' + j.warnings.join('\n  - ') : '없음'));
}

// 점검용 — 어느 시트를 보고 있는지 · 탭과 헤더가 스펙과 맞는지
function checkSheet() {
  var ss = openSS_();
  var src = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_PROP_KEY)
          ? '스크립트 속성' : '컨테이너 바인딩';
  var lines = ['시트: ' + ss.getName() + ' (' + src + ')', '시간대: ' + ss.getSpreadsheetTimeZone()];
  Object.keys(SHEET_SPEC).forEach(function (k) {
    var spec = SHEET_SPEC[k];
    try {
      var w = [];
      var g = openAndValidate_(ss, spec, w);
      lines.push('  ✔ ' + spec.tab + ' — ' + (g.rows.length - 1) + '행 / ' + g.hdrs.length + '열'
               + (w.length ? '\n      ' + w.join('\n      ') : ''));
    } catch (e) {
      lines.push('  ✘ ' + spec.tab + ' — ' + e.message);
    }
  });
  Logger.log(lines.join('\n'));
}

// 점검용 — 파서만 돌려 합계를 눈으로 확인 (6단계 검증 대조용)
function checkTotals() {
  var p = buildPayload_();
  var cv = 0, cs = 0, co = 0;
  p.commerce.forEach(function (r) { cv += r.visits; cs += r.sales; co += r.orders; });
  var hv = 0, hs = 0, na = 0;
  p.channel.forEach(function (r) {
    hv += r.visits; hs += r.sales;
    if (p.excludedChannels.indexOf(r.channel) >= 0) na += r.sales;
  });
  Logger.log('기간: ' + p.range.start + ' ~ ' + p.range.end + ' (' + p.range.days + '일)\n' +
             'commerce — 방문 ' + cv + ' / 매출 $' + cs.toFixed(2) + ' / 주문 ' + co + '\n' +
             'channel  — 방문 ' + hv + ' / 매출 $' + hs.toFixed(2) + '\n' +
             'NA 매출 $' + na.toFixed(2) + ' (' + (hs > 0 ? (na / hs * 100).toFixed(2) : '0') + '%)\n' +
             '주차: ' + p.weeks.map(function (w) { return w.key + '(' + w.start + '~' + w.end + ')'; }).join(', '));
}
