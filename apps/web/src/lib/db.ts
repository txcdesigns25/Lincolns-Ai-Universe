import "server-only";
import { getDb } from "@universe/core";
export const db = () => getDb();
