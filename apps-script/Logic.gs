const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const GRACE_WINDOWS = 2;
const ALLOWED_DOMAIN = '@gms.ndhu.edu.tw';
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function normSid_(s) {
  return s == null ? '' : String(s).replace(/\s/g, '').replace(/^ndhu_/i, '').toUpperCase();
}

function sidFromEmail_(email) {
  const address = String(email ?? '').replace(/\s/g, '').toLowerCase();
  return address.endsWith(ALLOWED_DOMAIN) ? normSid_(address.slice(0, -ALLOWED_DOMAIN.length)) : '';
}

function taipeiDate_(ms) {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

function taipeiTime_(ms) {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(11, 19);
}

function windowIndex_(nowMs, openedAtMs, rotateSec) {
  return rotateSec <= 0 ? 0 : Math.max(0, Math.floor((nowMs - openedAtMs) / (rotateSec * 1000)));
}

function codeFromBytes_(bytes) {
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_ALPHABET[(bytes[i] & 0xff) % CODE_ALPHABET.length];
  }
  return code;
}

function codeFor_(session, w, hmacFn) {
  return codeFromBytes_(hmacFn(session.id + ':' + w, session.secret));
}

function checkCode_(input, session, nowMs, hmacFn) {
  const code = String(input ?? '').replace(/\s/g, '').toUpperCase();
  if (code.length !== CODE_LEN || [...code].some(char => !CODE_ALPHABET.includes(char))) {
    return { ok: false, reason: 'format' };
  }
  const current = windowIndex_(nowMs, session.openedAtMs, session.rotateSec);
  for (let w = current; w >= Math.max(0, current - GRACE_WINDOWS); w--) {
    if (code === codeFor_(session, w, hmacFn)) return { ok: true, reason: '' };
  }
  return { ok: false, reason: 'wrong' };
}

function sessionPhase_(session, nowMs) {
  if (session.status !== 'open') return 'closed';
  return nowMs >= session.closesAtMs ? 'expired' : 'open';
}

function arrivalStatus_(session, nowMs) {
  return session.lateAfterMin > 0 && nowMs > session.openedAtMs + session.lateAfterMin * 60000
    ? '遲到' : '準時';
}

function findDateColumn_(headerRow, dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -1;
  let found = -1;
  for (let col = 2; col < headerRow.length; col++) {
    const header = headerRow[col];
    const value = Object.prototype.toString.call(header) === '[object Date]' && Number.isFinite(header.getTime())
      ? taipeiDate_(header.getTime()) : String(header ?? '').trim();
    if (value !== dateStr) continue;
    if (found !== -1) return -1;
    found = col;
  }
  return found;
}

function rosterFromRows_(rows) {
  const list = [];
  const dup = new Set();
  const seen = new Set();
  rows.forEach((cells, row) => {
    const sid = normSid_(cells[0]);
    if (!sid) return;
    if (seen.has(sid)) {
      dup.add(sid);
      return;
    }
    seen.add(sid);
    list.push({ sid, name: String(cells[1] ?? ''), row });
  });
  return { list, dup: [...dup] };
}

function presentSet_(checkins) {
  const present = {};
  const cancelled = new Set();
  for (const checkin of checkins) {
    const sid = normSid_(checkin.sid);
    if (!sid) continue;
    if (checkin.status === '老師取消') {
      cancelled.add(sid);
      delete present[sid];
    } else if (checkin.status === '老師補登') {
      cancelled.delete(sid);
      present[sid] = checkin;
    } else if (!cancelled.has(sid) && (checkin.status === '準時' || checkin.status === '遲到')) {
      present[sid] = checkin;
    }
  }
  return present;
}

/**
 * 老師最後一次手動決定是「取消」的學號（2026-11-24 即時寫入用）。
 * 判法與 presentSet_ 同一套：老師取消之後，學生自己再掃不算數，只有老師補登能改回來。
 */
function cancelledSids_(checkins) {
  const cancelled = new Set();
  for (const checkin of checkins) {
    const sid = normSid_(checkin.sid);
    if (!sid) continue;
    if (checkin.status === '老師取消') cancelled.add(sid);
    else if (checkin.status === '老師補登') cancelled.delete(sid);
  }
  return cancelled;
}

/** 成績簿日期欄一格的狀態：blank 空白、zero 0、one 1、other 其他內容（文字、公式、別的數字）。 */
function cellState_(value) {
  if (blankCell_(value)) return 'blank';
  if (value === 0 || value === '0') return 'zero';
  if (value === 1 || value === '1') return 'one';
  return 'other';
}

/**
 * 即時寫入的場次，日期欄每一格該改成什麼（只算，不寫）。
 *   出席 → 1；老師取消 → 0；沒簽到的人平常不動，結束點名（final）時空白補成 0。
 *   沒簽到、格子卻是 1＝老師自己在試算表填的，保留不動（kept 計數）。
 *   格子是 0、1、空白以外的內容一律不碰（blocked 記下列號）。
 */
