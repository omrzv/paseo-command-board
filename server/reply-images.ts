import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { replySaveImagesRpc } from "../shared/reply-rpc";
import { pluginDataDir } from "./plugin-data";

/** Saved images are removed after this long. */
const KEPT_MS = 7 * 24 * 60 * 60_000;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function replyImagesDir(): string {
  return join(pluginDataDir(), "reply-images");
}

/** Writes each image to its own file; returns their absolute paths in order. */
export async function saveReplyImages(images: { data: string; mimeType: string }[], dir = replyImagesDir(), now = Date.now()): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  void prune(dir, now);
  return Promise.all(images.map(async (image) => {
    const path = join(dir, `${new Date(now).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.${EXTENSIONS[image.mimeType] ?? "png"}`);
    await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return path;
  }));
}

async function prune(dir: string, now: number): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (now - (await stat(path)).mtimeMs > KEPT_MS) await unlink(path);
    }
  } catch {
    // Best effort.
  }
}

export function registerReplyImagesServer(server: PluginServerContext): void {
  server.handle(replySaveImagesRpc, async ({ images }) => ({ paths: await saveReplyImages(images) }));
}
