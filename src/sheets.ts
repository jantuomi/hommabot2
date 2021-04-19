import { google } from "googleapis";
import { add, Duration, parse, format, getDay, subDays, addDays } from "date-fns";

import config from "./config";

interface SheetsRawEntry {
  intervalStr: string;
  name: string;
  lastDoneDateStr: string;
}

interface SheetsProcessedEntry {
  name: string;
  nextDateStamp: string;
  nextDate: Date;
  lastDateStamp: string;
  lastDate?: Date;
  interval: string;
}

const INTERVAL_ABBREVS = {
  pv: 1,
  vk: 7,
  kk: 30,
  v: 365,
} as const;

type IntervalAbbrevKey = keyof typeof INTERVAL_ABBREVS;

const strToDate = (s: string) => parse(s, "yyyy-MM-dd", new Date());
const dateToStr = (d: Date) => format(d, "yyyy-MM-dd");

const calculateDuration = (intervalStr: string) => {
  const match = /(\d+)(\w+)/.exec(intervalStr);

  if (!match) {
    throw new Error("Given interval string does not match regular expression");
  }

  const number = Number.parseInt(match[1]);
  const abbrev = match[2];

  if (number <= 0) {
    throw new Error(`"${number}" is an invalid interval number`);
  }

  if (!Object.keys(INTERVAL_ABBREVS).includes(abbrev)) {
    throw new Error(`"${abbrev}" is an invalid interval string`);
  }

  const days = INTERVAL_ABBREVS[abbrev as IntervalAbbrevKey];

  const totalDuration: Duration = {
    days: number * days,
  };

  return totalDuration;
};

const processRow = (row: SheetsRawEntry) => {
  const duration = calculateDuration(row.intervalStr);

  const calcValues = () => {
    if (row.lastDoneDateStr) {
      const lastDate = strToDate(row.lastDoneDateStr);
      const nextDate = add(lastDate, duration);
      const nextDateStamp = dateToStr(nextDate);

      return { lastDate, nextDate, nextDateStamp };
    } else {
      const lastDate = undefined;
      const nextDate = new Date();
      const nextDateStamp = dateToStr(nextDate);

      return { lastDate, nextDate, nextDateStamp };
    }
  };

  const processedEntry: SheetsProcessedEntry = {
    ...calcValues(),
    name: row.name,
    lastDateStamp: row.lastDoneDateStr,
    interval: row.intervalStr,
  };

  return processedEntry;
};

const isThisWeek = (entry: SheetsProcessedEntry): boolean => {
  const nextDate = entry.nextDate;
  const today = new Date();
  const dayOfWeek = (getDay(today) + 7 - 1) % 7; // getDay returns sunday = 0
  const currentWeekStart = subDays(today, dayOfWeek);
  const currentWeekEnd = addDays(currentWeekStart, 7);
  return nextDate >= currentWeekStart && nextDate < currentWeekEnd;
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const buildSheetsClient = async () => {
  const auth = new google.auth.GoogleAuth({
    // Scopes can be specified either as an array or as a single, space-delimited string.
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
    keyFile: config.googleSaJsonPath,
  });

  // Acquire an auth client, and bind it to all future calls
  const authClient = await auth.getClient();
  google.options({ auth: authClient });
  const sheets = google.sheets({ version: "v4" });

  const fetchSheetData = async (): Promise<SheetsRawEntry[]> => {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: config.sheetsSpreadsheetId,
        range: config.sheetsRange,
      });

      const entriesAsLists = res.data.values || [];
      const rawEntries: SheetsRawEntry[] = entriesAsLists.map(row => ({
        intervalStr: row[0],
        name: row[1],
        lastDoneDateStr: row[2],
      }));

      console.log(`Fetched ${rawEntries.length} rows from Sheets.`);
      return rawEntries;
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  const getRightmostColumnInRange = (range: string): string => {
    const match = /(.+!)?([A-Z]+?)(\d+):([A-Z]+?)(\d+)/.exec(range);

    if (!match) {
      throw new Error("Given range does not match regular expression");
    }

    const sheetName = match[1];
    const topLeftRow = Number.parseInt(match[3]);
    const bottomRightCol = match[4];
    const bottomRightRow = Number.parseInt(match[5]);

    const rmCol = bottomRightCol;
    const rmRowStart = topLeftRow;
    const rmRowEnd = bottomRightRow;

    return `${sheetName}${rmCol}${rmRowStart}:${rmCol}${rmRowEnd}`;
  };

  const updateSheetLastDoneColumn = async (newDateStamps: string[]) => {
    const lastDoneColumnRange = getRightmostColumnInRange(config.sheetsRange);

    const body = {
      values: newDateStamps.map(nds => [nds]),
    };

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetsSpreadsheetId,
      range: lastDoneColumnRange,
      valueInputOption: "RAW",
      requestBody: body,
    });
  };

  const processRows = (rows: SheetsRawEntry[]) => rows.map(processRow);

  const filterOnlyThisWeek = (entries: SheetsProcessedEntry[]): SheetsProcessedEntry[] => entries.filter(isThisWeek);

  const updatedLastDoneDateStamps = (entries: SheetsProcessedEntry[]): string[] =>
    entries.map(e => isThisWeek(e) ? e.nextDateStamp : e.lastDateStamp);

  return {
    fetchSheetData,
    getRightmostColumnInRange,
    updateSheetLastDoneColumn,
    processRows,
    filterOnlyThisWeek,
    updatedLastDoneDateStamps,
  };
};
