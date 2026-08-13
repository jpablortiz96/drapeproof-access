import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { NeonDatabaseClient } from "../src/product/production/db.js";

const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
if (!migrationDatabaseUrl) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required for migrations.");
const database = new NeonDatabaseClient(migrationDatabaseUrl);
const directory = resolve("migrations");
const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();

for (const name of files) {
  const text = await readFile(resolve(directory, name), "utf8");
  for (const statement of text.split(/^\s*-- statement-breakpoint\s*$/m).map((value) => value.trim()).filter(Boolean)) {
    await database.query(statement);
  }
  await database.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [name]);
  process.stdout.write(`Applied ${name}\n`);
}
