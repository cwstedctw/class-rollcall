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
