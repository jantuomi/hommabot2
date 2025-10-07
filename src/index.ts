import { buildSheetsClient } from "./sheets";
import { broadcastMessage } from "./tg";

const main = async (): Promise<void> => {
  const startTime = Date.now();
  console.log("[run] Starting recurring tasks notification script");

  const sheets = await buildSheetsClient();

  // 1. Fetch raw sheet data
  const sheetData = await sheets.fetchSheetData();
  console.log(`[run] Retrieved ${sheetData.length} raw rows from Sheets`);

  // 2. Process rows (compute next/last dates)
  const entries = sheets.processRows(sheetData);
  console.log(`[run] Processed ${entries.length} entries`);

  // 3. Filter only tasks due this week
  const thisWeeksEntries = sheets.filterOnlyThisWeek(entries);
  console.log(`[run] Found ${thisWeeksEntries.length} entries due this week`);

  // 4. Compose & broadcast Telegram message
  if (thisWeeksEntries.length > 0) {
    const tasks = thisWeeksEntries.map((e) => `${e.name} (${e.interval})`);
    const taskText = tasks.join("\n");
    const msg = `Tällä viikolla tehtävät hommat:\n${taskText}`;
    await broadcastMessage(msg);
    console.log("[run] Broadcasted weekly task message");
  } else {
    const msg = "Tällä viikolla ei toistuvia hommia! 🎉";
    await broadcastMessage(msg);
    console.log("[run] Broadcasted empty-week message");
  }

  // 5. Update "last done" column with new date stamps (only tasks done this week are advanced)
  const newDateStamps = sheets.updatedLastDoneDateStamps(entries);
  await sheets.updateSheetLastDoneColumn(newDateStamps);
  console.log("[run] Updated last done column in sheet");

  const durationMs = Date.now() - startTime;
  console.log(`[run] Completed successfully in ${durationMs}ms`);
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[run] Fatal error:", err);
    process.exit(1);
  });
