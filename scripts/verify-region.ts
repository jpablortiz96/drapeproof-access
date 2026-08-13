import { resolve } from "node:path";
import { verifyRegions } from "../src/verification/verification.js";

function value(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const result = index >= 0 ? argv[index + 1] : undefined;
  if (!result || result.startsWith("--")) throw new Error(`${name} is required.`);
  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const originalPath = resolve(value(argv, "--original"));
  const generatedPath = resolve(value(argv, "--generated"));
  const regionsPath = resolve(value(argv, "--regions"));
  const policyIndex = argv.indexOf("--policy");
  const outputIndex = argv.indexOf("--output");
  const policyPath = resolve(policyIndex >= 0 ? value(argv, "--policy") : "config/preservation-policy.json");
  const outputRoot = resolve(outputIndex >= 0 ? value(argv, "--output") : ".tmp/region-verification");
  const outputs = await verifyRegions({ originalPath, generatedPath, regionsPath, policyPath, outputRoot });
  for (const output of outputs) {
    console.log(`${output.region.id}: ${output.decision}`);
    console.log(resolve(output.outputDirectory, "verification.json"));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
