# hommabot2

A shared Telegram bot for shopping and recurring household tasks, with a Finnish interface and embedded SQLite persistence.

## Everyday use

Send `/start` to open the persistent menu and enable weekly reminders in that conversation. Both permitted users share the same household data, whether using private chats or a shared group.

### Shopping

- **Ostoslista** shows named item buttons. Tap an item to mark it **bought**, not delete it.
- Item rows keep neutral styling. Navigation/actions use blue **primary** buttons, grouped in a footer below the items; **Lisää tuotteita** shares a control row with **Päivitä** rather than resembling another product. Button colors require a current Telegram client; the grouped layout and control icons remain useful on older clients.
- Long item names open details before an action, so a truncated button cannot lead to checking off the wrong item.
- **Ostetut** lets you return purchases to the active list.
- **Muokkaa / historia** opens item details for renaming, recoverable removal and history.
- **Poistetut** restores removed items to their previous state (active or bought).
- Buying, restoring, removing and undoing items update the existing views with only a brief callback toast—no new success messages in the chat. Renaming updates the item card and turns the input prompt into current item details. The footer and item details offer **Kumoa** for the latest applicable change, while history retains per-item recovery. Stale/missing actions produce an alert, and failed refreshes still report explicitly that the saved state needs refreshing.
- **Ostoksia** or `/add` starts **add mode**. Your subsequent text messages in that chat are split by newline and added as items without repeating `/add`. Commas remain part of the item name. `/done` ends add mode.
- Duplicate active names are matched case-insensitively. The bot reports duplicates and offers **Lisää päällekkäisetkin**; it never silently merges quantities.
- Each message accepts up to 30 items, with names of 1–200 characters. Quantities are ordinary text, e.g. `Maito 2 l`.

Add mode is scoped to **the user and chat** that started it: another person's messages or your messages in another chat are not captured. In groups, free-form messages must be delivered to the bot (see setup below); replying to an addition prompt also works with privacy mode enabled. `/done`, **Valmis**, or `/cancel` ends entry; items already saved stay on the list. After stopping, ordinary group conversation is no longer captured.

### Recurring tasks

**Viikon hommat** or `/week` shows this week's and overdue tasks again at any time, sorted by due date. Viewing or reminding never changes completion or scheduling. Unfinished tasks remain in this view across weeks until completed (or explicitly archived/rescheduled), including snoozed tasks with their deferred reminder status. Every task button includes its name and due status. **Kaikki hommat** includes future tasks too; **Arkisto** contains recoverable archived tasks. Long lists are paginated.

Select a task to:

- Mark it **done today**, see the updated next date, or undo the latest change.
- **Snooze its reminder** by 1, 3 or 7 days without changing the due or completion date.
- Edit its name and frequency. Keep its current completion date, or explicitly reset the next due date; previous values remain in history.
- Archive it after confirmation, stopping reminders without deleting its data.
- Open history to see who changed it and when (history timestamps are UTC).

**Uusi homma** guides you through name, frequency and first due date, then requires confirmation before saving. Frequency is measured **from actual completion**, using calendar months and years rather than 30/365-day approximations. For example, a monthly task completed on January 31 is next due on the last day of February.

Intervals: `pv` = days, `vk` = weeks, `kk` = months, `v` = years; use a count from 1–1000, such as `2vk`. Input dates use `YYYY-MM-DD`.

### Recovery and shared state

Changes are committed before success is reported. Shopping items and tasks are never hard-deleted by the interface. Undo restores the preceding state, including completion and snooze dates, but is refused if the entity has changed since that event. Old and repeated button taps cannot toggle an item back or advance another task occurrence. Either permitted user can restore or undo household changes.

The six newest tracked views in each chat refresh after household mutations, including views in the other user's chat. Older messages have refresh/navigation buttons and revision-checked actions; shopping actions on an untracked message open current item details in that same message. If a message can no longer be edited, a replacement opens. Failed refreshes are logged and reported without claiming the saved change was lost.

Input sessions are per user and per chat, survive restarts, and expire after 30 minutes of inactivity. Invalid input re-prompts; starting another input flow replaces the previous one. Task creation/editing in groups accepts only replies to the latest prompt. Opening `/list`, `/tasks`, `/week` or the corresponding menu entries ends the current input session to avoid accidentally capturing later messages.

## Commands

Commands remain shortcuts; IDs are not needed for the menu-based workflows.

| Command | Description |
|---------|-------------|
| `/start` | Open the menu and subscribe this chat to weekly reminders |
| `/stop` | Unsubscribe this chat; the bot and shared data remain usable |
| `/help` | Show instructions and the menu |
| `/list` | Show active shopping items |
| `/add` | Start an addition session |
| `/add <items>` | Add items, one per line, and continue the addition session |
| `/tasks` | Show this week's and overdue tasks |
| `/week` | Show the weekly periodic tasks again, including unfinished and snoozed tasks |
| `/newtask` | Start guided task creation |
| `/newtask <interval> <name>` | Prefill creation, then choose the first due date and confirm |
| `/done` | End shopping add mode without completing any task |
| `/done <id>` | Show an explicit completion confirmation for the task |
| `/edittask <id> <interval> <name>` | Prefill editing, then choose scheduling behavior and confirm |
| `/cancel` | End the current input session without discarding saved changes |

