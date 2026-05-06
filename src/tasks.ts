import { add, parse, format, startOfWeek, addWeeks, isWithinInterval, Duration } from "date-fns";
import { RecurringTask } from "./db";
import config from "./config";

const INTERVAL_ABBREVS: Record<string, number> = {
  pv: 1,
  vk: 7,
  kk: 30,
  v: 365,
};

export const now = (): Date => {
  return new Date(new Date().toLocaleString("en-US", { timeZone: config.tz }));
};

export const parseInterval = (intervalStr: string): Duration => {
  const match = /^(\d+)(pv|vk|kk|v)$/.exec(intervalStr);
  if (!match) throw new Error(`Virheellinen intervalli: "${intervalStr}"`);
  const num = parseInt(match[1]);
  const days = num * INTERVAL_ABBREVS[match[2]];
  return { days };
};

export const getNextDate = (task: RecurringTask): Date => {
  if (!task.last_done) return now();
  const lastDate = parse(task.last_done, "yyyy-MM-dd", now());
  return add(lastDate, parseInterval(task.interval));
};

export const isThisWeek = (task: RecurringTask): boolean => {
  const nextDate = getNextDate(task);
  const weekStart = startOfWeek(now(), { weekStartsOn: 1 });
  const weekEnd = addWeeks(weekStart, 1);
  return isWithinInterval(nextDate, { start: weekStart, end: weekEnd });
};

export const formatDate = (d: Date): string => format(d, "yyyy-MM-dd");

export const today = (): string => format(now(), "yyyy-MM-dd");
