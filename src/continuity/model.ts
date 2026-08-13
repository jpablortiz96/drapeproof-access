import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
export const POSE_MODEL_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";
const current = resolve(process.cwd());
const root = existsSync(resolve(current, "models/continuity/pose_landmarker_lite.task")) ? current : resolve(current, "..");
export const POSE_MODEL_PATH = resolve(root, "models/continuity/pose_landmarker_lite.task");
