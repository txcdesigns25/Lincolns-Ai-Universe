import { getDb, closeDb } from "../db.js";
import { migrate, seed } from "../migrate-lib.js";
const db = getDb();
await migrate(db);
if (process.argv.includes("--seed")) { await seed(db); console.log("seeded"); }
await closeDb();
