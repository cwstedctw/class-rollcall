/**
 * 課堂點名網頁（class-rollcall）純邏輯測試
 * 測試對象：apps-script/Logic.gs（規格第 6 節介面契約）
 *
 * 【秀姑巒對規格未明寫處的邊界解讀（請洄瀾裁決）】
 * 1. [解讀-1] normSid_：若字串先有空白才有 ndhu_ 前綴（例 '  ndhu_s0000001 '），應先去空白再剝除開頭的 ndhu_，得到 'S0000001'；若只有 'ndhu_' 無後續字元則回 ''。
 * 2. [解讀-2] checkCode_：當時間窗剛開始（w = 0 或 w = 1）時，前推 GRACE_WINDOWS (2) 個時間窗不得落入負數時間窗（w = -1, -2 的 HMAC 碼必須被拒絕，回 reason: 'wrong'）。
 * 3. [解讀-3] rosterFromRows_：同一個學號若在名冊重複出現 3 次（例列 0、列 1、列 2），list 只留第一筆（列 0），dup 陣列包含該學號（去重後含 'S0000001'，不重複塞兩次同一個 sid，或至少包含該 sid）。本測試檢查 dup 含 'S0000001' 且不重複列出相同 sid。
 * 4. [解讀-4] planColumnWrite_（fill 與 occupied 的列範圍）：尾部（最後一個有學號的列之後）若有多餘的空白列，不計入 values 長度與 occupied 掃描範圍；中間穿插的學號空白列在 fill 時填 ['']，在 occupied 時不列入 upgrades。
 * 5. [解讀-5] verifyColumn_：當 expected 與 actual 長度不同時，ok 必為 false，且 mismatches 至少包含多出／缺少的那幾列索引（不為空陣列）。
 * 6. [解讀-6] summary_：第一個參數 roster 傳入 rosterFromRows_(rows).list（陣列 [{sid, name, row}]）時可正常計算；同時測試若傳入完整 rosterFromRows_(rows) 回傳物件 { list, dup } 時也能相容處理（或依契約傳 list）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const LOGIC_PATH = fileURLToPath(new URL('../Logic.gs', import.meta.url));

function loadLogic() {
  const source = fs.readFileSync(LOGIC_PATH, 'utf8');
  const ctx = vm.createContext({
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    JSON,
    Map,
    Set,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
  });
  vm.runInContext(source, ctx, { filename: 'Logic.gs' });
  return vm.runInContext(
    `({
      CODE_ALPHABET: typeof CODE_ALPHABET !== 'undefined' ? CODE_ALPHABET : undefined,
      CODE_LEN: typeof CODE_LEN !== 'undefined' ? CODE_LEN : undefined,
      GRACE_WINDOWS: typeof GRACE_WINDOWS !== 'undefined' ? GRACE_WINDOWS : undefined,
      ALLOWED_DOMAIN: typeof ALLOWED_DOMAIN !== 'undefined' ? ALLOWED_DOMAIN : undefined,
      normSid_: typeof normSid_ !== 'undefined' ? normSid_ : undefined,
      sidFromEmail_: typeof sidFromEmail_ !== 'undefined' ? sidFromEmail_ : undefined,
      taipeiDate_: typeof taipeiDate_ !== 'undefined' ? taipeiDate_ : undefined,
      taipeiTime_: typeof taipeiTime_ !== 'undefined' ? taipeiTime_ : undefined,
      windowIndex_: typeof windowIndex_ !== 'undefined' ? windowIndex_ : undefined,
      codeFromBytes_: typeof codeFromBytes_ !== 'undefined' ? codeFromBytes_ : undefined,
      codeFor_: typeof codeFor_ !== 'undefined' ? codeFor_ : undefined,
      checkCode_: typeof checkCode_ !== 'undefined' ? checkCode_ : undefined,
      sessionPhase_: typeof sessionPhase_ !== 'undefined' ? sessionPhase_ : undefined,
      arrivalStatus_: typeof arrivalStatus_ !== 'undefined' ? arrivalStatus_ : undefined,
      findDateColumn_: typeof findDateColumn_ !== 'undefined' ? findDateColumn_ : undefined,
      rosterFromRows_: typeof rosterFromRows_ !== 'undefined' ? rosterFromRows_ : undefined,
      presentSet_: typeof presentSet_ !== 'undefined' ? presentSet_ : undefined,
      planColumnWrite_: typeof planColumnWrite_ !== 'undefined' ? planColumnWrite_ : undefined,
      verifyColumn_: typeof verifyColumn_ !== 'undefined' ? verifyColumn_ : undefined,
      summary_: typeof summary_ !== 'undefined' ? summary_ : undefined,
      safeCell_: typeof safeCell_ !== 'undefined' ? safeCell_ : undefined,
    })`,
    ctx
  );
}

const plain = (x) => JSON.parse(JSON.stringify(x));

function hmacFn(message, secret) {
  return Array.from(
    crypto.createHmac('sha256', String(secret)).update(String(message)).digest()
  );
}

const logic = loadLogic();

// ============================================================================
// 0. 常數契約檢查
// ============================================================================
test('常數定義符合規格：31 個易讀字元、長度 6、寬限 2 窗、東華網域', () => {
  assert.equal(logic.CODE_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
  assert.equal(logic.CODE_ALPHABET.length, 31);
  assert.equal(logic.CODE_LEN, 6);
  assert.equal(logic.GRACE_WINDOWS, 2);
  assert.equal(logic.ALLOWED_DOMAIN, '@gms.ndhu.edu.tw');
});

// ============================================================================
// 1. normSid_
// ============================================================================
test('normSid_：小寫轉大寫並去掉前後與中間空白', () => {
  assert.equal(logic.normSid_('  s000 0001 \t '), 'S0000001');
  assert.equal(logic.normSid_('s 0 0 0 0 0 0 2'), 'S0000002');
});

test('normSid_：去掉開頭的 ndhu_ 與 NDHU_ 前綴（不分大小寫）', () => {
  assert.equal(logic.normSid_('ndhu_s0000001'), 'S0000001');
  assert.equal(logic.normSid_('NDHU_S0000001'), 'S0000001');
  assert.equal(logic.normSid_('  NdHu_s000 0001 '), 'S0000001');
});

test('normSid_：null、undefined、空字串或只有前綴時回空字串，數字可轉字串', () => {
  assert.equal(logic.normSid_(null), '');
  assert.equal(logic.normSid_(undefined), '');
  assert.equal(logic.normSid_('   '), '');
  assert.equal(logic.normSid_('ndhu_'), '');
  assert.equal(logic.normSid_(12345), '12345');   // 洄瀾 11/18：原本是九位數、格式像真學號，被 pre-commit 擋下，改成一眼看得出是假的數字；測的規則不變（數字轉字串）
});

// ============================================================================
// 2. sidFromEmail_
// ============================================================================
test('sidFromEmail_：東華帳號回正規化後的學號（含大小寫混用與 ndhu_ 前綴）', () => {
  assert.equal(logic.sidFromEmail_('s0000001@gms.ndhu.edu.tw'), 'S0000001');
  assert.equal(logic.sidFromEmail_('  NDHU_s0000002@GMS.NDHU.EDU.TW  '), 'S0000002');
});

test('sidFromEmail_：校外 Gmail、偽造網域、空字串或無帳號前綴一律回空字串', () => {
  assert.equal(logic.sidFromEmail_('s0000001@gmail.com'), '');
  assert.equal(logic.sidFromEmail_('s0000001@ndhu.edu.tw'), '');
  assert.equal(logic.sidFromEmail_('s0000001@gms.ndhu.edu.tw.evil.com'), '');
  assert.equal(logic.sidFromEmail_('@gms.ndhu.edu.tw'), '');
  assert.equal(logic.sidFromEmail_(''), '');
  assert.equal(logic.sidFromEmail_(null), '');
  assert.equal(logic.sidFromEmail_(undefined), '');
});

// ============================================================================
// 3. taipeiDate_ / taipeiTime_
// ============================================================================
test('taipeiDate_ 與 taipeiTime_：UTC 15:59:59 仍在台北同一天 23:59:59', () => {
  const ms = Date.UTC(2026, 10, 18, 15, 59, 59, 999); // 2026-11-18T15:59:59.999Z
  assert.equal(logic.taipeiDate_(ms), '2026-11-18');
  assert.equal(logic.taipeiTime_(ms), '23:59:59');
});

test('taipeiDate_ 與 taipeiTime_：UTC 16:00:00 跨入台北隔天 00:00:00', () => {
  const ms = Date.UTC(2026, 10, 18, 16, 0, 0, 0); // 2026-11-18T16:00:00.000Z
  assert.equal(logic.taipeiDate_(ms), '2026-11-19');
  assert.equal(logic.taipeiTime_(ms), '00:00:00');
});

test('taipeiDate_ 與 taipeiTime_：個位數月日時分秒固定補零', () => {
  const ms = Date.UTC(2026, 0, 5, 1, 2, 3, 0); // 2026-01-05T01:02:03.000Z -> 台北 09:02:03
  assert.equal(logic.taipeiDate_(ms), '2026-01-05');
  assert.equal(logic.taipeiTime_(ms), '09:02:03');
});

// ============================================================================
// 4. windowIndex_
// ============================================================================
test('windowIndex_：剛開場為 0，跨窗前一毫秒為 0，剛好跨窗的那一毫秒為 1', () => {
  const openedAt = 1_700_000_000_000;
  assert.equal(logic.windowIndex_(openedAt, openedAt, 20), 0);
  assert.equal(logic.windowIndex_(openedAt + 19_999, openedAt, 20), 0);
  assert.equal(logic.windowIndex_(openedAt + 20_000, openedAt, 20), 1);
  assert.equal(logic.windowIndex_(openedAt + 40_000, openedAt, 20), 2);
});

test('windowIndex_：rotateSec <= 0 時恆為 0，現在時間早於開場時間時不小於 0', () => {
  const openedAt = 1_700_000_000_000;
  assert.equal(logic.windowIndex_(openedAt + 999_999, openedAt, 0), 0);
  assert.equal(logic.windowIndex_(openedAt + 999_999, openedAt, -10), 0);
  assert.equal(logic.windowIndex_(openedAt - 5_000, openedAt, 20), 0);
});

// ============================================================================
// 5. codeFromBytes_
// ============================================================================
test('codeFromBytes_：有號位元組（-128..127）與無號位元組（0..255）表示同值時結果相同', () => {
  const unsignedBytes = [0, 30, 31, 128, 200, 255, 10, 20];
  const signedBytes = unsignedBytes.map((b) => (b > 127 ? b - 256 : b));
  const codeU = logic.codeFromBytes_(unsignedBytes);
  const codeS = logic.codeFromBytes_(signedBytes);

  assert.equal(codeU, codeS);
  assert.equal(codeU.length, 6);
  for (const ch of codeU) {
    assert.ok(logic.CODE_ALPHABET.includes(ch), `字元 ${ch} 應在字母表內`);
  }
});

test('codeFromBytes_：取前 6 個位元組依 (b & 0xff) % 31 對應字母表', () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = [0, 1, 30, 31, 32, 61, 99, 100];
  const expected =
    alphabet[0] +
    alphabet[1] +
    alphabet[30] +
    alphabet[0] +
    alphabet[1] +
    alphabet[30];
  assert.equal(logic.codeFromBytes_(bytes), expected);
});

// ============================================================================
// 6. codeFor_ / checkCode_
// ============================================================================
test('codeFor_ 與 checkCode_：目前窗、前 1 窗、前 2 窗通過；前 3 窗與下一窗被拒絕', () => {
  const openedAtMs = 1_700_000_000_000;
  const session = {
    id: 'sess_101',
    secret: 'sec_alpha',
    openedAtMs,
    closesAtMs: openedAtMs + 600_000,
    rotateSec: 20,
    status: 'open',
  };
  // 目前在第 5 個時間窗（openedAtMs + 105_000）
  const nowMs = openedAtMs + 5 * 20_000 + 5_000;

  const codeW5 = logic.codeFor_(session, 5, hmacFn);
  const codeW4 = logic.codeFor_(session, 4, hmacFn);
  const codeW3 = logic.codeFor_(session, 3, hmacFn);
  const codeW2 = logic.codeFor_(session, 2, hmacFn);
  const codeW6 = logic.codeFor_(session, 6, hmacFn);

  assert.deepStrictEqual(plain(logic.checkCode_(codeW5, session, nowMs, hmacFn)), {
    ok: true,
    reason: '',
  });
  assert.deepStrictEqual(plain(logic.checkCode_(codeW4, session, nowMs, hmacFn)), {
    ok: true,
    reason: '',
  });
  assert.deepStrictEqual(plain(logic.checkCode_(codeW3, session, nowMs, hmacFn)), {
    ok: true,
    reason: '',
  });
  assert.deepStrictEqual(plain(logic.checkCode_(codeW2, session, nowMs, hmacFn)), {
    ok: false,
    reason: 'wrong',
  });
  assert.deepStrictEqual(plain(logic.checkCode_(codeW6, session, nowMs, hmacFn)), {
    ok: false,
    reason: 'wrong',
  });
});

test('checkCode_：小寫與夾空白的輸入在正規化後可通過', () => {
  const openedAtMs = 1_700_000_000_000;
  const session = {
    id: 'sess_102',
    secret: 'sec_beta',
    openedAtMs,
    closesAtMs: openedAtMs + 300_000,
    rotateSec: 20,
    status: 'open',
  };
  const code = logic.codeFor_(session, 0, hmacFn);
  const messyInput = `  ${code.slice(0, 3).toLowerCase()} ${code.slice(3).toLowerCase()} \t`;

  assert.deepStrictEqual(plain(logic.checkCode_(messyInput, session, openedAtMs + 1_000, hmacFn)), {
    ok: true,
    reason: '',
  });
});

test('checkCode_：長度不對或含字母表外字元（0/O/1/I/L/符號）回 format', () => {
  const openedAtMs = 1_700_000_000_000;
  const session = {
    id: 'sess_103',
    secret: 'sec_gamma',
    openedAtMs,
    closesAtMs: openedAtMs + 300_000,
    rotateSec: 20,
    status: 'open',
  };

  for (const bad of ['', 'ABCDE', 'ABCDEFG', 'ABCDE0', 'ABCDEO', 'ABCDE1', 'ABCDEI', 'ABCDEL', 'ABC-EF', null, undefined]) {
    assert.deepStrictEqual(
      plain(logic.checkCode_(bad, session, openedAtMs + 1_000, hmacFn)),
      { ok: false, reason: 'format' },
      `輸入 ${String(bad)} 應回 format`
    );
  }
});

test('checkCode_：rotateSec = 0 時整場同一個碼；不同場次 ID 或不同 secret 的碼互不通用', () => {
  const openedAtMs = 1_700_000_000_000;
  const sessionFixed = {
    id: 'sess_fixed',
    secret: 'sec_fixed',
    openedAtMs,
    closesAtMs: openedAtMs + 600_000,
    rotateSec: 0,
    status: 'open',
  };
  const otherIdSession = { ...sessionFixed, id: 'sess_other' };
  const otherSecretSession = { ...sessionFixed, secret: 'sec_other' };

  const code0 = logic.codeFor_(sessionFixed, 0, hmacFn);
  // 過了 5 分鐘仍接受 w = 0 的碼
  assert.deepStrictEqual(
    plain(logic.checkCode_(code0, sessionFixed, openedAtMs + 300_000, hmacFn)),
    { ok: true, reason: '' }
  );
  // 別場或不同 secret 的碼不可通過
  const codeOtherId = logic.codeFor_(otherIdSession, 0, hmacFn);
  const codeOtherSec = logic.codeFor_(otherSecretSession, 0, hmacFn);
  assert.deepStrictEqual(
    plain(logic.checkCode_(codeOtherId, sessionFixed, openedAtMs + 10_000, hmacFn)),
    { ok: false, reason: 'wrong' }
  );
  assert.deepStrictEqual(
    plain(logic.checkCode_(codeOtherSec, sessionFixed, openedAtMs + 10_000, hmacFn)),
    { ok: false, reason: 'wrong' }
  );
  // [解讀-2] 剛開場 w = 0 時，負數窗 w = -1 的碼不可通過
  const codeNeg1 = logic.codeFor_(sessionFixed, -1, hmacFn);
  assert.deepStrictEqual(
    plain(logic.checkCode_(codeNeg1, sessionFixed, openedAtMs + 1_000, hmacFn)),
    { ok: false, reason: 'wrong' }
  );
});

// ============================================================================
// 7. sessionPhase_
// ============================================================================
test('sessionPhase_：開放中為 open、剛好到期那一毫秒為 expired、status 非 open 一律為 closed', () => {
  const closesAtMs = 1_700_000_300_000;
  const openSess = { status: 'open', closesAtMs };
  assert.equal(logic.sessionPhase_(openSess, closesAtMs - 1), 'open');
  assert.equal(logic.sessionPhase_(openSess, closesAtMs), 'expired');
  assert.equal(logic.sessionPhase_(openSess, closesAtMs + 5_000), 'expired');

  const closedSess = { status: 'closed', closesAtMs };
  assert.equal(logic.sessionPhase_(closedSess, closesAtMs - 10_000), 'closed');
  assert.equal(logic.sessionPhase_(closedSess, closesAtMs + 10_000), 'closed');
});

// ============================================================================
// 8. arrivalStatus_
// ============================================================================
test('arrivalStatus_：lateAfterMin = 0 一律準時；剛好在界線上算準時，多 1 毫秒算遲到', () => {
  const openedAtMs = 1_700_000_000_000;
  const noLateSess = { openedAtMs, lateAfterMin: 0 };
  assert.equal(logic.arrivalStatus_(noLateSess, openedAtMs + 3_600_000), '準時');

  const late5Sess = { openedAtMs, lateAfterMin: 5 };
  const boundaryMs = openedAtMs + 5 * 60_000;
  assert.equal(logic.arrivalStatus_(late5Sess, boundaryMs - 1), '準時');
  assert.equal(logic.arrivalStatus_(late5Sess, boundaryMs), '準時');
  assert.equal(logic.arrivalStatus_(late5Sess, boundaryMs + 1), '遲到');
});

// ============================================================================
// 9. findDateColumn_
// ============================================================================
test('findDateColumn_：支援文字表頭、表頭帶空白與 Date 物件表頭（以台北日期比對）', () => {
  const headerText = ['學號', '姓名', '2026-11-11', ' 2026-11-18 ', '點名'];
  assert.equal(logic.findDateColumn_(headerText, '2026-11-11'), 2);
  assert.equal(logic.findDateColumn_(headerText, '2026-11-18'), 3);

  // UTC 2026-11-17T16:00:00Z = 台北 2026-11-18 00:00:00
  const dateObj = new Date(Date.UTC(2026, 10, 17, 16, 0, 0));
  const headerDate = ['學號', '姓名', dateObj, '點名'];
  assert.equal(logic.findDateColumn_(headerDate, '2026-11-18'), 2);
});

test('findDateColumn_：找不到回 -1、重複日期欄回 -1、不誤認索引 0/1 與「點名」合計欄', () => {
  // 找不到
  assert.equal(logic.findDateColumn_(['學號', '姓名', '2026-11-11', '點名'], '2026-11-18'), -1);
  // 同一日期出現兩欄回 -1
  assert.equal(
    logic.findDateColumn_(['學號', '姓名', '2026-11-18', ' 2026-11-18 ', '點名'], '2026-11-18'),
    -1
  );
  // 索引 0 或 1 就算長得像日期也不得當成日期欄；也不會誤認「點名」合計欄
  assert.equal(logic.findDateColumn_(['2026-11-18', '2026-11-18', '2026-11-11', '點名'], '2026-11-18'), -1);
  assert.equal(logic.findDateColumn_(['學號', '姓名', '2026-11-18', '點名'], '點名'), -1);
});

// ============================================================================
// 10. rosterFromRows_
// ============================================================================
test('rosterFromRows_：略過學號空白列、正規化 ndhu_ 前綴、重複學號只留第一筆並記入 dup', () => {
  const rows = [
    ['ndhu_s0000001', '測試生甲'],
    ['   ', '空白學號列'],
    ['S0000002', '測試生乙'],
    ['S0000001', '測試生甲重複1'],
    [null, '空值列'],
    ['  s0000001 ', '測試生甲重複2'],
    ['NDHU_S0000003', ' 測試生丙 '],
  ];
  const res = plain(logic.rosterFromRows_(rows));

  assert.equal(res.list.length, 3);
  assert.deepStrictEqual(
    res.list.map((r) => ({ sid: r.sid, name: r.name.trim(), row: r.row })),
    [
      { sid: 'S0000001', name: '測試生甲', row: 0 },
      { sid: 'S0000002', name: '測試生乙', row: 2 },
      { sid: 'S0000003', name: '測試生丙', row: 6 },
    ]
  );
  assert.ok(Array.isArray(res.dup));
  assert.ok(res.dup.includes('S0000001'));
});

// ============================================================================
// 11. presentSet_
// ============================================================================
test('presentSet_：先簽到後被老師取消＝不在；先取消後補登＝在；不在名冊忽略；學號大小寫視為同一人', () => {
  const checkins = [
    { sid: 's0000001', status: '準時', timeMs: 1000, source: 'QR' },
    { sid: 'S0000001', status: '老師取消', timeMs: 2000, source: '老師' },
    { sid: 'S0000002', status: '老師取消', timeMs: 1500, source: '老師' },
    { sid: 'ndhu_s0000002', status: '老師補登', timeMs: 2500, source: '老師' },
    { sid: 'S0000003', status: '遲到', timeMs: 1800, source: '手動碼' },
    { sid: 'S0000099', status: '不在名冊', timeMs: 1900, source: 'QR' },
  ];
  const present = plain(logic.presentSet_(checkins));

  assert.equal('S0000001' in present, false);
  assert.equal('S0000099' in present, false);
  assert.equal('S0000002' in present, true);
  assert.equal(present.S0000002.status, '老師補登');
  assert.equal('S0000003' in present, true);
  assert.equal(present.S0000003.status, '遲到');
});

// ============================================================================
// 12. planColumnWrite_
// ============================================================================
test('planColumnWrite_：找不到日期欄時回 kind: missing', () => {
  const header = ['學號', '姓名', '2026-11-11', '點名'];
  const rows = [['S0000001', '測試生甲', '', 0]];
  const res = plain(logic.planColumnWrite_(header, rows, '2026-11-18', { S0000001: { status: '準時' } }));
  assert.deepStrictEqual(res, { kind: 'missing' });
});

test('planColumnWrite_：整欄空白時回 fill，學號空白列填空字串，長度到最後一個有學號的列為止，名冊外不影響', () => {
  const header = ['學號', '姓名', '2026-11-18', '點名'];
  const rows = [
    ['S0000001', '測試生甲', '', 0],
    ['', '', '', ''], // 中間學號空白列
    ['ndhu_s0000002', '測試生乙', '   ', 0],
    ['S0000003', '測試生丙', null, 0],
    ['', '', '', ''], // 尾部多餘空白列（應截除）
  ];
  const present = {
    S0000001: { sid: 'S0000001', status: '準時' },
    S0000003: { sid: 'S0000003', status: '遲到' },
    S0000099: { sid: 'S0000099', status: '準時' }, // 名冊外出席者
  };

  const res = plain(logic.planColumnWrite_(header, rows, '2026-11-18', present));
  assert.equal(res.kind, 'fill');
  assert.equal(res.col, 2);
  assert.deepStrictEqual(res.values, [[1], [''], [0], [1]]);
  assert.equal(res.rosterCount, 3);
  assert.equal(res.presentCount, 2);
  assert.deepStrictEqual(res.absent, ['S0000002']);
});

test('planColumnWrite_：欄內只要有一格有值（含 0）即回 occupied，upgrades 只列有出席且表上為 0 或空白的名冊列', () => {
  const header = ['學號', '姓名', '2026-11-18', '點名'];
  const rows = [
    ['S0000001', '測試生甲', 0, 0], // 有出席、表上是數字 0 → 應升級
    ['S0000002', '測試生乙', '', 0], // 有出席、表上是空白 → 應升級
    ['S0000003', '測試生丙', 1, 1], // 有出席、表上已是 1 → 不列
    ['S0000004', '測試生丁', 0, 0], // 沒出席、表上是 0 → 不列
    ['S0000005', '測試生戊', '0', 0], // 有出席、表上是文字 '0' → 應升級
  ];
  const present = {
    S0000001: { sid: 'S0000001', status: '準時' },
    S0000002: { sid: 'S0000002', status: '準時' },
    S0000003: { sid: 'S0000003', status: '準時' },
    S0000005: { sid: 'S0000005', status: '老師補登' },
    S0000099: { sid: 'S0000099', status: '準時' }, // 名冊外
  };

  const res = plain(logic.planColumnWrite_(header, rows, '2026-11-18', present));
  assert.equal(res.kind, 'occupied');
  assert.equal(res.col, 2);
  assert.equal(res.filled, 4);
  assert.deepStrictEqual(res.upgrades, [
    { row: 0, sid: 'S0000001' },
    { row: 1, sid: 'S0000002' },
    { row: 4, sid: 'S0000005' },
  ]);
});

// ============================================================================
// 13. verifyColumn_
// ============================================================================
test('verifyColumn_：1 對 "1"、0 對 "0"、"" 對 null 視為相同；值不同或長度不同算不合', () => {
  const expected = [[1], [0], [''], [1]];
  const actualSame = [['1'], ['0'], [null], [1]];
  assert.deepStrictEqual(plain(logic.verifyColumn_(expected, actualSame)), {
    ok: true,
    mismatches: [],
  });

  const actualDiff = [[1], [1], [''], [0]];
  assert.deepStrictEqual(plain(logic.verifyColumn_(expected, actualDiff)), {
    ok: false,
    mismatches: [1, 3],
  });

  const actualShort = [[1], [0]];
  const shortRes = plain(logic.verifyColumn_(expected, actualShort));
  assert.equal(shortRes.ok, false);
  assert.ok(shortRes.mismatches.length > 0);
});

// ============================================================================
// 14. summary_
// ============================================================================
test('summary_：正確統計名冊人數、出席人數與未到名單，名冊外的人不計入', () => {
  const roster = [
    { sid: 'S0000001', name: '測試生甲', row: 0 },
    { sid: 'S0000002', name: '測試生乙', row: 1 },
    { sid: 'S0000003', name: '測試生丙', row: 2 },
  ];
  const present = {
    S0000001: { sid: 'S0000001', status: '準時' },
    S0000003: { sid: 'S0000003', status: '遲到' },
    S0000099: { sid: 'S0000099', status: '準時' }, // 名冊外
  };

  const res = plain(logic.summary_(roster, present));
  assert.deepStrictEqual(res, {
    total: 3,
    present: 2,
    absent: [{ sid: 'S0000002', name: '測試生乙' }],
  });
});

// ============================================================================
// 15. safeCell_
// ============================================================================
test('safeCell_：=、+、-、@ 開頭轉全形，一般文字與非字串原樣回傳', () => {
  assert.equal(logic.safeCell_('=SUM(A1:A5)'), '＝SUM(A1:A5)');
  assert.equal(logic.safeCell_('+12345'), '＋12345');
  assert.equal(logic.safeCell_('-1+1'), '－1+1');
  assert.equal(logic.safeCell_('@import'), '＠import');

  assert.equal(logic.safeCell_('測試生甲-01'), '測試生甲-01');
  assert.equal(logic.safeCell_('s0000001@gms.ndhu.edu.tw'), 's0000001@gms.ndhu.edu.tw');
  assert.equal(logic.safeCell_(''), '');
  assert.equal(logic.safeCell_(1), 1);
  assert.equal(logic.safeCell_(-5), -5);
  assert.equal(logic.safeCell_(null), null);
});
