import { NextRequest } from "next/server";
import sharp from "sharp";
import { renderPassportPng } from "@web/server/live";
import { notFoundSession, ownedSession, privateHeaders, productError } from "@web/server/api";
import { sessions } from "@web/server/session-context";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const session = await ownedSession(request, id);
  if (!session) return notFoundSession();
  if (kind === "passport") {
    if (!session.providerResult) return productError("This Passport is not ready yet.", "Return to your result and try again.", 409);
    let png: Uint8Array;
    if (session.passportImage) png = await sessions().readAsset(id, session.passportImage);
    else {
      const resultPath = await sessions().materializeAsset(id, session.preservedResult ?? session.providerResult);
      png = new Uint8Array(await renderPassportPng(session, resultPath));
      session.passportImage = await sessions().writeAsset(id, { kind: "passport", filename: `passport-${id}.png`, mediaType: "image/png", width: 1080, height: 1350, size: png.byteLength }, png);
      await sessions().save(session);
    }
    return new Response(Buffer.from(png), { headers: privateHeaders({ "Content-Type": "image/png", "Content-Length": String(png.byteLength), "Content-Disposition": `attachment; filename="drapeproof-${id.slice(0,8)}.png"`, "X-Content-Type-Options": "nosniff" }) });
  }
  const asset = kind === "source" ? session.sourceImage : kind === "product" ? session.productImage : kind === "result" ? session.providerResult : kind === "preserved" ? session.preservedResult : null;
  if (!asset) return new Response(null, { status: 404 });
  let bytes = Buffer.from(await sessions().readAsset(id, asset));
  let mediaType: string = asset.mediaType;
  if (request.nextUrl.searchParams.get("display") === "1") {
    let image = sharp(bytes).rotate();
    const regionId = request.nextUrl.searchParams.get("region");
    if (regionId && (kind === "source" || kind === "result" || kind === "preserved")) {
      const region = session.protectedRegions.find((item) => item.id === regionId);
      if (!region) return new Response(null, { status: 404 });
      const metadata = await image.metadata();
      if (!metadata.autoOrient.width || !metadata.autoOrient.height) return new Response(null, { status: 404 });
      const width = metadata.autoOrient.width, height = metadata.autoOrient.height;
      const xs = region.polygon.map((point) => point.x), ys = region.polygon.map((point) => point.y);
      const padX = Math.max(12, Math.round(width * .025)), padY = Math.max(12, Math.round(height * .025));
      const left = Math.max(0, Math.floor(Math.min(...xs) * width) - padX), top = Math.max(0, Math.floor(Math.min(...ys) * height) - padY);
      const right = Math.min(width, Math.ceil(Math.max(...xs) * width) + padX), bottom = Math.min(height, Math.ceil(Math.max(...ys) * height) + padY);
      image = image.extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) });
    }
    bytes = await image.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 84, effort: 4 }).toBuffer();
    mediaType = "image/webp";
  }
  return new Response(bytes, { headers: privateHeaders({ "Content-Type": mediaType, "Content-Length": String(bytes.byteLength), "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" }) });
}
