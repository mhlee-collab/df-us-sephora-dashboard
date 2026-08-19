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
// 배포된 코드 버전 표식.
// doGet 은 **배포된 버전의 코드**로 돌고, 30분 트리거는 저장된 최신 코드로 돈다.
// 「기존 버전으로 배포」하면 데이터는 새 코드로 구워지는데 게이트는 옛 코드가 도는
// 상태가 될 수 있다. 토큰 없이 /exec 를 호출하면 이 값이 돌아오므로
// 밖에서 배포 상태를 바로 확인할 수 있다.
// 🛑 Code.gs 를 고치면 이 값을 함께 올린다.
var CODE_VERSION = '2026-08-19b';

// 이 배포가 실제로 거는 검사 목록. 토큰 없이 /exec 를 부르면 함께 돌아온다.
// audience 가 빠져 있으면 옛 코드가 배포돼 있다는 뜻이다 (→ 새 버전으로 재배포).
var GATE_CHECKS = 'token,audience,verified_email,domain';

var SPREADSHEET_PROP_KEY = 'SPREADSHEET_ID';
var ALLOWED_DOMAIN = 'wyattcorp.com';
var USD_TO_KRW     = 1500;               // 환율 기준: $1 = 1,500원 (수동 갱신)

// 🛑 이 대시보드의 접근 게이트는 아래 verifyToken_() 이 전부다.
//    배포 액세스가 「모든 사용자」인 이유는 그래야 CORS 가 열리기 때문이지
//    아무나 데이터를 볼 수 있게 하려는 게 아니다.
//    (액세스를 「도메인 내 사용자」로 두면 /a/macros/<도메인>/ 주소가 발급되고,
//     그 주소는 구글 로그인 페이지로 302 를 쏘면서 Access-Control-Allow-Origin 을
//     주지 않아 브라우저 fetch 가 "Failed to fetch" 로 떨어진다. 2026-08-14 실측.)
//    ⚠️ 실행 계정은 반드시 「나(MJ)」로 둔다 — 웹앱이 MJ 권한으로 시트를 읽는다.
// 클라이언트 ID 는 공개 가능한 값이다 (index.html 에도 그대로 들어 있다).
var GOOGLE_CLIENT_ID = '549092732127-gl1eesou2gi3s89mc088qgid3j369cl1.apps.googleusercontent.com';

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
  },

  // ── B&M · 재고 계열 (주 단위 · 세포라 실매출 리포트) ────────────────────────
  // 🛑🛑 **구글 시트의 열 이름 규칙 — 이걸 놓치면 값이 1500배로 틀린다.**
  //     `이름 ($)` = 세포라 원본(USD)  ·  `이름`(평문) = 시트가 만든 **KRW 파생열(×1500)**
  //     로컬 누적관리용 xlsx 에는 KRW 파생열이 아예 없어서 평문 이름이 곧 USD 였다.
  //     그 파일만 보고 스펙을 짰다가 2026-08-19 배포 후 `Raw_BM재고` TTL 이 정확히
  //     1500배(₩36,934,605)로 나왔다. col_() 은 완전 일치 + indexOf 라 조용히 KRW 열을 잡는다.
  //     → **금액 열은 언제나 `($)` 붙은 쪽을 읽는다.** 수량·개수 열은 파생열이 없어 평문 그대로다.
  bmInv: {
    tab: 'Raw_BM재고', cols: 32,
    required: ['주차', '주종료일', 'SKU', '제품명', '정가',
               'B&M매출 ($)', '.COM매출 ($)', 'TTL매출 ($)',
               '배치매장수', '재고보유매장수', 'InStock%', '품절매장수', '매장재고', 'DC재고',
               'WOS', '.COM_OH', '.COM_OO', '.COM_WOS',
               'YTD_B&M ($)', 'YTD_COM ($)', 'YTD_전체 ($)']
  },
  bmStore: {
    tab: 'Raw_BM매장', cols: 14,
    required: ['주차', '주종료일', '매장번호', '매장명', '주간매출', '주간수량',
               '매장재고', 'AFS', 'YTD 매출 ($)']
  },
  bmWeek: {
    tab: 'Raw_BM주간요약', cols: 23,
    required: ['주차', '주종료일', 'B&M매출 ($)', '.COM매출 ($)', '전체매출 ($)', 'InStock%',
               '활성매장수', 'SpD', '.COM_OH', '.COM_OO',
               'YTD_B&M ($)', 'YTD_COM ($)', 'YTD_전체 ($)']
  },
  // Sephora 공통 매장 인프라 매핑 (브랜드 수치 아님). 매장번호로 조인해 권역만 붙인다.
  bmRegion: {
    tab: 'Raw_BM_권역매핑', cols: 5,
    required: ['Location Number', 'Store Name', 'Region', 'District']
  },

  // ── 실매출 계열 (일·주 · 세포라 실매출 리포트) ─────────────────────────────
  // ⚠️ `Raw_실매출` 은 SKU 단위가 아니라 **날짜별 전 SKU 합산** 탭이다.
  //    SKU × 일별은 `Raw_실매출_SKU별_일간` 이다. 이름이 헷갈리기 쉬우니 주의.
  // ⚠️ F~K(파생) 열은 로컬 원본에서 비어 있다. 파서는 읽지 않고 날짜에서 직접 만든다.
  // 🛑 시트의 실제 탭 이름은 `RAW_실매출`(RAW 대문자)이다. 다른 실매출 탭은 `Raw_` 인데
  //    이 탭만 다르다. getSheetByName 이 관대해 소문자로도 통과하지만 기대지 않는다.
  salesDaily: {
    tab: 'RAW_실매출', cols: 11,
    required: ['날짜', '주차', 'B&M 매출 ($)', '.COM 매출 ($)', '전체 매출 ($)']
  },
  // 🛑 **선택 탭.** 현재 구글 시트에 없다(로컬 누적관리 파일에만 있다).
  //    없어도 화면은 정상이다 — 주차 라벨·기간은 `RAW_실매출`(일별)에서 전부 파생하고,
  //    이 탭은 교차검증용 롤업일 뿐이다. 그래서 없을 때 화면 경고를 띄우지 않는다.
  //    (탭이 있는데 헤더가 틀린 경우에는 경고를 띄운다 — 그건 진짜 사고다.)
  //    `비고` 열은 읽지 않는다 — 분석 메모라 화면에 그릴 내용이 아니다.
  salesWeek: {
    tab: '주차별요약', cols: 11, optional: true,
    required: ['주차', '기간', '일수', 'B&M 매출($)', '.COM 매출($)', '전체 매출($)', '.COM 비중']
  },
  skuWeek: {
    tab: 'Raw_실매출_SKU별_주간', cols: 18,
    required: ['주차', '주종료일', 'SKU번호', '제품명',
               'B&M매출 ($)', '.COM매출 ($)', '전체매출 ($)',
               'B&M수량', '.COM수량', '전체수량']
  },
  skuDaily: {
    tab: 'Raw_실매출_SKU별_일간', cols: 20,
    required: ['주차', '주종료일', '일', 'SKU번호', '제품명',
               'B&M매출 ($)', '.COM매출 ($)', '전체매출 ($)',
               'B&M수량', '.COM수량', '전체수량']
  }
};

