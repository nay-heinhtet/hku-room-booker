// Booking rules shared by the API. These mirror queue_booking.py / book.py so
// entries written by the site look exactly like ones the Python tools write.

import catalog from "../../data/room_catalog.json" with { type: "json" };

export const ROOM_TARGETS = Object.entries(catalog.targets).map(([id, t]) => ({ id, description: t.description }));
const TARGET_IDS = new Set(ROOM_TARGETS.map((t) => t.id));

export const FIRST_HOUR = 8;
export const LAST_HOUR = 23;
export const MAX_DURATION = 2;

const HKT = "Asia/Hong_Kong";

export function hktParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: HKT,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return parts;
}

export function hktToday(now = new Date()) {
  const p = hktParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function hktIsoNow(now = new Date()) {
  const p = hktParts(now);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function hktStamp(now = new Date()) {
  const p = hktParts(now);
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

// Returns { request } or { error }. `mode` is "now" for today/tomorrow (the
// booking window is open) and "queue" for later dates.
export function validateBooking(input, now = new Date()) {
  const date = String(input?.date || "");
  const time = String(input?.time || "");
  const duration = Number(input?.duration);
  const roomTarget = String(input?.room_target || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return { error: "Pick a valid date." };
  }
  const match = /^(\d{2}):00$/.exec(time);
  const hour = match ? Number(match[1]) : NaN;
  if (!(hour >= FIRST_HOUR && hour <= LAST_HOUR)) {
    return { error: `Start time must be on the hour between ${FIRST_HOUR}:00 and ${LAST_HOUR}:00.` };
  }
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION) {
    return { error: `Duration must be 1 to ${MAX_DURATION} hours.` };
  }
  if (hour + duration > 24) return { error: "A booking cannot run past midnight." };
  if (!TARGET_IDS.has(roomTarget)) return { error: "Pick a room type from the list." };

  const today = hktToday(now);
  if (date < today) return { error: "That date has already passed." };
  if (date > addDays(today, 60)) return { error: "Pick a date within the next 60 days." };

  const mode = date <= addDays(today, 1) ? "now" : "queue";
  return { request: { date, time, duration, room_target: roomTarget, mode } };
}

export function newQueueEntry(req, now = new Date()) {
  return {
    id: `${req.date}-${req.time}-${req.room_target}-${hktStamp(now)}`,
    date: req.date,
    time: req.time,
    duration: req.duration,
    room_target: req.room_target,
    status: "pending",
    created_at: hktIsoNow(now),
    attempt_count: 0,
  };
}

export function isDuplicate(bookings, req) {
  return bookings.some(
    (b) => b.status === "pending" && b.date === req.date && b.time === req.time && bookingTarget(b) === req.room_target,
  );
}

function bookingTarget(entry) {
  return entry.room_target || entry.room_type;
}
