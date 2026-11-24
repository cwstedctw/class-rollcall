const DEFAULT_OPTIONS_ = { durationMin: 5, rotateSec: 20, lateAfterMin: 0 };
// 指令碼屬性的快照：一次執行（一個網頁請求或一次老師操作）只讀一次，之後都從這裡拿。
// 讀寫屬性每次約 0.05–0.15 秒（2026-11-24 實測），老師頁開機原本要讀三十幾次。
// 等過鎖、睡過、或隔了一段時間要再確認場次狀態之前，先呼叫 staleProps_() 讓它重讀。
let propsSnapshot_ = null;
const WRONG_CODE_TTL_SEC_ = 600;
const LOG_HEADERS_ = {
  '場次': ['場次ID', '成績簿名稱', '成績簿ID', '日期', '開始時間', '結束時間', 'QR秒數', '遲到分鐘', '狀態', '名冊人數', '簽到人數', '寫入結果', '備註'],
  '簽到': ['時間', '場次ID', '成績簿名稱', '日期', '學號', '姓名', '狀態', '來源'],
  '寫入備份': ['時間', '場次ID', '成績簿ID', '欄名', '舊值JSON', '新值JSON', '回讀結果'],
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const email = activeEmail_();
  if (params.s === undefined && params.k === undefined && isTeacher_(email)) {
    return HtmlService.createTemplateFromFile('Teacher').evaluate()
      .setTitle('課堂點名').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  let result = studentResult_(sidFromEmail_(email) ? 'manual' : 'unauthorized');
  if (params.s !== undefined || params.k !== undefined) {
    result = studentRequest_(() => checkInForSession_(email, params.s, params.k));
  }
  // 非東華帳號：附上「用東華帳號簽到」按鈕要去的網址（帶東華網域，Google 會挑或要求登入東華帳號）。
  if (result.kind === 'unauthorized') result.switchUrl = switchUrl_(params);
  const page = HtmlService.createTemplateFromFile('Student');
  page.initialResult = result;
  return page.evaluate().setTitle('課堂簽到')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function checkInByCode(code) {
  return studentRequest_(() => {
    const email = activeEmail_();
    const sid = sidFromEmail_(email);
    if (!sid) return studentResult_('unauthorized');

    const now = Date.now();
    const open = openSessions_().filter(s => sessionPhase_(s, now) === 'open');
    const matches = open.filter(s => checkCode_(code, s, now, hmac_).ok);
    if (matches.length > 1) return studentResult_('ambiguous');
    if (matches.length === 1) return recordStudentCheckin_(matches[0], email, sid, '手動碼');
    if (!open.length) return studentResult_('closed');

    let available = false;
    open.forEach(s => {
      if (!recordWrongCode_(s.id, sid)) available = true;
    });
    return studentResult_(available ? 'wrong' : 'rateLimited');
  });
}

function teacherBoot() {
  requireTeacher_();
  const toRecover = openSessions_().concat(recentSessions_())
    .filter(s => s.logPending || sessionPhase_(s, Date.now()) === 'expired');
  if (toRecover.length) {
    locked_(() => toRecover.forEach(s => {
      const fresh = requiredSession_(s.id);
      if (sessionPhase_(fresh, Date.now()) === 'expired') closeSessionLocked_(fresh);
      else if (fresh.logPending) finishSessionUpdate_(fresh);
    }));
  }
  const closed = recentSessions_();
  const demoIds = demoBookIds_(false);
  return Object.assign(courseCatalog_(), {
    openSessions: openSessions_().map(s => sessionView_(s)),
    closedSessions: closed.map(s => sessionView_(s)),
    // 老師頁用這個數字決定要不要出現「清掉測試場次」按鈕。
    testSessionCount: closed.filter(s => demoIds.has(s.bookId)).length,
    defaults: readOptions_(),
    needsGradeFolder: !prop_('GRADE_FOLDER_ID'),
  });
}

// 測試用成績簿（createDemoBook 建的那個資料夾裡的試算表）的 ID。
function demoBookIds_(refresh) {
  const folderId = prop_('DEMO_GRADE_FOLDER_ID');
  if (!folderId) return new Set();
  try {
    return new Set(coursesInFolder_(folderId, refresh).map(course => course.id));
  } catch (err) {
    return new Set();   // 資料夾讀不到就當成沒有測試成績簿，什麼都不清
  }
}

// 只把「測試用成績簿、而且已經結束」的場次從老師頁的清單拿掉（2026-11-18 Ted：can clean this）。
// 真的課、還開著的場次都不碰；點名紀錄試算表裡的列也不動，那是紀錄。
function clearTestSessions() {
  requireTeacher_();
  return locked_(() => {
    const demoIds = demoBookIds_(true);
    const keep = [];
    const removed = [];
    idList_('recent_ids').forEach(id => {
      const session = readSession_(id);
      if (session && session.status === 'closed' && demoIds.has(session.bookId)) removed.push(id);
      else keep.push(id);
    });
    if (removed.length) {
      setProps_({ recent_ids: JSON.stringify(keep) });
      removed.forEach(id => deleteProp_('sess_' + id));
    }
    return { removed: removed.length };
  });
}

function saveGradeFolder(urlOrId) {
  requireTeacher_();
  const input = String(urlOrId || '').trim();
  const url = input.match(/^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]+)(?:[/?#].*)?$/i);
  const id = url ? url[1] : input;
  if (!/^[\w-]{1,150}$/.test(id)) {
    throw new Error(bi_('請輸入 Google 雲端硬碟的資料夾網址或 ID。', 'Enter a Google Drive folder URL or ID.'));
  }
  return locked_(() => {
    try {
      coursesInFolder_(id, true);
    } catch (err) {
      throw new Error(bi_('無法讀取成績簿資料夾，請確認網址和存取權限。',
        'Can\u2019t read that gradebook folder. Check the URL and sharing permissions.'));
    }
    setProps_({ GRADE_FOLDER_ID: id });
    return courseCatalog_();
  });
}

function startSession(bookId, opts) {
  requireTeacher_();
  const settings = options_(opts);

  return locked_(() => {
    const course = courseCatalog_().courses.find(item => item.id === bookId);
    if (!course) throw new Error(bi_('請選擇成績簿清單中的課程。', 'Choose a course from the gradebook list.'));
    const existing = openSessions_().find(s => s.bookId === bookId);
    if (existing) {
      if (sessionPhase_(existing, Date.now()) === 'open') {
        throw new Error(bi_('這門課已經有一場點名。', 'This course already has an open roll call.'));
      }
      closeSessionLocked_(existing);
    }

    const log = logBook_(true);
    const now = Date.now();
    const date = taipeiDate_(now);
    const grade = readGrade_(bookId, date);
    const roster = rosterFromRows_(grade.rows);
    const initial = planColumnWrite_(grade.header, grade.rows, date, {});
    const warnings = [];
    if (initial.kind === 'missing') {
      warnings.push(bi_('成績簿沒有今天這一欄，照樣可以點名，結果只留在紀錄表。',
        'The gradebook has no column for today. Roll call still works; results stay in the roll-call log.'));
    } else if (initial.kind === 'occupied') {
      warnings.push(bi_('今天這欄已經有資料，結束時不會覆蓋。',
        'Today’s column already has data. It will not be overwritten when roll call ends.'));
    }
    if (roster.dup.length) {
      warnings.push(bi_('名冊有重複學號，簽到與寫入以第一筆為準。',
        'The roster has duplicate student IDs. Check-ins and writes use the first one.'));
    }

    const session = {
      id: Utilities.getUuid(),
      bookId,
      bookName: course.name,
      date,
      openedAtMs: now,
      closesAtMs: now + settings.durationMin * 60000,
      rotateSec: settings.rotateSec,
      lateAfterMin: settings.lateAfterMin,
      secret: Utilities.getUuid() + Utilities.getUuid(),
      status: 'open',
      written: '',
      rosterCount: roster.list.length,
      logBookId: log.getId(),
      checkinStartRow: log.getSheetByName('簽到').getLastRow() + 1,
      logStartRow: log.getSheetByName('場次').getLastRow() + 1,
      warning: warnings.join('\n'),
      // 當天那一欄整欄空白，這一場就邊點名邊寫成績簿（2026-11-24 Ted：immediate update google sheet）。
      // 欄位不存在或已經有資料，照舊：不即時寫，結束時也不覆蓋。
      live: initial.kind === 'fill',
      liveSig: liveSignature_(roster.list, {}, new Set()),
      liveSynced: 0,
    };
    log.getSheetByName('場次').appendRow(sessionLogRow_(session));
    SpreadsheetApp.flush();
    storeSession_(session, {
      open_ids: JSON.stringify(idList_('open_ids').concat(session.id)),
      rollcall_options: JSON.stringify(settings),
    });
    cacheRoster_(session, roster.list);
    return sessionView_(session, 0);
  });
}

function teacherTick(sessionId) {
  requireTeacher_();
  const session = requiredSession_(sessionId);
  if (sessionPhase_(session, Date.now()) === 'expired') {
    return locked_(() => closeSessionLocked_(requiredSession_(sessionId)));
  }
  return sessionView_(session);
}

// 老師頁在背景呼叫：把還沒進成績簿的簽到寫進去（即時寫入）。
// 簽到那條路不寫成績簿——學生掃碼要快，而且同時好幾個人寫同一欄不安全；統一由這裡排鎖、一次寫。
// 回傳 null＝這次沒做（別的老師操作正在進行、場次已結束、或這一場不是即時寫入），老師頁下一輪再問。
function syncLive(sessionId) {
  requireTeacher_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return null;
  try {
    staleProps_();
    const session = requiredSession_(sessionId);
    if (!session.live || session.liveStopped || sessionPhase_(session, Date.now()) !== 'open') return null;
    return sessionView_(session, liveSync_(session));
  } finally {
    lock.releaseLock();
  }
}

// 把「紀錄表上已經出席或被老師取消、成績簿還沒跟上」的格子寫進成績簿。呼叫的人要先拿到指令碼鎖。
// 只會動當天那一欄、名冊上的列：出席→1、老師取消→0，其他格子不碰。回傳名冊上目前的出席人數。
function liveSync_(session) {
  const checkins = readCheckins_(session, sessionLogBook_(session));
  const present = presentSet_(checkins);
  const cancelled = cancelledSids_(checkins);
  let roster = rosterFor_(session);
  try {
    const grade = readGrade_(session.bookId, session.date);
    if (grade.col < 0) {
      throw gradeWriteError_(bi_('成績簿的日期欄已變更。', 'The date column in the gradebook has changed.'));
    }
    roster = rosterFromRows_(grade.rows).list;
    cacheRoster_(session, roster);
    const plan = liveChanges_(grade.rows, grade.col, roster, present, cancelled, false);
    writeGradeColumn_(session, grade, plan.changes, 'live');
    session.liveSig = liveSignature_(roster, present, cancelled);
    session.liveSynced = plan.ones;
    // 格子裡已經是別的內容而沒寫的格數：投影頁要講出來，不然老師不知道有人沒寫進去（立霧複驗 #5）。
    session.liveBlocked = plan.blocked.length;
    session.liveError = '';
    session.liveFails = 0;
    session.mismatches = [];
  } catch (err) {
    // 成績簿被改動（欄位、名冊、格子內容）就停掉這一場的即時寫入；偶發的讀寫錯誤連續三次才停。
    // 停掉不影響簽到，結束點名時仍會做一次完整的寫入與回讀。
    session.liveFails = (session.liveFails || 0) + 1;
    if (err.rollcallWrite || session.liveFails >= 3) {
      session.liveStopped = true;
      session.liveError = [
        err.rollcallWrite ? err.message
          : bi_('即時寫入成績簿時發生錯誤。', 'Something went wrong while updating the gradebook live.'),
        bi_('即時寫入已停止，簽到照常；結束點名時會再寫一次。',
          'Live update has stopped. Check-in still works; the gradebook is written again when roll call ends.'),
      ].join('\n');
    }
  }
  storeSession_(session);
  return summary_(roster, present).present;
}

function extendSession(sessionId, minutes) {
  requireTeacher_();
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) {
    throw new Error(bi_('延長時間請輸入 1 到 180 分鐘。', 'Extension must be 1 to 180 minutes.'));
  }
  return locked_(() => {
    const session = requiredSession_(sessionId);
    if (sessionPhase_(session, Date.now()) !== 'open') return closeSessionLocked_(session);
    session.closesAtMs += minutes * 60000;
    finishSessionUpdate_(session);
    return sessionView_(session);
  });
}

function closeSession(sessionId) {
  requireTeacher_();
  return locked_(() => closeSessionLocked_(requiredSession_(sessionId)));
}

function sessionRoster(sessionId) {
  requireTeacher_();
  const session = requiredSession_(sessionId);
  const { roster, checkins } = sessionRecords_(session);
  const cancellations = new Map();
  checkins.forEach(entry => {
    if (entry.status === '老師取消') cancellations.set(entry.sid, entry);
  });
  const present = presentSet_(checkins);
  const list = roster.map(person => {
    const isPresent = hasAttendance_(present, person.sid);
    const entry = isPresent ? present[person.sid] : cancellations.get(person.sid);
    return {
      sid: person.sid,
      name: person.name,
      present: isPresent,
      status: entry ? entry.status : '',
      time: entry ? taipeiTime_(entry.timeMs) : '',
    };
  });
  return { list, total: list.length, present: list.filter(person => person.present).length };
}

function teacherMark(sessionId, sid, present) {
  requireTeacher_();
  if (typeof present !== 'boolean') throw new Error(bi_('請選擇出席或未到。', 'Choose present or absent.'));
  return locked_(() => {
    const session = requiredSession_(sessionId);
    if (sessionPhase_(session, Date.now()) === 'expired') closeSessionLocked_(session);
    let roster = rosterFor_(session);
    let student = roster.find(person => person.sid === normSid_(sid));
    if (!student) {
      roster = rosterFor_(session, true);
      student = roster.find(person => person.sid === normSid_(sid));
    }
    if (!student) throw new Error(bi_('找不到這位學生。', 'Student not found.'));

    const written = session.written;
    const action = present ? '老師補登' : '老師取消';
    const log = sessionLogBook_(session);
    const checkinSheet = log.getSheetByName('簽到');
    const markedAt = Date.now();
    appendCheckin_(checkinSheet, session, student.sid, student.name, action, '老師', markedAt);
    SpreadsheetApp.flush();
    if (session.status === 'open') {
      const key = checkinCacheKey_(session.id, student.sid);
      if (present) rememberFirstCheckin_(key, markedAt, true);
      else cachePut_(key, 'cancelled');
      // 場次還開著：只記這一筆就回去，按鈕不必等成績簿（真環境實測當場寫要 5 秒）。
      // 回傳的畫面資料會帶 syncPending，老師頁隨即在背景把這一格寫進成績簿；場次摘要留到結束時一起更新。
      return sessionView_(session);
    }
    const presentRecords = presentSet_(readCheckins_(session, log));
    session.presentCount = summary_(roster, presentRecords).present;
    if (written === 'filled' || written === 'topped') {
      writeAttempt_(session, () => {
        const grade = readGrade_(session.bookId, session.date);
        const current = rosterFromRows_(grade.rows).list.find(person => person.sid === student.sid);
        if (!current || grade.col < 0) {
          throw gradeWriteError_(bi_('成績簿名冊或日期欄已變更，簽到紀錄已保留。',
            'The gradebook roster or date column has changed. The check-in record was kept.'));
        }
        session.written = written;
        if (cellState_(grade.rows[current.row][grade.col]) === 'other') {
          // 那一格是老師寫的字或公式：簽到紀錄已經記了，成績簿這一格留給老師自己改。
          session.mismatches = [current.row + 2];
          return bi_('這位學生那一格已經是別的內容，沒有覆蓋；紀錄已記下，請直接在試算表核對。',
            'That cell already holds other content and was left as is. The record was saved; please check the spreadsheet.');
        }
        session.written = 'error';
        writeGradeColumn_(session, grade, [{ row: current.row, value: present ? 1 : 0 }], 'mark');
        session.written = written;
      });
    } else if (written === 'occupied') {
      const grade = readGrade_(session.bookId, session.date);
      const placement = planColumnWrite_(grade.header, grade.rows, session.date, presentRecords);
      session.upgradeCount = topUpRows_(grade, placement, presentRecords).length;
    }
    finishSessionUpdate_(session);
    return sessionView_(session, session.presentCount);
  });
}

function applyTopUp(sessionId) {
  requireTeacher_();
  return locked_(() => {
    const session = requiredSession_(sessionId);
    if (session.written !== 'occupied') return sessionView_(session);
    writeAttempt_(session, () => {
      const grade = readGrade_(session.bookId, session.date);
      const present = presentSet_(readCheckins_(session, sessionLogBook_(session)));
      writeTopUp_(session, grade, present);
      session.written = 'topped';
      session.upgradeCount = 0;
    });
    finishSessionUpdate_(session);
    return sessionView_(session);
  });
}

function createDemoBook() {
  const teacherEmail = requireTeacher_();
  return locked_(() => {
    let folderId = prop_('DEMO_GRADE_FOLDER_ID');
    if (!folderId) {
      folderId = DriveApp.createFolder('課堂點名測試成績簿').getId();
      setProps_({ DEMO_GRADE_FOLDER_ID: folderId });
    }
    const folder = DriveApp.getFolderById(folderId);
    const book = SpreadsheetApp.create('點名網頁測試用成績簿');
    book.setSpreadsheetTimeZone('Asia/Taipei');
    const sheet = book.getSheets()[0].setName('點名');
    const now = Date.now();
    const dates = [-2, -1, 0, 1, 2].map(day => taipeiDate_(now + day * 86400000));
    const roster = Array.from({ length: 8 }, (_, i) => ['S' + String(i + 1).padStart(7, '0'), '假學生 ' + (i + 1)]);
    roster.push([safeCell_(sidFromEmail_(teacherEmail)), '老師測試']);
    const rows = roster.map(([sid, name], i) => [sid, name, '', '', '', '', '', '=SUM(C' + (i + 2) + ':G' + (i + 2) + ')']);
    sheet.getRange(1, 3, 1, dates.length).setNumberFormat('@');
    sheet.getRange(1, 1, rows.length + 1, dates.length + 3)
      .setValues([['學號', '姓名'].concat(dates, '點名')].concat(rows));
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    DriveApp.getFileById(book.getId()).moveTo(folder);
    coursesInFolder_(folderId, true);
    return Object.assign({ id: book.getId(), name: book.getName() }, courseCatalog_());
  });
}

function setup() {
  requireTeacher_();
  return locked_(() => ({ id: logBook_(true).getId() }));
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key) {
  if (!propsSnapshot_) propsSnapshot_ = props_().getProperties();
  const value = propsSnapshot_[key];
  return value == null ? null : value;
}

// 別的執行可能改過屬性（例如學生簽到途中老師按了結束）：要看最新狀態之前先丟掉快照。
function staleProps_() {
  propsSnapshot_ = null;
}

function setProps_(values) {
  props_().setProperties(values);
  if (propsSnapshot_) Object.keys(values).forEach(key => { propsSnapshot_[key] = String(values[key]); });
}

function deleteProp_(key) {
  props_().deleteProperty(key);
  if (propsSnapshot_) delete propsSnapshot_[key];
}

// 本機測試用：假環境的每一次呼叫等於一次新的執行，要從乾淨的狀態開始。
function resetExecution_() {
  propsSnapshot_ = null;
}

function activeEmail_() {
  return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

function isTeacher_(email) {
  if (!sidFromEmail_(email)) return false;
  const owner = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  const configured = (prop_('TEACHER_EMAILS') || '').split(',')
    .map(item => item.trim().toLowerCase());
  return email === owner || configured.includes(email);
}

function requireTeacher_() {
  const email = activeEmail_();
  if (!isTeacher_(email)) throw new Error(bi_('只有老師可以使用這項功能。', 'Only teachers can use this.'));
  return email;
}

function locked_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error(bi_('系統忙線，請再試一次。', 'The system is busy. Please try again.'));
  }
  staleProps_();
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}

function cacheGet_(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    return null;
  }
}

