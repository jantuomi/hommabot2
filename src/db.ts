import config from "./config";
import { HouseholdStore } from "./storage";
import { today } from "./tasks";

export const store = new HouseholdStore(config.sqlitePath, today(config.tz));
