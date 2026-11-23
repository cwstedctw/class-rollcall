import { TEACHER } from './gasfake.mjs';

const DAY_MS = 86_400_000;
export const ROSTER = Array.from({ length: 8 }, (_, index) => ({
  sid: `S${String(index + 1).padStart(7, '0')}`,
  name: `測試學生 ${index + 1}`,
}));

export function seed(gas) {
  const { DriveApp, SpreadsheetApp, Utilities } = gas.ctx;
  const folder = DriveApp.createFolder('點名網頁假成績簿');
  const book = SpreadsheetApp.create('假課程・課堂點名');
  const bookId = book.getId();
  const folderId = folder.getId();
  DriveApp.getFileById(bookId).moveTo(folder);

  const dates = [-DAY_MS, 0, DAY_MS].map((offset) =>
    Utilities.formatDate(new Date(gas.now() + offset), 'Asia/Taipei', 'yyyy-MM-dd'));
  const rows = [['學號', '姓名', ...dates, '點名']];
  ROSTER.forEach(({ sid, name }, index) => {
    const row = index + 2;
    rows.push([sid, name, '', '', '', `=SUM(C${row}:E${row})`]);
  });
  const rollcall = book.getSheets()[0].setName('點名');
  rollcall.getRange(1, 3, 1, dates.length).setNumberFormat('@');
  rollcall.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  rollcall.setFrozenRows(1);
  book.insertSheet('作業').appendRow(['假作業成績']).appendRow([87]);

  gas.as(TEACHER).call('setup');
  gas.call('saveGradeFolder', folderId);
  return { folderId, bookId, roster: ROSTER };
}
