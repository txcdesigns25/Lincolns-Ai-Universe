import { getDb, closeDb } from "../db.js";
import { seed } from "../migrate-lib.js";
await seed(getDb());
console.log("seeded");
await closeDb();