Buttons on pre-upgrade messages open current details instead of performing old destructive actions.

## Setup

Use a current Node.js LTS release (Node 22 or newer recommended).

1. Install dependencies with `npm install`.
2. Copy `.env.sample` to `.env` and set `TELEGRAM_BOT_TOKEN`. Optionally set `SQLITE_PATH` (defaults to `./data/hommabot.db`) and `TZ` (defaults to `Europe/Helsinki`).
3. Permit **both users' Telegram user IDs**. For a new database using the default path:

   ```sh
   mkdir -p data
   sqlite3 data/hommabot.db "
     CREATE TABLE IF NOT EXISTS permitted_users (id INTEGER PRIMARY KEY) STRICT;
     INSERT OR IGNORE INTO permitted_users (id) VALUES (123456789), (987654321);
   "
   ```

   Replace the example IDs and use your configured database path if different. Existing permissions are preserved on upgrade.
4. Run `npm start`, then send `/start` in each conversation that should receive reminders.

In private chats, add mode captures all your text messages immediately. For the same free-form behavior in groups, the bot needs access to ordinary messages: disable its group privacy mode with BotFather's `/setprivacy` and re-add the bot to the group if Telegram requires it, or give it appropriate group administrator access. With privacy mode enabled, replies to bot prompts still work; unaddressed messages Telegram does not deliver cannot be added. Guided task creation/editing always uses explicit prompt replies in groups. Run only one polling bot process for a token/database.

## Upgrading an existing database

**No manual schema migration or re-entry is required.** Stop the old bot and run the new version with the **same `SQLITE_PATH` and working directory**. Startup automatically upgrades the original SQLite database in one `BEGIN IMMEDIATE` transaction and records `PRAGMA user_version = 1`. Repeated startups do not repeat the migration. Unsupported newer database versions and migration errors stop startup explicitly; a failed migration rolls back schema and data changes.

The migration preserves:

- Shopping item IDs, names, adding users and creation timestamps; all surviving items become **active**.
- Task IDs, names, stored intervals and recorded completion dates.
- Permitted users and reminder subscriptions.

Never-completed tasks get the migration's local date as their first due date, matching the old bot's immediately-due behavior without inventing a completion. Existing tasks with completion dates use the corrected calendar-based interval calculation. Legacy invalid schedules are retained verbatim, logged, and shown with **korjaa aikataulu** so they can be repaired through editing rather than blocking access to the household's data.

Previously hard-deleted rows cannot be recovered. Completion dates written by the old reminder bug cannot reliably be distinguished from real completions, so the migration does **not** guess or erase them. Review suspect tasks and use **Muokkaa** to set a new due date if necessary. Pre-upgrade history is unavailable; new actions are recorded from the upgrade onward.

For an optional pre-upgrade backup, while the old bot is stopped:

```sh
sqlite3 data/hommabot.db ".backup 'data/hommabot-before-upgrade.db'"
```

Use the actual configured database path. The old version is not compatible with the new state model: do not run it against an upgraded database.

## Reminders

The weekly digest becomes eligible Monday at 09:00 in `TZ`. It includes overdue tasks and tasks due before the next Monday, excluding archived tasks. Snoozed unfinished tasks remain listed with their deferred reminder date. **Sending or reopening the weekly output never marks anything done or restarts an interval. Only actual completion starts the next interval.**

The scheduler checks on startup and every minute. If the bot was offline Monday morning, it sends the current week's digest when it next runs; previous weeks are not replayed. Successful deliveries are recorded per chat/week so ordinary restarts do not repeat them. Failed sends remain pending and retry after 15 minutes without blocking other chats.

Snoozed reminders wake at 09:00 on or after their chosen date, with separate persisted delivery tracking. A task already included in that week's digest at snooze expiry does not receive a duplicate wake-up reminder.

There is a small unavoidable delivery uncertainty if Telegram accepts a message but the process dies before recording its delivery, or the response is lost: that message may be retried. Reminder delivery is not claimed to be exactly-once.

## Development

```sh
npm run check
npm test
```

Tests use temporary/in-memory databases and a mocked Telegram API. They cover legacy upgrade and rollback, persistence across reopen, recovery and stale actions, calendar/week boundaries, reminder delivery/retries, guided creation/editing, shared-view refreshes, and private/group input handling. They do not contact Telegram or modify the household database.

If a Node upgrade leaves the native SQLite binding incompatible, rebuild it with `npm rebuild better-sqlite3`.
