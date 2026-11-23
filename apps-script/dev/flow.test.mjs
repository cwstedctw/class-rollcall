/**
 * 課堂點名網頁：整條流程驗收（洄瀾寫，立霧與秀姑巒不得修改）
 * 對象：Code.gs 透過 dev/gasfake.mjs 假環境跑出來的行為；判準＝內容規格.md 第 5、9 節。
 * 只用假環境的公開介面（makeGas／seed／as／call／page／sheet／setNow／advance／setLockAvailable／props）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGas, mail, TEACHER } from './gasfake.mjs';
import { seed } from './seed.mjs';

const NOW = Date.UTC(2026, 10, 18, 2, 0, 0);   // 台北 2026-11-18 10:00:00
const TODAY = '2026-11-18';
const SERVICE_URL = 'http://127.0.0.1:8918/';
const TEACHER_FUNCTIONS = [
  'teacherBoot', 'saveGradeFolder', 'startSession', 'teacherTick', 'extendSession',
  'closeSession', 'sessionRoster', 'teacherMark', 'applyTopUp', 'createDemoBook', 'setup', 'clearTestSessions',
];

function fresh() {
  const gas = makeGas({ nowMs: NOW, serviceUrl: SERVICE_URL });
  const seeded = seed(gas);
  const grade = () => gas.sheet('點名', seeded.bookId);
  const col = grade()[0].indexOf(TODAY);
  assert.equal(col, 3, '假成績簿今天那欄應該在 D 欄');
  return { gas, ...seeded, grade, col };
}

function pageResult(html) {
  const m = html.match(/<textarea id="initial-result"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, '學生頁找不到 initial-result');
  const text = m[1].replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(text);
}

const scan = (gas, sid, session, code = session.code) =>
  pageResult(gas.as(mail(sid)).page({ s: session.id, k: code }));
const start = (gas, bookId, opts = { durationMin: 5, rotateSec: 20, lateAfterMin: 0 }) =>
  gas.as(TEACHER).call('startSession', bookId, opts);
const column = (data, col) => data.slice(1).map((row) => row[col]);
const without = (data, col) => JSON.stringify(data.map((row) => row.filter((_, i) => i !== col)));
const logRows = (gas, tab) => gas.sheet(tab).slice(1).filter((row) => row.some((cell) => cell !== '' && cell != null));

function secretsOf(gas) {
  const found = [];
  for (const value of gas.props.values()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.secret === 'string' && parsed.secret) found.push(parsed.secret);
    } catch { /* 不是 JSON 的屬性略過 */ }
  }
  return found;
}

