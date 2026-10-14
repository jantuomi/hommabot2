import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Telegram, TelegramError } from "telegraf";
import type { Update } from "telegraf/types";
import { createHouseholdBot } from "../src/app";
import { HouseholdStore } from "../src/storage";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  messageId?: number;
}

const botInfo = {
  id: 999,
  is_bot: true as const,
  first_name: "HommaBot",
  username: "hommabot_test",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

const harness = (t: TestContext) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  store.db.exec("INSERT INTO permitted_users VALUES (10), (20)");
  t.after(() => store.close());
  let instant = new Date("2026-10-13T09:00:00Z");
  let sequence = 100;
  let updateId = 1;
  let failEdits = false;
  let failSave = false;
  const calls: ApiCall[] = [];
  t.mock.method(
    Telegram.prototype,
    "callApi",
    async (method: string, payload: Record<string, unknown>) => {
      const call: ApiCall = { method, payload };
      calls.push(call);
      if (method === "answerCallbackQuery") return true;
      if (method === "editMessageText" && failEdits) {
        throw new TelegramError({
          error_code: 500,
          description: "Temporary edit failure",
        });
      }
      if (method !== "sendMessage" && method !== "editMessageText") {
        throw new Error(`Unexpected API method: ${method}`);
      }
      const messageId =
        method === "sendMessage" ? ++sequence : Number(payload.message_id);
      call.messageId = messageId;
      return {
        message_id: messageId,
        date: 1,
        from: botInfo,
        chat: {
          id: Number(payload.chat_id),
          type: Number(payload.chat_id) > 0 ? "private" : "supergroup",
        },
        text: String(payload.text),
      };
    },
  );
  const log = t.mock.method(console, "error", () => {});
  let { bot } = createHouseholdBot(
    "test-token",
    store,
    "Europe/Helsinki",
    () => instant,
  );
  bot.botInfo = botInfo;

  const text = async (
    value: string,
    userId = 10,
    chatId = userId,
    replyId?: number,
  ) => {
    const chat =
      chatId > 0
        ? { id: chatId, type: "private" as const, first_name: "Jan" }
        : { id: chatId, type: "supergroup" as const, title: "Household" };
    const update: Update = {
      update_id: updateId++,
      message: {
        message_id: ++sequence,
        date: 1,
        chat,
        from: {
          id: userId,
          is_bot: false,
          first_name: userId === 10 ? "Jan" : "Spouse",
        },
        text: value,
        ...(value.startsWith("/")
          ? {
              entities: [
                {
                  type: "bot_command" as const,
                  offset: 0,
                  length: value.split(/\s/)[0].length,
                },
              ],
            }
          : {}),
        ...(replyId
          ? {
              reply_to_message: {
                message_id: replyId,
                date: 1,
                chat,
                from: botInfo,
                text: "Prompt",
                reply_to_message: undefined,
              },
            }
          : {}),
      },
    };
    await bot.handleUpdate(update);
  };
  const tap = async (
    data: string,
    messageId: number,
    userId = 10,
    chatId = userId,
  ) => {
    const chat =
      chatId > 0
        ? { id: chatId, type: "private" as const, first_name: "Jan" }
        : { id: chatId, type: "supergroup" as const, title: "Household" };
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        chat_instance: "test",
        from: {
          id: userId,
          is_bot: false,
          first_name: userId === 10 ? "Jan" : "Spouse",
        },
        data,
        message: {
          message_id: messageId,
          date: 1,
          chat,
          from: botInfo,
          text: "Bot message",
        },
      },
    });
  };
  const sent = () => calls.filter((call) => call.method === "sendMessage");
  const lastText = () => String(sent().at(-1)?.payload.text);
  const session = (chatId = 10, userId = 10) => {
    const session = store.session(chatId, userId);
    assert.ok(session, "Expected active session");
    return session;
  };
  return {
    store,
    calls,
    text,
    tap,
    sent,
    lastText,
    session,
    log,
    restart: () => {
      ({ bot } = createHouseholdBot(
        "test-token",
        store,
        "Europe/Helsinki",
        () => instant,
      ));
      bot.botInfo = botInfo;
    },
    setTime: (value: string) => {
      instant = new Date(value);
    },
    failEdits: () => {
      failEdits = true;
    },
    failSave: () => {
      if (failSave) return;
      failSave = true;
      store.db.exec(
        `CREATE TRIGGER reject_add BEFORE INSERT ON shopping_list BEGIN SELECT RAISE(ABORT, 'Cannot save'); END`,
      );
    },
  };
};

