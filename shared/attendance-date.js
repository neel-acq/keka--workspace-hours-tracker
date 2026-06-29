function getLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function matchesTodayEntry(entry, today = new Date()) {
  if (!entry) return false;

  if (entry.attendanceDate) {
    const key = String(entry.attendanceDate).split('T')[0];
    return key === getLocalDateKey(today);
  }

  if (!entry.date) return false;

  const todayDay = today.getDate();
  const todayMonth = today.toLocaleString('en-US', { month: 'short' }).toLowerCase();

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

function findTodayEntry(entries) {
  if (!entries?.length) return null;
  return entries.find((entry) => matchesTodayEntry(entry)) || null;
}