test('整條流程：5 人簽到、重複掃、名冊外、校外帳號、過期碼，結束後成績簿當天欄＝5 個 1 其餘 0', () => {
  const { gas, bookId, grade, col } = fresh();
  const before = without(grade(), col);
  const session = start(gas, bookId);

  assert.equal(session.status, 'open');
  assert.match(session.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(session.qrUrl, `${SERVICE_URL}?s=${session.id}&k=${session.code}`);

  for (const sid of ['S0000001', 'S0000002', 'S0000003']) {
    const result = scan(gas, sid, session);
    assert.equal(result.kind, 'success', sid);
    assert.equal(result.sid, sid);
    assert.equal(result.time, '10:00:00');
  }

  const again = scan(gas, 'S0000001', session);
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.time, '10:00:00');

  assert.equal(scan(gas, 'S9999999', session).kind, 'notInRoster');
  assert.equal(scan(gas, 'S9999999', session).kind, 'notInRoster');
  assert.equal(pageResult(gas.as('someone@gmail.com').page({ s: session.id, k: session.code })).kind, 'unauthorized');

  // 手動輸入：小寫、夾空白照樣通過
  const typed = gas.as(mail('S0000004')).call('checkInByCode', ` ${session.code.toLowerCase().slice(0, 3)} ${session.code.toLowerCase().slice(3)} `);
  assert.equal(typed.kind, 'success');

  // 過了 4 個時間窗（80 秒）之後，舊碼不收、新碼收
  gas.advance(80_000);
  assert.equal(scan(gas, 'S0000005', session).kind, 'wrong');
  const tick = gas.as(TEACHER).call('teacherTick', session.id);
  assert.notEqual(tick.code, session.code);
  assert.equal(tick.presentCount, 4);
  assert.equal(scan(gas, 'S0000005', tick).kind, 'success');

  const closed = gas.as(TEACHER).call('closeSession', session.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.written, 'filled');
  assert.equal(closed.presentCount, 5);
  assert.equal(closed.rosterCount, 8);

  assert.deepEqual(column(grade(), col), [1, 1, 1, 1, 1, 0, 0, 0]);
  column(grade(), col).forEach((value) => assert.equal(typeof value, 'number', '寫進成績簿的必須是數字'));
  assert.equal(without(grade(), col), before, '當天欄以外的格子（含合計公式、其他日期、學號姓名）一格都不能變');

  const checkins = logRows(gas, '簽到');
  assert.equal(checkins.length, 6, '5 筆出席＋1 筆不在名冊');
  assert.equal(checkins.filter((row) => row[6] === '不在名冊').length, 1);
  assert.equal(checkins.filter((row) => row[7] === '手動碼').length, 1);

  const backups = logRows(gas, '寫入備份');
  assert.equal(backups.length, 1);
  assert.equal(backups[0][6], '相符');

  assert.equal(scan(gas, 'S0000006', tick).kind, 'closed', '結束後不能再簽');
  assert.deepEqual(column(grade(), col), [1, 1, 1, 1, 1, 0, 0, 0]);

  // 重複結束不會再寫一次
  gas.as(TEACHER).call('closeSession', session.id);
  assert.equal(logRows(gas, '寫入備份').length, 1);
});

test('當天欄事先有值：結束時一格都不改，補簽只把 0 與空白改成 1、絕不把 1 改成 0', () => {
  const { gas, bookId, grade, col } = fresh();
  const data = grade();
  data[1][col] = 1;   // S1 已是 1
  data[2][col] = 0;   // S2 是 0
  data[4][col] = 0;   // S4 是 0（這次不會來）
  data[6][col] = 1;   // S6 是 1（這次不會來，不能被改成 0）
  const beforeAll = JSON.stringify(grade());

  const session = start(gas, bookId);
  assert.match(session.warning, /已經有資料/);
  for (const sid of ['S0000001', 'S0000002', 'S0000003']) assert.equal(scan(gas, sid, session).kind, 'success');

  const closed = gas.as(TEACHER).call('closeSession', session.id);
  assert.equal(closed.written, 'occupied');
  assert.equal(closed.upgradeCount, 2, 'S2（0）與 S3（空白）可以補成 1');
  assert.equal(JSON.stringify(grade()), beforeAll, '有值的欄在結束時整張表一格都不能變');

  const topped = gas.as(TEACHER).call('applyTopUp', session.id);
  assert.equal(topped.written, 'topped');
  assert.deepEqual(column(grade(), col), [1, 1, 1, 0, '', 1, '', '']);
  assert.equal(without(grade(), col), without(JSON.parse(beforeAll), col));
});

test('成績簿沒有今天這一欄：照樣點名，結束時不寫成績簿', () => {
  const { gas, bookId, grade, col } = fresh();
  grade()[0][col] = '2026-11-20';
  const beforeAll = JSON.stringify(grade());

  const session = start(gas, bookId);
  assert.match(session.warning, /沒有今天這一欄/);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  const closed = gas.as(TEACHER).call('closeSession', session.id);
  assert.equal(closed.written, 'missing');
  assert.equal(JSON.stringify(grade()), beforeAll);
  assert.equal(logRows(gas, '簽到').length, 1, '簽到紀錄照樣留著');
  assert.equal(logRows(gas, '寫入備份').length, 0);
});

