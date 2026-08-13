import "dotenv/config";
import { NeonDatabaseClient } from "../src/product/production/db.js";
import { generationEnabled, providerDailyUnitBudget } from "../src/product/production/config.js";
import { PostgresProductAnalyticsStore } from "../src/product/beta/events.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for operator beta status.");
const status = await new PostgresProductAnalyticsStore(new NeonDatabaseClient(databaseUrl)).betaStatus({ generationEnabled: generationEnabled(), budget: providerDailyUnitBudget() });
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
