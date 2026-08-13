import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Vercel's Next.js output collector observes this transient Next 16 build file.
// Recreate an empty sentinel after the build so collection cannot race its removal.
if (process.env.VERCEL === "1") {
  await writeFile(resolve("web/.next/lock"), "", { flag: "a" });
}
