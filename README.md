# hommabot2

Telegram bot for recurring household tasks and shopping lists.

## Features

- **Recurring tasks** — add tasks with intervals (days/weeks/months/years), get weekly Monday broadcasts of what's due
- **Shopping list** — shared list with inline delete buttons
- **Persistence** — embedded SQLite (STRICT tables), no external services needed

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Register chat for weekly broadcasts |
| `/stop` | Unregister chat |
| `/newtask <interval> <name>` | Add recurring task (e.g. `/newtask 2vk Imurointi`) |
| `/tasks` | Show all tasks with ✅ done / 🗑️ delete buttons |
| `/done <id>` | Mark task done |
| `/edittask <id> <interval> <name>` | Edit a task |
| `/add <item>` | Add item to shopping list |
| `/list` | Show shopping list with ❌ delete buttons |

**Intervals:** `pv` (day), `vk` (week), `kk` (month), `v` (year). Prefix with number, e.g. `2vk` = every 2 weeks.

## Setup

1. Install dependencies:

```sh
npm install
```

2. Create `.env`:

```sh
TELEGRAM_BOT_TOKEN=...
# Optional:
# SQLITE_PATH=./data/hommabot.db
```

3. (Optional) Seed permitted users:

```sh
sqlite3 data/hommabot.db "INSERT OR IGNORE INTO permitted_users (id) VALUES (123456789);"
```

## Running

```sh
npm start
```

The bot runs as a long-lived process. Weekly task broadcasts fire every Monday at 09:00 Finland time.

## Building

```sh
npm run build
```