test('時間到沒人按結束：老師頁下一次輪詢會自動結束並寫入', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  assert.equal(scan(gas, 'S0000007', session).kind, 'success');
  gas.advance(5 * 60_000 + 1);
  assert.equal(scan(gas, 'S0000008', session).kind, 'closed');
  const tick = gas.as(TEACHER).call('teacherTick', session.id);
  assert.equal(tick.status, 'closed');
  assert.equal(tick.written, 'filled');
  assert.deepEqual(column(grade(), col), [0, 0, 0, 0, 0, 0, 1, 0]);
});

test('寫入之後老師手動改：只動那一位學生那一格', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  gas.as(TEACHER).call('closeSession', session.id);
  assert.deepEqual(column(grade(), col), [1, 0, 0, 0, 0, 0, 0, 0]);
  const before = without(grade(), col);

  gas.as(TEACHER).call('teacherMark', session.id, 'S0000008', true);
  assert.deepEqual(column(grade(), col), [1, 0, 0, 0, 0, 0, 0, 1]);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000001', false);
  assert.deepEqual(column(grade(), col), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(without(grade(), col), before);

  const statuses = logRows(gas, '簽到').map((row) => row[6]);
  assert.deepEqual(statuses, ['準時', '老師補登', '老師取消']);
  const roster = gas.as(TEACHER).call('sessionRoster', session.id);
  assert.equal(roster.present, 1);
});

test('點名進行中老師手動補登與取消，結束時照最後一筆算', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  gas.advance(1000);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000002', true);
  gas.advance(1000);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000001', false);
  gas.advance(1000);
  gas.as(TEACHER).call('closeSession', session.id);
  assert.deepEqual(column(grade(), col), [0, 1, 0, 0, 0, 0, 0, 0]);
});

test('遲到設定：超過分鐘數記「遲到」，仍算出席', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId, { durationMin: 10, rotateSec: 0, lateAfterMin: 1 });
  assert.equal(scan(gas, 'S0000001', session).status, '準時');
  gas.advance(60_001);
  const late = scan(gas, 'S0000002', session);   // rotateSec=0：整場同一個碼
  assert.equal(late.kind, 'success');
  assert.equal(late.status, '遲到');
  gas.as(TEACHER).call('closeSession', session.id);
  assert.deepEqual(column(grade(), col), [1, 1, 0, 0, 0, 0, 0, 0]);
});

test('學生身分呼叫任何老師函式都被拒，而且成績簿與紀錄不受影響', () => {
  const { gas, bookId, grade } = fresh();
  const session = start(gas, bookId);
  const beforeAll = JSON.stringify(grade());
  for (const fn of TEACHER_FUNCTIONS) {
    for (const who of [mail('S0000001'), 'someone@gmail.com', '']) {
      assert.throws(() => gas.as(who).call(fn, session.id, 'S0000002', true), undefined, `${who || '未登入'} 呼叫 ${fn}`);
    }
  }
  assert.equal(JSON.stringify(grade()), beforeAll);
  assert.equal(gas.as(TEACHER).call('teacherTick', session.id).status, 'open', '學生不能把場次關掉');
  assert.equal(gas.as('someone@gmail.com').call('checkInByCode', session.code).kind, 'unauthorized');
});

test('回給瀏覽器的資料不含 secret；投影畫面的資料與老師頁原始碼不含學生學號姓名', () => {
  const { gas, bookId, roster } = fresh();
  const session = start(gas, bookId);
  scan(gas, 'S0000001', session);
  const secrets = secretsOf(gas);
  assert.ok(secrets.length >= 1, '假環境裡應該找得到場次的 secret');

  const projector = [
    JSON.stringify(session),
    JSON.stringify(gas.as(TEACHER).call('teacherBoot')),
    JSON.stringify(gas.as(TEACHER).call('teacherTick', session.id)),
    gas.as(TEACHER).page({}),
  ];
  const studentSide = [
    gas.as(mail('S0000002')).page({ s: session.id, k: session.code }),
    gas.as(mail('S0000003')).page({}),
    JSON.stringify(gas.as(mail('S0000004')).call('checkInByCode', 'AAAAAA')),
  ];
  const closing = JSON.stringify(gas.as(TEACHER).call('closeSession', session.id));
  const rosterJson = JSON.stringify(gas.as(TEACHER).call('sessionRoster', session.id));

  for (const text of [...projector, ...studentSide, closing, rosterJson]) {
    for (const secret of secrets) assert.ok(!text.includes(secret), '回應裡出現了 secret');
  }
  for (const text of [...projector, closing]) {
    for (const person of roster) {
      assert.ok(!text.includes(person.sid), `投影資料出現學號 ${person.sid}`);
      assert.ok(!text.includes(person.name), `投影資料出現姓名 ${person.name}`);
    }
  }
  assert.ok(rosterJson.includes('S0000001'), '名單（老師按了才出現）才應該有學號');
});

