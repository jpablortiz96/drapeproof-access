import sharp from "sharp";
import type { TryOnSession } from "./types.js";

function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

export async function renderPassportPng(session: TryOnSession, resultPath: string): Promise<Buffer> {
  const image = await sharp(resultPath).resize(960, 720, { fit: "cover", position: "attention" }).png().toBuffer();
  const scene = session.continuity.state === "CONSISTENT" ? "Consistent" : "Changed too much";
  const accepted = session.preservationAttempts.filter((attempt) => attempt.state === "RESTORED" || attempt.state === "IMPROVED_BUT_REVIEW");
  const regions = session.continuity.localVerificationEligible
    ? session.protectedRegionResults.map((region) => `${region.label}: ${region.repairState === "RESTORED" ? "Restored" : region.repairState === "IMPROVED_BUT_REVIEW" ? "Improved - Review" : region.state === "PRESERVED" ? "Preserved" : region.state === "REVIEW" ? "Review" : region.state === "CHANGED" ? "Changed" : "Not evaluated"}`).slice(0, 4)
    : ["Protected areas: Not checked"];
  const lines = regions.map((line, index) => `<text x="74" y="${960 + index * 45}" class="region">${xml(line)}</text>`).join("");
  const preservation = accepted.length ? `${accepted.length} source restoration${accepted.length === 1 ? "" : "s"} - v${session.preservationVersion}` : "No restoration applied";
  const overlay = Buffer.from(`<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#866cff"/><stop offset="1" stop-color="#39d9ff"/></linearGradient></defs><style>.brand{font:800 24px Arial;letter-spacing:5px}.small{font:600 18px Arial;fill:#9da6b2;letter-spacing:2px}.value{font:700 26px Arial}.region{font:600 23px Arial;fill:#f7f8fa}.foot{font:500 17px Arial;fill:#9da6b2}</style><rect width="1080" height="1350" rx="54" fill="#11151a"/><rect x="40" y="40" width="1000" height="770" rx="38" fill="#171c22"/><rect x="40" y="40" width="1000" height="8" rx="4" fill="url(#a)"/><circle cx="82" cy="852" r="24" fill="url(#a)"/><text x="74" y="866" text-anchor="middle" fill="white" font-family="Arial" font-weight="800">D</text><text x="122" y="860" class="brand" fill="#f7f8fa">DRAPEPROOF</text><text x="74" y="916" class="small">PASSPORT V2 · ${xml(session.category === "CLOTHING" ? "CLOTHING" : "BAG")}</text><text x="600" y="858" class="small">SCENE</text><text x="600" y="900" class="value" fill="#f7f8fa">${xml(scene)}</text>${lines}<text x="74" y="1185" class="small">AI GENERATION</text><text x="310" y="1185" class="region">${xml(session.provider.product)}</text><text x="74" y="1230" class="small">DRAPEPROOF</text><text x="310" y="1230" class="region">${xml(preservation)}</text><line x1="74" y1="1260" x2="1006" y2="1260" stroke="#303741"/><text x="74" y="1302" class="foot">Visual verification only · No fit, safety, or compatibility guarantee</text></svg>`);
  return sharp({ create: { width: 1080, height: 1350, channels: 4, background: { r: 17, g: 21, b: 26, alpha: 1 } } })
    .composite([{ input: overlay }, { input: image, left: 60, top: 60 }]).png().toBuffer();
}
