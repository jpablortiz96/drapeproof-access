import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertVerificationAssets } from "../src/product/live/continuity.js";

const assets = await assertVerificationAssets();
const [vercel, requirements, trace] = await Promise.all([
  readFile(resolve("vercel.json"), "utf8"),
  readFile(resolve("requirements.txt"), "utf8"),
  readFile(resolve("web/.next/server/app/api/sessions/[id]/route.js.nft.json"), "utf8"),
]);
const tracedFiles = (JSON.parse(trace) as { files: string[] }).files.map((path) => path.replaceAll("\\", "/"));
for (const dependency of ["mediapipe==0.10.30", "./python/opencv-contrib-python", "opencv-contrib-python-headless==5.0.0.93", "numpy==2.4.4"]) {
  if (!requirements.includes(dependency)) throw new Error(`Python verification dependency is not locked: ${dependency}`);
}
for (const required of ["models/continuity/pose_landmarker_lite.task", "scripts/continuity_cv.py", "api/verification-worker.py"]) {
  if (!vercel.includes(required)) throw new Error(`Vercel verification bundle declaration is missing: ${required}`);
}
for (const required of ["config/continuity-policy.json", "config/preservation-policy.json"]) {
  if (!tracedFiles.some((path) => path.endsWith(required))) throw new Error(`Node verification trace is missing: ${required}`);
}
process.stdout.write(`PASS: verification runtime assets locked and traced (${assets.modelSha256}).\n`);