function cachePut_(key, value, seconds = 21600) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), seconds);
  } catch (err) {
    // Cache is an optimization. The source remains available on a cache miss.
  }
}

// 一次往返拿好幾個快取值（學生簽到那條路每省一次往返約 0.02–0.05 秒）。拿不到的鍵不會出現在結果裡。
function cacheGetAll_(keys) {
  const found = {};
  try {
    const values = CacheService.getScriptCache().getAll(keys);
    Object.keys(values).forEach(key => { found[key] = JSON.parse(values[key]); });
  } catch (err) {
    // 快取讀不到就當成都沒有，後面各自回到原始資料。
  }
  return found;
}

function coursesInFolder_(id, refresh) {
  const key = 'courses_' + id;
  if (!refresh) {
    const cached = cacheGet_(key);
    if (cached) return cached;
  }
  const files = DriveApp.getFolderById(id).getFilesByType(MimeType.GOOGLE_SHEETS);
  const courses = [];
  while (files.hasNext()) {
    const file = files.next();
    courses.push({ id: file.getId(), name: file.getName() });
  }
  cachePut_(key, courses);
  return courses;
}

function courseCatalog_() {
  const folders = [prop_('GRADE_FOLDER_ID'), prop_('DEMO_GRADE_FOLDER_ID')].filter(Boolean);
  const courses = new Map();
  let folderError = '';
  new Set(folders).forEach(id => {
    try {
      coursesInFolder_(id).forEach(course => courses.set(course.id, course));
    } catch (err) {
      folderError = bi_('無法讀取成績簿資料夾，請確認部署者有存取權限。',
        'Can’t read the gradebook folder. Make sure the deploying account has access.');
    }
  });
  return { courses: Array.from(courses.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW')), folderError };
}

function options_(opts) {
  const settings = Object.assign({}, DEFAULT_OPTIONS_, opts);
  const { durationMin, rotateSec, lateAfterMin } = settings;
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 180) {
    throw new Error(bi_('開放時間請輸入 1 到 180 分鐘。', 'Open time must be 1 to 180 minutes.'));
  }
  if (![0, 20, 60].includes(rotateSec)) {
    throw new Error(bi_('請選擇 QR 的輪換秒數。', 'Choose how often the QR refreshes.'));
  }
  if (!Number.isSafeInteger(lateAfterMin) || lateAfterMin < 0) {
    throw new Error(bi_('遲到分鐘數請輸入非負整數。', 'Late-after minutes must be 0 or a positive whole number.'));
  }
  return { durationMin, rotateSec, lateAfterMin };
}

function readOptions_() {
  const saved = prop_('rollcall_options');
  return saved ? options_(JSON.parse(saved)) : Object.assign({}, DEFAULT_OPTIONS_);
}

function idList_(key) {
  return JSON.parse(prop_(key) || '[]');
}

function readSession_(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) return null;
  const raw = prop_('sess_' + id);
  return raw ? JSON.parse(raw) : null;
}

