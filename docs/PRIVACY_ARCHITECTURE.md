# Privacy architecture

DrapeProof is anonymous-first. The production design minimizes identity data while still providing resumable sessions, private media, deletion, and aggregate product learning.

## Ownership

The browser receives a random anonymous token in an HTTP-only, secure, same-site cookie. The server stores only a keyed one-way hash for ownership checks. Public session responses omit ownership hashes, provider task IDs, idempotency keys, private object keys, and derived artifact paths.

## Private media

Source photos, product images, AI outputs, Passport images, and accepted preserved derivatives are stored in private Vercel Blob objects. Retrieval routes require ownership and return private, no-store responses. Provider result URLs are downloaded server-side rather than exposed to the browser.

## Retention and deletion

Sessions expire after 24 hours by default. Scheduled cleanup deletes controlled Blob objects and tombstones the database record. The product also provides explicit deletion. Product events and optional feedback have separate retention windows and cascade with the owning session where applicable.

## Product telemetry

Server-side events use an allowlist of low-cardinality properties. Protected-area coordinates, image pixels, private URLs, owner tokens, and provider task identifiers are rejected. Anonymous event buckets rotate and are non-reversible. Vercel page/performance analytics receives normalized paths with dynamic identifiers and query parameters removed.

## Secret boundaries

YouCam, Neon, Blob, owner-hash, and cron credentials are server-only. The Python CV worker is authorized with the cron secret but does not receive the database, Blob, or YouCam credentials. Mutation routes enforce origin checks and scoped rate limits.

## What this does not claim

This architecture is a privacy-minimization design, not a claim of regulatory certification. DrapeProof does not perform biometric identity verification or medical analysis.
