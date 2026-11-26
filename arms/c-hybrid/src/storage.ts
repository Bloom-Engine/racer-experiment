/**
 * Best lap persisted with Bloom's file API (writeFile/readFile). Bloom's writeFile doesn't
 * create folders, so the folder is made with node:fs first. Location: Application Support on
 * macOS and in the iOS app container (HOME is the container there).
 */
import { writeFile, readFile, fileExists } from "@bloomengine/engine";
import { mkdirSync } from "node:fs";

const DIR = (process.env["RACER_SAVE_DIR"] ?? ((process.env["HOME"] ?? ".") + "/Library/Application Support/arcade-racer-hybrid")).replace(/\/$/, "");
const FILE = DIR + "/save.json";

interface Save { bestLap: number | null }

export function loadBestLap(): number | null {
  try {
    if (!fileExists(FILE)) return null;
    const s = JSON.parse(readFile(FILE)) as Save;
    return typeof s.bestLap === "number" && s.bestLap > 0 ? s.bestLap : null;
  } catch { return null; }
}

export function saveBestLap(t: number): boolean {
  try { mkdirSync(DIR, { recursive: true }); } catch { /* exists */ }
  const save: Save = { bestLap: t };
  return writeFile(FILE, JSON.stringify(save));
}

export const SAVE_FILE = FILE;
