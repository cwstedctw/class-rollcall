// 在 Node.js 執行原本的 Apps Script，所有假資料都留在記憶體。
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
export const TEACHER = 'teacher@gms.ndhu.edu.tw';
export const mail = (sid) => `${String(sid).toLowerCase()}@gms.ndhu.edu.tw`;

function isFormula(value) {
  return typeof value === 'string' && value.startsWith('=');
}

function makeRange(sheet, row, column, height, width) {
  if (![row, column, height, width].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('範圍的起點與尺寸必須是正整數');
  }
  function readCells(transform) {
    return Array.from({ length: height }, (_, r) =>
      Array.from({ length: width }, (_, c) =>
        transform(sheet.data[row + r - 1]?.[column + c - 1] ?? '')));
  }
  const range = {
    getValue: () => range.getValues()[0][0],
    getValues: () => readCells((value) => value instanceof Date ? new Date(value) : value),
    getDisplayValue: () => range.getDisplayValues()[0][0],
    getDisplayValues: () => readCells(String),
    getFormula: () => range.getFormulas()[0][0],
    getFormulas: () => readCells((value) => isFormula(value) ? value : ''),
    setValue(value) {
      return range.setValues([[value]]);
    },
    setValues(values) {
      if (values.length !== height || values.some((cells) => cells.length !== width)) {
        throw new Error('setValues 的資料尺寸與範圍不合');
      }
      values.forEach((cells, r) => {
        const target = sheet.data[row + r - 1] ??= [];
        cells.forEach((value, c) => {
          target[column + c - 1] = value instanceof Date ? new Date(value) : (value ?? '');
        });
      });
      return range;
    },
    clearContent() {
      return range.setValues(Array.from({ length: height }, () => Array(width).fill('')));
    },
    setNumberFormat: () => range,
  };
  return range;
}

function makeSheet(initialName, id) {
  let name = initialName;
  const sheet = {
    data: [],
    frozen: 0,
    getSheetId: () => id,
    getName: () => name,
    setName(value) {
      name = String(value);
      return sheet;
    },
    setFrozenRows(value) {
      sheet.frozen = value;
    },
    getLastRow() {
      return sheet.data.findLastIndex((row) => row?.some((cell) => cell != null && cell !== '')) + 1;
    },
    getLastColumn() {
      return sheet.data.reduce((last, row) => {
        const index = row?.findLastIndex((cell) => cell != null && cell !== '') ?? -1;
        return Math.max(last, index + 1);
      }, 0);
    },
    getRange: (row, column, height = 1, width = 1) => makeRange(sheet, row, column, height, width),
    getDataRange: () => sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), Math.max(sheet.getLastColumn(), 1)),
    appendRow(values) {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, values.length).setValues([values]);
      return sheet;
    },
  };
  return sheet;
}

function makeSpreadsheet(id, name) {
  let sequence = 0;
  let timeZone = 'Asia/Taipei';
  const tabs = [makeSheet('Sheet1', sequence++)];
  const book = {
    id, name, tabs,
    getId: () => id,
    getName: () => name,
    getUrl: () => `http://local.invalid/spreadsheets/d/${id}/edit`,
    getSpreadsheetTimeZone: () => timeZone,
    setSpreadsheetTimeZone(value) {
      timeZone = value;
      return book;
    },
    getSheets: () => tabs.slice(),
    getSheetByName: (name) => tabs.find((sheet) => sheet.getName() === name) ?? null,
    insertSheet(name) {
      if (book.getSheetByName(name)) throw new Error(`分頁已存在：${name}`);
      const sheet = makeSheet(name, sequence++);
      tabs.push(sheet);
      return sheet;
    },
    deleteSheet(sheet) {
      const index = tabs.indexOf(sheet);
      if (index >= 0) tabs.splice(index, 1);
    },
  };
  return book;
}

function iterator(values) {
  const entries = [...values];
  let index = 0;
  return {
    hasNext: () => index < entries.length,
    next() {
      if (index >= entries.length) throw new Error('已讀完清單');
      return entries[index++];
    },
  };
}

