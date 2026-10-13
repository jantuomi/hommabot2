import { add, format, parseISO, startOfWeek } from "date-fns";
import type { RecurringTask } from "./storage";
import { InputError } from "./errors";

export const parseInterval = (value: string) => {
  const match = /^([1-9]\d*)(pv|vk|kk|v)$/.exec(value);
  if (!match)
    throw new InputError(`Virheellinen intervalli: "${value.slice(0, 64)}"`);
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count > 1000) {
    throw new InputError("Intervallin pitää olla välillä 1–1000.");
  }
  switch (match[2]) {
    case "pv":
      return { days: count };
    case "vk":
      return { weeks: count };
    case "kk":
      return { months: count };
    default:
      return { years: count };
  }
};

export const today = (
  timeZone = "Europe/Helsinki",
  instant = new Date(),
): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const validDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(parseISO(value).getTime()) &&
  format(parseISO(value), "yyyy-MM-dd") === value;

export const addInterval = (date: string, interval: string): string =>
  format(add(parseISO(date), parseInterval(interval)), "yyyy-MM-dd");

export const addDaysToDate = (date: string, days: number): string =>
  format(add(parseISO(date), { days }), "yyyy-MM-dd");

export const getNextDate = (task: RecurringTask): string => {
  parseInterval(task.interval);
  const base = task.last_done ?? task.first_due;
  if (!validDate(base))
    throw new InputError("Virheellinen aikataulun päivämäärä.");
  const next = task.last_done ? addInterval(base, task.interval) : base;
  if (!validDate(next))
    throw new InputError(
      "Seuraava päivämäärä on sallitun alueen ulkopuolella.",
    );
  return next;
};

export const scheduleProblem = (task: RecurringTask): string | null => {
  try {
    getNextDate(task);
    return null;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return error.message;
  }
};

export const intervalLabel = (interval: string): string => {
  const duration = parseInterval(interval);
  const count =
    duration.days ?? duration.weeks ?? duration.months ?? duration.years ?? 0;
  const unit = duration.days
    ? "päivän"
    : duration.weeks
      ? "viikon"
      : duration.months
        ? "kuukauden"
        : "vuoden";
  return `${count} ${unit} välein`;
};

export const weekWindow = (date: string) => {
  const start = format(
    startOfWeek(parseISO(date), { weekStartsOn: 1 }),
    "yyyy-MM-dd",
  );
  return { start, end: addDaysToDate(start, 7) };
};

export const dueThisWeek = (task: RecurringTask, date: string): boolean =>
  !task.archived_at &&
  (scheduleProblem(task) !== null || getNextDate(task) < weekWindow(date).end);

export const weeklyRunKey = (
  instant: Date,
  timeZone: string,
): string | null => {
  const date = today(timeZone, instant);
  const { start } = weekWindow(date);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(instant),
  );
  return date === start && hour < 9 ? null : start;
};