function liveChanges_(rows, col, roster, present, cancelled, final) {
  const changes = [];
  const blocked = [];
  let kept = 0;
  let ones = 0;
  roster.forEach(person => {
    const state = cellState_(rows[person.row][col]);
    if (state === 'other') {
      blocked.push(person.row);
      return;
    }
    let target = null;
    if (hasAttendance_(present, person.sid)) target = 1;
    else if (cancelled.has(person.sid)) target = 0;
    else if (final && state === 'blank') target = 0;
    else if (state === 'one') kept++;
    const already = target === 1 ? state === 'one' : state === 'zero';
    if (target !== null && !already) changes.push({ row: person.row, value: target });
    if (target === 1) ones++;
  });
  return { changes, blocked, kept, ones };
}

/** 「名冊上誰出席、誰被老師取消」的指紋；跟上次寫進成績簿時的不一樣，就代表有東西還沒寫。 */
function liveSignature_(roster, present, cancelled) {
  const here = roster.filter(person => hasAttendance_(present, person.sid)).map(person => person.sid);
  const gone = roster.filter(person => !hasAttendance_(present, person.sid) && cancelled.has(person.sid))
    .map(person => person.sid);
  const text = here.join(',') + '|' + gone.join(',');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return here.length + ':' + gone.length + ':' + hash.toString(36);
}

/** 給畫面看的雙語訊息：第一行中文、第二行英文。每則訊息固定兩行，訊息之間也用換行接。 */
function bi_(zh, en) {
  return zh + '\n' + en;
}

/** 從雙語訊息取出中文那幾行（寫進點名紀錄試算表的備註用）。 */
function zhOnly_(text) {
  return String(text == null ? '' : text).split('\n').filter((_, index) => index % 2 === 0).join(' ');
}

function planColumnWrite_(headerRow, rows, dateStr, present) {
  const col = findDateColumn_(headerRow, dateStr);
  if (col < 0) return { kind: 'missing' };

  const filled = rows.reduce((count, row) => count + Number(!blankCell_(row[col])), 0);
  if (filled) {
    const upgrades = [];
    rows.forEach((cells, row) => {
      const sid = normSid_(cells[0]);
      const value = cells[col];
      if (sid && hasAttendance_(present, sid) && (blankCell_(value) || value === 0 || value === '0')) {
        upgrades.push({ row, sid });
      }
    });
    return { kind: 'occupied', col, filled, upgrades };
  }

  const roster = rosterFromRows_(rows).list;
  const counts = summary_(roster, present);
  let end = rows.length;
  while (end > 0 && !normSid_(rows[end - 1][0])) end--;
  const values = rows.slice(0, end).map(cells => {
    const sid = normSid_(cells[0]);
    return [sid ? Number(hasAttendance_(present, sid)) : ''];
  });
  return {
    kind: 'fill', col, values, rosterCount: counts.total, presentCount: counts.present,
    absent: counts.absent.map(person => person.sid),
  };
}

function blankCell_(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function hasAttendance_(present, sid) {
  return Object.prototype.hasOwnProperty.call(present, sid);
}

function verifyColumn_(expected, actual) {
  const mismatches = [];
  for (let row = 0; row < Math.max(expected.length, actual.length); row++) {
    if (row >= expected.length || row >= actual.length ||
        comparableCell_(expected[row][0]) !== comparableCell_(actual[row][0])) {
      mismatches.push(row);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function comparableCell_(value) {
  if (value == null) return '';
  if (value === '0' || value === '1') return Number(value);
  return value;
}

function summary_(roster, present) {
  const absent = roster.filter(person => !hasAttendance_(present, normSid_(person.sid)))
    .map(({ sid, name }) => ({ sid, name }));
  return { total: roster.length, present: roster.length - absent.length, absent };
}

function safeCell_(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/^[=+@-]/, char => '＝＋－＠'['=+-@'.indexOf(char)]);
}

/**
 * 把 Apps Script 網頁應用程式的網址整理成兩種（2026-11-18 第四輪）：
 *   generic＝任何 Google 帳號都走得通的網址，QR 用這個——非東華帳號才進得了我們自己的說明頁；
 *   domain ＝帶東華網域的網址，Google 會自動挑（或要求登入）東華帳號，「用東華帳號簽到」按鈕用這個。
 * 不是 Apps Script 網址（例如本機預覽）就原樣回傳。
 */
function publicUrls_(url) {
  const text = String(url == null ? '' : url);
  const m = text.match(/^https:\/\/script\.google\.com\/(?:a\/(?:macros\/[^/]+|[^/]+\/macros)\/|macros\/)s\/([\w-]+)\/(exec|dev)(.*)$/);
  if (!m) return { generic: text, domain: text };
  const tail = 's/' + m[1] + '/' + m[2] + m[3];
  return {
    generic: 'https://script.google.com/macros/' + tail,
    domain: 'https://script.google.com/a/macros/' + ALLOWED_DOMAIN.slice(1) + '/' + tail,
  };
}
