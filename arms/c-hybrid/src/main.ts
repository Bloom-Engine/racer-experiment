/**
 * Game entry (imported by bloom/main.ts after the Bloom web runtime is installed).
 * The frame loop is three.js's renderer.setAnimationLoop, which the bridge drives from Bloom.
 */
import { config } from "@bloomengine/web/config";
import { Game } from "./game.ts";
import { installTestCommands } from "./testing.ts";

const game = new Game();
installTestCommands(game, config().scriptCommands);
game.init().then(() => {
  game.start();
  console.log("[racer] ready");
}, (err: unknown) => {
  console.error("[racer] failed to load: " + String(err) + "\n" + String((err as { stack?: string }).stack ?? ""));
});
