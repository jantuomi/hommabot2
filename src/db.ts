import {
  createPool,
  QueryResultType,
  sql,
} from "slonik";
import config from "./config";

interface ActiveChat {
  id: number;
}

interface PermittedUser {
  id: number;
}

const connection = createPool(config.pgConnectionUri);

export const getActiveChats = async (): Promise<readonly ActiveChat[]> =>
  connection.any(sql`
    SELECT *
    FROM active_chats
  `);

export const addActiveChat = async (id: number): Promise<QueryResultType<void>> =>
  connection.query<void>(sql`
    INSERT INTO active_chats
    (id) VALUES
    (${id})
  `);

export const removeActiveChat = async (id: number): Promise<QueryResultType<void>> =>
  connection.query<void>(sql`
    DELETE FROM active_chats
    WHERE id = ${id}
  `);

export const getPermittedUsers = async (): Promise<readonly PermittedUser[]> =>
  connection.any(sql`
    SELECT *
    FROM permitted_users
  `);