test("shopping accepts multiline and successive messages without repeating /add, then stops explicitly", async (t) => {
  const h = harness(t);
  await h.text("/add");
  await h.text("Maito 2 l\nKahvi");
  await h.text("Omenat");
  assert.deepEqual(
    h.store.items("active").map((item) => item.item),
    ["Maito 2 l", "Kahvi", "Omenat"],
  );
  await h.tap("session:end:10", h.session().promptId);
  assert.equal(h.store.session(10, 10), undefined);
  await h.text("Voi");
  assert.equal(h.store.items().length, 3);
  assert.ok(h.lastText().includes("Viestiä ei tallennettu"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("privacy-mode group entry guides mysli into a reply before /done", async (t) => {
  const h = harness(t);
  await h.text("/add", 10, -123);
  const prompt = h.sent().at(-1)!;
  const markup = prompt.payload.reply_markup as {
    force_reply?: boolean;
    selective?: boolean;
  };
  // Privacy-enabled groups deliver commands and replies, not an ordinary text post.
  if (markup.force_reply) {
    await h.text("mysli", 10, -123, prompt.messageId);
  }
  await h.text("/done", 10, -123);
  assert.deepEqual(
    h.store.items("active").map((item) => item.item),
    ["mysli"],
  );
  assert.equal(markup.force_reply, true);
  assert.equal(markup.selective, true);
  assert.equal(h.store.session(-123, 10), undefined);
});

test("group callback entry renews targeted reply prompts and retains working duplicate and finish buttons", async (t) => {
  const h = harness(t);
  await h.text("/list", 10, -123);
  await h.tap("capture", h.sent().at(-1)!.messageId!, 10, -123);
  const initialControls = h.session(-123).promptId;
  const initialPrompt = h.sent().at(-1)!;
  assert.notEqual(initialPrompt.messageId, initialControls);
  assert.equal(initialPrompt.payload.parse_mode, "HTML");
  assert.ok(
    String(initialPrompt.payload.text).startsWith(
      '<a href="tg://user?id=10">Jan</a>',
    ),
  );
  await h.text("mysli & <siemenet>\nmaito", 10, -123, initialPrompt.messageId);
  const nextPrompt = h.sent().at(-1)!;
  assert.ok(
    String(nextPrompt.payload.text).includes("mysli &amp; &lt;siemenet&gt;"),
  );
  assert.equal(
    (nextPrompt.payload.reply_markup as { force_reply?: boolean }).force_reply,
    true,
  );
  assert.equal(h.session(-123).state.kind, "shopping-add");
  await h.text("maito", 10, -123, nextPrompt.messageId);
  const duplicateControls = h.session(-123).promptId;
  await h.tap("session:duplicates:10", duplicateControls, 10, -123);
  assert.equal(h.store.items("active").length, 3);
  await h.tap("session:end:10", initialControls, 10, -123);
  assert.ok(h.store.session(-123, 10));
  await h.tap("session:end:10", h.session(-123).promptId, 10, -123);
  assert.equal(h.store.session(-123, 10), undefined);
  assert.ok(
    h
      .sent()
      .some((call) => String(call.payload.text).includes("Lisätty 3 tuotetta")),
  );
  await h.text("Ei kuulu listalle", 10, -123, nextPrompt.messageId);
  assert.equal(h.store.items("active").length, 3);
  assert.equal(h.log.mock.callCount(), 0);
});

test("group /add with initial items leaves a reply prompt ready for the next message", async (t) => {
  const h = harness(t);
  await h.text("/add mysli", 10, -123);
  const prompt = h.sent().at(-1)!;
  assert.equal(
    (prompt.payload.reply_markup as { force_reply?: boolean }).force_reply,
    true,
  );
  await h.text("kahvi\nmaito", 10, -123, prompt.messageId);
  h.restart();
  await h.text("/done", 10, -123);
  assert.deepEqual(
    h.store.items("active").map((item) => item.item),
    ["mysli", "kahvi", "maito"],
  );
  assert.ok(
    h
      .sent()
      .some((call) => String(call.payload.text).includes("Lisätty 3 tuotetta")),
  );
  assert.equal(h.log.mock.callCount(), 0);
});

test("finishing without delivered item messages warns rather than implying items were saved", async (t) => {
  const h = harness(t);
  await h.text("/add", 10, -123);
  // Simulate dismissing Telegram's reply composer: the ordinary message never reaches the bot.
  await h.text("/done", 10, -123);
  assert.equal(h.store.items().length, 0);
  assert.ok(
    h
      .sent()
      .some((call) =>
        String(call.payload.text).includes(
          "En vastaanottanut yhtään tuoteviestiä",
        ),
      ),
  );
  assert.ok(
    h
      .sent()
      .some((call) => String(call.payload.text).includes("Lisätty 0 tuotetta")),
  );
  await h.text("/add", 10, -123);
  await h.text("x".repeat(201), 10, -123, h.sent().at(-1)!.messageId);
  const beforeFinish = h.sent().length;
  await h.text("/done", 10, -123);
  const finishReplies = h.sent().slice(beforeFinish);
  assert.ok(
    finishReplies.some((call) =>
      String(call.payload.text).includes("Lisätty 0 tuotetta"),
    ),
  );
  assert.ok(
    !finishReplies.some((call) =>
      String(call.payload.text).includes("En vastaanottanut"),
    ),
  );
});

test("existing persisted add sessions without counters finish without inventing a saved-item count", async (t) => {
  const h = harness(t);
  h.store.addItems(["mysli"], { id: 10, name: "Jan" });
  h.store.setSession(-123, 10, {
    state: { kind: "shopping-add" },
    promptId: 100,
    expiresAt: Date.parse("2026-10-13T10:00:00Z"),
  });
  await h.text("/done", 10, -123);
  assert.equal(h.store.items("active").length, 1);
  assert.ok(
    h
      .sent()
      .some((call) =>
        String(call.payload.text).includes("Jo lisätyt tuotteet säilyvät"),
      ),
  );
  assert.ok(
    !h
      .sent()
      .some(
        (call) =>
          String(call.payload.text).includes("Lisätty 0") ||
          String(call.payload.text).includes("En vastaanottanut"),
      ),
  );
});

test("duplicate items require explicit opt-in and old duplicate buttons cannot add them twice", async (t) => {
  const h = harness(t);
  await h.text("/add Kahvi");
  await h.text("kahvi");
  assert.equal(h.store.items().length, 1);
  const promptId = h.session().promptId;
  assert.ok(h.lastText().includes("Jo listalla"));
  await h.tap("session:duplicates:10", promptId);
  assert.equal(h.store.items().length, 2);
  await h.tap("session:duplicates:10", promptId);
  assert.equal(h.store.items().length, 2);
  assert.ok(h.lastText().includes("vanha syöttöpyyntö"));
});

test("buy updates both spouses' active views and undo restores the item; double taps are safe", async (t) => {
  const h = harness(t);
  await h.text("/add Maito");
  await h.text("/list", 20);
  const views = h.store.views().filter((view) => view.view.kind === "shopping");
  assert.equal(views.length, 2);
  const ownBoardId = views.find((view) => view.chatId === 10)!.messageId;
  const spouseBoardId = views.find((view) => view.chatId === 20)!.messageId;
  const item = h.store.items()[0];
  await h.tap(`si:buy:${item.id}:0`, ownBoardId);
  assert.equal(h.store.items("bought").length, 1);
  const updated = h.calls.filter(
    (call) =>
      call.method === "editMessageText" &&
      String(call.payload.text).includes("Lista on tyhjä"),
  );
  assert.deepEqual(
    new Set(updated.map((call) => call.payload.chat_id)),
    new Set([10, 20]),
  );
  const event = h.store.history("shopping", item.id)[0];
  const beforeStaleTap = h.sent().length;
  await h.tap(`si:buy:${item.id}:0`, spouseBoardId, 20);
  assert.equal(h.store.items("bought").length, 1);
  assert.equal(h.sent().length, beforeStaleTap);
  const alert = h.calls
    .filter((call) => call.method === "answerCallbackQuery")
    .at(-1)!;
  assert.ok(String(alert.payload.text).includes("jo muutettu"));
  assert.equal(alert.payload.show_alert, true);
  await h.tap(`undo:${event.id}`, ownBoardId);
  assert.equal(h.store.items("active").length, 1);
  assert.equal(h.log.mock.callCount(), 0);
});

test("shopping buy, restore, remove, undo and rename update existing views without success messages", async (t) => {
  const h = harness(t);
  await h.text("/add mysli");
  await h.text("/done");
  const item = h.store.items()[0];
  const boardId = h.sent().at(-1)!.messageId!;
  const sentBefore = h.sent().length;
  const editedButtons = () => {
    const edit = h.calls
      .filter(
        (call) =>
          call.method === "editMessageText" &&
          call.payload.message_id === boardId,
      )
      .at(-1)!;
    return (
      edit.payload.reply_markup as {
        inline_keyboard: {
          text: string;
          callback_data: string;
          style?: string;
        }[][];
      }
    ).inline_keyboard.flat();
  };
  const tapMutation = async (data: string) => {
    const before = h.calls.length;
    await h.tap(data, boardId);
    assert.equal(h.sent().length, sentBefore);
    const answers = h.calls
      .slice(before)
      .filter((call) => call.method === "answerCallbackQuery");
    assert.equal(answers.length, 1);
    assert.equal(answers[0].payload.show_alert, false);
    assert.ok(String(answers[0].payload.text).length <= 200);
  };

  await tapMutation(`si:buy:${item.id}:0`);
  assert.equal(h.store.item(item.id)?.status, "bought");
  assert.ok(
    editedButtons().some((button) => button.callback_data.startsWith("undo:")),
  );
  await h.tap("sh:bought:0:0", boardId);
  const restore = editedButtons().find((button) =>
    button.callback_data.startsWith("si:restore:"),
  )!;
  await tapMutation(restore.callback_data);
  assert.equal(h.store.item(item.id)?.status, "active");
  await h.tap(`item:${item.id}`, boardId);
  await tapMutation(`si:remove:${item.id}:2`);
  assert.equal(h.store.item(item.id)?.status, "removed");
  const undo = editedButtons().find((button) =>
    button.callback_data.startsWith("undo:"),
  )!;
  assert.equal(undo.style, "primary");
  await tapMutation(undo.callback_data);
  assert.equal(h.store.item(item.id)?.status, "active");
  assert.ok(
    !editedButtons().some((button) => button.callback_data.startsWith("undo:")),
  );

  await h.tap(`rename:${item.id}:4`, boardId);
  const renamePromptCount = h.sent().length;
  const renamePromptId = h.session().promptId;
  await h.text("mysli & pähkinät");
  assert.equal(h.store.item(item.id)?.item, "mysli & pähkinät");
  assert.equal(h.sent().length, renamePromptCount);
  assert.ok(
    h.calls.some(
      (call) =>
        call.method === "editMessageText" &&
        call.payload.message_id === renamePromptId &&
        String(call.payload.text).includes("mysli & pähkinät"),
    ),
  );
  assert.ok(
    editedButtons().some((button) => button.callback_data.startsWith("undo:")),
  );
  assert.equal(h.store.session(10, 10), undefined);
  assert.equal(h.log.mock.callCount(), 0);
});

test("shopping actions on older untracked messages show current details and undo without new messages", async (t) => {
  const h = harness(t);
  await h.text("/add Maito");
  await h.text("/done");
  const item = h.store.items()[0];
  const oldBoardId = h.sent().at(-1)!.messageId!;
  for (let index = 0; index < 7; index++) await h.text("/list");
  assert.ok(!h.store.views().some((view) => view.messageId === oldBoardId));
  const before = h.sent().length;
  await h.tap(`si:buy:${item.id}:0`, oldBoardId);
  assert.equal(h.store.item(item.id)?.status, "bought");
  assert.equal(h.sent().length, before);
  const edit = h.calls
    .filter(
      (call) =>
        call.method === "editMessageText" &&
        call.payload.message_id === oldBoardId,
    )
    .at(-1)!;
  assert.ok(String(edit.payload.text).includes("Maito\nTila: ostettu"));
  const buttons = (
    edit.payload.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    }
  ).inline_keyboard.flat();
  const undo = buttons.find((button) =>
    button.callback_data.startsWith("undo:"),
  )!;
  await h.tap(undo.callback_data, oldBoardId);
  assert.equal(h.store.item(item.id)?.status, "active");
  assert.equal(h.sent().length, before);
  const lastEdit = h.calls
    .filter(
      (call) =>
        call.method === "editMessageText" &&
        call.payload.message_id === oldBoardId,
    )
    .at(-1)!;
  assert.ok(String(lastEdit.payload.text).includes("Maito\nTila: ostamatta"));
  assert.equal(h.log.mock.callCount(), 0);
});

for (const untracked of [false, true]) {
  test(`quiet shopping actions report refresh failures on ${untracked ? "untracked" : "tracked"} messages and keep the saved change`, async (t) => {
    const h = harness(t);
    await h.text("/add Maito");
    await h.text("/done");
    const item = h.store.items()[0];
    const boardId = h.sent().at(-1)!.messageId!;
    if (untracked) {
      for (let index = 0; index < 7; index++) await h.text("/list");
    }
    const before = h.sent().length;
    h.failEdits();
    await h.tap(`si:buy:${item.id}:0`, boardId);
    assert.equal(h.store.item(item.id)?.status, "bought");
    assert.equal(h.sent().length, before + 1);
    assert.ok(h.lastText().includes("Muutos tallennettiin"));
    assert.ok(h.lastText().includes("ei voitu päivittää"));
    assert.ok(h.log.mock.callCount() > 0);
  });
}

test("missing shopping items produce an alert without a success-shaped chat reply", async (t) => {
  const h = harness(t);
  await h.text("/list");
  const before = h.sent().length;
  await h.tap("si:buy:999:0", h.sent().at(-1)!.messageId!);
  assert.equal(h.sent().length, before);
  const answer = h.calls
    .filter((call) => call.method === "answerCallbackQuery")
    .at(-1)!;
  assert.equal(answer.payload.show_alert, true);
  assert.ok(String(answer.payload.text).includes("ei löydy"));
});

test("remove is recoverable and task completion refreshes its named card", async (t) => {
  const h = harness(t);
  await h.text("/add Maito");
  const item = h.store.items()[0];
  await h.tap(`si:remove:${item.id}:0`, h.sent().at(-1)!.messageId!);
  assert.equal(h.store.items("removed").length, 1);
  await h.tap(`si:restore:${item.id}:1`, h.sent().at(-1)!.messageId!);
  assert.equal(h.store.items("active").length, 1);
  const id = h.store.addTask("Imurointi", "2vk", "2026-10-01", {
    id: 10,
    name: "Jan",
  });
  await h.text("/tasks");
  const boardId = h.sent().at(-1)!.messageId!;
  await h.tap(`task:${id}`, boardId);
  const edited = h.calls
    .filter((call) => call.method === "editMessageText")
    .at(-1)!;
  assert.ok(String(edited.payload.text).startsWith("Imurointi"));
  await h.tap(`ta:done:${id}:0`, boardId);
  assert.equal(h.store.task(id)?.last_done, "2026-10-13");
  assert.ok(
    h.calls.some(
      (call) =>
        call.method === "editMessageText" &&
        String(call.payload.text).includes("Seuraava: 27.10.2026"),
    ),
  );
  assert.ok(h.lastText().includes("Imurointi tehty tänään"));
  await h.tap(`ta:done:${id}:0`, boardId);
  assert.ok(h.lastText().includes("jo muutettu"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("guided creation previews before saving and stale confirmation cannot create a second task", async (t) => {
  const h = harness(t);
  await h.text("/newtask");
  await h.text("Imurointi *[nimellä]*");
  await h.tap("pick:2vk:10", h.session().promptId);
  await h.tap("date:tomorrow:10", h.session().promptId);
  assert.equal(h.store.tasks().length, 0);
  assert.ok(h.lastText().includes("14.10.2026"));
  const promptId = h.session().promptId;
  await h.tap("session:confirm:10", promptId);
  assert.equal(h.store.tasks().length, 1);
  assert.equal(h.store.tasks()[0].first_due, "2026-10-14");
  assert.equal(h.store.tasks()[0].name, "Imurointi *[nimellä]*");
  await h.tap("session:confirm:10", promptId);
  assert.equal(h.store.tasks().length, 1);
  assert.ok(h.lastText().includes("ei ole enää aktiivinen"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("group add mode captures the owner's messages without replies, not other users or chats", async (t) => {
  const h = harness(t);
  await h.text("/add", 10, -123);
  const original = h.session(-123).promptId;
  await h.text("Maito\nVoi", 10, -123);
  await h.text("Not my shopping session", 20, -123, original);
  await h.text("Another chat", 10, 10);
  assert.equal(h.store.items().length, 2);
  await h.text("Kahvi", 10, -123, original);
  assert.equal(h.store.items().length, 3);
  await h.tap("session:end:10", h.session(-123).promptId, 20, -123);
  assert.ok(h.store.session(-123, 10));
  const answer = h.calls.at(-1)!;
  assert.equal(answer.method, "answerCallbackQuery");
  assert.ok(String(answer.payload.text).includes("toiselle käyttäjälle"));
  await h.text("/add", 20, -123);
  await h.text("/done", 10, -123);
  assert.equal(h.store.session(-123, 10), undefined);
  assert.ok(h.store.session(-123, 20));
  await h.text("Ordinary conversation", 10, -123);
  assert.equal(h.store.items().length, 3);
});

test("/done ends shopping add mode without completing a task and keeps task-ID completion distinct", async (t) => {
  const h = harness(t);
  const id = h.store.addTask("Imurointi", "2vk", "2026-10-01", {
    id: 10,
    name: "Jan",
  });
  await h.text("/add Maito\nKahvi");
  await h.text("Omenat\nVoi");
  h.restart();
  await h.text("/done@hommabot_test");
  assert.equal(h.store.session(10, 10), undefined);
  assert.equal(h.store.task(id)?.last_done, null);
  assert.deepEqual(
    h.store.items().map((item) => item.item),
    ["Maito", "Kahvi", "Omenat", "Voi"],
  );
  await h.text("Not an item now");
  assert.equal(h.store.items().length, 4);
  await h.text(`/done ${id}`);
  assert.ok(h.lastText().includes("Merkitäänkö Imurointi"));
  await h.tap(`ta:done:${id}:0`, h.sent().at(-1)!.messageId!);
  assert.equal(h.store.task(id)?.last_done, "2026-10-13");
  await h.text("/done");
  assert.ok(h.lastText().includes("lisäystila ei ole päällä"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("/week and weekly button are repeatable reads; unfinished and snoozed tasks remain across weeks until done", async (t) => {
  const h = harness(t);
  const id = h.store.addTask("Imurointi", "2vk", "2026-10-01", {
    id: 10,
    name: "Jan",
  });
  h.store.changeTask(id, 0, "snooze", { id: 10, name: "Jan" }, "2026-11-01");
  const namedTaskButtons = () => {
    const board = h.sent().at(-1)!;
    const markup = board.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    return markup.inline_keyboard
      .flat()
      .filter((button) => button.callback_data === `task:${id}`);
  };
  await h.text("/week");
  assert.equal(namedTaskButtons().length, 1);
  assert.ok(namedTaskButtons()[0].text.includes("muistutus"));
  await h.text("📅 Viikon hommat");
  assert.equal(namedTaskButtons().length, 1);
  h.setTime("2026-10-20T09:00:00Z");
  await h.text("/week");
  assert.equal(namedTaskButtons().length, 1);
  assert.equal(h.store.task(id)?.last_done, null);
  assert.equal(h.store.task(id)?.revision, 1);
  assert.equal(h.store.reminderSent("2026-10-19", 10), false);
  await h.tap(`ta:done:${id}:1`, h.sent().at(-1)!.messageId!);
  assert.equal(h.store.task(id)?.last_done, "2026-10-20");
  assert.ok(h.lastText().includes("3.11.2026"));
  await h.text("/week");
  assert.equal(namedTaskButtons().length, 0);
  assert.ok(h.lastText().includes("Ei muistutettavia hommia"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("invalid group input re-prompts, and expiry never captures the next message", async (t) => {
  const h = harness(t);
  await h.text("/newtask", 10, -123);
  const original = h.session(-123).promptId;
  await h.text("x".repeat(201), 10, -123, original);
  assert.ok(h.lastText().includes("1–200"));
  const reprompt = h.session(-123).promptId;
  assert.notEqual(reprompt, original);
  await h.text("Imurointi", 10, -123, reprompt);
  assert.equal(h.session(-123).state.kind, "task-interval");
  h.setTime("2026-10-13T09:31:00Z");
  await h.text("2vk", 10, -123, h.session(-123).promptId);
  assert.equal(h.store.session(-123, 10), undefined);
  assert.ok(h.lastText().includes("vanheni"));
  assert.equal(h.store.tasks().length, 0);
  assert.equal(h.log.mock.callCount(), 0);
});

test("guided editing preserves or explicitly resets schedule and prevents overwriting concurrent changes", async (t) => {
  const h = harness(t);
  const id = h.store.addTask("Imurointi", "2vk", "2026-10-01", {
    id: 10,
    name: "Jan",
  });
  h.store.changeTask(id, 0, "done", { id: 10, name: "Jan" }, "2026-10-12");
  await h.text("/tasks");
  const board = h.sent().at(-1)!.messageId!;
  await h.tap(`edit:${id}:1`, board);
  await h.text("=");
  await h.tap("pick:1kk:10", h.session().promptId);
  await h.tap("date:keep:10", h.session().promptId);
  await h.tap("session:confirm:10", h.session().promptId);
  assert.equal(h.store.task(id)?.interval, "1kk");
  assert.equal(h.store.task(id)?.last_done, "2026-10-12");
  await h.text(`/edittask ${id} 1vk Uusi nimi`);
  await h.tap("date:today:10", h.session().promptId);
  const pending = h.session().promptId;
  h.store.changeTask(id, 2, "snooze", { id: 20, name: "Spouse" }, "2026-10-16");
  await h.tap("session:confirm:10", pending);
  assert.equal(h.store.task(id)?.name, "Imurointi");
  assert.equal(h.store.task(id)?.last_done, "2026-10-12");
  assert.ok(
    h.sent().some((call) => String(call.payload.text).includes("jo muutettu")),
  );
  assert.equal(h.log.mock.callCount(), 0);
});

test("archive requires explicit confirmation and can be restored; old legacy buttons only open current details", async (t) => {
  const h = harness(t);
  const id = h.store.addTask("Imurointi", "2vk", "2026-10-01", {
    id: 10,
    name: "Jan",
  });
  await h.text("/tasks");
  const messageId = h.sent().at(-1)!.messageId!;
  await h.tap(`archive:${id}:0`, messageId);
  assert.equal(h.store.task(id)?.archived_at, null);
  await h.tap(`ta:archive:${id}:0`, h.sent().at(-1)!.messageId!);
  assert.ok(h.store.task(id)?.archived_at);
  await h.tap(`ta:restore:${id}:1`, messageId);
  assert.equal(h.store.task(id)?.archived_at, null);
  await h.tap(`taskdone:${id}`, messageId);
  assert.equal(h.store.task(id)?.last_done, null);
  assert.ok(h.lastText().includes("Imurointi"));
  assert.equal(h.log.mock.callCount(), 0);
});

test("save failures are not misreported as authorization problems; successful saves survive view failures", async (t) => {
  const h = harness(t);
  await h.text("/list");
  h.failEdits();
  await h.text("/add Maito");
  assert.equal(h.store.items().length, 1);
  assert.ok(
    h
      .sent()
      .some((call) => String(call.payload.text).includes("Tallennus onnistui")),
  );
  assert.ok(h.log.mock.callCount() > 0);
  h.failSave();
  await h.text("Kahvi");
  assert.equal(h.store.items().length, 1);
  assert.ok(h.lastText().includes("Toiminto epäonnistui"));
  assert.ok(!h.lastText().includes("luvituksessa"));
});

test("missing tasks do not produce success confirmations and unauthorized callbacks are acknowledged", async (t) => {
  const h = harness(t);
  await h.text("/done 999");
  assert.ok(h.lastText().includes("ei löydy"));
  await h.text("/list", 30);
  assert.ok(h.lastText().includes("ei ole oikeuksia"));
  await h.tap("si:buy:1:0", 100, 30);
  assert.equal(h.calls.at(-1)!.method, "answerCallbackQuery");
  assert.ok(String(h.calls.at(-1)!.payload.text).includes("ei ole oikeuksia"));
});

test("unfinished creation survives bot restart and navigation explicitly ends capture", async (t) => {
  const h = harness(t);
  await h.text("/newtask 2vk Imurointi");
  h.restart();
  await h.tap("date:today:10", h.session().promptId);
  h.restart();
  await h.tap("session:confirm:10", h.session().promptId);
  assert.equal(h.store.tasks()[0].name, "Imurointi");
  await h.text("/add");
  await h.text("Maito");
  await h.text("/tasks");
  assert.equal(h.store.session(10, 10), undefined);
  await h.text("Ordinary task discussion");
  assert.deepEqual(
    h.store.items().map((item) => item.item),
    ["Maito"],
  );
  assert.equal(h.log.mock.callCount(), 0);
});
