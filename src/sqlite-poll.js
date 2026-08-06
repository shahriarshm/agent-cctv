import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The sqlite counterpart to tail.js.
 *
 * OpenCode and Hermes keep sessions in sqlite databases, and everything hard
 * about reading one out from under a running agent is the same for both:
 * whether this Node even has a sqlite module, opening read-only, surviving a
 * WAL database whose owner is not running, and retrying instead of crashing
 * when the file is deleted or migrated mid-poll. That lives here once; a
 * source supplies only its queries, through a poll callback.
 *
 * Polling, not fs.watch: WAL commits land in the -wal sidecar and do not
 * reliably fire events on the database file itself.
 *
 * Read-only matters twice over. It is the pure-observer rule, and it means we
 * can never hold a write lock against the live agent.
 */

const POLL_MS = 2000;

let sqlite; // undefined = never tried, null = tried and absent

/**
 * node:sqlite shipped in Node 22.5 behind a flag and unflagged in 22.13; on
 * anything older this returns null and the caller reports that in its
 * capabilities rather than crashing. Loaded lazily so a machine with no
 * sqlite-backed agent never even prints the module's experimental warning.
 */
export function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite');
  } catch {
    sqlite = null;
  }
  return sqlite;
}

export class SqlitePoller {
  /** @param {{dbPath: string, poll: (db: any, first: boolean) => void, pollMs?: number}} opts */
  constructor({ dbPath, poll, pollMs = POLL_MS }) {
    this.dbPath = dbPath;
    this.poll = poll;
    this.pollMs = pollMs;
    this.db = null;
    this.first = true;
    this.timer = null;
  }

  start() {
    if (!loadSqlite()) return false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.close();
  }

  close() {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  tick() {
    // Checked every tick, not once at start: the database appears the first
    // time the agent runs, which may be after we did.
    if (!this.db && !fs.existsSync(this.dbPath)) return;
    try {
      if (!this.db) {
        const { DatabaseSync } = loadSqlite();
        // A read-only open of a WAL database can fail while its owner is not
        // running to maintain the -shm file. That is "no data right now" —
        // the next tick tries again.
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      }
      this.poll(this.db, this.first);
      this.first = false;
    } catch {
      // Deleted, migrated, or locked out from under us. Drop the handle and
      // let a later tick rebuild the world rather than taking the wall down.
      this.close();
    }
  }
}
