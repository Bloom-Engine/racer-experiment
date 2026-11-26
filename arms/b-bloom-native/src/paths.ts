// Location of generated game data (collision, procedural audio).
// Source tree: resources/. In the signed iOS bundle the folder is renamed to
// gamedata/ by tools/package-ios.sh, because a top-level "resources" folder in a
// flat iOS .app collides (case-insensitively) with the reserved "Resources"
// directory and makes `codesign` reject the bundle.
import { getPlatform, Platform } from "bloom/core";

export function dataPath(file: string): string {
  if (getPlatform() === Platform.IOS) return "gamedata/" + file;
  return "resources/" + file;
}
