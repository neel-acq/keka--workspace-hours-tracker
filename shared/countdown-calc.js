// Shared countdown calculation module
// Single source of truth for target exit time, effective hours, break calculations.
// Used by both popup and background service worker.

/**
 * Parse a Keka swipe time string (e.g. "10:46:30 AM") into a Date object (today).
 * Replaces duplicated parseKekaTime / parseKekaTimeInBackground / parseKekaTimeStr.
 */
function parseSwipeTime(timeStr) {
    if (!timeStr || timeStr === 'MISSING') return null;

    const today = new Date();
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);

    if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseInt(timeMatch[3]);
        const period = timeMatch[4].toUpperCase();

        if (period === 'PM' && hours !== 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;

        today.setHours(hours, minutes, seconds, 0);
        return today;
    }

    return null;
}

/**
 * Calculate how many seconds of the 1 PM – 2 PM mandatory break window
 * overlap with "working" segments (IN→OUT or IN→now).
 */
function calcStrictBreakOverlap(validSwipes) {
    let overlapSeconds = 0;
    const segments = [];

    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseSwipeTime(swipe.time);
        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseSwipeTime(validSwipes[i + 1].time);
                if (outTime) segments.push({ start: swipeTime, end: outTime });
            }
        }
    }

    const lastSwipe = validSwipes[validSwipes.length - 1];
    if (lastSwipe && lastSwipe.type === 'IN') {
        const lastInTime = parseSwipeTime(lastSwipe.time);
        if (lastInTime) segments.push({ start: lastInTime, end: new Date() });
    }

    if (segments.length > 0) {
        const baseDate = segments[0].start;
        const onePM = new Date(baseDate);
        onePM.setHours(13, 0, 0, 0);
        const twoPM = new Date(baseDate);
        twoPM.setHours(14, 0, 0, 0);

        for (const seg of segments) {
            if (seg.end > onePM && seg.start < twoPM) {
                const overlapStart = new Date(Math.max(seg.start, onePM));
                const overlapEnd = new Date(Math.min(seg.end, twoPM));
                overlapSeconds += (overlapEnd - overlapStart) / 1000;
            }
        }
    }
    return overlapSeconds;
}

/**
 * Compute the full countdown state from today's attendance entry.
 *
 * @param {Object} todayEntry - The resolved today entry from scrapedAttendance
 * @returns {Object|null} Countdown state object or null if no valid data
 *
 * Returned object:
 *   firstInTime          {Date}      First IN swipe
 *   lastOutTime          {Date|null} Last OUT swipe (null if still working)
 *   isCurrentlyWorking   {boolean}   True if last swipe is IN
 *   isEarlyEntry         {boolean}   True if firstIn < 10 AM
 *   totalEffectiveSeconds{number}    Effective work seconds (1–2 PM break deducted)
 *   totalBreakSeconds    {number}    Total break seconds (gaps + 1–2 PM overlap)
 *   grossSeconds         {number}    Gross seconds from firstIn to now/lastOut
 *   targetExitTime       {Date}      Canonical target exit time
 *   remainingMs          {number}    targetExitTime - now (negative = overtime)
 *   isComplete           {boolean}   True if effective >= 9h (full day threshold)
 */