test('打錯碼超過 10 次就暫停受理', () => {
  const { gas, bookId } = fresh();
  const session = start(gas, bookId);
  const wrong = session.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
  const kinds = [];
  for (let i = 0; i < 12; i++) kinds.push(scan(gas, 'S0000001', session, wrong).kind);
  assert.deepEqual(kinds.slice(0, 10), Array(10).fill('wrong'));
  assert.equal(kinds[11], 'rateLimited');
  assert.equal(scan(gas, 'S0000001', session).kind, 'rateLimited', '暫停期間連對的碼也不收');
  assert.equal(scan(gas, 'S0000002', session).kind, 'success', '別的同學不受影響');
});

test('第二輪要求：指令碼鎖被別人佔住時學生照樣簽得進去，老師操作才需要鎖', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  gas.setLockAvailable(false);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  assert.equal(gas.as(mail('S0000002')).call('checkInByCode', session.code).kind, 'success');
  assert.equal(scan(gas, 'S0000001', session).kind, 'duplicate');
  assert.throws(() => gas.as(TEACHER).call('closeSession', session.id));
  gas.setLockAvailable(true);
  const closed = gas.as(TEACHER).call('closeSession', session.id);
  assert.equal(closed.written, 'filled');
  assert.deepEqual(column(grade(), col), [1, 1, 0, 0, 0, 0, 0, 0]);
});

test('同一門課同時間只能開一場；延長時間有效', () => {
  const { gas, bookId } = fresh();
  const session = start(gas, bookId);
  assert.throws(() => start(gas, bookId));
  gas.advance(4 * 60_000);
  const extended = gas.as(TEACHER).call('extendSession', session.id, 2);
  assert.equal(extended.closesAtMs, session.closesAtMs + 120_000);
  gas.advance(2 * 60_000);   // 原本這時已經過期
  const tick = gas.as(TEACHER).call('teacherTick', session.id);
  assert.equal(tick.status, 'open');
  assert.equal(scan(gas, 'S0000001', tick).kind, 'success');
});

// ───────── 第三輪（2026-11-18 晚，依秀姑巒唯讀複驗，洄瀾逐條回程式核對後收的五條） ─────────

test('第三輪 #1：日期表頭是日期值或前後帶空白時，開場通過、結束也要寫得進去', () => {
  for (const header of [new Date(Date.UTC(2026, 10, 17, 16, 0, 0)), ' 2026-11-18 ']) {
    const { gas, bookId, grade, col } = fresh();
    grade()[0][col] = header;
    const session = start(gas, bookId);
    assert.equal(session.warning, '', '開場不該警告');
    assert.equal(scan(gas, 'S0000001', session).kind, 'success');
    const closed = gas.as(TEACHER).call('closeSession', session.id);
    assert.equal(closed.written, 'filled', `表頭 ${String(header)}：${closed.error}`);
    assert.deepEqual(column(grade(), col), [1, 0, 0, 0, 0, 0, 0, 0]);
  }
});

