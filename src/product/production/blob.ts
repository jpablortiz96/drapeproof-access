import { randomUUID } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import type { SessionAsset } from "../live/types.js";

export interface PrivateObjectStore {
  putAsset(kind: SessionAsset["kind"], extension: "jpg" | "png", bytes: Uint8Array): Promise<string>;
  putDerived(extension: string, bytes: Uint8Array): Promise<string>;
  read(key: string): Promise<Uint8Array>;
  delete(keys: string[]): Promise<void>;
  health(): Promise<boolean>;
}

const folders: Record<SessionAsset["kind"], string> = {
  source: "source", product: "product", result: "provider-result", "face-control": "derived", passport: "passport",
  preserved: "preserved", repair: "repair",
};

export class VercelPrivateObjectStore implements PrivateObjectStore {
  constructor(private readonly token: string) {}

  private async write(pathname: string, bytes: Uint8Array): Promise<string> {
    const blob = await put(pathname, Buffer.from(bytes), { access: "private", addRandomSuffix: false, token: this.token });
    return blob.pathname;
  }

  putAsset(kind: SessionAsset["kind"], extension: "jpg" | "png", bytes: Uint8Array): Promise<string> {
    return this.write(`${folders[kind]}/${randomUUID()}.${extension}`, bytes);
  }

  putDerived(extension: string, bytes: Uint8Array): Promise<string> {
    const safe = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "bin";
    return this.write(`derived/${randomUUID()}.${safe}`, bytes);
  }

  async read(key: string): Promise<Uint8Array> {
    const result = await get(key, { access: "private", token: this.token, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Private object is unavailable.");
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length) await del(keys, { token: this.token });
  }

  async health(): Promise<boolean> {
    try { await list({ limit: 1, token: this.token }); return true; } catch { return false; }
  }
}
