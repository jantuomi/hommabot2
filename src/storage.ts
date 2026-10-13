import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  addInterval,
  getNextDate,
  parseInterval,
  scheduleProblem,
  today,
  validDate,
} from "./tasks";
import { InputError } from "./errors";

export interface Actor {
  id: number;
  name: string;
}

export interface ShoppingItem {
  id: number;
  item: string;
  added_by: number;
  created_at: string;
  status: "active" | "bought" | "removed";
  previous_status: "active" | "bought";
  revision: number;
}

export interface RecurringTask {
  id: number;
  name: string;
  interval: string;
  last_done: string | null;
  first_due: string;
  archived_at: string | null;
  snoozed_until: string | null;
  snooze_revision: number | null;
  revision: number;
}

type Entity = "shopping" | "task";
type Snapshot = ShoppingItem | RecurringTask;

export interface HistoryEvent {
  id: number;
  entity: Entity;
  entity_id: number;
  action: string;
  actor_id: number;
  actor_name: string;
  created_at: string;
  before_json: string | null;
  after_revision: number;
  undone: number;
}

export type Mutation =
  | { kind: "changed"; eventId: number }
  | { kind: "missing" | "stale" | "unchanged" };

export type SessionState =
  | { kind: "shopping-add"; duplicates?: string[] }
  | { kind: "shopping-rename"; id: number; revision: number }
  | { kind: "task-name" }
  | { kind: "task-interval"; name: string }
  | { kind: "task-date"; name: string; interval: string }
  | { kind: "task-confirm"; name: string; interval: string; firstDue: string }
  | { kind: "task-edit-name"; id: number; revision: number }
  | { kind: "task-edit-interval"; id: number; revision: number; name: string }
  | {
      kind: "task-edit-date";
      id: number;
      revision: number;
      name: string;
      interval: string;
    }
  | {
      kind: "task-edit-confirm";
      id: number;
      revision: number;
      name: string;
      interval: string;
      firstDue?: string;
    };

export interface Session {
  state: SessionState;
  promptId: number;
  expiresAt: number;
}

export type View =
  | {
      kind: "shopping";
      tab: ShoppingItem["status"];
      page: number;
      edit: boolean;
    }
  | { kind: "tasks"; tab: "due" | "all" | "archived"; page: number }
  | { kind: "item"; id: number }
  | { kind: "task"; id: number }
  | { kind: "history"; entity: Entity; id: number; page: number };

export interface TrackedView {
  chatId: number;
  messageId: number;
  view: View;
}

const cleanName = (name: string): string => {
  const value = name.trim();
  if (!value || value.length > 200 || /[\r\n]/.test(value)) {
    throw new InputError("Nimen pitää olla 1–200 merkkiä yhdellä rivillä.");
  }
  return value;
};

export class HouseholdStore {
  readonly db: Database.Database;