function computeCountdownState(todayEntry) {
    if (!todayEntry) return null;

    const inOutArray = todayEntry.inOutArray;
    if (!inOutArray || inOutArray.length === 0) return null;

    const validSwipes = inOutArray.filter(swipe => swipe.time && swipe.time !== 'MISSING');
    if (validSwipes.length === 0) return null;

    let firstInTime = null;
    let lastOutTime = null;
    let totalEffectiveSeconds = 0;
    let totalBreakSeconds = 0;
    let isCurrentlyWorking = false;

    for (let i = 0; i < validSwipes.length; i++) {
        const swipe = validSwipes[i];
        const swipeTime = parseSwipeTime(swipe.time);
        if (!swipeTime) continue;

        if (swipe.type === 'IN') {
            if (!firstInTime) firstInTime = swipeTime;

            if (i + 1 < validSwipes.length && validSwipes[i + 1].type === 'OUT') {
                const outTime = parseSwipeTime(validSwipes[i + 1].time);
                if (outTime) {
                    totalEffectiveSeconds += (outTime - swipeTime) / 1000;
                    lastOutTime = outTime;

                    // Break = gap between this OUT and next IN
                    if (i + 2 < validSwipes.length && validSwipes[i + 2].type === 'IN') {
                        const nextInTime = parseSwipeTime(validSwipes[i + 2].time);
                        if (nextInTime) {
                            totalBreakSeconds += (nextInTime - outTime) / 1000;
                        }
                    }
                }
            }
        }
    }

    // If last swipe is IN, count time until now as effective work
    const lastSwipe = validSwipes[validSwipes.length - 1];
    if (lastSwipe && lastSwipe.type === 'IN') {
        const lastInTime = parseSwipeTime(lastSwipe.time);
        if (lastInTime) {
            const now = new Date();
            totalEffectiveSeconds += (now - lastInTime) / 1000;
            isCurrentlyWorking = true;
        }
    }

    if (!firstInTime) return null;

    // Deduct 1 PM – 2 PM mandatory break overlap from effective, add to break
    const strictBreakOverlapSeconds = calcStrictBreakOverlap(validSwipes);
    totalEffectiveSeconds = Math.max(0, totalEffectiveSeconds - strictBreakOverlapSeconds);
    totalBreakSeconds += strictBreakOverlapSeconds;

    const hasLeave = todayEntry && todayEntry.leaveDetails && todayEntry.leaveDetails.length > 0;
    let isFirstHalfLeave = false;
    if (hasLeave) {
        const firstLeave = todayEntry.leaveDetails[0];
        isFirstHalfLeave = firstLeave?.isFirstHalfLeave === true || todayEntry.isFirstHalfLeave === true;
    }

    // Calculate target exit time: firstIn + requiredEffectiveMs + actual breaks
    const requiredEffectiveHours = hasLeave ? 4 : 8;
    const requiredEffectiveMs = requiredEffectiveHours * 60 * 60 * 1000;
    const breakMs = totalBreakSeconds * 1000;
    const targetWithActualBreak = new Date(firstInTime.getTime() + requiredEffectiveMs + breakMs);

    let targetExitTime;
    let isEarlyEntry;

    if (hasLeave) {
        if (isFirstHalfLeave) {
            // 1st half leave: working 2nd half (3 PM to 7 PM)
            const threePM = new Date(firstInTime);
            threePM.setHours(15, 0, 0, 0);
            isEarlyEntry = firstInTime < threePM;

            if (isEarlyEntry) {
                const sevenPm = new Date(firstInTime);
                sevenPm.setHours(19, 0, 0, 0);
                targetExitTime = new Date(Math.max(sevenPm.getTime(), targetWithActualBreak.getTime()));
            } else {
                targetExitTime = targetWithActualBreak;
            }
        } else {
            // 2nd half leave: working 1st half (10 AM to 3 PM)
            const tenAM = new Date(firstInTime);
            tenAM.setHours(10, 0, 0, 0);
            isEarlyEntry = firstInTime < tenAM;

            if (isEarlyEntry) {
                const threePm = new Date(firstInTime);
                threePm.setHours(15, 0, 0, 0);
                targetExitTime = new Date(Math.max(threePm.getTime(), targetWithActualBreak.getTime()));
            } else {
                const fiveHoursMs = 5 * 60 * 60 * 1000;
                const targetWithStandardBreak = new Date(firstInTime.getTime() + fiveHoursMs);
                targetExitTime = new Date(Math.max(targetWithStandardBreak.getTime(), targetWithActualBreak.getTime()));
            }
        }
    } else {
        // Standard full day logic
        const tenAM = new Date(firstInTime);
        tenAM.setHours(10, 0, 0, 0);
        isEarlyEntry = firstInTime < tenAM;

        if (isEarlyEntry) {
            // Early entry: max(7 PM, firstIn + 8h + breaks)
            const sevenPm = new Date(firstInTime);
            sevenPm.setHours(19, 0, 0, 0);
            targetExitTime = new Date(Math.max(sevenPm.getTime(), targetWithActualBreak.getTime()));
        } else {
            // Late entry: max(firstIn + 9h, firstIn + 8h + breaks)
            const oneHourBreakMs = 60 * 60 * 1000;
            const targetWithStandardBreak = new Date(firstInTime.getTime() + requiredEffectiveMs + oneHourBreakMs);
            targetExitTime = new Date(Math.max(targetWithStandardBreak.getTime(), targetWithActualBreak.getTime()));
        }
    }

    // Gross seconds
    const now = new Date();
    let grossSeconds;
    if (isCurrentlyWorking || !lastOutTime) {
        grossSeconds = (now - firstInTime) / 1000;
    } else {
        grossSeconds = (lastOutTime - firstInTime) / 1000;
    }

    const remainingMs = targetExitTime - now;
    const completionThresholdSeconds = hasLeave ? (4 * 60 * 60) : (9 * 60 * 60);
    const isComplete = totalEffectiveSeconds >= completionThresholdSeconds;

    return {
        firstInTime,
        lastOutTime,
        isCurrentlyWorking,
        isEarlyEntry,
        totalEffectiveSeconds,
        totalBreakSeconds,
        grossSeconds,
        targetExitTime,
        remainingMs,
        isComplete
    };
}
