import "dotenv/config";
import { VercelPrivateObjectStore } from "../src/product/production/blob.js";
import { loadProductionConfig } from "../src/product/production/config.js";
import { NeonDatabaseClient } from "../src/product/production/db.js";
import { PostgresBlobSessionRepository } from "../src/product/production/repository.js";
import { PostgresProductAnalyticsStore } from "../src/product/beta/events.js";

const config = loadProductionConfig();
const database = new NeonDatabaseClient(config.databaseUrl);
const repository = new PostgresBlobSessionRepository(database, new VercelPrivateObjectStore(config.blobToken), config.sessionTtlHours);
const analytics = new PostgresProductAnalyticsStore(database);
const startedAt = new Date().toISOString();
const summary = await repository.cleanupExpired();
const analyticsSummary = await analytics.cleanupExpired();
await analytics.recordCleanupRun({ startedAt, completedAt: new Date().toISOString(), status: summary.failed ? "FAILED" : "SUCCESS", sessions: summary, ...analyticsSummary, errorCode: summary.failed ? "CLEANUP_RETRY_REQUIRED" : null });
process.stdout.write(`${JSON.stringify({ ok: summary.failed === 0, ...summary, ...analyticsSummary })}\n`);
if (summary.failed) process.exitCode = 1;
