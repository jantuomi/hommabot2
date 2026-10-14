import { Context, Markup, Telegraf, TelegramError } from "telegraf";
import { message } from "telegraf/filters";
import { authorization } from "./middleware";
import { InputError } from "./errors";
import type {
  Actor,
  HouseholdStore,
  Mutation,
  Session,
  SessionState,
  View,
} from "./storage";
import {
  addDaysToDate,
  getNextDate,
  intervalLabel,
  parseInterval,
  today,
  validDate,
} from "./tasks";
import { displayDate, displayName, homeKeyboard, renderView } from "./ui";

const SESSION_MS = 30 * 60 * 1000;
const callback = Markup.button.callback;
const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const mutationFailure = (kind: Exclude<Mutation["kind"], "changed">): string =>
  kind === "missing"
    ? "Kohdetta ei löydy. Avaa lista uudelleen."
    : kind === "stale"
      ? "Kohdetta on jo muutettu. Päivitä näkymä; vanhaa toimintoa ei tehty."
      : "Kohde on jo tässä tilassa. Uutta muutosta ei tehty.";
const unavailableView = (error: unknown): error is TelegramError =>
  error instanceof TelegramError &&
  (error.code === 403 ||
    /message (to edit not found|can't be edited)/i.test(error.description));
const help =
  "🛒 Ostoslista: napauta tuotetta merkitäksesi sen ostetuksi. Ostetut ja poistetut voi palauttaa.\n\n" +
  "➕ Ostoksia: käynnistä lisäystila ja lähetä tuotteita yksi per rivi, myös useassa viestissä. " +
  "Lopeta /done-komennolla, Valmis-painikkeella tai /cancel. Jo lisätyt tuotteet säilyvät. " +
  "Ryhmässä botti avaa vastauksen lisäyspyyntöön automaattisesti, jotta viesti tulee perille myös yksityisyystilassa. Älä sulje vastausta ennen lähettämistä.\n\n" +
  "📅 Viikon hommat tai /week näyttää tämän viikon ja myöhässä olevat hommat uudelleen. " +
  "Tekemättömät hommat pysyvät näkyvissä, myös siirretyt muistutukset. Valitse homma, merkitse tehdyksi tai siirrä muistutusta. " +
  "Toisto lasketaan todellisesta valmistumisesta. Muistutus ei merkitse hommaa tehdyksi.\n\n" +
  "Viimeisimmän muutoksen voi kumota. Vanhempi kumoaminen estetään, jos kohdetta on sittemmin muutettu.\n\n" +
  "/start ottaa tämän keskustelun viikkomuistutukset käyttöön. /stop poistaa vain muistutukset.\n" +
  "Pikakomennot: /list, /add (tuote per rivi), /tasks, /newtask 2vk Imurointi, " +
  "/week, /done (lopeta ostosten lisäys), /done <id>, /edittask <id> <intervalli> <nimi>.\n" +
  "Intervallit: 1pv, 2vk, 1kk, 1v. Päivämäärät: VVVV-KK-PP.";

export const createHouseholdBot = (
  token: string,
  store: HouseholdStore,
  timeZone = "Europe/Helsinki",
  clock: () => Date = () => new Date(),
) => {
  const bot = new Telegraf(token);
  const day = () => today(timeZone, clock());
  const actor = (ctx: Context): Actor => {
    if (!ctx.from) throw new Error("Missing actor");
    return {
      id: ctx.from.id,
      name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
    };
  };
  const ids = (ctx: Context) => {
    if (!ctx.chat || !ctx.from) throw new Error("Missing chat or user");
    return { chatId: ctx.chat.id, userId: ctx.from.id };
  };

  // Telegram updates may overlap; serialize read/modify/write interaction flows.
  let tail: Promise<void> = Promise.resolve();
  bot.use(async (_ctx, next) => {
    const preceding = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      await next();
    } finally {
      release();
    }
  });
  bot.use(authorization(store));
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      const session = store.session(ids(ctx).chatId, ids(ctx).userId);
      const text = `${error.message}\nKorjaa syöte ja yritä uudelleen. /cancel peruuttaa.`;
      if (session && session.expiresAt > clock().getTime()) {
        await prompt(
          ctx,
          session.state,
          `${text}\nRyhmässä vastaa tähän viestiin.`,
        );
      } else {
        await ctx.reply(text);
      }
    }
  });

  const show = async (
    ctx: Context,
    view: View,
    edit = false,
    targetMessageId?: number,
  ) => {
    const screen = renderView(store, view, day());
    const { chatId } = ids(ctx);
    const messageId =
      targetMessageId ??
      (ctx.callbackQuery && "message" in ctx.callbackQuery
        ? ctx.callbackQuery.message?.message_id
        : undefined);
    if (edit && messageId !== undefined) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          screen.text,
          screen.keyboard,
        );
      } catch (error) {
        if (unavailableView(error)) {
          store.forgetView(chatId, messageId);
          console.warn(
            "[views] Opening replacement view:",
            chatId,
            messageId,
            error.description,
          );
          const sent = await ctx.reply(
            `Vanha näkymä ei ole enää muokattavissa. Tässä nykyinen tilanne:\n\n${screen.text}`,
            screen.keyboard,
          );
          store.trackView(chatId, sent.message_id, view);
          return;
        }
        if (
          !(error instanceof TelegramError) ||
          !error.description.includes("message is not modified")
        ) {
          throw error;
        }
      }
      store.trackView(chatId, messageId, view);
    } else {
      const sent = await ctx.reply(screen.text, screen.keyboard);
      store.trackView(chatId, sent.message_id, view);
    }
  };

  const refreshViews = async (): Promise<boolean> => {
    let failed = false;
    for (const tracked of store.views()) {
      const screen = renderView(store, tracked.view, day());
      try {
        await bot.telegram.editMessageText(
          tracked.chatId,
          tracked.messageId,
          undefined,
          screen.text,
          screen.keyboard,
        );
      } catch (error) {
        if (
          error instanceof TelegramError &&
          error.description.includes("message is not modified")
        ) {
          continue;
        }
        if (unavailableView(error)) {
          store.forgetView(tracked.chatId, tracked.messageId);
          console.warn(
            "[views] Retiring unavailable view:",
            tracked.chatId,
            tracked.messageId,
            error.description,
          );
          continue;
        }
        console.error(
          "[views] Refresh failed:",
          tracked.chatId,
          tracked.messageId,
          error,
        );
        failed = true;
      }
    }
    return !failed;
  };

  const feedback = async (ctx: Context, result: Mutation, text: string) => {
    const updated = await refreshViews();
    if (result.kind === "changed") {
      const event = store.event(result.eventId);
      if (!event) throw new Error("Mutation history missing");
      const keyboard =
        event.action === "undo"
          ? undefined
          : Markup.inlineKeyboard([
              [callback("Kumoa", `undo:${result.eventId}`)],
            ]);
      await ctx.reply(
        `${text}${updated ? "" : "\nMuutos tallennettiin, mutta kaikkia näkymiä ei voitu päivittää. Käytä Päivitä-painiketta."}`,
        keyboard,
      );
    } else {
      await ctx.reply(mutationFailure(result.kind));
    }
  };

  const shoppingFeedback = async (
    ctx: Context,
    result: Mutation,
    text: string,
    id: number,
    promptId?: number,
  ) => {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(
        result.kind === "changed" ? text : mutationFailure(result.kind),
        { show_alert: result.kind === "missing" || result.kind === "stale" },
      );
    } else if (result.kind !== "changed") {
      await ctx.reply(mutationFailure(result.kind));
    }
    const messageId =
      promptId ??
      (ctx.callbackQuery && "message" in ctx.callbackQuery
        ? ctx.callbackQuery.message?.message_id
        : undefined);
    let sourceRefreshFailed = false;
    if (messageId !== undefined) {
      const { chatId } = ids(ctx);
      const view = store
        .views()
        .find(
          (tracked) =>
            tracked.chatId === chatId && tracked.messageId === messageId,
        )?.view;
      const showsItem =
        view?.kind === "shopping" ||
        (view?.kind === "item" && view.id === id) ||
        (view?.kind === "history" &&
          view.entity === "shopping" &&
          view.id === id);
      if (!showsItem) {
        try {
          await show(ctx, { kind: "item", id }, true, messageId);
        } catch (error) {
          if (!(error instanceof TelegramError)) throw error;
          console.error("[views] Refresh failed:", chatId, messageId, error);
          sourceRefreshFailed = true;
        }
      }
    }
    const updated = await refreshViews();
    if (!updated || sourceRefreshFailed) {
      await ctx.reply(
        result.kind === "changed"
          ? "Muutos tallennettiin, mutta kaikkia näkymiä ei voitu päivittää. Käytä Päivitä-painiketta."
          : "Kaikkia näkymiä ei voitu päivittää. Avaa /list uudelleen.",
      );
    }
  };

  const finishSession = async (ctx: Context, showShoppingList = true) => {
    const { chatId, userId } = ids(ctx);
    const state = store.session(chatId, userId)?.state;
    store.clearSession(chatId, userId);
    let text = "Syöttö lopetettu. Jo tallennetut muutokset säilyvät.";
    if (state?.kind === "shopping-add") {
      text = "🛒 Ostosten lisäystila lopetettu.";
      text +=
        state.addedCount === undefined
          ? " Jo lisätyt tuotteet säilyvät."
          : ` Lisätty ${state.addedCount} tuotetta.`;
      if (state.receivedCount === 0) {
        text += "\nEn vastaanottanut yhtään tuoteviestiä.";
        if (ctx.chat?.type !== "private") {
          text +=
            "\nJos kirjoitit tuotteita, ne eivät tulleet botille asti. Aloita /add uudelleen ja lähetä tuotteet vastauksena botin lisäyspyyntöön.";
        }
      }
    }
    await ctx.reply(text, homeKeyboard);
    if (state?.kind === "shopping-add" && showShoppingList) {
      await show(ctx, shoppingView);
    }
  };

  const prompt = async (ctx: Context, state: SessionState, text: string) => {
    const { chatId, userId } = ids(ctx);
    const rows = [
      [
        callback(
          state.kind === "shopping-add" ? "Valmis" : "Peruuta",
          `session:end:${userId}`,
        ),
      ],
    ];
    if (state.kind === "shopping-add" && state.duplicates?.length) {
      rows.unshift([
        callback("Lisää päällekkäisetkin", `session:duplicates:${userId}`),
      ]);
    }
    if (state.kind === "task-interval" || state.kind === "task-edit-interval") {
      rows.unshift([
        callback("Viikko", `pick:1vk:${userId}`),
        callback("2 viikkoa", `pick:2vk:${userId}`),
        callback("Kuukausi", `pick:1kk:${userId}`),
      ]);
    }
    if (state.kind === "task-date" || state.kind === "task-edit-date") {
      rows.unshift([
        callback("Tänään", `date:today:${userId}`),
        callback("Huomenna", `date:tomorrow:${userId}`),
      ]);
      if (state.kind === "task-edit-date") {
        rows.unshift([
          callback("Säilytä nykyinen aikataulu", `date:keep:${userId}`),
        ]);
      }
    }
    if (state.kind === "task-confirm" || state.kind === "task-edit-confirm") {
      rows.unshift([callback("Tallenna", `session:confirm:${userId}`)]);
    }
    const groupShopping =
      state.kind === "shopping-add" && ctx.chat?.type !== "private";
    const sent = await ctx.reply(
      groupShopping
        ? "🛒 Lisäystilan painikkeet. Valmis lopettaa lisäyksen."
        : text,
      Markup.inlineKeyboard(rows),
    );
    store.setSession(chatId, userId, {
      state,
      promptId: sent.message_id,
      expiresAt: clock().getTime() + SESSION_MS,
    });
    if (groupShopping) {
      // ForceReply and inline buttons need separate messages; callbacks use the controls' ID.
      await ctx.reply(
        `<a href="tg://user?id=${userId}">${escapeHtml(actor(ctx).name)}</a>\n${escapeHtml(text)}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            selective: true,
            input_field_placeholder: "Tuotteet yksi per rivi · /done lopettaa",
          },
        },
      );
    }
  };

  const currentSession = async (
    ctx: Context,
    requirePrompt = false,
  ): Promise<Session | undefined> => {
    const { chatId, userId } = ids(ctx);
    const session = store.session(chatId, userId);
    if (!session) {
      if (requirePrompt)
        await ctx.reply(
          "Tämä syöttövaihe ei ole enää aktiivinen. Aloita uudelleen valikosta.",
        );
      return undefined;
    }
    if (session.expiresAt <= clock().getTime()) {
      store.clearSession(chatId, userId);
      await ctx.reply(
        "Syöttövaihe vanheni 30 minuutin jälkeen. Viestiä ei tallennettu. Aloita uudelleen valikosta.",
        homeKeyboard,
      );
      return undefined;
    }
    if (requirePrompt) {
      const messageId =
        ctx.callbackQuery && "message" in ctx.callbackQuery
          ? ctx.callbackQuery.message?.message_id
          : undefined;
      if (messageId !== session.promptId) {
        await ctx.reply(
          "Tämä on vanha syöttöpyyntö. Käytä uusimman viestin painikkeita.",
        );
        return undefined;
      }
    }
    return session;
  };

  const shoppingView: View = {
    kind: "shopping",
    tab: "active",
    page: 0,
    edit: false,
  };
  const tasksView: View = { kind: "tasks", tab: "due", page: 0 };
  const allTasksView: View = { kind: "tasks", tab: "all", page: 0 };
  const openBoard = async (ctx: Context, view: View) => {
    const { chatId, userId } = ids(ctx);
    if (store.session(chatId, userId)) {
      await finishSession(ctx, false);
    }
    await show(ctx, view);
  };
  const startShopping = async (ctx: Context) => {
    await show(ctx, shoppingView);
    await prompt(
      ctx,
      { kind: "shopping-add", addedCount: 0, receivedCount: 0 },
      "🛒 Ostosten lisäystila on päällä tässä keskustelussa vain sinulle.\n" +
        "Lähetä tuotteita yksi per rivi (enintään 30 kerralla, nimi enintään 200 merkkiä).\n" +
        "Voit lähettää useita viestejä ilman /add-komentoa. Ryhmässä lähetä tuotteet automaattisesti avattuun vastaukseen, jotta botti saa viestisi.\n" +
        "Esim:\nMaito 2 l\nKahvi\nOmenat\n\n/done, Valmis tai /cancel lopettaa; jo lisätyt tuotteet säilyvät.",
    );
  };

  const addShopping = async (
    ctx: Context,
    text: string,
    allowDuplicates = false,
  ) => {
    const { chatId, userId } = ids(ctx);
    const previous = store.session(chatId, userId);
    const base: Extract<SessionState, { kind: "shopping-add" }> =
      previous?.state.kind === "shopping-add" &&
      previous.expiresAt > clock().getTime()
        ? previous.state
        : { kind: "shopping-add", addedCount: 0, receivedCount: 0 };
    const state = {
      ...base,
      receivedCount:
        base.receivedCount === undefined
          ? undefined
          : base.receivedCount + Number(ctx.updateType === "message"),
    };
    const persist = (next: typeof state) =>
      store.setSession(chatId, userId, {
        state: next,
        promptId: 0,
        expiresAt: clock().getTime() + SESSION_MS,
      });
    persist(state);
    const names = text
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    const result = store.addItems(names, actor(ctx), allowDuplicates);
    const nextState = {
      ...state,
      duplicates: result.duplicates,
      addedCount:
        state.addedCount === undefined
          ? undefined
          : state.addedCount + result.added.length,
    };
    persist(nextState);
    const updated = await refreshViews();
    const summary = result.added.length
      ? `Lisätty ${result.added.length}: ${result.added
          .slice(0, 8)
          .map((item) => item.item.slice(0, 44))
          .join(", ")}${result.added.length > 8 ? "…" : ""}.`
      : "Uusia tuotteita ei lisätty.";
    const duplicates = result.duplicates.length
      ? `\nJo listalla (${result.duplicates.length}): ${result.duplicates
          .slice(0, 8)
          .map((name) => name.slice(0, 44))
          .join(
            ", ",
          )}.\nLisää ne erikseen painikkeella tai jatka muilla tuotteilla.`
      : "";
    await prompt(
      ctx,
      nextState,
      `${summary}${duplicates}\nLisäystila on päällä: jatka lähettämällä tuotteita. /done lopettaa.${updated ? "" : "\nTallennus onnistui, mutta näkymän päivitys epäonnistui. Käytä Päivitä-painiketta."}`,
    );
  };

  const intervalPrompt = (ctx: Context, state: SessionState) =>
    prompt(
      ctx,
      state,
      "Kuinka usein homma toistuu valmistumisesta?\nValitse painike tai lähetä esim. 2vk, 1kk, 3pv tai 1v.\nRyhmässä vastaa tähän viestiin.",
    );
  const datePrompt = (ctx: Context, state: SessionState) =>
    prompt(
      ctx,
      state,
      state.kind === "task-edit-date"
        ? "Säilytetäänkö aikataulu? Voit myös asettaa uuden eräpäivän (VVVV-KK-PP).\n" +
            "Uusi eräpäivä tyhjentää nykyisen valmistumismerkinnän, mutta säilyttää sen historiassa.\nRyhmässä vastaa tähän viestiin."
        : "Milloin homma on ensimmäisen kerran tehtävä?\nValitse painike tai lähetä VVVV-KK-PP. Ryhmässä vastaa tähän viestiin.",
    );

  const acceptDate = async (
    ctx: Context,
    state: Extract<SessionState, { kind: "task-date" | "task-edit-date" }>,
    date?: string,
  ) => {
    if (date !== undefined && !validDate(date))
      throw new InputError("Käytä oikeaa päivämäärää muodossa VVVV-KK-PP.");
    if (state.kind === "task-date") {
      if (!date) throw new InputError("Ensimmäinen eräpäivä tarvitaan.");
      await prompt(
        ctx,
        { ...state, kind: "task-confirm", firstDue: date },
        `Uusi homma: ${state.name}\nToistuu: ${intervalLabel(state.interval)} valmistumisesta\n` +
          `Ensimmäinen eräpäivä: ${displayDate(date)}\nTallenna tai peruuta.`,
      );
    } else {
      const task = store.task(state.id);
      if (!task || task.revision !== state.revision || task.archived_at) {
        store.clearSession(ids(ctx).chatId, ids(ctx).userId);
        await ctx.reply(
          "Hommaa on muutettu. Avaa sen tiedot ja aloita muokkaus uudelleen.",
        );
        return;
      }
      const next = date ?? getNextDate({ ...task, interval: state.interval });
      await prompt(
        ctx,
        { ...state, kind: "task-edit-confirm", firstDue: date },
        `Muokattu homma: ${state.name}\nToistuu: ${intervalLabel(state.interval)} valmistumisesta\n` +
          `Seuraava: ${displayDate(next)}\n${date ? "Nykyinen valmistumispäivä tyhjennetään; historia säilyy." : "Valmistumispäivä säilytetään."}\nTallenna tai peruuta.`,
      );
    }
  };

  const acceptInterval = async (
    ctx: Context,
    state: Extract<
      SessionState,
      { kind: "task-interval" | "task-edit-interval" }
    >,
    value: string,
  ) => {
    parseInterval(value);
    await datePrompt(
      ctx,
      state.kind === "task-interval"
        ? { ...state, kind: "task-date", interval: value }
        : { ...state, kind: "task-edit-date", interval: value },
    );
  };

  bot.command("start", async (ctx) => {
    store.subscribe(ctx.chat.id);
    await ctx.reply(
      "HommaBot käytössä. Tämän keskustelun viikkomuistutukset ovat päällä (maanantaisin klo 9).",
      homeKeyboard,
    );
    await openBoard(ctx, tasksView);
  });
  bot.command("stop", async (ctx) => {
    store.unsubscribe(ctx.chat.id);
    await ctx.reply(
      "Tämän keskustelun viikkomuistutukset poistettu. Listat ja hommat ovat yhä käytettävissä.",
      homeKeyboard,
    );
  });
  bot.command("help", (ctx) => ctx.reply(help, homeKeyboard));
  bot.command("list", (ctx) => openBoard(ctx, shoppingView));
  bot.command("tasks", (ctx) => openBoard(ctx, tasksView));
  bot.command("week", (ctx) => openBoard(ctx, tasksView));
  bot.command("cancel", async (ctx) => {
    await finishSession(ctx);
  });
  bot.command("add", async (ctx) => {
    const text = ctx.message.text.replace(/^\/add(?:@\w+)?\s*/, "").trim();
    if (!text) return startShopping(ctx);
    await show(ctx, shoppingView);
    await addShopping(ctx, text);
  });
  bot.command("newtask", async (ctx) => {
    const args = ctx.message.text.replace(/^\/newtask(?:@\w+)?\s*/, "").trim();
    if (!args)
      return prompt(
        ctx,
        { kind: "task-name" },
        "Mikä homma? Lähetä nimi (1–200 merkkiä). Ryhmässä vastaa tähän viestiin.",
      );
    const match = /^(\S+)\s+(.+)$/.exec(args);
    if (!match)
      throw new InputError(
        "Käyttö: /newtask 2vk Imurointi tai /newtask ilman lisätietoja.",
      );
    parseInterval(match[1]);
    if (!match[2].trim() || match[2].length > 200)
      throw new InputError("Nimen pitää olla 1–200 merkkiä.");
    await datePrompt(ctx, {
      kind: "task-date",
      interval: match[1],
      name: match[2].trim(),
    });
  });
  bot.command("done", async (ctx) => {
    const value = ctx.message.text.replace(/^\/done(?:@\w+)?\s*/, "").trim();
    if (!value) {
      const session = store.session(ctx.chat.id, ctx.from.id);
      if (session?.state.kind === "shopping-add") {
        await finishSession(ctx);
      } else {
        await ctx.reply(
          "Ostosten lisäystila ei ole päällä. /add käynnistää sen. Homman valmistuminen: /done <id> tai homman Tehty-painike.",
          homeKeyboard,
        );
      }
      return;
    }
    if (!/^[1-9]\d*$/.test(value)) throw new InputError("Käyttö: /done <id>.");
    const task = store.task(Number(value));
    if (!task)
      return ctx.reply("Hommaa ei löydy. /tasks näyttää nykyiset hommat.");
    // Commands also use an explicit confirmation, so repeated old commands cannot advance a task.
    await ctx.reply(
      `Merkitäänkö ${displayName(task.name)} tehdyksi tänään?`,
      Markup.inlineKeyboard([
        [callback("✅ Tehty tänään", `ta:done:${task.id}:${task.revision}`)],
        [callback("Avaa homma", `task:${task.id}`)],
      ]),
    );
  });
  bot.command("edittask", async (ctx) => {
    const args = ctx.message.text.replace(/^\/edittask(?:@\w+)?\s*/, "").trim();
    const match = /^([1-9]\d*)\s+(\S+)\s+(.+)$/.exec(args);
    if (!match)
      throw new InputError("Käyttö: /edittask <id> <intervalli> <nimi>.");
    parseInterval(match[2]);
    if (match[3].length > 200)
      throw new InputError("Nimen pitää olla 1–200 merkkiä.");
    const task = store.task(Number(match[1]));
    if (!task || task.archived_at)
      return ctx.reply("Aktiivista hommaa ei löydy.");
    await datePrompt(ctx, {
      kind: "task-edit-date",
      id: task.id,
      revision: task.revision,
      name: match[3].trim(),
      interval: match[2],
    });
  });

  bot.hears("🛒 Ostoslista", (ctx) => openBoard(ctx, shoppingView));
  bot.hears("📋 Hommat", (ctx) => openBoard(ctx, tasksView));
  bot.hears("📅 Viikon hommat", (ctx) => openBoard(ctx, tasksView));
  bot.hears("📋 Kaikki hommat", (ctx) => openBoard(ctx, allTasksView));
  bot.hears("➕ Ostoksia", startShopping);
  bot.hears("➕ Uusi homma", (ctx) =>
    prompt(
      ctx,
      { kind: "task-name" },
      "Mikä homma? Lähetä nimi (1–200 merkkiä). Ryhmässä vastaa tähän viestiin.",
    ),
  );
  bot.hears("ℹ️ Ohje", (ctx) => ctx.reply(help, homeKeyboard));

  bot.action("capture", async (ctx) => {
    await ctx.answerCbQuery();
    await startShopping(ctx);
  });
  bot.action("newtask", async (ctx) => {
    await ctx.answerCbQuery();
    await prompt(
      ctx,
      { kind: "task-name" },
      "Mikä homma? Lähetä nimi (1–200 merkkiä). Ryhmässä vastaa tähän viestiin.",
    );
  });
  bot.action(/^sh:(active|bought|removed):(\d+):([01])$/, async (ctx) => {
    await ctx.answerCbQuery();
    await show(
      ctx,
      {
        kind: "shopping",
        tab: ctx.match[1] as "active" | "bought" | "removed",
        page: Number(ctx.match[2]),
        edit: ctx.match[3] === "1",
      },
      true,
    );
  });
  bot.action(/^tl:(due|all|archived):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await show(
      ctx,
      {
        kind: "tasks",
        tab: ctx.match[1] as "due" | "all" | "archived",
        page: Number(ctx.match[2]),
      },
      true,
    );
  });
  bot.action(/^(task|item):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await show(
      ctx,
      { kind: ctx.match[1] as "task" | "item", id: Number(ctx.match[2]) },
      true,
    );
  });
  bot.action(/^hi:(task|shopping):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await show(
      ctx,
      {
        kind: "history",
        entity: ctx.match[1] as "task" | "shopping",
        id: Number(ctx.match[2]),
        page: Number(ctx.match[3]),
      },
      true,
    );
  });
  bot.action(/^si:(buy|restore|remove):(\d+):(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[2]);
    const item = store.item(id);
    const action = ctx.match[1] as "buy" | "restore" | "remove";
    const result = store.changeItem(
      id,
      Number(ctx.match[3]),
      action,
      actor(ctx),
    );
    const label =
      action === "buy"
        ? "merkitty ostetuksi"
        : action === "remove"
          ? "poistettu (palautettavissa)"
          : "palautettu";
    await shoppingFeedback(
      ctx,
      result,
      `${displayName(item?.item ?? "Tuote", 80)} ${label}.`,
      id,
    );
  });
  bot.action(/^rename:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const item = store.item(Number(ctx.match[1]));
    if (!item || item.revision !== Number(ctx.match[2]))
      return ctx.reply("Tuotetta on muutettu. Päivitä näkymä.");
    await show(ctx, { kind: "item", id: item.id }, true);
    await prompt(
      ctx,
      { kind: "shopping-rename", id: item.id, revision: item.revision },
      `Tuote: ${displayName(item.item)}\nLähetä uusi nimi (1–200 merkkiä). Ryhmässä vastaa tähän viestiin.`,
    );
  });
  bot.action(/^ta:(done|restore|archive):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[2]);
    const task = store.task(id);
    const action = ctx.match[1] as "done" | "restore" | "archive";
    const result = store.changeTask(
      id,
      Number(ctx.match[3]),
      action,
      actor(ctx),
      day(),
    );
    const current = store.task(id);
    if (result.kind === "changed" && !current)
      throw new Error("Updated task missing");
    const text =
      action === "done"
        ? `✅ ${displayName(task?.name ?? "Homma")} tehty tänään.${result.kind === "changed" && current ? ` Seuraava: ${displayDate(getNextDate(current))}.` : ""}`
        : `${displayName(task?.name ?? "Homma")} ${action === "archive" ? "arkistoitu (palautettavissa)" : "palautettu"}.`;
    await feedback(ctx, result, text);
  });
  bot.action(/^archive:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = store.task(Number(ctx.match[1]));
    if (!task || task.revision !== Number(ctx.match[2]))
      return ctx.reply("Hommaa on muutettu. Päivitä näkymä.");
    await ctx.reply(
      `Arkistoidaanko ${displayName(task.name)}? Muistutukset loppuvat. Homman voi palauttaa Arkisto-näkymästä.`,
      Markup.inlineKeyboard([
        [callback("Arkistoi", `ta:archive:${task.id}:${task.revision}`)],
        [callback("Peruuta / avaa homma", `task:${task.id}`)],
      ]),
    );
  });
  bot.action(/^snooze:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = store.task(Number(ctx.match[1]));
    if (!task || task.revision !== Number(ctx.match[2]))
      return ctx.reply("Hommaa on muutettu. Päivitä näkymä.");
    await ctx.reply(
      `${displayName(task.name)}: kuinka pitkälle muistutusta siirretään? Eräpäivä ei muutu.`,
      Markup.inlineKeyboard([
        [1, 3, 7].map((days) =>
          callback(`${days} pv`, `ts:${task.id}:${task.revision}:${days}`),
        ),
        [callback("Takaisin", `task:${task.id}`)],
      ]),
    );
  });
  bot.action(/^ts:(\d+):(\d+):(1|3|7)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    const date = addDaysToDate(day(), Number(ctx.match[3]));
    const result = store.changeTask(
      id,
      Number(ctx.match[2]),
      "snooze",
      actor(ctx),
      date,
    );
    await feedback(
      ctx,
      result,
      `${displayName(store.task(id)?.name ?? "Homma")}: muistutus siirretty päivään ${displayDate(date)}. Eräpäivä ei muuttunut.`,
    );
  });
  bot.action(/^edit:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = store.task(Number(ctx.match[1]));
    if (!task || task.archived_at || task.revision !== Number(ctx.match[2]))
      return ctx.reply("Hommaa on muutettu. Päivitä näkymä.");
    await prompt(
      ctx,
      { kind: "task-edit-name", id: task.id, revision: task.revision },
      `Nykyinen nimi: ${displayName(task.name)}\nLähetä uusi nimi tai = säilyttääksesi nimen. Ryhmässä vastaa tähän viestiin.`,
    );
  });
  bot.action(/^undo:(\d+)$/, async (ctx) => {
    const event = store.event(Number(ctx.match[1]));
    const entity =
      event?.entity === "task"
        ? store.task(event.entity_id)
        : event
          ? store.item(event.entity_id)
          : undefined;
    const name = entity && ("name" in entity ? entity.name : entity.item);
    const result = store.undo(Number(ctx.match[1]), actor(ctx), day());
    if (event?.entity === "shopping") {
      await shoppingFeedback(
        ctx,
        result,
        `${displayName(name || "Tuote", 80)}: muutos kumottu.`,
        event.entity_id,
      );
      return;
    }
    await ctx.answerCbQuery();
    await feedback(
      ctx,
      result,
      `${displayName(name || "Kohde")}: viimeisin merkintä kumottu. Aikaisempi tila palautettiin.`,
    );
  });

  bot.action(
    /^(session:(?:end|duplicates|confirm)|pick:(?:1vk|2vk|1kk)|date:(?:today|tomorrow|keep)):(\d+)$/,
    async (ctx) => {
      if (ctx.from.id !== Number(ctx.match[2])) {
        await ctx.answerCbQuery(
          "Tämä syöttövaihe kuuluu toiselle käyttäjälle.",
          { show_alert: true },
        );
        return;
      }
      await ctx.answerCbQuery();
      const session = await currentSession(ctx, true);
      if (!session) return;
      const { state } = session;
      const operation = ctx.match[1];
      if (operation === "session:end") {
        await finishSession(ctx);
      } else if (
        operation === "session:duplicates" &&
        state.kind === "shopping-add" &&
        state.duplicates?.length
      ) {
        await addShopping(ctx, state.duplicates.join("\n"), true);
      } else if (
        operation.startsWith("pick:") &&
        (state.kind === "task-interval" || state.kind === "task-edit-interval")
      ) {
        await acceptInterval(ctx, state, operation.slice(5));
      } else if (
        operation.startsWith("date:") &&
        (state.kind === "task-date" || state.kind === "task-edit-date")
      ) {
        if (operation === "date:keep" && state.kind !== "task-edit-date") {
          throw new InputError("Uudelle hommalle tarvitaan eräpäivä.");
        }
        await acceptDate(
          ctx,
          state,
          operation === "date:keep"
            ? undefined
            : operation === "date:today"
              ? day()
              : addDaysToDate(day(), 1),
        );
      } else if (
        operation === "session:confirm" &&
        state.kind === "task-confirm"
      ) {
        const id = store.addTask(
          state.name,
          state.interval,
          state.firstDue,
          actor(ctx),
        );
        store.clearSession(ids(ctx).chatId, ctx.from.id);
        const refreshed = await refreshViews();
        await ctx.reply(
          `✅ ${state.name} tallennettu.${refreshed ? "" : " Näkymän päivitys epäonnistui; käytä Päivitä-painiketta."}`,
          homeKeyboard,
        );
        await show(ctx, { kind: "task", id });
      } else if (
        operation === "session:confirm" &&
        state.kind === "task-edit-confirm"
      ) {
        const result = store.changeTask(
          state.id,
          state.revision,
          "edit",
          actor(ctx),
          day(),
          state,
        );
        store.clearSession(ids(ctx).chatId, ctx.from.id);
        await feedback(ctx, result, `${state.name}: muutokset tallennettu.`);
        await show(ctx, { kind: "task", id: state.id });
      } else {
        await ctx.reply(
          "Tämä toiminto ei kuulu nykyiseen syöttövaiheeseen. Käytä uusimman viestin painikkeita.",
        );
      }
    },
  );

  // Old messages remain usable after the upgrade without trusting their stale state.
  bot.action(/^(del|taskdone|taskdel):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery(
      "Toiminnot ovat uudistuneet. Avaa nykyinen näkymä.",
    );
    await show(ctx, {
      kind: ctx.match[1] === "del" ? "item" : "task",
      id: Number(ctx.match[2]),
    });
  });

  bot.on(message("text"), async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply(
        "Tuntematon komento. /help näyttää ohjeet.",
        homeKeyboard,
      );
      return;
    }
    const session = await currentSession(ctx);
    if (!session) {
      if (ctx.chat.type === "private") {
        await ctx.reply(
          "Lisää ostoksia tai uusi homma valikosta. Viestiä ei tallennettu.",
          homeKeyboard,
        );
      }
      return;
    }
    if (
      session.state.kind !== "shopping-add" &&
      ctx.chat.type !== "private" &&
      ctx.message.reply_to_message?.message_id !== session.promptId
    ) {
      // Ordinary household group conversation must not become shopping input.
      if (ctx.message.reply_to_message?.from?.id === ctx.botInfo.id) {
        await ctx.reply(
          "Vastaa uusimpaan syöttöpyyntöön tai lopeta /cancel-komennolla. Viestiä ei tallennettu.",
        );
      }
      return;
    }
    const value = ctx.message.text.trim();
    const { state } = session;
    switch (state.kind) {
      case "shopping-add":
        await addShopping(ctx, value);
        break;
      case "shopping-rename": {
        const result = store.changeItem(
          state.id,
          state.revision,
          "rename",
          actor(ctx),
          value,
        );
        store.clearSession(ctx.chat.id, ctx.from.id);
        await shoppingFeedback(
          ctx,
          result,
          `${displayName(value, 80)}: nimi tallennettu.`,
          state.id,
          session.promptId,
        );
        break;
      }
      case "task-name":
      case "task-edit-name": {
        const name =
          state.kind === "task-edit-name" && value === "="
            ? store.task(state.id)?.name
            : value;
        if (!name || name.length > 200 || /[\r\n]/.test(name)) {
          throw new InputError(
            "Nimen pitää olla 1–200 merkkiä yhdellä rivillä.",
          );
        }
        await intervalPrompt(
          ctx,
          state.kind === "task-name"
            ? { kind: "task-interval", name }
            : { ...state, kind: "task-edit-interval", name },
        );
        break;
      }
      case "task-interval":
      case "task-edit-interval":
        await acceptInterval(ctx, state, value);
        break;
      case "task-date":
      case "task-edit-date":
        await acceptDate(ctx, state, value);
        break;
      case "task-confirm":
      case "task-edit-confirm":
        await ctx.reply(
          "Tarkista tiedot ja käytä viimeisimmän viestin Tallenna- tai Peruuta-painiketta.",
        );
        break;
    }
  });
  bot.on("callback_query", (ctx) =>
    ctx.answerCbQuery(
      "Vanha tai tuntematon painike. Avaa /list tai /tasks uudelleen.",
      { show_alert: true },
    ),
  );

  bot.catch(async (error, ctx) => {
    console.error("[bot] Interaction failed:", error);
    try {
      await ctx.reply(
        "Toiminto epäonnistui. Päivitä lista tai homman tiedot ennen uutta yritystä; jo tallennetut muutokset voivat näkyä siellä.",
        homeKeyboard,
      );
    } catch (notificationError) {
      console.error(
        "[bot] Could not notify user of failed interaction:",
        notificationError,
      );
    }
  });
  return { bot, refreshViews, show };
};
