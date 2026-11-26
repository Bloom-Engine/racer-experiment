/**
 * Where the game's files are. A dev build reads them from the project folder; an app bundle
 * carries `assets/` next to the executable (iOS) or in Contents/Resources (macOS). Every path we
 * hand to Bloom or three.js is absolute, because relative paths resolve against the CWD on macOS
 * and against the bundle on iOS.
 */
import { existsSync } from "node:fs";

function findRoot(): string {
  const exe = process.execPath ?? process.argv[0] ?? "";
  const dir = exe.slice(0, exe.lastIndexOf("/") + 1);
  const candidates = [dir, dir + "../Resources/", dir + "../", process.cwd() + "/"];
  const env = process.env["RACER_ROOT"];
  if (env !== undefined && env !== "") candidates.unshift(env.endsWith("/") ? env : env + "/");
  for (const c of candidates) if (existsSync(c + "assets/manifest.json")) return c;
  return process.cwd() + "/";
}

export const ROOT = findRoot();

/** Absolute path of a file under assets/. */
export function asset(rel: string): string { return ROOT + "assets/" + rel; }

/** A file:// URL for three.js loaders (the web layer's fetch reads file:// URLs from disk). */
export function assetUrl(rel: string): string { return "file://" + asset(rel); }
