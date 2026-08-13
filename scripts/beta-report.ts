import "dotenv/config";
import { NeonDatabaseClient } from "../src/product/production/db.js";
import { providerDailyUnitBudget, analyticsRetentionDays } from "../src/product/production/config.js";
import { PostgresProductAnalyticsStore } from "../src/product/beta/events.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for the operator beta report.");
const daysArgument = process.argv.find((argument) => argument.startsWith("--days="))?.split("=", 2)[1];
const days = daysArgument ? Number(daysArgument) : analyticsRetentionDays();
if (!Number.isSafeInteger(days) || days <= 0 || days > analyticsRetentionDays()) throw new Error(`--days must be between 1 and ${analyticsRetentionDays()}.`);
const end = new Date(); const start = new Date(end.getTime() - days * 86_400_000);
const report = await new PostgresProductAnalyticsStore(new NeonDatabaseClient(databaseUrl)).betaReport({ start: start.toISOString(), end: end.toISOString(), budget: providerDailyUnitBudget() });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
