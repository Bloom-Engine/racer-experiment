// Native entry: configure the web runtime the bridge runs on, then start the game.
import { configure } from "@bloomengine/web/config";
configure({ app: "arcade-racer", title: "Arcade Racer", width: 1280, height: 720, page: "none", root: new URL("../", import.meta.url).pathname });
import "@bloomengine/web";
import "../src/main.ts";