function storeSession_(session, extra) {
  setProps_(Object.assign({ ['sess_' + session.id]: JSON.stringify(session) }, extra || {}));
}

function requiredSession_(id) {
  const session = readSession_(id);
  if (!session) throw new Error(bi_('找不到這場點名。', 'Roll call not found.'));
  return session;
}

function openSessions_() {
  return idList_('open_ids').map(id => readSession_(id)).filter(s => s && s.status === 'open');
}

function recentSessions_() {
  return idList_('recent_ids').map(id => readSession_(id)).filter(s => s && s.status === 'closed');
}

function logBook_(create) {
  const id = prop_('LOG_SHEET_ID');
  if (id) {
    try {
      const book = SpreadsheetApp.openById(id);
      // 垃圾桶檢查要多打一次雲端硬碟，只在開場與建表（create）時做；學生簽到那條路每次都會來這裡，不能多這一趟。
      if (!create || !DriveApp.getFileById(id).isTrashed()) return book;
    } catch (err) {
      if (!create) throw err;
    }
  }
  if (!create) throw new Error(bi_('點名紀錄尚未建立。', 'The roll-call log has not been created yet.'));
  const book = SpreadsheetApp.create('課堂點名紀錄（點名網頁資料）');
  book.setSpreadsheetTimeZone('Asia/Taipei');
  Object.keys(LOG_HEADERS_).forEach((name, i) => {
    const sheet = i === 0 ? book.getSheets()[0].setName(name) : book.insertSheet(name);
    sheet.appendRow(LOG_HEADERS_[name]);
    sheet.setFrozenRows(1);
  });
  SpreadsheetApp.flush();
  setProps_({ LOG_SHEET_ID: book.getId() });
  return book;
}

