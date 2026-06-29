const KEKA_TIMEZONE = 'Asia/Kolkata';

function getTodayDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KEKA_TIMEZONE }).format(date);
}

function getAttendanceDateKey(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: KEKA_TIMEZONE }).format(parsed);
    }
  }
  return s.split('T')[0];
}

function formatAttendanceDisplayDate(dateKey) {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: KEKA_TIMEZONE
  });
  return `${d} ${monthLabel}`;
}

function formatTime12hIST(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: KEKA_TIMEZONE
  });
}

function matchesTodayEntry(entry, today = new Date()) {
  if (!entry) return false;

  const todayKey = getTodayDateKey(today);

  if (entry.attendanceDate) {
    return getAttendanceDateKey(entry.attendanceDate) === todayKey;
  }

  if (!entry.date) return false;

  const todayDay = Number(todayKey.split('-')[2]);
  const todayMonth = new Date(`${todayKey}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: KEKA_TIMEZONE
  }).toLowerCase();

  const dayFirst = entry.date.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (dayFirst) {
    return parseInt(dayFirst[1], 10) === todayDay &&
      dayFirst[2].toLowerCase() === todayMonth;
  }

  const monthFirst = entry.date.match(/([A-Za-z]{3})\s+(\d{1,2})/);
  if (monthFirst) {
    return parseInt(monthFirst[2], 10) === todayDay &&
      monthFirst[1].toLowerCase() === todayMonth;
  }

  return false;
}

function findTodayEntry(entries, today = new Date()) {
  if (!entries?.length) return null;
  return entries.find((entry) => matchesTodayEntry(entry, today)) || null;
}

/** Never trust stored todayDateKey — always match against current IST calendar day. */
function resolveTodayEntry(scrapedAttendance) {
  if (!scrapedAttendance?.entries?.length) return null;
  return findTodayEntry(scrapedAttendance.entries);
}

function attendanceHasToday(attendanceData) {
  if (!attendanceData?.entries?.length) return false;
  const todayKey = getTodayDateKey();
  if (attendanceData.todayEntry) {
    const entryKey = getAttendanceDateKey(attendanceData.todayEntry.attendanceDate);
    if (entryKey === todayKey) return true;
  }
  return !!findTodayEntry(attendanceData.entries);
}

function isStorageForToday(scrapedAttendance) {
  if (!scrapedAttendance) return false;
  const todayKey = getTodayDateKey();
  if (scrapedAttendance.todayDateKey && scrapedAttendance.todayDateKey !== todayKey) {
    return false;
  }
  const entry = resolveTodayEntry(scrapedAttendance);
  if (!entry) return false;
  const entryKey = getAttendanceDateKey(entry.attendanceDate);
  return entryKey === todayKey;
}

function buildAttendancePayload(entries) {
  const todayDateKey = getTodayDateKey();
  const todayEntry = findTodayEntry(entries);
  return {
    scrapedAt: new Date().toISOString(),
    source: 'API',
    todayDateKey,
    todayEntry,
    entries
  };
}
