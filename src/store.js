import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Tiny JSON-file store for sessions, bookings and webhook de-duplication.
 * Good for a single instance / MVP. For multiple instances swap this for
 * Postgres or Redis while keeping the same method names.
 */
export function createStore(file = null) {
  let db = { sessions: {}, bookings: {}, seen: [] };
  if (file && fs.existsSync(file)) {
    try {
      db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      console.error(`[store] could not read ${file}, starting empty:`, e.message);
    }
  }

  let timer = null;
  const persist = () => {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 50);
  };
  const flush = () => {
    if (!file) return;
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  };

  const clone = (v) => (v == null ? v : structuredClone(v));

  return {
    flush,
    getSession: (userId) => clone(db.sessions[userId]),
    saveSession(userId, session) {
      db.sessions[userId] = clone(session);
      persist();
    },

    createBooking(data) {
      const id = `NM${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const booking = { id, status: 'pending_payment', createdAt: new Date().toISOString(), ...data };
      db.bookings[id] = booking;
      persist();
      return clone(booking);
    },
    getBooking: (id) => clone(db.bookings[id]),
    updateBooking(id, patch) {
      if (!db.bookings[id]) return null;
      db.bookings[id] = { ...db.bookings[id], ...patch, updatedAt: new Date().toISOString() };
      persist();
      return clone(db.bookings[id]);
    },
    listBookings: (userId) =>
      Object.values(db.bookings)
        .filter((b) => b.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone),

    /** Returns true the first time an id is seen (webhook retries are dropped). */
    markSeen(id) {
      if (db.seen.includes(id)) return false;
      db.seen.push(id);
      if (db.seen.length > 2000) db.seen.splice(0, db.seen.length - 2000);
      persist();
      return true;
    },
  };
}
