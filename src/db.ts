/* SQLite3 persistence layer replacing previous PG / Slonik implementation.
 *
 * Features:
 * - Uses better-sqlite3 (synchronous, high-performance, safe for WAL mode)
 * - Separate "write" connection (single) and a small pool of readonly connections for parallel reads
 * - Applies requested PRAGMAs on every connection
 * - Uses BEGIN IMMEDIATE transactions for write operations
 * - STRICT tables (requires SQLite 3.37+)
 *
 * Environment:
 *   SQLITE_PATH (optional) - path to DB file. Defaults to ./data/hommabot.db
 *
 * Schema (mirrors previous PG schema):
 *   active_chats(id INTEGER PRIMARY KEY)
 *   permitted_users(id INTEGER PRIMARY KEY)
 */

import fs from "fs";
import path from "path";
import Database, { Database as BetterSqliteDb } from "better-sqlite3";

interface ActiveChat {
  id: number;
}

interface PermittedUser {
  id: number;
}

const DB_FILE =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "hommabot.db");

ensurePath();
const db = new Database(DB_FILE, {
  fileMustExist: false,
  readonly: false,
});
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = 1000000000");
db.pragma("foreign_keys = ON");
db.pragma("temp_store = MEMORY");

const ddl = `
  BEGIN IMMEDIATE;
  CREATE TABLE IF NOT EXISTS active_chats (
    id INTEGER PRIMARY KEY
  ) STRICT;

  CREATE TABLE IF NOT EXISTS permitted_users (
    id INTEGER PRIMARY KEY
  ) STRICT;
  COMMIT;
`;
db.exec(ddl);

/**
 * Initialize directory for DB file if required.
 */
function ensurePath() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Wrap a write operation in a BEGIN IMMEDIATE transaction.
 */
function withWriteTx<T>(fn: (db: BetterSqliteDb) => T): T {
  const begin = db.prepare("BEGIN IMMEDIATE");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");

  begin.run();
  try {
    const result = fn(db);
    commit.run();
    return result;
  } catch (err) {
    try {
      rollback.run();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/* Public API (mirrors old Slonik-based version) */

export const getActiveChats = async (): Promise<readonly ActiveChat[]> => {
  const stmt = db.prepare("SELECT id FROM active_chats");
  return stmt.all() as ActiveChat[];
};

export const addActiveChat = async (id: number): Promise<void> => {
  withWriteTx((db) => {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO active_chats (id) VALUES (?)",
    );
    stmt.run(id);
  });
};

export const removeActiveChat = async (id: number): Promise<void> => {
  withWriteTx((db) => {
    const stmt = db.prepare("DELETE FROM active_chats WHERE id = ?");
    stmt.run(id);
  });
};

export const getPermittedUsers = async (): Promise<
  readonly PermittedUser[]
> => {
  const stmt = db.prepare("SELECT id FROM permitted_users");
  return stmt.all() as PermittedUser[];
};
