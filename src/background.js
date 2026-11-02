/**
 * Full-screen panel background (M5.1).
 *
 * Users without a wallpaper plugin can still give the Lattice panel its own
 * backdrop: the panel uploads a local image to the host, the host stores it in
 * the plugin state dir, and the panel fetches it back from
 * `/lattice-panel/background`. Keeping the bytes on the host (instead of in
 * localStorage) means the choice survives desktop restarts, whose HTTP port —
 * and therefore the page origin — changes between sessions.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state.js";

const DATA_FILE = "background.bin";
const META_FILE = "background.json";
const MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

function files() {
  const dir = stateDir();
  return { dir, data: path.join(dir, DATA_FILE), meta: path.join(dir, META_FILE) };
}

/** `{ mime, updatedAt, bytes }` for the stored image, or null. */
export function readBackgroundMeta() {
  const { data, meta } = files();
  try {
    const parsed = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (!parsed || typeof parsed.mime !== "string" || !MIME_BY_EXT[parsed.mime]) return null;
    if (!fs.existsSync(data)) return null;
    const size = fs.statSync(data).size;
    if (!size) return null;
    return { mime: parsed.mime, updatedAt: String(parsed.updatedAt || ""), bytes: size };
  } catch {
    return null;
  }
}

/** `{ mime, bytes: Buffer }` for the stored image, or null. */
export function readBackgroundBytes() {
  const info = readBackgroundMeta();
  if (!info) return null;
  try {
    return { mime: info.mime, bytes: fs.readFileSync(files().data) };
  } catch {
    return null;
  }
}

/**
 * Accept a `data:image/...;base64,...` URL, validate it and persist the image.
 * Throws with a user-facing message on any validation failure.
 */
export function saveBackgroundDataUrl(dataUrl) {
  const text = String(dataUrl || "").trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(text);
  if (!match) {
    throw new Error("background must be a base64 data URL, e.g. data:image/png;base64,...");
  }
  const mime = match[1].toLowerCase();
  if (!MIME_BY_EXT[mime]) {
    throw new Error(`unsupported image type "${mime}"; use PNG, JPEG, WebP, GIF or BMP`);
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) throw new Error("background image is empty");
  if (bytes.length > MAX_BYTES) {
    throw new Error(`background image is too large (${bytes.length} bytes; limit ${MAX_BYTES})`);
  }
  const { dir, data, meta } = files();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(data, bytes);
  fs.writeFileSync(meta, JSON.stringify({ mime, updatedAt: new Date().toISOString(), bytes: bytes.length }, null, 2));
  return { mime, bytes: bytes.length, updatedAt: new Date().toISOString() };
}

/** Remove the stored image; returns true when something was removed. */
export function clearBackground() {
  const { data, meta } = files();
  let removed = false;
  for (const file of [data, meta]) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

export const BACKGROUND_LIMITS = { maxBytes: MAX_BYTES, bodyLimit: 12 * 1024 * 1024 };