function escapeHtml(value) {
  const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => escapes[character]);
}

function makeOutput(content) {
  const output = {
    getContent: () => content,
    setTitle: () => output,
    addMetaTag: () => output,
    setXFrameOptionsMode: () => output,
  };
  return output;
}

function fileContent(name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error('HTML 檔名格式錯誤');
  return readFileSync(resolve(APP_DIR, `${name}.html`), 'utf8');
}

function makeTemplate(context, name) {
  const source = fileContent(name);
  const parts = [];
  let offset = 0;
  for (const match of source.matchAll(/<\?(!?=)?\s*([\s\S]*?)\?>/g)) {
    parts.push(`output.push(${JSON.stringify(source.slice(offset, match.index))});`);
    const [, mode, expression] = match;
    if (mode === '=') parts.push(`output.push(escapeValue(${expression}));`);
    else if (mode === '!=') parts.push(`output.push(${expression});`);
    else parts.push(expression);
    offset = match.index + match[0].length;
  }
  parts.push(`output.push(${JSON.stringify(source.slice(offset))});`);
  const render = vm.runInContext(`(function (vars, escapeValue) {
    const output = [];
    with (vars) { ${parts.join('\n')} }
    return output.join('');
  })`, context, { filename: `${name}.html` });
  return {
    evaluate() {
      const { evaluate, ...variables } = this;
      return makeOutput(render(variables, escapeHtml));
    },
  };
}

function formatDate(date, timeZone, format) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const keys = { yyyy: 'year', MM: 'month', dd: 'day', HH: 'hour', mm: 'minute', ss: 'second' };
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => fields[keys[token]]);
}