function sessionLogBook_(session) {
  const book = logBook_(false);
  // Sessions created before this field was added can still verify their summary row.
  const matches = session.logBookId ? session.logBookId === book.getId()
    : book.getSheetByName('場次').getRange(session.logStartRow, 1).getValue() === session.id;
  if (!matches) {
    throw gradeWriteError_(bi_('這場的點名紀錄試算表已更換，請先核對原本的紀錄。',
      'The roll-call log for this session has been replaced. Check the original log first.'));
  }
  return book;
}

function sessionLogRow_(session) {
  const note = [session.warning, session.error, session.liveError].filter(Boolean).map(zhOnly_).join(' ');
  return [
    session.id, safeCell_(session.bookName), session.bookId, session.date, new Date(session.openedAtMs),
    new Date(session.closesAtMs), session.rotateSec, session.lateAfterMin, session.status,
    session.rosterCount, session.presentCount || 0, session.written, safeCell_(note),
  ];
}

function updateSessionLog_(session) {
  const sheet = logBook_(false).getSheetByName('場次');
  const row = sessionLogRow_(session);
  if (sheet.getRange(session.logStartRow, 1).getValue() !== session.id) {
    throw new Error(bi_('場次紀錄已移動，請先檢查點名紀錄。', 'The session row has moved. Check the roll-call log first.'));
  }
  sheet.getRange(session.logStartRow, 1, 1, row.length).setValues([row]);
  SpreadsheetApp.flush();
}