test('第三輪 #2：結束寫入期間才落地的簽到，寫完後要補進成績簿（只會 0→1）', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  gas.advance(1000);

  const original = gas.ctx.readCheckins_;
  let calls = 0;
  gas.ctx.readCheckins_ = (s) => {
    const rows = original(s);
    if (++calls === 1) {
      // 模擬：這位同學在結束前一瞬間通過檢查，但那一列等第一次讀完才落地
      gas.sheet('簽到').push([new Date(gas.now() - 500), session.id, '假課程・課堂點名', TODAY, 'S0000005', '測試學生 5', '準時', 'QR']);
    }
    return rows;
  };
  const closed = gas.as(TEACHER).call('closeSession', session.id);
  gas.ctx.readCheckins_ = original;

  assert.equal(closed.written, 'filled');
  assert.deepEqual(column(grade(), col), [1, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(closed.presentCount, 2);
  const backups = logRows(gas, '寫入備份');
  assert.equal(backups.length, 2, '整欄填一次、補收一次，各留一筆備份');
  backups.forEach((row) => assert.equal(row[6], '相符'));
});

test('第三輪 #3：老師改成未到之後，學生自己再掃不算數；只有老師補登能改回來', () => {
  const { gas, bookId, grade, col } = fresh();
  const session = start(gas, bookId);
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  gas.advance(1000);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000001', false);
  gas.advance(1000);

  const rescan = scan(gas, 'S0000001', session);
  assert.equal(rescan.kind, 'cancelled', '要告訴學生是老師改的，不能說「你已經簽到了」');
  const typed = gas.as(mail('S0000001')).call('checkInByCode', session.code);
  assert.equal(typed.kind, 'cancelled');

  // 快取被清掉（Google 的快取不保證留著）也不能讓學生自己掃回來
  gas.cache.clear();
  gas.advance(1000);
  scan(gas, 'S0000001', session);
  assert.equal(gas.as(TEACHER).call('sessionRoster', session.id).list.find((p) => p.sid === 'S0000001').present, false);

  gas.advance(1000);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000002', true);
  gas.as(TEACHER).call('closeSession', session.id);
  assert.deepEqual(column(grade(), col), [0, 1, 0, 0, 0, 0, 0, 0]);

  gas.advance(1000);
  gas.as(TEACHER).call('teacherMark', session.id, 'S0000001', true);
  assert.deepEqual(column(grade(), col), [1, 1, 0, 0, 0, 0, 0, 0]);
});

test('第三輪 #3（純邏輯）：presentSet_ 以老師的手動決定為準', () => {
  const { gas } = fresh();
  const run = (statuses) => Object.keys(JSON.parse(JSON.stringify(
    gas.ctx.presentSet_(statuses.map((status, i) => ({ sid: 'S0000001', status, timeMs: i, source: 'x' }))))));
  assert.deepEqual(run(['準時', '老師取消', '準時']), [], '取消後學生再掃：不在');
  assert.deepEqual(run(['準時', '老師取消', '遲到']), []);
  assert.deepEqual(run(['老師取消', '準時']), []);
  assert.deepEqual(run(['準時', '老師取消', '老師補登']), ['S0000001'], '老師補登可以改回來');
  assert.deepEqual(run(['老師補登', '準時']), ['S0000001']);
  assert.deepEqual(run(['老師補登', '老師取消', '準時', '老師補登', '老師取消']), []);
});

test('第三輪 #8：結束很多場之後，指令碼屬性裡的舊場次要清掉', () => {
  const { gas, bookId } = fresh();
  for (let i = 0; i < 16; i++) {
    const session = start(gas, bookId);
    gas.advance(1000);
    gas.as(TEACHER).call('closeSession', session.id);
    gas.advance(60_000);
  }
  const kept = [...gas.props.keys()].filter((key) => key.startsWith('sess_'));
  assert.ok(kept.length <= 12, `留了 ${kept.length} 場，最多留最近 12 場`);
  assert.equal(gas.as(TEACHER).call('teacherBoot').closedSessions.length, kept.length);
});

test('第三輪 #9：點名紀錄試算表不見了，老師按建立紀錄表要能重建', () => {
  const { gas } = fresh();
  const oldId = gas.props.get('LOG_SHEET_ID');
  gas.books.delete(oldId);
  const rebuilt = gas.as(TEACHER).call('setup');
  assert.notEqual(rebuilt.id, oldId);
  assert.equal(gas.props.get('LOG_SHEET_ID'), rebuilt.id);
  for (const tab of ['場次', '簽到', '寫入備份']) assert.ok(gas.sheet(tab).length >= 1, tab);
});

test('第三輪收件後洄瀾補：紀錄表在垃圾桶時開場會重建；學生簽到那條路不多查一次雲端硬碟', () => {
  const { gas, bookId } = fresh();
  const drive = gas.ctx.DriveApp;
  const original = drive.getFileById;
  let lookups = 0;
  drive.getFileById = (...args) => { lookups += 1; return original.apply(drive, args); };

  const session = start(gas, bookId);
  lookups = 0;
  assert.equal(scan(gas, 'S0000001', session).kind, 'success');
  assert.equal(gas.as(mail('S0000002')).call('checkInByCode', session.code).kind, 'success');
  assert.equal(lookups, 0, '簽到路徑不該呼叫 DriveApp.getFileById');
  gas.as(TEACHER).call('closeSession', session.id);
  drive.getFileById = original;

  const oldId = gas.props.get('LOG_SHEET_ID');
  drive.getFileById(oldId).setTrashed(true);
  gas.advance(60_000);
  const next = start(gas, bookId);
  assert.notEqual(gas.props.get('LOG_SHEET_ID'), oldId, '紀錄表在垃圾桶，開場時要換一份新的');
  assert.equal(scan(gas, 'S0000003', next).kind, 'success');
  assert.equal(logRows(gas, '簽到').length, 1, '新紀錄表只有這一筆');
});

// ───────── 第四輪（2026-11-18 晚，Ted 用手機實測：非東華帳號被 Google 擋在外面、看不到說明；結束後還看得到輸入框） ─────────

const GOOGLE_DOMAIN_URL = 'https://script.google.com/a/gms.ndhu.edu.tw/macros/s/FAKE_DEPLOY-id_1/exec';
const GOOGLE_GENERIC_URL = 'https://script.google.com/macros/s/FAKE_DEPLOY-id_1/exec';
const GOOGLE_SWITCH_URL = 'https://script.google.com/a/macros/gms.ndhu.edu.tw/s/FAKE_DEPLOY-id_1/exec';

test('第四輪：publicUrls_ 把各種 Apps Script 網址整理成「通用」與「東華網域」兩種', () => {
  const { gas } = fresh();
  const urls = (u) => JSON.parse(JSON.stringify(gas.ctx.publicUrls_(u)));
  const expected = { generic: GOOGLE_GENERIC_URL, domain: GOOGLE_SWITCH_URL };
  assert.deepEqual(urls(GOOGLE_DOMAIN_URL), expected);
  assert.deepEqual(urls(GOOGLE_SWITCH_URL), expected);
  assert.deepEqual(urls(GOOGLE_GENERIC_URL), expected);
  assert.deepEqual(urls('https://script.google.com/macros/s/ABC/dev'),
    { generic: 'https://script.google.com/macros/s/ABC/dev', domain: 'https://script.google.com/a/macros/gms.ndhu.edu.tw/s/ABC/dev' });
  assert.deepEqual(urls(SERVICE_URL), { generic: SERVICE_URL, domain: SERVICE_URL }, '不是 Apps Script 網址就原樣');
  assert.deepEqual(urls(''), { generic: '', domain: '' });
});

test('第四輪：QR 用通用網址（非東華帳號才進得了我們的說明頁），說明頁的按鈕指到東華網域網址並帶著原本的 s、k', () => {
  const gas = makeGas({ nowMs: NOW, serviceUrl: GOOGLE_DOMAIN_URL });
  const { bookId } = seed(gas);
  const session = gas.as(TEACHER).call('startSession', bookId, { durationMin: 5, rotateSec: 20, lateAfterMin: 0 });
  assert.equal(session.qrUrl, `${GOOGLE_GENERIC_URL}?s=${session.id}&k=${session.code}`);

  for (const who of ['someone@gmail.com', '']) {
    const blocked = pageResult(gas.as(who).page({ s: session.id, k: session.code }));
    assert.equal(blocked.kind, 'unauthorized');
    assert.equal(blocked.switchUrl, `${GOOGLE_SWITCH_URL}?s=${session.id}&k=${session.code}`);
    const plain = pageResult(gas.as(who).page({}));
    assert.equal(plain.kind, 'unauthorized');
    assert.equal(plain.switchUrl, GOOGLE_SWITCH_URL);
  }
  // 參數裡夾怪字元時不帶過去（不讓人拿這顆按鈕組出奇怪的網址）
  const odd = pageResult(gas.as('someone@gmail.com').page({ s: 'a b"><x', k: 'https://evil.example' }));
  assert.equal(odd.switchUrl, GOOGLE_SWITCH_URL);
  assert.equal(logRows(gas, '簽到').length, 0, '非東華帳號一筆都不記');
  assert.equal(scan(gas, 'S0000001', session).kind, 'success', '東華帳號照常簽到');
});

test('第四輪：學生頁原始碼——非東華帳號有步驟說明與切換按鈕；點名結束的畫面不再出現輸入框', () => {
  const { gas, bookId } = fresh();
  const session = start(gas, bookId);
  const html = gas.as('someone@gmail.com').page({ s: session.id, k: session.code });
  assert.match(html, /id="switch-link"/);
  assert.match(html, /gms\.ndhu\.edu\.tw/);
  assert.match(html, /使用其他帳戶/);
  assert.doesNotMatch(html, /closed:\s*\{[^}]*allowManual/, '「已結束」不該再給輸入框');
  assert.match(html, /switchUrl/);
});

// ───────── 第五輪（2026-11-18 晚，Ted 貼了老師頁「已結束的點名」那四場測試：「can clean this」） ─────────

test('第五輪：清掉測試場次——只清測試用成績簿已結束的場次，真的課、還開著的場次、紀錄表都不動', () => {
  const { gas, bookId } = fresh();
  const demo = gas.as(TEACHER).call('createDemoBook');
  const run = (id) => {
    const s = start(gas, id);
    gas.advance(1000);
    gas.as(TEACHER).call('closeSession', s.id);
    gas.advance(60_000);
    return s;
  };
  const d1 = run(demo.id);
  const d2 = run(demo.id);
  const real = run(bookId);
  const openDemo = start(gas, demo.id);

  let boot = gas.as(TEACHER).call('teacherBoot');
  assert.equal(boot.closedSessions.length, 3);
  assert.equal(boot.testSessionCount, 2);
  const rowsBefore = logRows(gas, '場次').length;

  assert.throws(() => gas.as(mail('S0000001')).call('clearTestSessions'));
  assert.equal(gas.as(TEACHER).call('clearTestSessions').removed, 2);

  boot = gas.as(TEACHER).call('teacherBoot');
  assert.deepEqual(boot.closedSessions.map((s) => s.id), [real.id], '真的課那一場要留著');
  assert.equal(boot.testSessionCount, 0);
  assert.deepEqual(boot.openSessions.map((s) => s.id), [openDemo.id], '還開著的測試場次不能清');
  for (const s of [d1, d2]) assert.ok(!gas.props.has('sess_' + s.id), '測試場次的狀態要刪掉');
  assert.ok(gas.props.has('sess_' + real.id));
  assert.equal(logRows(gas, '場次').length, rowsBefore, '紀錄表一列都不動');
  assert.equal(gas.as(TEACHER).call('clearTestSessions').removed, 0, '再按一次沒有東西可清');
});

test('老師頁在點名進行中提示成績簿什麼時候寫入', () => {
  const { gas } = fresh();
  const html = gas.as(TEACHER).page();
  assert.ok(html.includes('結束點名後才會寫入成績簿'), '老師頁應該有寫入時機的提示');
});