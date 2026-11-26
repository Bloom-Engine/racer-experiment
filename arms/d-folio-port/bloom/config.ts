/**
 * Settings for folio-2025 on Bloom, set before @bloomengine/web installs the browser.
 */
import { configure } from "@bloomengine/web/config";

const size = (name: string, fallback: number): number => Number(process.env[name] ?? "") || fallback;

/** BLOOM_SCRIPT helpers for test drives: `hold KeyW` / `release KeyW` (the game reads KeyboardEvent.code). */
function keyEvent(type: string, code: string): void {
  const g = globalThis as unknown as { KeyboardEvent: new (t: string, i: unknown) => unknown; window: { dispatchEvent(e: unknown): void } };
  const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.startsWith("Digit") ? code.slice(5) : code === "Space" ? " " : code;
  g.window.dispatchEvent(new g.KeyboardEvent(type, { bubbles: true, key, code }));
}

configure({
  app: "folio2025",
  title: "Bruno's",
  width: size("BLOOM_WIDTH", 1280),
  height: size("BLOOM_HEIGHT", 800),
  root: new URL("./assets/folio/", import.meta.url).pathname,   // the staged site (stage.mjs)
  bundle: "folio",
  canvas: ".js-canvas",
  storageName: "storage.json",
  scriptCommands: {
    hold: (code: string) => keyEvent("keydown", code.trim()),
    release: (code: string) => keyEvent("keyup", code.trim()),
  },
});
