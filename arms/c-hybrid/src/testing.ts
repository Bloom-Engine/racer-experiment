/**
 * Scripted test commands for BLOOM_SCRIPT runs (see README of @bloomengine/web):
 *   BLOOM_SCRIPT="30 race; 40 autopilot on; 5000 quit" ./dist/racer
 * They drive the real game through its own code paths (input injection, teleports), so the
 * Definition-of-Done checks in NOTES.md are repeatable.
 */
import * as P from "@bloomengine/engine/physics";
import { injectKeyDown, injectKeyUp, Key } from "@bloomengine/engine";
import type { Game } from "./game.ts";

function keyCode(name: string): number {
  const k = (Key as Record<string, number>)[name.toUpperCase()];
  return k ?? 0;
}

export function installTestCommands(game: Game, commands: Record<string, (arg: string) => void>): void {
  commands["race"] = () => game.confirm();
  commands["autopilot"] = (a) => { game.autopilot = a !== "off"; console.log("[test] autopilot " + String(game.autopilot)); };
  commands["hold"] = (a) => injectKeyDown(keyCode(a));
  commands["release"] = (a) => injectKeyUp(keyCode(a));
  commands["nitrofill"] = (a) => { game.playerCar.nitro = a === "" ? 1 : Number(a); };
  commands["log"] = () => { game.log = true; };
  commands["state"] = () => {
    const c = game.playerCar, s = c.vehicle.state;
    console.log(`[test] state nitro=${c.nitro.toFixed(2)} drift=${String(s.drifting)} slip=${s.slipAngle.toFixed(2)} v=${(s.speed * 3.6).toFixed(1)} pos=(${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)}) lap=${c.racer.lap} next=${c.racer.nextCp} last=${c.racer.lastCp} saves=${c.vehicle.tunnelSaves}`);
  };
  /** Teleport the player to checkpoint i (by the track), facing the race direction. */
  commands["tp"] = (a) => {
    const cp = game.trackData.checkpoints[Number(a)];
    if (cp === undefined) return;
    game.playerCar.vehicle.teleport(cp.pos, cp.rot);
    game.playerCar.racer.prev = { ...cp.pos };
    console.log(`[test] teleported to cp_${a}`);
  };
  /**
   * Fire the player at the nearest wall at `kmh` (default 300) from 25 m away, perpendicular.
   * The car must end up on the track side: logs the lateral offset before and after.
   */
  commands["wallshot"] = (a) => {
    const kmh = a === "" ? 300 : Number(a);
    const t = game.trackData, c = game.playerCar;
    const i = c.racer.lineIndex;
    const p = t.point(i), d = t.direction(i);
    const side = Math.random() < 0.5 ? -1 : 1;
    const right = { x: -d.z * side, z: d.x * side };
    // start on the road, aimed steeply into the wall
    const start = { x: p.x - right.x * 2, y: p.y + 0.4, z: p.z - right.z * 2 };
    // 60° into the wall: a hard hit, not a graze
    const dir = { x: right.x * 0.866 + d.x * 0.5, z: right.z * 0.866 + d.z * 0.5 };
    const yaw = Math.atan2(-dir.x, -dir.z);
    const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    c.vehicle.teleport(start, rot);
    const v = kmh / 3.6;
    P.setLinearVelocity(c.vehicle.body, { x: dir.x * v, y: 0, z: dir.z * v });
    c.racer.prev = { ...start };
    shots.push({ frame: 0, lineIndex: i, side });
    console.log(`[test] wallshot ${kmh} km/h side=${side} at line ${i}`);
  };
  commands["wallcheck"] = () => {
    const shot = shots.shift();
    if (shot === undefined) return;
    const s = game.playerCar.vehicle.state;
    // beyond the barriers there is no collider at all: a probe that finds nothing = tunnelled
    const probe = game.physics.probe(s.pos.x, s.pos.y + 3, s.pos.z, 20);
    const names = ["none", "road", "run-off", "wall", "car"];
    const ok = probe.surface === 1 || probe.surface === 2;
    wallStats.total++; if (ok) wallStats.inside++;
    console.log(`[test] wallcheck surface=${names[probe.surface] ?? "?"} speed=${(s.speed * 3.6).toFixed(0)} km/h ${ok ? "INSIDE" : "TUNNELLED"} (${wallStats.inside}/${wallStats.total} inside) guardSaves=${game.playerCar.vehicle.tunnelSaves}`);
  };
  /** Turn the player upside down (auto reset must put it back within ~3 s). */
  commands["flip"] = () => {
    const c = game.playerCar, s = c.vehicle.state;
    c.vehicle.teleport({ x: s.pos.x, y: s.pos.y + 1.5, z: s.pos.z }, { x: 0, y: 0, z: 1, w: 0 });
    console.log("[test] flipped");
  };
  /** Drop the player onto the run-off (grass), parked. */
  commands["offtrack"] = () => {
    const t = game.trackData, c = game.playerCar;
    const i = c.racer.lineIndex, p = t.point(i), d = t.direction(i);
    for (let off = 9; off < 30; off += 1) {
      const x = p.x - d.z * off, z = p.z + d.x * off;
      const probe = game.physics.probe(x, p.y + 5, z, 12);
      if (probe.surface === 2) { c.vehicle.teleport({ x, y: p.y + 5 - probe.distance, z }, c.vehicle.state.rot); console.log(`[test] offtrack at +${off} m`); return; }
    }
    console.log("[test] offtrack: no terrain found");
  };
  /** Shortcut: jump the player from where it is to checkpoint `a` (skipping the ones between). */
  commands["shortcut"] = (a) => {
    const cp = game.trackData.checkpoints[Number(a)];
    if (cp === undefined) return;
    const c = game.playerCar;
    const back = { x: cp.pos.x - cp.fwd.x * 15, y: cp.pos.y, z: cp.pos.z - cp.fwd.z * 15 };
    c.vehicle.teleport(back, cp.rot);
    c.racer.prev = { ...back };
    console.log(`[test] shortcut to before cp_${a} (expected next cp_${c.racer.nextCp})`);
  };
}

const wallStats = { total: 0, inside: 0 };
const shots: { frame: number; lineIndex: number; side: number }[] = [];