// 🛑 `Raw_BM매장` 에 원본 그대로 들어 있는 `.COM` 물류센터 5곳.
//    매장 실적(활성매장수·매장당 주간매출 등)에 넣으면 `.COM` 매출과 이중 계상된다.
//    행을 지우지 않고 dc:true 로 표시해 프런트가 골라 쓰게 한다.
//    (`Raw_BM주간요약` 의 `활성매장수` 는 이미 이 5곳을 뺀 값이다.)
var DC_STORE_NOS = ['700', '900', '1000', '1020', '1090'];

// ═══════════════════════════════════════════════════════════════════════════════
//  엔드포인트
//    /exec?token=…            현재 캐시 반환 (라이브 파싱 아님)
//    /exec?token=…&fresh=1    캐시 우회 + 라이브 파싱 + 캐시 재작성
//    /exec?token=…&only=키    단일 섹션 경량 경로
//                             (meta|commerce|channel|bmInv|bmStore|bmWeek
//                              |salesDaily|salesWeek|skuWeek|skuDaily)
// ═══════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  var p = (e && e.parameter) ? e.parameter : {};

  // ── 1. 토큰 인증 ───────────────────────────────────────────────────────────
  var token = p.token || '';
  if (!token) return jsonOut_({ error: 'NO_TOKEN', v: CODE_VERSION, gate: GATE_CHECKS });

  var auth = verifyToken_(token);
  if (auth.error) { auth.v = CODE_VERSION; return jsonOut_(auth); }
  var email = auth.email;

  // ── 2. 단일 섹션 경량 경로 (캐시 미경유 — 수정 시 새 버전 배포 필요) ────────
  var only = String(p.only || '').trim();
  if (only) {
    try {
      var ss1 = openSS_();
      var warn = [];
      var section;
      if      (only === 'meta')       section = parseMeta_(ss1, warn);
      else if (only === 'commerce')   section = parseCommerce_(ss1, warn);
      else if (only === 'channel')    section = parseChannel_(ss1, warn);
      else if (only === 'bmInv')      section = parseBmInv_(ss1, warn);
      else if (only === 'bmStore')    section = parseBmStore_(ss1, warn, parseBmRegion_(ss1, warn));
      else if (only === 'bmWeek')     section = parseBmWeek_(ss1, warn);
      else if (only === 'salesDaily') section = parseSalesDaily_(ss1, warn);
      else if (only === 'salesWeek')  section = parseSalesWeek_(ss1, warn);
      else if (only === 'skuWeek')    section = parseSkuWeek_(ss1, warn);
      else if (only === 'skuDaily')   section = parseSkuDaily_(ss1, warn);
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
//  토큰 검증 — 이 대시보드의 유일한 접근 게이트
//
//  통과 조건 4개를 전부 만족해야 한다.
//   1. 구글이 유효하다고 답하는 액세스 토큰인가            (tokeninfo 200)
//   2. 🛑 그 토큰이 **이 대시보드의 클라이언트 ID로 발급**됐는가 (audience)
//   3. 확인된(verified) 이메일인가
//   4. @wyattcorp.com 계정인가
//
//  🛑 2번이 없으면 도메인 검증이 사실상 무력해진다.
//     와이어트 직원이 구글 로그인으로 접속한 **아무 제3자 사이트**가 그 직원의
//     액세스 토큰을 갖게 되고, 그 토큰을 이 엔드포인트에 그대로 넣으면
//     tokeninfo 는 여전히 email: …@wyattcorp.com 을 돌려준다.
//     audience 를 확인해야 「우리 앱에서 로그인한 사람」으로 좁혀진다.
//     배포 액세스가 「도메인 내 사용자」였을 때는 구글 세션이 이 구멍을 가려주고 있었다.
// ═══════════════════════════════════════════════════════════════════════════════
function verifyToken_(token) {
  var info;
  try {
    var res = UrlFetchApp.fetch(
      'https://www.googleapis.com/oauth2/v2/tokeninfo?access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return { error: 'INVALID_TOKEN' };
    info = JSON.parse(res.getContentText());
  } catch (err) {
    return { error: 'TOKEN_VERIFY_FAILED', detail: err.message };
  }

  // 2. 발급처 확인 — v2 tokeninfo 는 audience 와 issued_to 를 함께 준다.
  //    둘 다 없으면 응답 계약이 바뀐 것이다. 통과시키지 않고(fail closed)
  //    WRONG_AUDIENCE 와 구분되는 코드로 돌려 원인이 바로 보이게 한다.
  //    → 그때는 편집기에서 checkToken(토큰) 을 돌려 실제 응답 필드를 확인할 것.
  //    정상 흐름에서 두 값은 항상 같다. 하나라도 다르면 통과시키지 않는다.
  var aud = info.audience  || '';
  var iss = info.issued_to || '';
  if (!aud && !iss) return { error: 'AUDIENCE_MISSING' };
  if ((aud && aud !== GOOGLE_CLIENT_ID) || (iss && iss !== GOOGLE_CLIENT_ID))
    return { error: 'WRONG_AUDIENCE' };

  // 3·4. 이메일 확인
  if (!info.email) return { error: 'INVALID_TOKEN' };
  if (info.verified_email === false) return { error: 'UNVERIFIED_EMAIL' };

  var email = String(info.email).trim().toLowerCase();
  var at = email.indexOf('@');
  if (at < 1) return { error: 'INVALID_TOKEN' };            // 로컬파트가 비었거나 @ 가 없다
  if (email.slice(at) !== '@' + ALLOWED_DOMAIN)             // 접미사가 아니라 도메인 전체 일치
    return { error: 'UNAUTHORIZED_DOMAIN', email: email };

  return { email: email };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  페이로드 빌드
// ═══════════════════════════════════════════════════════════════════════════════
function buildPayload_() {
  var ss = openSS_();
  var warnings = [];        // 화면에 그려진다 — 데이터가 실제로 깨진 경우에만
  var diagnostics = [];     // 화면에 안 그린다 — 로그·하네스 대조용 내부 진단

  var meta     = parseMeta_(ss, warnings);
  var commerce = parseCommerce_(ss, warnings);
  var channel  = parseChannel_(ss, warnings);

  // ── B&M · 재고 / SKU 실매출 계열 ──────────────────────────────────────────
  // 🛑 여기만 soft-fail 이다. 위 세 탭은 대시보드의 뿌리라 실패하면 그대로 던지지만,
  //    새로 붙은 여섯 탭 중 하나가 없거나 헤더가 바뀌었다고 해서 이미 잘 도는
  //    통합 탭·유입 채널 탭까지 500 으로 같이 죽이지는 않는다.
  //    대신 warnings 에 실어 화면에 그대로 띄운다 — 조용히 삼키지 않는다.
  var regionMap  = softParse_('Raw_BM_권역매핑', function(){ return parseBmRegion_(ss, warnings); }, warnings, {});
  var bmInv      = softParse_('Raw_BM재고',      function(){ return parseBmInv_(ss, warnings); }, warnings, []);
  var bmStore    = softParse_('Raw_BM매장',      function(){ return parseBmStore_(ss, warnings, regionMap); }, warnings, []);
  var bmWeek     = softParse_('Raw_BM주간요약',   function(){ return parseBmWeek_(ss, warnings); }, warnings, []);
  var salesDaily = softParse_('RAW_실매출',       function(){ return parseSalesDaily_(ss, warnings); }, warnings, []);

  // 🛑 `주차별요약` 은 선택 탭이다. 시트에 없어도 화면은 정상이므로 경고를 띄우지 않는다 —
  //    주차 라벨·기간은 `RAW_실매출`(일별)에서 전부 파생하고, 이 탭은 교차검증용 롤업일 뿐이다.
  //    탭이 **있는데** 헤더가 틀린 경우에만 경고가 뜬다 (그건 진짜 사고다).
  var salesWeek = [];
  if (ss.getSheetByName(SHEET_SPEC.salesWeek.tab)) {
    salesWeek = softParse_('주차별요약', function(){ return parseSalesWeek_(ss, warnings); }, warnings, []);
  } else {
    diagnostics.push('[주차별요약] 탭이 시트에 없습니다 — 선택 탭이라 건너뜁니다 '
                   + '(주차 라벨·기간은 RAW_실매출에서 파생).');
  }
  var skuWeek    = softParse_('Raw_실매출_SKU별_주간', function(){ return parseSkuWeek_(ss, warnings); }, warnings, []);
  var skuDaily   = softParse_('Raw_실매출_SKU별_일간', function(){ return parseSkuDaily_(ss, warnings); }, warnings, []);

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
  channel = fillMissingChannelRows_(channel, channels, diagnostics);

  // ── 주차 목록 (전부 데이터 파생 — 화면 문구에 주차 수를 박지 않기 위함) ────
  var weeks = buildWeeks_(commerce.concat(channel));

  // ── 기간 ──────────────────────────────────────────────────────────────────
  var allDates = {};
  commerce.forEach(function (r) { allDates[r.date] = 1; });
  channel.forEach(function (r) { allDates[r.date] = 1; });
  var dates = Object.keys(allDates).sort();

  return {
    ok:        true,
    v:         CODE_VERSION,
    tz:        ss.getSpreadsheetTimeZone(),
    usdToKrw:  USD_TO_KRW,
    excludedChannels: EXCLUDED_CHANNELS,
    range:     { start: dates[0] || null, end: dates[dates.length - 1] || null, days: dates.length },
    weeks:     weeks,
    channels:  channels,
    meta:      meta,
    commerce:  commerce,
    channel:   channel,

    // 🛑 실매출 계열은 주 단위 리포트다. 포털(commerce/channel)과 **일 단위로 합치거나
    //    비교하지 않는다** — 포털은 당일 오더 gross, 실매출은 환불을 처리일 기준 차감한 값이라
    //    일별로는 양방향으로 크게 어긋난다. 프런트에서도 두 계열을 섞은 지표를 만들지 않는다.
    bmInv:      bmInv,
    bmStore:    bmStore,
    bmWeek:     bmWeek,
    salesDaily: salesDaily,
    salesWeek:  salesWeek,
    skuWeek:    skuWeek,
    skuDaily:   skuDaily,
    // 실매출 주차 목록 — 라벨은 `주차별요약` 의 `기간` 을 정본으로 쓴다.
    bmWeeks:    buildBmWeeks_(bmWeek, salesWeek, salesDaily),
    dcStoreNos: DC_STORE_NOS,

    warnings:  warnings,
    diagnostics: diagnostics,
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

// ═══════════════════════════════════════════════════════════════════════════════
//  B&M · 재고 / SKU 실매출 파서
//
//  전부 세포라 실매출 리포트(주 단위 수급)에서 온 탭이다.
//  🛑 원본에 숫자와 텍스트가 섞인 열이 있다 — `InStock%` 의 `-`(배치매장수 0),
//     `WOS`·`.COM_WOS` 의 `/0`(분모 0). 세포라 원본 표기이며 우리 버그가 아니다.
//     toNum_() 에 그냥 넣으면 0 으로 뭉개져 「재고가 0주치 남았다」로 오독되므로
//     numOrNull_() 로 null 을 만들어 프런트에서 '-' 로 그리게 한다.
// ═══════════════════════════════════════════════════════════════════════════════

// 새 탭 파서 전용 안전망. 실패를 삼키지 않고 warnings 로 화면에 올린다.
function softParse_(label, fn, warnings, fallback) {
  try {
    return fn();
  } catch (err) {
    warnings.push('[' + label + '] 시트를 읽지 못했습니다 — ' + err.message);
    return fallback;
  }
}

// 숫자면 숫자, 그 밖(빈 값·'-'·'/0')이면 null. 0 과 null 을 구분해야 하므로 toNum_ 과 다르다.
function numOrNull_(val) {
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (val === '' || val === null || val === undefined) return null;
  var s = String(val).replace(/[,$%\s]/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// 매장번호·SKU 는 숫자로도 문자로도 들어온다 → 언제나 문자열 키로 통일한다.
function idKey_(val) {
  if (val === '' || val === null || val === undefined) return '';
  if (typeof val === 'number') return String(Math.round(val));
  return String(val).trim();
}

// ── Raw_BM_권역매핑 — 매장번호 → 권역/구역 ─────────────────────────────────
// Sephora 전 브랜드 공통 매장 인프라 정보다(브랜드 매출 수치가 아니다).
// 매핑 자체는 화면에 내보내지 않고 `Raw_BM매장` 행에 권역만 붙여 보낸다.
function parseBmRegion_(ss, warnings) {
  var spec = SHEET_SPEC.bmRegion;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs;

  var iNo   = col_(hdrs, 'Location Number', spec.tab);
  var iReg  = col_(hdrs, 'Region',          spec.tab);
  var iDist = col_(hdrs, 'District',        spec.tab);

  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var no = idKey_(rows[i][iNo]);
    if (!no) continue;
    map[no] = {
      region:   String(rows[i][iReg]  || '').trim(),
      district: String(rows[i][iDist] || '').trim()
    };
  }
  return map;
}

// ── Raw_BM재고 — SKU × 주간 (재고·InStock%·WOS·YTD) ────────────────────────
function parseBmInv_(ss, warnings) {
  var spec = SHEET_SPEC.bmInv;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iWk   = col_(hdrs, '주차',           spec.tab);
  var iEnd  = col_(hdrs, '주종료일',        spec.tab);
  var iSku  = col_(hdrs, 'SKU',            spec.tab);
  var iName = col_(hdrs, '제품명',          spec.tab);
  var iPrc  = col_(hdrs, '정가',            spec.tab);
  // 🛑 반드시 `($)` 붙은 USD 원본을 읽는다. 평문 이름은 시트가 만든 KRW 파생열(×1500)이다.
  var iBm   = col_(hdrs, 'B&M매출 ($)',     spec.tab);
  var iCom  = col_(hdrs, '.COM매출 ($)',    spec.tab);
  var iTtl  = col_(hdrs, 'TTL매출 ($)',     spec.tab);
  var iDoor = col_(hdrs, '배치매장수',       spec.tab);
  var iIn   = col_(hdrs, '재고보유매장수',    spec.tab);
  var iPct  = col_(hdrs, 'InStock%',        spec.tab);
  var iOos  = col_(hdrs, '품절매장수',       spec.tab);
  var iInv  = col_(hdrs, '매장재고',         spec.tab);
  var iDc   = col_(hdrs, 'DC재고',          spec.tab);
  var iWos  = col_(hdrs, 'WOS',            spec.tab);
  var iOh   = col_(hdrs, '.COM_OH',         spec.tab);
  var iOo   = col_(hdrs, '.COM_OO',         spec.tab);
  var iCWos = col_(hdrs, '.COM_WOS',        spec.tab);
  var iYBm  = col_(hdrs, 'YTD_B&M ($)',     spec.tab);
  var iYCom = col_(hdrs, 'YTD_COM ($)',     spec.tab);
  var iYTtl = col_(hdrs, 'YTD_전체 ($)',     spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r  = rows[i];
    var wk = String(r[iWk] || '').trim();
    var sku = idKey_(r[iSku]);
    if (!wk || !sku) continue;
    out.push({
      week:    wk,
      weekEnd: fmtDate_(r[iEnd], tz),
      sku:     sku,
      name:    String(r[iName] || '').trim(),
      price:   toNum_(r[iPrc]),
      bm:      toNum_(r[iBm]),          // 🛑 음수(반품)를 결측 처리하지 않는다
      com:     toNum_(r[iCom]),
      ttl:     toNum_(r[iTtl]),
      doors:   toNum_(r[iDoor]),
      inDoors: toNum_(r[iIn]),
      inPct:   numOrNull_(r[iPct]),     // 소수(0.95). 배치매장수 0이면 원본이 '-' → null
      oos:     toNum_(r[iOos]),
      inv:     toNum_(r[iInv]),
      dcInv:   toNum_(r[iDc]),
      wos:     numOrNull_(r[iWos]),     // '/0' → null
      comOh:   toNum_(r[iOh]),
      comOo:   toNum_(r[iOo]),
      comWos:  numOrNull_(r[iCWos]),
      ytdBm:   toNum_(r[iYBm]),
      ytdCom:  toNum_(r[iYCom]),
      ytdTtl:  toNum_(r[iYTtl])
    });
  }
  if (!out.length) warnings.push('[Raw_BM재고] 데이터 행이 0건입니다.');
  return out;
}

// ── Raw_BM매장 — 매장 × 주간 ───────────────────────────────────────────────
// 🛑 `.COM` 물류센터 5곳은 행을 지우지 않고 dc:true 로만 표시한다 (원본 보존).
//    매장 실적 집계에서 빼는 것은 프런트의 몫 — 여기서 지우면 원본 대조가 안 된다.
function parseBmStore_(ss, warnings, regionMap) {
  var spec = SHEET_SPEC.bmStore;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iWk   = col_(hdrs, '주차',        spec.tab);
  var iEnd  = col_(hdrs, '주종료일',     spec.tab);
  var iNo   = col_(hdrs, '매장번호',     spec.tab);
  var iName = col_(hdrs, '매장명',       spec.tab);
  var iSal  = col_(hdrs, '주간매출',     spec.tab);
  var iUnit = col_(hdrs, '주간수량',     spec.tab);
  var iInv  = col_(hdrs, '매장재고',     spec.tab);
  var iAfs  = col_(hdrs, 'AFS',        spec.tab);
  var iYtd  = col_(hdrs, 'YTD 매출 ($)', spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r  = rows[i];
    var wk = String(r[iWk] || '').trim();
    var no = idKey_(r[iNo]);
    if (!wk || !no) continue;
    var reg = (regionMap && regionMap[no]) || null;
    out.push({
      week:     wk,
      weekEnd:  fmtDate_(r[iEnd], tz),
      no:       no,
      name:     String(r[iName] || '').trim(),
      sales:    toNum_(r[iSal]),
      units:    toNum_(r[iUnit]),
      inv:      toNum_(r[iInv]),
      afs:      toNum_(r[iAfs]),
      ytd:      toNum_(r[iYtd]),
      region:   reg ? reg.region   : '',
      district: reg ? reg.district : '',
      dc:       DC_STORE_NOS.indexOf(no) >= 0
    });
  }
  if (!out.length) warnings.push('[Raw_BM매장] 데이터 행이 0건입니다.');
  return out;
}

// ── Raw_BM주간요약 — 주간 롤업 ─────────────────────────────────────────────
// `활성매장수` 는 시트에서 이미 `.COM` 물류센터 5곳을 뺀 값이다. 다시 계산하지 않는다.
function parseBmWeek_(ss, warnings) {
  var spec = SHEET_SPEC.bmWeek;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iWk   = col_(hdrs, '주차',        spec.tab);
  var iEnd  = col_(hdrs, '주종료일',     spec.tab);
  // 🛑 여기도 `($)` 쪽이 USD 원본이다. 평문은 KRW 파생열.
  var iBm   = col_(hdrs, 'B&M매출 ($)',  spec.tab);
  var iCom  = col_(hdrs, '.COM매출 ($)', spec.tab);
  var iTot  = col_(hdrs, '전체매출 ($)', spec.tab);
  var iPct  = col_(hdrs, 'InStock%',    spec.tab);
  var iDoor = col_(hdrs, '활성매장수',    spec.tab);
  var iSpd  = col_(hdrs, 'SpD',         spec.tab);
  var iOh   = col_(hdrs, '.COM_OH',      spec.tab);
  var iOo   = col_(hdrs, '.COM_OO',      spec.tab);
  var iYBm  = col_(hdrs, 'YTD_B&M ($)',  spec.tab);
  var iYCom = col_(hdrs, 'YTD_COM ($)',  spec.tab);
  var iYTtl = col_(hdrs, 'YTD_전체 ($)',  spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r  = rows[i];
    var wk = String(r[iWk] || '').trim();
    if (!wk) continue;
    out.push({
      week:    wk,
      weekEnd: fmtDate_(r[iEnd], tz),
      bm:      toNum_(r[iBm]),
      com:     toNum_(r[iCom]),
      total:   toNum_(r[iTot]),
      inPct:   numOrNull_(r[iPct]),      // 매출 가중 In-Stock%. 소수(0.95)
      doors:   toNum_(r[iDoor]),
      spd:     toNum_(r[iSpd]),
      comOh:   toNum_(r[iOh]),
      comOo:   toNum_(r[iOo]),
      ytdBm:   toNum_(r[iYBm]),
      ytdCom:  toNum_(r[iYCom]),
      ytdTtl:  toNum_(r[iYTtl])
    });
  }
  if (!out.length) warnings.push('[Raw_BM주간요약] 데이터 행이 0건입니다.');
  return out;
}

// ── Raw_실매출 — 날짜별 전 SKU 합산 (일별) ──────────────────────────────────
// ⚠️ SKU 단위가 아니다. 이름이 헷갈리기 쉬우니 주의 — SKU × 일별은 skuDaily 다.
// 🛑 시트의 파생열(년·월·주차)은 읽지 않는다. 날짜에서 직접 만든다
//    (새 탭에 ARRAYFORMULA 파생열을 새로 만들지 않는다는 원칙 그대로).
function parseSalesDaily_(ss, warnings) {
  var spec = SHEET_SPEC.salesDaily;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iDate = col_(hdrs, '날짜',           spec.tab);
  var iWk   = col_(hdrs, '주차',           spec.tab);   // 🛑 K열에도 같은 이름의 파생열이 있다.
  var iBm   = col_(hdrs, 'B&M 매출 ($)',    spec.tab);   //    indexOf 는 앞선 B열을 잡는다 — 그게 원본이다.
  var iCom  = col_(hdrs, '.COM 매출 ($)',   spec.tab);
  var iTot  = col_(hdrs, '전체 매출 ($)',   spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r    = rows[i];
    var date = fmtDate_(r[iDate], tz);
    if (!date) continue;
    out.push({
      date:  date,
      week:  String(r[iWk] || '').trim(),
      month: date.slice(0, 7),
      bm:    toNum_(r[iBm]),
      com:   toNum_(r[iCom]),
      total: toNum_(r[iTot])
    });
  }
  if (!out.length) warnings.push('[Raw_실매출] 데이터 행이 0건입니다.');
  return out;
}

// ── 주차별요약 — 주간 롤업 ─────────────────────────────────────────────────
// 🛑 `비고` 열은 읽지 않는다. 분석 메모(포털 대비 차이 원인 등)라 화면에 그릴 내용이 아니다.
function parseSalesWeek_(ss, warnings) {
  var spec = SHEET_SPEC.salesWeek;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs;

  var iWk   = col_(hdrs, '주차',           spec.tab);
  var iRng  = col_(hdrs, '기간',           spec.tab);
  var iDays = col_(hdrs, '일수',           spec.tab);
  var iBm   = col_(hdrs, 'B&M 매출($)',     spec.tab);
  var iCom  = col_(hdrs, '.COM 매출($)',    spec.tab);
  var iTot  = col_(hdrs, '전체 매출($)',    spec.tab);
  var iShr  = col_(hdrs, '.COM 비중',       spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r  = rows[i];
    var wk = String(r[iWk] || '').trim();
    if (!wk) continue;
    out.push({
      week:     wk,
      range:    String(r[iRng] || '').trim(),
      days:     toNum_(r[iDays]),
      bm:       toNum_(r[iBm]),
      com:      toNum_(r[iCom]),
      total:    toNum_(r[iTot]),
      comShare: numOrNull_(r[iShr])          // 소수(0.9273)
    });
  }
  if (!out.length) warnings.push('[주차별요약] 데이터 행이 0건입니다.');
  return out;
}

// ── Raw_실매출_SKU별_주간 ──────────────────────────────────────────────────
function parseSkuWeek_(ss, warnings) {
  var spec = SHEET_SPEC.skuWeek;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iWk    = col_(hdrs, '주차',          spec.tab);
  var iEnd   = col_(hdrs, '주종료일',       spec.tab);
  var iSku   = col_(hdrs, 'SKU번호',        spec.tab);
  var iName  = col_(hdrs, '제품명',         spec.tab);
  var iBm    = col_(hdrs, 'B&M매출 ($)',    spec.tab);
  var iCom   = col_(hdrs, '.COM매출 ($)',   spec.tab);
  var iTot   = col_(hdrs, '전체매출 ($)',   spec.tab);
  var iBmU   = col_(hdrs, 'B&M수량',        spec.tab);
  var iComU  = col_(hdrs, '.COM수량',       spec.tab);
  var iTotU  = col_(hdrs, '전체수량',       spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r   = rows[i];
    var wk  = String(r[iWk] || '').trim();
    var sku = idKey_(r[iSku]);
    if (!wk || !sku) continue;
    out.push({
      week: wk, weekEnd: fmtDate_(r[iEnd], tz), sku: sku,
      name:  String(r[iName] || '').trim(),
      bm:    toNum_(r[iBm]),   com:   toNum_(r[iCom]),  total:  toNum_(r[iTot]),
      bmU:   toNum_(r[iBmU]),  comU:  toNum_(r[iComU]), totalU: toNum_(r[iTotU])
    });
  }
  if (!out.length) warnings.push('[Raw_실매출_SKU별_주간] 데이터 행이 0건입니다.');
  return out;
}

// ── Raw_실매출_SKU별_일간 ──────────────────────────────────────────────────
// 🛑 `일`(C열)·`주차`(A열)와 같은 이름의 파생열이 오른쪽 끝에도 있다.
//    col_ 은 완전 일치 + indexOf 라 언제나 앞선 원본 열을 잡는다 — 의도한 동작이다.
function parseSkuDaily_(ss, warnings) {
  var spec = SHEET_SPEC.skuDaily;
  var g    = openAndValidate_(ss, spec, warnings);
  var rows = g.rows, hdrs = g.hdrs, tz = g.tz;

  var iWk    = col_(hdrs, '주차',          spec.tab);
  var iEnd   = col_(hdrs, '주종료일',       spec.tab);
  var iDay   = col_(hdrs, '일',            spec.tab);
  var iSku   = col_(hdrs, 'SKU번호',        spec.tab);
  var iName  = col_(hdrs, '제품명',         spec.tab);
  var iBm    = col_(hdrs, 'B&M매출 ($)',    spec.tab);
  var iCom   = col_(hdrs, '.COM매출 ($)',   spec.tab);
  var iTot   = col_(hdrs, '전체매출 ($)',   spec.tab);
  var iBmU   = col_(hdrs, 'B&M수량',        spec.tab);
  var iComU  = col_(hdrs, '.COM수량',       spec.tab);
  var iTotU  = col_(hdrs, '전체수량',       spec.tab);

  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r    = rows[i];
    var date = fmtDate_(r[iDay], tz);
    var sku  = idKey_(r[iSku]);
    if (!date || !sku) continue;
    out.push({
      date: date, month: date.slice(0, 7),
      week: String(r[iWk] || '').trim(), weekEnd: fmtDate_(r[iEnd], tz), sku: sku,
      name:  String(r[iName] || '').trim(),
      bm:    toNum_(r[iBm]),   com:   toNum_(r[iCom]),  total:  toNum_(r[iTot]),
      bmU:   toNum_(r[iBmU]),  comU:  toNum_(r[iComU]), totalU: toNum_(r[iTotU])
    });
  }
  if (!out.length) warnings.push('[Raw_실매출_SKU별_일간] 데이터 행이 0건입니다.');
  return out;
}

// ── 실매출 주차 목록 ───────────────────────────────────────────────────────
// 🛑 화면 문구에 주차 수를 박지 않기 위해 라벨을 전부 데이터에서 만든다.
//    `주차별요약` 의 `기간`(07/26~08/01) 이 정본이고, 없으면 일별 행의 최소·최대 날짜로 만든다.
function buildBmWeeks_(bmWeek, salesWeek, salesDaily) {
  var byKey = {};
  function slot(k) {
    if (!byKey[k]) byKey[k] = { key: k, range: '', end: null, start: null };
    return byKey[k];
  }
  bmWeek.forEach(function (r) { var s = slot(r.week); s.end = r.weekEnd || s.end; });
  salesWeek.forEach(function (r) { var s = slot(r.week); s.range = r.range || s.range; });
  salesDaily.forEach(function (r) {
    if (!r.week) return;
    var s = slot(r.week);
    if (!s.start || r.date < s.start) s.start = r.date;
    if (!s.end   || r.date > s.end)   s.end   = r.date;
  });
  return Object.keys(byKey)
    .map(function (k) { return byKey[k]; })
    .sort(function (a, b) {
      var ka = a.end || a.key, kb = b.end || b.key;
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
}

// ── 결측 채널 0 채우기 ───────────────────────────────────────────────────────
// 값 0인 채널은 원본에서 행 자체가 빠진다 → 날짜 × 채널 격자를 0으로 메워
// 차트 계열이 중간에 끊기지 않게 한다. 채워 넣은 행은 filled:true 로 표시한다.
function fillMissingChannelRows_(rows, channels, diagnostics) {
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
  // 🛑 warnings 로 올리지 않는다 — warnings 는 화면에 그려진다.
  //    세포라가 값 0인 채널의 행을 생략하는 것을 우리가 0으로 메우는 것은 **내부 처리 규칙**이지
  //    대시보드를 보는 경영진·BM팀이 알아야 할 정보가 아니다. 오히려 데이터가 부실하다는
  //    오해를 준다 (MJ 결정 2026-08-16). 감시는 test/ 하네스와 Cowork 주간 검증이 맡는다.
  //    warnings 는 「데이터가 실제로 깨진 경우」(필수 헤더 누락·열 개수 불일치)에만 쓴다.
  if (added) diagnostics.push('[RAW_유입] 결측 채널 ' + added + '행을 0으로 채움 (원본은 값 0인 채널의 행을 생략함).');

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
             'B&M — 재고 ' + (j.bmInv || []).length + '행 / 매장 ' + (j.bmStore || []).length +
               '행 / 주간요약 ' + (j.bmWeek || []).length + '행\n' +
             '실매출 — 일별 ' + (j.salesDaily || []).length + '행 / 주간 ' + (j.salesWeek || []).length +
               '행 / SKU주간 ' + (j.skuWeek || []).length + '행 / SKU일간 ' + (j.skuDaily || []).length + '행\n' +
             '주차: ' + (j.weeks || []).map(function (w) { return w.key; }).join(', ') + '\n' +
             '채널: ' + (j.channels || []).join(', ') + '\n' +
             '경고: ' + ((j.warnings || []).length ? '\n  - ' + j.warnings.join('\n  - ') : '없음'));
}

// 점검용 — 실제 토큰으로 tokeninfo 응답 필드를 눈으로 확인한다.
//
//   브라우저에서 대시보드에 로그인한 뒤 개발자도구 콘솔에
//     sessionStorage.getItem('dfus_token')
//   로 토큰을 복사해 아래 TOKEN 에 붙여넣고 실행한다.
//
// 🛑 토큰은 1시간짜리 접근 자격이다. 로그로 남기거나 이 파일에 저장한 채 두지 말 것.
//    확인이 끝나면 TOKEN 을 다시 빈 문자열로 되돌린다.
function checkToken() {
  var TOKEN = '';   // ← 여기에 붙여넣고 실행, 끝나면 지운다

  if (!TOKEN) { Logger.log('TOKEN 을 채우고 실행하세요.'); return; }
  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/oauth2/v2/tokeninfo?access_token=' + encodeURIComponent(TOKEN),
    { muteHttpExceptions: true });
  var code = res.getResponseCode();
  var body = res.getContentText();
  var info = {};
  try { info = JSON.parse(body); } catch (e) {}

  var aud = info.audience || info.issued_to || '';
  Logger.log(
    'HTTP ' + code + '\n' +
    '응답 필드: ' + Object.keys(info).join(', ') + '\n' +
    '  audience   : ' + (info.audience   || '(없음)') + '\n' +
    '  issued_to  : ' + (info.issued_to  || '(없음)') + '\n' +
    '  email      : ' + (info.email      || '(없음)') + '\n' +
    '  verified   : ' + info.verified_email + '\n' +
    '  expires_in : ' + info.expires_in + '\n' +
    '  scope      : ' + (info.scope || '(없음)') + '\n' +
    '─────────────────────────────\n' +
    'audience 가 이 대시보드 클라이언트 ID와 일치하는가: ' +
      (aud === GOOGLE_CLIENT_ID ? '예 ✔' : '아니오 ✘  (' + (aud || '필드 없음') + ')') + '\n' +
    'verifyToken_() 판정: ' + JSON.stringify(verifyToken_(TOKEN)));
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
  // 실매출 계열 교차검증 — 같은 원천을 세 각도로 가공한 탭이라 합계가 소수점까지 맞아야 한다.
  // 🛑 이 값들을 위 commerce/channel 합계와 비교하지 말 것. 정의가 다르다(오더 gross vs 환불 차감).
  function sum(rows, f) { var t = 0; (rows || []).forEach(function (r) { t += f(r) || 0; }); return t; }
  var rsD = sum(p.salesDaily, function (r) { return r.total; });
  var rsW = sum(p.salesWeek,  function (r) { return r.total; });
  var rsSW = sum(p.skuWeek,   function (r) { return r.total; });
  var rsSD = sum(p.skuDaily,  function (r) { return r.total; });
  var rsBI = sum(p.bmInv,     function (r) { return r.ttl; });
  var rsBW = sum(p.bmWeek,    function (r) { return r.total; });
  var stTot = sum((p.bmStore || []).filter(function (r) { return !r.dc; }), function (r) { return r.sales; });
  var dcTot = sum((p.bmStore || []).filter(function (r) { return r.dc; }),  function (r) { return r.sales; });

  // 🛑 여섯 탭은 같은 원천을 세 각도로 가공한 것이라 합계가 소수점까지 맞아야 한다.
  //    2026-08-19 배포 때 `Raw_BM재고` 가 KRW 파생열을 잡아 정확히 1500배로 나왔는데,
  //    숫자를 나란히 찍어만 두니 눈으로 흘려보냈다. 이제 기계가 판정한다.
  var cross = [
    { n: 'Raw_실매출',   v: rsD },  { n: 'SKU주간',        v: rsSW },
    { n: 'SKU일간',      v: rsSD },  { n: 'Raw_BM재고',     v: rsBI },
    { n: 'Raw_BM주간요약', v: rsBW }
  ];
  if (p.salesWeek && p.salesWeek.length) cross.push({ n: '주차별요약', v: rsW });
  var base = rsD;
  var bad  = cross.filter(function (c) { return Math.abs(c.v - base) > 0.01; });
  var verdict = bad.length
    ? '✘ 불일치 — ' + bad.map(function (c) {
        var ratio = base !== 0 ? (c.v / base) : 0;
        return c.n + ' $' + c.v.toFixed(2)
             + (Math.abs(ratio - USD_TO_KRW) < 1 ? ' (정확히 ' + USD_TO_KRW + '배 → KRW 파생열을 읽고 있다)'
                : c.v === 0 ? ' (0 — 탭/헤더를 못 읽었다. warnings 확인)' : ' (' + ratio.toFixed(4) + '배)');
      }).join(' / ')
    : '✔ 전부 일치';

  Logger.log('기간: ' + p.range.start + ' ~ ' + p.range.end + ' (' + p.range.days + '일)\n' +
             'commerce — 방문 ' + cv + ' / 매출 $' + cs.toFixed(2) + ' / 주문 ' + co + '\n' +
             'channel  — 방문 ' + hv + ' / 매출 $' + hs.toFixed(2) + '\n' +
             'NA 매출 $' + na.toFixed(2) + ' (' + (hs > 0 ? (na / hs * 100).toFixed(2) : '0') + '%)\n' +
             '주차: ' + p.weeks.map(function (w) { return w.key + '(' + w.start + '~' + w.end + ')'; }).join(', ') + '\n' +
             '─────────────────────────────\n' +
             '실매출 전체매출 — Raw_실매출 $' + rsD.toFixed(2) + ' / 주차별요약 $' + rsW.toFixed(2) +
               ' / SKU주간 $' + rsSW.toFixed(2) + ' / SKU일간 $' + rsSD.toFixed(2) + '\n' +
             'B&M TTL — Raw_BM재고 $' + rsBI.toFixed(2) + ' / Raw_BM주간요약 $' + rsBW.toFixed(2) + '\n' +
             'Raw_BM매장 — 매장 $' + stTot.toFixed(2) + ' / .COM 물류센터 5곳 $' + dcTot.toFixed(2) +
               ' (물류센터는 .COM 매출과 이중 계상되므로 매장 실적에서 제외)\n' +
             '실매출 주차: ' + (p.bmWeeks || []).map(function (w) {
                return w.key + '(' + (w.range || (w.start && w.end ? w.start + '~' + w.end : '—')) + ')';
             }).join(', ') + '\n' +
             '교차검증: ' + verdict + '\n' +
             '─────────────────────────────\n' +
             // 🛑 warnings 를 반드시 함께 찍는다. soft-fail 한 새 탭의 실패 사유가 여기 실린다 —
             //    안 찍으면 「합계가 0」이라는 증상만 보이고 원인이 안 보인다 (2026-08-19 실제로 그랬다).
             '경고: ' + ((p.warnings || []).length ? '\n  - ' + p.warnings.join('\n  - ') : '없음') + '\n' +
             // 화면에서 뺀 내부 진단은 여기로만 남긴다 (MJ 결정 2026-08-16)
             '진단: ' + ((p.diagnostics || []).length ? '\n  - ' + p.diagnostics.join('\n  - ') : '없음'));
}