function finishSessionUpdate_(session) {
  session.logPending = true;
  storeSession_(session);
  try {
    updateSessionLog_(session);
    delete session.logPending;
    storeSession_(session);
  } catch (err) {
    // The authoritative result survives, and the next teacher boot retries the log summary.
    session.logPending = true;
  }
}

function readGrade_(bookId, date) {
  const sheet = SpreadsheetApp.openById(bookId).getSheetByName('點名');
  if (!sheet) throw new Error(bi_('成績簿缺少「點名」分頁。', 'The gradebook has no "點名" (roll call) tab.'));
  const all = sheet.getDataRange().getValues();
  const header = all[0] || [];
  if (String(header[0]).trim() !== '學號' || String(header[1]).trim() !== '姓名') {
    throw new Error(bi_('「點名」分頁前兩欄必須是「學號」和「姓名」。',
      'The first two columns of the "點名" tab must be "學號" (student ID) and "姓名" (name).'));
  }
  const rows = all.slice(1);
  const col = findDateColumn_(header, date);
  if (col >= 0 && rows.length) {
    // A formula returning an empty string still occupies the cell.
    const formulas = sheet.getRange(2, col + 1, rows.length, 1).getFormulas();
    formulas.forEach(([formula], row) => {
      if (formula) rows[row][col] = formula;
    });
  }
  return { sheet, header, rows, col };
}

function rosterFor_(session, fresh) {
  const key = 'roster_' + session.id;
  const saved = fresh ? null : cacheGet_(key);
  if (saved) return saved;
  const roster = rosterFromRows_(readGrade_(session.bookId, session.date).rows).list;
  cacheRoster_(session, roster);
  return roster;
}

// 場次開著時名冊快取放久一點（背景同步每次都會換成最新的）；結束後只留 10 分鐘，
// 老師下課後在成績簿加人、改學號，最慢 10 分鐘後老師頁就看得到（立霧複驗 2026-11-24）。
function cacheRoster_(session, roster) {
  cachePut_('roster_' + session.id, roster, session.status === 'open' ? 21600 : 600);
}

