const KEKA_TIMEZONE = 'Asia/Kolkata';

function getTodayDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KEKA_TIMEZONE }).format(date);
}

function getAttendanceDateKey(dateStr) {
  if (dateStr == null || dateStr === '') return null;

  if (typeof dateStr === 'number') {
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: KEKA_TIMEZONE }).format(parsed);
    }
    return null;
  }

  const s = String(dateStr).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const hasOffset = /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(s) || hasOffset) {
    const normalized = hasOffset ? s : `${s.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: KEKA_TIMEZONE }).format(parsed);
    }
  }

  return s.split('T')[0] || null;
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

/** Punch/shift instants — ISO components are IST wall clock (Keka office time). */
function parseKekaTimestamp(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const s = String(value).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (iso) {
    const parsed = new Date(`${iso[1]}T${iso[2]}+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseKekaDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d+)h\s*(\d+)m$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
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