  constructor(file: string, migrationDay: string) {
    if (!validDate(migrationDay)) throw new Error("Invalid migration date");
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    try {
      this.migrate(migrationDay);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(day: string): void {
    this.db
      .transaction(() => {
        const version = this.db.pragma("user_version", { simple: true });
        if (version !== 0 && version !== 1) {
          throw new Error(`Unsupported database version: ${version}`);
        }
        if (version === 1) return;
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS active_chats (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS permitted_users (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS shopping_list (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item TEXT NOT NULL,
          added_by INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS recurring_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          interval TEXT NOT NULL,
          last_done TEXT
        ) STRICT;
        ALTER TABLE shopping_list ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'bought', 'removed'));
        ALTER TABLE shopping_list ADD COLUMN previous_status TEXT NOT NULL DEFAULT 'active'
          CHECK (previous_status IN ('active', 'bought'));
        ALTER TABLE shopping_list ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recurring_tasks ADD COLUMN first_due TEXT NOT NULL DEFAULT '';
        ALTER TABLE recurring_tasks ADD COLUMN archived_at TEXT;
        ALTER TABLE recurring_tasks ADD COLUMN snoozed_until TEXT;
        ALTER TABLE recurring_tasks ADD COLUMN snooze_revision INTEGER;
        ALTER TABLE recurring_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity TEXT NOT NULL CHECK (entity IN ('shopping', 'task')),
          entity_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          actor_id INTEGER NOT NULL,
          actor_name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          before_json TEXT,
          after_revision INTEGER NOT NULL,
          undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1))
        ) STRICT;
        CREATE INDEX history_entity ON history(entity, entity_id, id DESC);
        CREATE TABLE sessions (
          chat_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          prompt_id INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, user_id)
        ) STRICT;
        CREATE TABLE views (
          chat_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          view_json TEXT NOT NULL,
          PRIMARY KEY (chat_id, message_id)
        ) STRICT;
        CREATE TABLE reminder_deliveries (
          week TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          sent_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (week, chat_id)
        ) STRICT;
        CREATE TABLE snooze_deliveries (
          task_id INTEGER NOT NULL,
          snooze_revision INTEGER NOT NULL,
          chat_id INTEGER NOT NULL,
          PRIMARY KEY (task_id, snooze_revision, chat_id)
        ) STRICT;
      `);
        this.db.prepare("UPDATE recurring_tasks SET first_due = ?").run(day);
        for (const task of this.tasks(true)) {
          const problem = scheduleProblem(task);
          if (problem) {
            // Preserve legacy input verbatim and expose a repair action instead of losing the household data.
            console.warn(
              `[migration] Task ${task.id} needs schedule repair: ${problem}`,
            );
          }
        }
        this.db.pragma("user_version = 1");
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }

  permittedUsers(): number[] {
    return (
      this.db.prepare("SELECT id FROM permitted_users").all() as {
        id: number;
      }[]
    ).map((row) => row.id);
  }

  activeChats(): number[] {
    return (
      this.db.prepare("SELECT id FROM active_chats").all() as { id: number }[]
    ).map((row) => row.id);
  }

  subscribe(chatId: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO active_chats (id) VALUES (?)")
      .run(chatId);
  }

  unsubscribe(chatId: number): void {
    this.db.prepare("DELETE FROM active_chats WHERE id = ?").run(chatId);
  }

  items(status?: ShoppingItem["status"]): ShoppingItem[] {
    return status
      ? (this.db
          .prepare("SELECT * FROM shopping_list WHERE status = ? ORDER BY id")
          .all(status) as ShoppingItem[])
      : (this.db
          .prepare("SELECT * FROM shopping_list ORDER BY id")
          .all() as ShoppingItem[]);
  }

  item(id: number): ShoppingItem | undefined {
    return this.db
      .prepare("SELECT * FROM shopping_list WHERE id = ?")
      .get(id) as ShoppingItem | undefined;
  }

  tasks(includeArchived = false): RecurringTask[] {
    return this.db
      .prepare(
        `SELECT * FROM recurring_tasks ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY id`,
      )
      .all() as RecurringTask[];
  }

  task(id: number): RecurringTask | undefined {
    return this.db
      .prepare("SELECT * FROM recurring_tasks WHERE id = ?")
      .get(id) as RecurringTask | undefined;
  }

  private record(
    entity: Entity,
    id: number,
    action: string,
    actor: Actor,
    before: Snapshot | null,
    revision: number,
  ): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO history (entity, entity_id, action, actor_id, actor_name, before_json, after_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entity,
          id,
          action,
          actor.id,
          actor.name,
          before ? JSON.stringify(before) : null,
          revision,
        ).lastInsertRowid,
    );
  }

  addItems(
    names: string[],
    actor: Actor,
    allowDuplicate = false,
  ): { added: ShoppingItem[]; duplicates: string[]; eventIds: number[] } {
    const cleaned = names.map(cleanName);
    if (cleaned.length === 0 || cleaned.length > 30) {
      throw new InputError("Lähetä 1–30 tuotetta kerrallaan.");
    }
    return this.db
      .transaction(() => {
        const added: ShoppingItem[] = [];
        const duplicates: string[] = [];
        const eventIds: number[] = [];
        for (const name of cleaned) {
          if (
            !allowDuplicate &&
            this.items("active").some(
              (item) =>
                item.item.toLocaleLowerCase("fi") ===
                name.toLocaleLowerCase("fi"),
            )
          ) {
            duplicates.push(name);
            continue;
          }
          const id = Number(
            this.db
              .prepare(
                "INSERT INTO shopping_list (item, added_by) VALUES (?, ?)",
              )
              .run(name, actor.id).lastInsertRowid,
          );
          const item = this.item(id);
          if (!item) throw new Error("Inserted shopping item missing");
          added.push(item);
          eventIds.push(this.record("shopping", id, "added", actor, null, 0));
        }
        return { added, duplicates, eventIds };
      })
      .immediate();
  }

  changeItem(
    id: number,
    revision: number,
    action: "buy" | "restore" | "remove" | "rename",
    actor: Actor,
    name?: string,
  ): Mutation {
    const renamed = action === "rename" ? cleanName(name ?? "") : null;
    return this.db
      .transaction((): Mutation => {
        const item = this.item(id);
        if (!item) return { kind: "missing" };
        if (item.revision !== revision) return { kind: "stale" };
        const status =
          action === "buy"
            ? "bought"
            : action === "remove"
              ? "removed"
              : action === "restore"
                ? item.status === "removed"
                  ? item.previous_status
                  : "active"
                : item.status;
        if (
          (action === "buy" && item.status !== "active") ||
          (action === "restore" && item.status === "active") ||
          (action === "remove" && item.status === "removed") ||
          (action === "rename" && renamed === item.item)
        ) {
          return { kind: "unchanged" };
        }
        this.db
          .prepare(`
        UPDATE shopping_list SET item = ?, status = ?, previous_status = ?, revision = revision + 1
        WHERE id = ?
      `)
          .run(
            renamed ?? item.item,
            status,
            action === "remove" ? item.status : item.previous_status,
            id,
          );
        return {
          kind: "changed",
          eventId: this.record(
            "shopping",
            id,
            action,
            actor,
            item,
            revision + 1,
          ),
        };
      })
      .immediate();
  }

  addTask(
    name: string,
    interval: string,
    firstDue: string,
    actor: Actor,
  ): number {
    const cleaned = cleanName(name);
    parseInterval(interval);
    if (!validDate(firstDue) || !validDate(addInterval(firstDue, interval))) {
      throw new InputError("Virheellinen päivämäärä.");
    }
    return this.db
      .transaction(() => {
        const id = Number(
          this.db
            .prepare(
              "INSERT INTO recurring_tasks (name, interval, first_due) VALUES (?, ?, ?)",
            )
            .run(cleaned, interval, firstDue).lastInsertRowid,
        );
        this.record("task", id, "added", actor, null, 0);
        return id;
      })
      .immediate();
  }

  changeTask(
    id: number,
    revision: number,
    action: "done" | "snooze" | "archive" | "restore" | "edit",
    actor: Actor,
    date: string,
    edit?: { name: string; interval: string; firstDue?: string },
  ): Mutation {
    if (!validDate(date)) throw new InputError("Virheellinen päivämäärä.");
    if (edit) {
      cleanName(edit.name);
      parseInterval(edit.interval);
      if (edit.firstDue !== undefined && !validDate(edit.firstDue)) {
        throw new InputError("Virheellinen päivämäärä.");
      }
    }
    return this.db
      .transaction((): Mutation => {
        const task = this.task(id);
        if (!task) return { kind: "missing" };
        if (task.revision !== revision) return { kind: "stale" };
        if (
          (task.archived_at && action !== "restore") ||
          (action === "restore" && !task.archived_at) ||
          (action === "done" && task.last_done === date) ||
          (action === "snooze" && task.snoozed_until === date)
        ) {
          return { kind: "unchanged" };
        }
        const next = { ...task, revision: revision + 1 };
        switch (action) {
          case "done":
            next.last_done = date;
            next.snoozed_until = null;
            next.snooze_revision = null;
            break;
          case "snooze":
            next.snoozed_until = date;
            next.snooze_revision = next.revision;
            break;
          case "archive":
            next.archived_at = date;
            break;
          case "restore":
            next.archived_at = null;
            break;
          case "edit":
            if (!edit) throw new Error("Missing task edit");
            next.name = cleanName(edit.name);
            next.interval = edit.interval;
            if (edit.firstDue !== undefined) {
              next.first_due = edit.firstDue;
              next.last_done = null;
              next.snoozed_until = null;
              next.snooze_revision = null;
            }
            break;
        }
        if (action !== "archive" && action !== "restore") getNextDate(next);
        this.writeTask(next);
        return {
          kind: "changed",
          eventId: this.record("task", id, action, actor, task, next.revision),
        };
      })
      .immediate();
  }

  private writeTask(task: RecurringTask): void {
    this.db
      .prepare(`
      UPDATE recurring_tasks SET name = ?, interval = ?, last_done = ?, first_due = ?,
        archived_at = ?, snoozed_until = ?, snooze_revision = ?, revision = ? WHERE id = ?
    `)
      .run(
        task.name,
        task.interval,
        task.last_done,
        task.first_due,
        task.archived_at,
        task.snoozed_until,
        task.snooze_revision,
        task.revision,
        task.id,
      );
  }

  history(entity: Entity, id: number): HistoryEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM history WHERE entity = ? AND entity_id = ? ORDER BY id DESC",
      )
      .all(entity, id) as HistoryEvent[];
  }

  event(id: number): HistoryEvent | undefined {
    return this.db.prepare("SELECT * FROM history WHERE id = ?").get(id) as
      | HistoryEvent
      | undefined;
  }

  undo(eventId: number, actor: Actor, date = today()): Mutation {
    if (!validDate(date)) throw new InputError("Virheellinen päivämäärä.");
    return this.db
      .transaction((): Mutation => {
        const event = this.event(eventId);
        if (!event) return { kind: "missing" };
        const current =
          event.entity === "shopping"
            ? this.item(event.entity_id)
            : this.task(event.entity_id);
        if (!current) return { kind: "missing" };
        if (
          event.undone ||
          event.action === "undo" ||
          current.revision !== event.after_revision
        ) {
          return { kind: "stale" };
        }
        const revision = current.revision + 1;
        if (event.entity === "shopping") {
          const before = event.before_json
            ? (JSON.parse(event.before_json) as ShoppingItem)
            : null;
          this.db
            .prepare(`
          UPDATE shopping_list SET item = ?, status = ?, previous_status = ?, revision = ? WHERE id = ?
        `)
            .run(
              before?.item ?? (current as ShoppingItem).item,
              before?.status ?? "removed",
              before?.previous_status ?? "active",
              revision,
              current.id,
            );
        } else {
          const before = event.before_json
            ? (JSON.parse(event.before_json) as RecurringTask)
            : null;
          const task = current as RecurringTask;
          this.writeTask(
            before
              ? { ...before, revision }
              : { ...task, archived_at: date, revision },
          );
        }
        this.db
          .prepare("UPDATE history SET undone = 1 WHERE id = ?")
          .run(eventId);
        return {
          kind: "changed",
          eventId: this.record(
            event.entity,
            current.id,
            "undo",
            actor,
            current,
            revision,
          ),
        };
      })
      .immediate();
  }

  setSession(chatId: number, userId: number, session: Session): void {
    this.db
      .prepare(`
      INSERT INTO sessions (chat_id, user_id, state_json, prompt_id, expires_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET
        state_json = excluded.state_json, prompt_id = excluded.prompt_id, expires_at = excluded.expires_at
    `)
      .run(
        chatId,
        userId,
        JSON.stringify(session.state),
        session.promptId,
        session.expiresAt,
      );
  }

  session(chatId: number, userId: number): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT state_json, prompt_id, expires_at FROM sessions WHERE chat_id = ? AND user_id = ?",
      )
      .get(chatId, userId) as
      | { state_json: string; prompt_id: number; expires_at: number }
      | undefined;
    return row
      ? {
          state: JSON.parse(row.state_json) as SessionState,
          promptId: row.prompt_id,
          expiresAt: row.expires_at,
        }
      : undefined;
  }

  clearSession(chatId: number, userId: number): void {
    this.db
      .prepare("DELETE FROM sessions WHERE chat_id = ? AND user_id = ?")
      .run(chatId, userId);
  }

  trackView(chatId: number, messageId: number, view: View): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(`
        INSERT INTO views (chat_id, message_id, view_json) VALUES (?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET view_json = excluded.view_json
      `)
          .run(chatId, messageId, JSON.stringify(view));
        this.db
          .prepare(`
        DELETE FROM views WHERE chat_id = ? AND message_id NOT IN
          (SELECT message_id FROM views WHERE chat_id = ? ORDER BY message_id DESC LIMIT 6)
      `)
          .run(chatId, chatId);
      })
      .immediate();
  }

  views(): TrackedView[] {
    return (
      this.db.prepare("SELECT * FROM views").all() as {
        chat_id: number;
        message_id: number;
        view_json: string;
      }[]
    ).map((row) => ({
      chatId: row.chat_id,
      messageId: row.message_id,
      view: JSON.parse(row.view_json) as View,
    }));
  }

  forgetView(chatId: number, messageId: number): void {
    this.db
      .prepare("DELETE FROM views WHERE chat_id = ? AND message_id = ?")
      .run(chatId, messageId);
  }

  reminderSent(week: string, chatId: number): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM reminder_deliveries WHERE week = ? AND chat_id = ?",
      )
      .get(week, chatId);
  }

  recordReminder(week: string, chatId: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO reminder_deliveries (week, chat_id) VALUES (?, ?)",
      )
      .run(week, chatId);
  }

  snoozeReminderSent(
    taskId: number,
    revision: number,
    chatId: number,
  ): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM snooze_deliveries WHERE task_id = ? AND snooze_revision = ? AND chat_id = ?",
      )
      .get(taskId, revision, chatId);
  }

  recordSnoozeReminder(taskId: number, revision: number, chatId: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO snooze_deliveries (task_id, snooze_revision, chat_id) VALUES (?, ?, ?)",
      )
      .run(taskId, revision, chatId);
  }
}
