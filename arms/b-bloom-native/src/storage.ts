// Best-lap persistence in a small text file in the user's data directory.
//
// Not `perry/system` preferencesGet/Set: that module lives in Perry's UI
// runtime, which a Bloom game does not link (undefined _perry_system_* symbols).
// Not Bloom's writeFile: it does not resolve to a writable directory on iOS.
// Perry's Node-compatible fs + os.homedir() work on macOS and in the iOS
// app sandbox (Documents/).
// Web: Bloom's readFile/writeFile/fileExists are backed by localStorage there.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { getPlatform, Platform, readFile, writeFile, fileExists } from "bloom/core";

const WEB_KEY = "bloomracer/best_lap.txt";

function dataDir(): string {
  const home = homedir();
  if (getPlatform() === Platform.IOS) return home + "/Documents";
  return home + "/Library/Application Support/BloomRacer";
}

function bestFile(): string {
  return dataDir() + "/best_lap.txt";
}

export function loadBestLap(): number {
  if (getPlatform() === Platform.WEB) {
    if (!fileExists(WEB_KEY)) return 0;
    const w = Number(readFile(WEB_KEY).trim());
    return w > 0 ? w : 0;
  }
  const f = bestFile();
  if (!existsSync(f)) return 0;
  const text = readFileSync(f, "utf8");
  const v = Number(text.trim());
  if (v > 0) return v;
  return 0;
}

export function saveBestLap(seconds: number): void {
  if (getPlatform() === Platform.WEB) {
    writeFile(WEB_KEY, "" + seconds);
    return;
  }
  const d = dataDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(bestFile(), "" + seconds);
}