function readCheckins_(session, book = logBook_(false)) {
  const sheet = book.getSheetByName('簽到');
  const start = session.checkinStartRow || 2;
  const rows = sheet.getLastRow() - start + 1;
  if (rows < 1) return [];
  return sheet.getRange(start, 1, rows, LOG_HEADERS_['簽到'].length).getValues()
    .filter(row => row[1] === session.id)
    .map(row => ({ timeMs: new Date(row[0]).getTime(), sid: normSid_(row[4]), status: row[6], source: row[7] }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

function topUpRows_(grade, plan, present) {
  const roster = rosterFromRows_(grade.rows).list;
  if (plan.kind === 'fill') {
    return roster.filter(person => hasAttendance_(present, person.sid)).map(person => person.row);
  }
  const firstRows = new Set(roster.map(person => person.row));
  return (plan.upgrades || []).filter(person => firstRows.has(person.row)).map(person => person.row);
}

function writeTopUp_(session, grade, present) {
  const placement = planColumnWrite_(grade.header, grade.rows, session.date, present);
  if (placement.kind === 'missing') {
    throw gradeWriteError_(bi_('成績簿的日期欄已變更。', 'The date column in the gradebook has changed.'));
  }
  const rows = topUpRows_(grade, placement, present);
  writeGradeColumn_(session, grade, rows.map(row => ({ row, value: 1 })), 'topUp');
}

function sessionRecords_(session) {
  return { roster: rosterFor_(session), checkins: readCheckins_(session) };
}

function appendCheckin_(sheet, session, sid, name, status, source, now) {
  sheet.appendRow([
    new Date(now), session.id, safeCell_(session.bookName), session.date,
    safeCell_(sid), safeCell_(name), status, source,
  ]);
}

function hmac_(message, secret) {
  return Utilities.computeHmacSha256Signature(message, secret);
}

function sessionView_(s, count) {
  const now = Date.now();
  const open = sessionPhase_(s, now) === 'open';
  const code = open ? codeFor_(s, windowIndex_(now, s.openedAtMs, s.rotateSec), hmac_) : '';
  // QR 用通用網址：帶網域的網址遇到非東華帳號會被 Google 擋在外面，學生看不到我們的說明。
  const base = publicUrls_(serviceUrl_()).generic;
  const join = base.includes('?') ? '&' : '?';
  let presentCount = count;
  // 有簽到還沒寫進成績簿：老師頁看到這個旗標就在背景呼叫 syncLive。
  let syncPending = false;
  if (presentCount === undefined) {
    presentCount = s.presentCount || 0;
    if (s.status === 'open') {
      const { roster, checkins } = sessionRecords_(s);
      const present = presentSet_(checkins);
      presentCount = summary_(roster, present).present;
      syncPending = Boolean(s.live) && !s.liveStopped && open &&
        liveSignature_(roster, present, cancelledSids_(checkins)) !== s.liveSig;
    }
  }
  return {
    id: s.id, bookId: s.bookId, bookName: s.bookName, date: s.date,
    openedAtMs: s.openedAtMs, closesAtMs: s.closesAtMs, serverNowMs: now,
    rotateSec: s.rotateSec, lateAfterMin: s.lateAfterMin, code,
    qrUrl: open && base ? base + join + 's=' + encodeURIComponent(s.id) + '&k=' + encodeURIComponent(code) : '',
    status: s.status, written: s.written, rosterCount: s.rosterCount, presentCount,
    upgradeCount: s.upgradeCount || 0, warning: s.warning || '', mismatches: s.mismatches || [],
    live: Boolean(s.live), syncPending, liveSynced: s.liveSynced || 0, liveError: s.liveError || '',
    liveBlocked: s.liveBlocked || 0, keptManual: s.keptManual || 0,
    error: [s.error, s.logPending && bi_('場次摘要待同步到點名紀錄。',
      'The session summary is waiting to sync to the roll-call log.')].filter(Boolean).join('\n'),
  };
}

function serviceUrl_() {
  const url = prop_('PUBLIC_URL') || ScriptApp.getService().getUrl() || '';
  return url.split('#')[0];
}

function switchUrl_(params) {
  const base = publicUrls_(serviceUrl_()).domain;
  // 只帶回格式單純的 s、k，不讓人用這顆按鈕組出別的網址。
  const query = ['s', 'k']
    .filter(key => typeof params[key] === 'string' && /^[\w-]{1,100}$/.test(params[key]))
    .map(key => key + '=' + encodeURIComponent(params[key])).join('&');
  return query ? base + (base.includes('?') ? '&' : '?') + query : base;
}

function studentResult_(kind, details) {
  const messages = {
    manual: '請輸入投影幕上的 6 碼。',
    unauthorized: '請改用東華 Google 帳號登入。',
    closed: '這場點名已經結束。',
    wrong: 'QR 過期了，請重新掃投影幕上的 QR，或輸入目前顯示的 6 碼。',
    duplicate: '你已經簽到了。',
    cancelled: '老師已將你這堂改為未到，請當面找老師。',
    notInRoster: '你不在這門課的名冊上，已記下來，請下課找老師。',
    success: '簽到成功',
    busy: '系統忙線，請再掃一次。',
    teacherTest: '老師測試：QR 有效，不記錄。',
    rateLimited: '輸入錯誤超過 10 次，請 10 分鐘後再試。',
    ambiguous: '這組碼符合不只一場點名，請掃你這堂課的 QR。',
    error: '簽到暫時無法處理，請重試或找老師。',
  };
  return Object.assign({ kind, message: messages[kind] }, details || {});
}

function studentRequest_(request) {
  try {
    return request();
  } catch (err) {
    return studentResult_('error');
  }
}

function closedResult_(session) {
  return studentResult_('closed', session ? {
    closesAtMs: session.closesAtMs,
    closeTime: taipeiTime_(session.closesAtMs),
  } : {});
}

function checkInForSession_(email, id, code) {
  const sid = sidFromEmail_(email);
  if (!sid) return studentResult_('unauthorized');

  const session = readSession_(id);
  const now = Date.now();
  if (!session || sessionPhase_(session, now) !== 'open') return closedResult_(session);
  if (!checkCode_(code, session, now, hmac_).ok) {
    return studentResult_(recordWrongCode_(id, sid) ? 'rateLimited' : 'wrong');
  }
  return recordStudentCheckin_(session, email, sid, 'QR');
}

function recordStudentCheckin_(session, email, sid, source) {
  const key = checkinCacheKey_(session.id, sid);
  const wrongKey = wrongCodeKey_(session.id, sid);
  const rosterKey = 'roster_' + session.id;
  // 打錯次數、有沒有簽過、名冊：三個快取一次拿（原本分三次往返）。
  const cached = cacheGetAll_([wrongKey, key, rosterKey]);
  if ((cached[wrongKey] || 0) > 10) return studentResult_('rateLimited');
  const remembered = cached[key];
  const details = { bookName: session.bookName, date: session.date };
  if (remembered === 'cancelled') return studentResult_('cancelled');
  if (typeof remembered === 'number') {
    return studentResult_('duplicate', Object.assign(details, { time: taipeiTime_(remembered) }));
  }
  if (remembered === 'notInRoster') {
    return studentResult_(isTeacher_(email) ? 'teacherTest' : 'notInRoster');
  }
  const roster = Array.isArray(cached[rosterKey]) ? cached[rosterKey] : rosterFor_(session);
  const student = roster.find(person => person.sid === sid);
  if (!student && isTeacher_(email)) return studentResult_('teacherTest');

  const sheet = sessionLogBook_(session).getSheetByName('簽到');
  // Check the authoritative state after resolving the roster and opening the log.
  staleProps_();
  const fresh = readSession_(session.id);
  const checkedAt = Date.now();
  if (!fresh || sessionPhase_(fresh, checkedAt) !== 'open') return closedResult_(fresh);
  const status = student ? arrivalStatus_(fresh, checkedAt) : '不在名冊';
  appendCheckin_(sheet, fresh, sid, student ? student.name : '', status, source, checkedAt);

  if (!student) {
    cachePut_(key, 'notInRoster');
    return studentResult_('notInRoster');
  }
  if (!rememberFirstCheckin_(key, checkedAt)) return studentResult_('cancelled');
  return studentResult_('success', Object.assign(details, {
    time: taipeiTime_(checkedAt), sid, name: student.name, status,
  }));
}

function checkinCacheKey_(id, sid) {
  return 'checkin_' + id + ':' + sid;
}

function rememberFirstCheckin_(key, timeMs, teacherRestored = false) {
  const first = cacheGet_(key);
  if (first === 'cancelled' && !teacherRestored) return false;
  if (typeof first !== 'number' || timeMs < first) cachePut_(key, timeMs);
  return true;
}

function wrongCodeKey_(id, sid) {
  return 'wrong_code_' + id + ':' + sid;
}

function wrongCodeCount_(id, sid) {
  return cacheGet_(wrongCodeKey_(id, sid)) || 0;
}

function recordWrongCode_(id, sid) {
  const count = wrongCodeCount_(id, sid);
  if (count > 10) return true;
  cachePut_(wrongCodeKey_(id, sid), count + 1, WRONG_CODE_TTL_SEC_);
  return count + 1 > 10;
}

function closeSessionLocked_(session) {
  if (session.status !== 'open') {
    if (session.logPending) finishSessionUpdate_(session);
    return sessionView_(session);
  }
  session.status = 'closed';
  session.closesAtMs = Math.min(session.closesAtMs, Date.now());
  const open = idList_('open_ids').filter(id => id !== session.id);
  const recent = [session.id].concat(idList_('recent_ids').filter(id => id !== session.id));
  writeAttempt_(session, () => {
    Utilities.sleep(2500);
    const grade = readGrade_(session.bookId, session.date);
    const log = sessionLogBook_(session);
    const checkins = readCheckins_(session, log);
    const present = presentSet_(checkins);
    const roster = rosterFromRows_(grade.rows).list;
    cacheRoster_(session, roster);
    const counts = summary_(roster, present);
    session.rosterCount = counts.total;
    session.presentCount = counts.present;
    const plan = planColumnWrite_(grade.header, grade.rows, session.date, present);
    session.upgradeCount = 0;
    session.keptManual = 0;
    // 即時寫入的場次：這一欄上已經有我們自己寫的 1（與老師取消的 0），不算「已經有資料」。
    const ownColumn = plan.kind === 'occupied' && session.live;
    if (plan.kind !== 'fill' && !ownColumn) {
      session.written = plan.kind;
      if (plan.kind === 'occupied') session.upgradeCount = topUpRows_(grade, plan, present).length;
      return '';
    }

    let blocked = [];
    if (ownColumn) {
      // 把這一欄補完整：出席 1、老師取消 0、其餘空白補 0；老師自己在試算表填的 1 與其他內容不動。
      const final = liveChanges_(grade.rows, grade.col, roster, present, cancelledSids_(checkins), true);
      writeGradeColumn_(session, grade, final.changes, 'live');
      session.keptManual = final.kept;
      session.liveSynced = final.ones;
      blocked = final.blocked;
    } else {
      const changes = roster.map(({ row }) => ({ row, value: plan.values[row][0] }));
      writeGradeColumn_(session, grade, changes, 'fill');
    }
    const latest = presentSet_(readCheckins_(session, log));
    session.presentCount = summary_(roster, latest).present;
    const arrivals = Object.fromEntries(Object.entries(latest).filter(([sid]) => !hasAttendance_(present, sid)));
    if (roster.some(({ sid }) => hasAttendance_(arrivals, sid))) {
      const current = readGrade_(session.bookId, session.date);
      if (current.col !== grade.col) {
        throw gradeWriteError_(bi_('成績簿的日期欄已變更，已停止補收。',
          'The date column in the gradebook has changed. Late check-ins were not added.'));
      }
      writeTopUp_(session, current, arrivals);
    }
    session.written = 'filled';
    if (!blocked.length) return '';
    session.mismatches = blocked.map(row => row + 2);
    return bi_('這一欄有 ' + blocked.length + ' 格已經是別的內容，沒有覆蓋，請核對。',
      blocked.length + ' cell(s) in this column already held other content and were left as is. Please check.');
  }, { open_ids: JSON.stringify(open), recent_ids: JSON.stringify(recent.slice(0, 12)) });
  finishSessionUpdate_(session);
  recent.slice(12).forEach(id => deleteProp_('sess_' + id));
  return sessionView_(session);
}

function writeAttempt_(session, work, extra) {
  // Persist a conservative outcome before touching the gradebook. Retrying an interrupted
  // execution never assumes that its write did or did not reach Google Sheets.
  session.written = 'error';
  session.error = bi_('寫入作業中斷，請檢查成績簿與寫入備份。',
    'The write was interrupted. Check the gradebook and the write backup.');
  session.mismatches = [];
  session.logPending = true;
  storeSession_(session, extra);
  try {
    // work 可以回傳一句「寫完了，但有幾格要老師看一下」的提醒。
    session.error = work() || '';
  } catch (err) {
    if (err.rollcallWrite) session.error = err.message;
    else {
      session.error = bi_('寫入成績簿時發生錯誤，請檢查成績簿與寫入備份。',
        'Something went wrong while writing the gradebook. Check the gradebook and the write backup.');
    }
  }
}

function gradeWriteError_(message) {
  const error = new Error(message);
  error.rollcallWrite = true;
  return error;
}

function writeGradeColumn_(session, grade, changes, mode) {
  if (!changes.length) return;
  const { sheet, col, rows } = grade;
  if (col < 2) throw gradeWriteError_(bi_('找不到唯一的日期欄。', 'Can’t find a single column for this date.'));
  const oldValues = rows.map(row => [row[col] == null ? '' : row[col]]);
  const expected = oldValues.map(row => row.slice());
  changes.forEach(change => { expected[change.row][0] = change.value; });

  const backup = logBook_(false).getSheetByName('寫入備份');
  const backupRow = backup.getLastRow() + 1;
  backup.appendRow([
    new Date(), session.id, session.bookId, session.date,
    JSON.stringify(oldValues), JSON.stringify(expected), '待回讀',
  ]);
  SpreadsheetApp.flush();

  try {
    // 寫入前把整張「點名」分頁再讀一次（兩次往返：值、這一欄的公式），
    // 確認表頭、名冊、要寫的格子都跟剛才算的時候一樣。原本分七次讀，慢了約半秒。
    const fresh = sheet.getDataRange().getValues();
    const formulas = sheet.getRange(1, col + 1, fresh.length, 1).getFormulas();
    if (formulas[0][0] || findDateColumn_(fresh[0] || [], session.date) !== col) {
      throw gradeWriteError_(bi_('找不到原本那一欄的唯一日期表頭，或表頭含公式，已停止寫入。',
        'The date header for this column is no longer unique, or it contains a formula. Nothing was written.'));
    }
    if (fresh.length !== rows.length + 1) {
      throw gradeWriteError_(bi_('寫入前發現成績簿列數變更，已停止寫入。',
        'The number of rows in the gradebook changed. Nothing was written.'));
    }
    const currentValues = rows.map((_, row) => [formulas[row + 1][0] || fresh[row + 1][col]]);
    const checkedRows = mode === 'fill' ? rows.map((_, index) => index) : changes.map(({ row }) => row);
    const changed = checkedRows.filter(row => {
      const current = currentValues[row][0];
      return normSid_(fresh[row + 1][0]) !== normSid_(rows[row][0]) ||
        comparableWriteCell_(current) !== comparableWriteCell_(oldValues[row][0]) ||
        (mode === 'topUp' && !isTopUpTarget_(current)) ||
        ((mode === 'mark' || mode === 'live') && cellState_(current) === 'other');
    });
    if (changed.length) {
      session.mismatches = changed.map(row => row + 2);
      throw gradeWriteError_(bi_('寫入前發現成績簿名冊或日期欄資料變更，已停止寫入。',
        'The gradebook roster or the date column changed before writing. Nothing was written.'));
    }

    writeRuns_(sheet, col, changes);
    SpreadsheetApp.flush();
    const actual = readColumn_(sheet, col, rows.length);
    const verified = verifyColumn_(expected.map(cells => cells.map(comparableWriteCell_)),
      actual.map(cells => cells.map(comparableWriteCell_)));
    session.mismatches = verified.mismatches.map(row => row + 2);
    if (!verified.ok) {
      throw gradeWriteError_(bi_('成績簿回讀不符，請查看標示的列。',
        'The gradebook did not read back as written. Check the rows listed.'));
    }
    // 這一格跟著執行結束一起送出，不另外強制送出（省一次往返）。
    backup.getRange(backupRow, 7).setValue('相符');
  } catch (err) {
    const result = err.rollcallWrite ? zhOnly_(err.message) : '讀寫時發生錯誤，請檢查成績簿。';
    const lines = session.mismatches.length ? ' 不符列 ' + session.mismatches.join('、') : '';
    backup.getRange(backupRow, 7).setValue(result + lines);
    SpreadsheetApp.flush();
    throw err;
  }
}

function comparableWriteCell_(value) {
  return value instanceof Date ? value.getTime() : value;
}

function readColumn_(sheet, col, count) {
  const range = sheet.getRange(2, col + 1, count, 1);
  const values = range.getValues();
  range.getFormulas().forEach(([formula], row) => {
    if (formula) values[row][0] = formula;
  });
  return values;
}

function isTopUpTarget_(value) {
  return value == null || value === 0 || value === '0' || (typeof value === 'string' && !value.trim());
}

function writeRuns_(sheet, col, changes) {
  let start = changes[0].row;
  let values = [];
  changes.forEach(({ row, value }) => {
    if (row !== start + values.length) {
      sheet.getRange(start + 2, col + 1, values.length, 1).setValues(values);
      start = row;
      values = [];
    }
    values.push([value]);
  });
  sheet.getRange(start + 2, col + 1, values.length, 1).setValues(values);
}
