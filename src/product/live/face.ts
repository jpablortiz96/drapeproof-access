import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { SkinAnalysisClient, SKIN_CONCERNS, type SkinAnalysisOutput } from "../../skin/client.js";
import { absoluteDelta } from "../../skin/signals.js";
import type { ValidatedFixture } from "../../validation.js";
import { fixtureFromAsset, loadServerApiKey } from "./provider.js";
import type { SessionRepository } from "./repository.js";
import type { FaceSignalValue, TryOnSession } from "./types.js";

function rawScore(outputs: SkinAnalysisOutput[], concern: string): number {
  const output = outputs.find((item) => item.type === concern);
  if (!output || typeof output.raw_score !== "number" || !Number.isFinite(output.raw_score)) {
    throw new Error(`Face appearance result is missing ${concern}.`);
  }
  return output.raw_score;
}

export async function startFaceAppearance(session: TryOnSession, repository: SessionRepository): Promise<void> {
  if (!session.sourceImage || !session.providerResult) throw new Error("Face appearance analysis requires source and result images.");
  const [sourcePath, resultPath] = await Promise.all([
    repository.materializeAsset(session.id, session.sourceImage),
    repository.materializeAsset(session.id, session.providerResult),
  ]);
  const controlBytes = await sharp(await readFile(sourcePath)).jpeg({ quality: 92, chromaSubsampling: "4:4:4", progressive: false, mozjpeg: false, optimiseCoding: true }).toBuffer();
  const metadata = await sharp(controlBytes).metadata();
  const controlAsset = await repository.writeAsset(session.id, {
    kind: "face-control", filename: "face-control.jpg", mediaType: "image/jpeg",
    width: metadata.width!, height: metadata.height!, size: controlBytes.byteLength,
  }, controlBytes);
  const client = new SkinAnalysisClient({ apiKey: loadServerApiKey() });
  const fixtures: ValidatedFixture[] = [
    fixtureFromAsset(sourcePath, session.sourceImage),
    fixtureFromAsset(await repository.materializeAsset(session.id, controlAsset), controlAsset),
    fixtureFromAsset(resultPath, session.providerResult),
  ];
  const initialized = await Promise.all(fixtures.map((fixture) => client.initializeFile(fixture)));
  await Promise.all(fixtures.map((fixture, index) => client.uploadFile(fixture, initialized[index]!)));
  const tasks = await Promise.all(initialized.map((upload) => client.createTask(upload.fileId)));
  session.faceAppearance = {
    enabled: true,
    state: "CHECKING",
    taskIds: { original: tasks[0]!.taskId, control: tasks[1]!.taskId, result: tasks[2]!.taskId },
  };
}

export async function pollFaceAppearance(session: TryOnSession): Promise<"RUNNING" | "COMPLETE"> {
  const ids = session.faceAppearance.taskIds;
  if (!ids) throw new Error("Face appearance tasks were not initialized.");
  const client = new SkinAnalysisClient({ apiKey: loadServerApiKey() });
  const [original, control, result] = await Promise.all([
    client.getTaskStatus(ids.original), client.getTaskStatus(ids.control), client.getTaskStatus(ids.result),
  ]);
  if ([original, control, result].some((status) => status.taskStatus === "error")) {
    session.faceAppearance = { enabled: true, state: "UNAVAILABLE", error: "Face appearance could not be checked for this preview." };
    return "COMPLETE";
  }
  if ([original, control, result].some((status) => status.taskStatus === "running")) return "RUNNING";
  const originalOutputs = original.results!.output;
  const controlOutputs = control.results!.output;
  const resultOutputs = result.results!.output;
  const signals: FaceSignalValue[] = SKIN_CONCERNS.map((concern) => {
    const originalValue = rawScore(originalOutputs, concern);
    const controlValue = rawScore(controlOutputs, concern);
    const resultValue = rawScore(resultOutputs, concern);
    return { concern, original: originalValue, control: controlValue, result: resultValue, controlDelta: absoluteDelta(originalValue, controlValue), resultDelta: absoluteDelta(originalValue, resultValue) };
  });
  session.faceAppearance = { enabled: true, state: "CHECKED", signals };
  return "COMPLETE";
}
