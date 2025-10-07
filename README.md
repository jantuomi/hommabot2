# hommabot2

Rewrite of hommabot (Python3) in TS.

1. Reads Google Sheets for recurring tasks
2. Determines which tasks fall in the current week
3. Broadcasts a Telegram message to all active chats
4. Updates the "last done" column for tasks that became due

## Persistence

- Embedded SQLite (STRICT tables) auto-initialized on first run
- Single connection (read + write)

## Setup

1. Install dependencies (includes better-sqlite3):

```sh
npm install
```

2. Create/update your `.env` (minimum required):

```sh
TELEGRAM_BOT_TOKEN=...
SHEETS_SPREADSHEET_ID=...
SHEETS_RANGE=...
G_SA_JSON_B64=...          # Base64-encoded Google Service Account JSON
# Optional:
# SQLITE_PATH=./data/hommabot.db
```

3. (Optional) Seed permitted Telegram user IDs (only these can /start to register chats):

```sh
sqlite3 data/hommabot.db "INSERT OR IGNORE INTO permitted_users (id) VALUES (123456789);"
```

Repeat with additional IDs as needed.

4. (Optional) Pre-register an active chat manually (normally added via /start):

```sh
sqlite3 data/hommabot.db "INSERT OR IGNORE INTO active_chats (id) VALUES (-1001234567890);"
```

## Running

Direct TypeScript execution:

```sh
npm start
```

## Building

```sh
npm run build
```

## Automating (cron example)

Run every Monday at 08:00:

```
0 8 * * 1 /usr/bin/node /path/to/hommabot2/build/index.js >> /path/to/hommabot2/hommabot.log 2>&1
```

## Inspecting the database

```sh
sqlite3 data/hommabot.db ".tables"
sqlite3 data/hommabot.db "SELECT * FROM active_chats;"
sqlite3 data/hommabot.db "SELECT * FROM permitted_users;"
```

## Notes

- To add new permitted users at any time, insert into `permitted_users`.
- To clear active chats:

```sh
sqlite3 data/hommabot.db "DELETE FROM active_chats;"
```