export function makeGas({ nowMs, serviceUrl = 'http://127.0.0.1:8918/', effectiveUser = TEACHER } = {}) {
  const props = new Map();
  const books = new Map();
  const folders = new Map();
  const files = new Map();
  const cache = new Map();
  const mimeType = 'application/vnd.google-apps.spreadsheet';
  let bookSequence = 0;
  let folderSequence = 0;
  let user = '';
  let lockAvailable = true;
  let lockOwner;
  let currentTime = nowMs;
  let clockOffsetMs = 0;
  const now = () => currentTime ?? Date.now() + clockOffsetMs;

  // 共用 Date.prototype，讓試算表傳回的日期也能在 VM 裡用 instanceof Date。
  function GasDate(...args) {
    if (new.target) return args.length ? new Date(...args) : new Date(now());
    return new Date(now()).toString();
  }
  Object.setPrototypeOf(GasDate, Date);
  GasDate.prototype = Date.prototype;
  GasDate.now = now;

  function createFolder(id, name = id) {
    if (folders.has(id)) throw new Error(`資料夾已存在：${id}`);
    const contents = new Set();
    const folder = {
      getId: () => id,
      getName: () => name,
      getFiles: () => iterator(contents),
      getFilesByType: (type) => iterator([...contents].filter((file) => file.getMimeType() === type)),
      addFile(file) {
        contents.add(file);
        return folder;
      },
      removeFile(file) {
        contents.delete(file);
        return folder;
      },
    };
    folders.set(id, folder);
    return folder;
  }

  function createBook(name) {
    const id = `FAKE_GRADE_BOOK_${++bookSequence}`;
    const book = makeSpreadsheet(id, name);
    books.set(id, book);
    let parent;
    let trashed = false;
    const file = {
      getId: book.getId,
      getName: book.getName,
      getMimeType: () => mimeType,
      isTrashed: () => trashed,
      setTrashed(value) {
        trashed = Boolean(value);
        return file;
      },
      moveTo(folder) {
        if (parent) parent.removeFile(file);
        parent = folder.addFile(file);
        return file;
      },
    };
    files.set(id, file);
    return book;
  }

  function lookup(map, id, type) {
    if (!map.has(id)) throw new Error(`找不到${type}：${id}`);
    return map.get(id);
  }

  function getLock() {
    const lock = {
      tryLock() {
        if (!lockAvailable || (lockOwner && lockOwner !== lock)) return false;
        lockOwner = lock;
        return true;
      },
      waitLock() {
        if (!lock.tryLock()) throw new Error('系統忙線，請稍後再試');
      },
      hasLock: () => lockOwner === lock,
      releaseLock() {
        if (lock.hasLock()) lockOwner = undefined;
      },
    };
    return lock;
  }

  const store = {
    getProperty: (key) => props.get(key) ?? null,
    getProperties: () => Object.fromEntries(props),
    setProperty(key, value) {
      props.set(key, String(value));
      return store;
    },
    setProperties(values, replace = false) {
      if (replace) props.clear();
      Object.entries(values).forEach(([key, value]) => store.setProperty(key, value));
      return store;
    },
    deleteProperty(key) {
      props.delete(key);
      return store;
    },
    deleteAllProperties() {
      props.clear();
      return store;
    },
  };

  const scriptCache = {
    get(key) {
      const entry = cache.get(key);
      if (entry && entry.expiresAt > now()) return entry.value;
      cache.delete(key);
      return null;
    },
    put(key, value, seconds = 600) {
      cache.set(key, { value: String(value), expiresAt: now() + seconds * 1000 });
    },
    remove: (key) => cache.delete(key),
  };

  const context = vm.createContext({
    Date: GasDate,
    SpreadsheetApp: {
      create: createBook,
      openById: (id) => lookup(books, id, '試算表'),
      flush() {},
    },
    DriveApp: {
      createFolder: (name) => createFolder(`FAKE_GRADE_FOLDER_${++folderSequence}`, name),
      getFolderById: (id) => lookup(folders, id, '資料夾'),
      getFileById: (id) => lookup(files, id, '檔案'),
    },
    MimeType: { GOOGLE_SHEETS: mimeType },
    PropertiesService: { getScriptProperties: () => store },
    CacheService: { getScriptCache: () => scriptCache },
    LockService: { getScriptLock: getLock },
    Session: {
      getActiveUser: () => ({ getEmail: () => user }),
      getEffectiveUser: () => ({ getEmail: () => effectiveUser }),
      getScriptTimeZone: () => 'Asia/Taipei',
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      computeHmacSha256Signature(message, key) {
        const bytes = createHmac('sha256', key).update(message).digest();
        return Array.from(bytes, (value) => value > 127 ? value - 256 : value);
      },
      getUuid: randomUUID,
      formatDate,
      sleep(ms) {
        if (currentTime == null) clockOffsetMs += ms;
        else currentTime += ms;
      },
    },
    ScriptApp: { getService: () => ({ getUrl: () => serviceUrl }) },
    HtmlService: {
      createHtmlOutputFromFile: (name) => makeOutput(fileContent(name)),
      createTemplateFromFile: (name) => makeTemplate(context, name),
      createHtmlOutput: makeOutput,
    },
    console,
  });

  for (const filename of ['Logic.gs', 'Code.gs']) {
    vm.runInContext(readFileSync(resolve(APP_DIR, filename), 'utf8'), context, { filename });
  }
  return {
    ctx: context, props, books, cache,
    now,
    setNow(ms) {
      if (!Number.isFinite(ms)) throw new Error('測試時間必須是毫秒數');
      currentTime = ms;
    },
    advance(ms) {
      this.setNow(now() + ms);
    },
    setLockAvailable(available) {
      lockAvailable = Boolean(available);
    },
    createFolder,
    as(email) {
      user = email;
      return this;
    },
    call(name, ...args) {
      if (typeof context[name] !== 'function') throw new Error(`找不到 Apps Script 函式：${name}`);
      const result = context[name](...args);
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    },
    page(parameter = {}) {
      return context.doGet({ parameter }).getContent();
    },
    sheet(name, id = props.get('LOG_SHEET_ID')) {
      const sheet = lookup(books, id, '試算表').getSheetByName(name);
      if (!sheet) throw new Error(`找不到分頁：${name}`);
      return sheet.data;
    },
  };
}
