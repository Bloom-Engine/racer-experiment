//! Automated in-game tests and measurements, enabled by environment variables
//! (see [`DebugOpts`]). They drive the real game: real physics, real race
//! rules, real rendering. Results are printed as `TEST ...` / `PERF ...` /
//! `RESULT ...` log lines so they can be grepped from a terminal run.

use avian3d::prelude::*;
use bevy::{
    app::AppExit,
    prelude::*,
    render::view::screenshot::{Screenshot, save_to_disk},
};

use crate::{
    ai::AiDriver,
    game_state::{AppState, DebugOpts},
    physics::{Layer, TunnelGuardStats},
    race::{LapCompleted, RaceClock, RaceProgress, format_time},
    track_data::TrackData,
    vehicle::{Car, CarImpact, ResetCar, VehicleInput, VehicleState},
};

pub struct TestingPlugin;

impl Plugin for TestingPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<LapPerf>()
            .init_resource::<TestState>()
            .init_resource::<OpponentSnapshot>()
            .add_systems(
                FixedUpdate,
                snapshot_opponents.before(crate::physics::FixedGameSystems::Guard),
            )
            .add_systems(
                Update,
                (lap_perf, screenshots, finish_and_quit, trace, flow_test),
            )
            .add_systems(First, touch_test)
            .add_systems(
                FixedUpdate,
                (tunnel_test, shortcut_test, reset_test, nitro_test)
                    .after(crate::physics::FixedGameSystems::Input)
                    .before(crate::physics::FixedGameSystems::Vehicle)
                    .run_if(in_state(AppState::Racing)),
            );
    }
}

/// Frame statistics for the player's current lap (DoD: ≥ 55 fps average).
#[derive(Resource, Default)]
struct LapPerf {
    frames: u32,
    time: f32,
    worst_frame: f32,
    race_frames: u32,
    race_time: f32,
}

fn lap_perf(
    real: Res<Time<Real>>,
    state: Res<State<AppState>>,
    mut perf: ResMut<LapPerf>,
    mut laps: MessageReader<LapCompleted>,
) {
    if *state.get() == AppState::Racing {
        let dt = real.delta_secs();
        perf.frames += 1;
        perf.time += dt;
        perf.worst_frame = perf.worst_frame.max(dt);
        perf.race_frames += 1;
        perf.race_time += dt;
    }
    for l in laps.read() {
        if l.is_player {
            let fps = perf.frames as f32 / perf.time.max(1e-3);
            info!(
                "PERF lap {} time {} avg_fps {:.1} worst_frame_ms {:.1} frames {}",
                l.lap,
                format_time(l.time),
                fps,
                perf.worst_frame * 1000.0,
                perf.frames
            );
            perf.frames = 0;
            perf.time = 0.0;
            perf.worst_frame = 0.0;
        }
    }
}

fn screenshots(
    mut commands: Commands,
    opts: Res<DebugOpts>,
    real: Res<Time<Real>>,
    state: Res<State<AppState>>,
    mut last: Local<f32>,
    mut n: Local<u32>,
) {
    let Some(dir) = &opts.screenshot_dir else {
        return;
    };
    let interval: f32 = std::env::var("RACER_SCREENSHOT_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5.0);
    let now = real.elapsed_secs();
    if now - *last < interval || *state.get() == AppState::Loading {
        return;
    }
    *last = now;
    *n += 1;
    let path = format!("{dir}/shot_{:03}_{:?}.png", *n, state.get());
    commands
        .spawn(Screenshot::primary_window())
        .observe(save_to_disk(path));
}

fn finish_and_quit(
    opts: Res<DebugOpts>,
    state: Res<State<AppState>>,
    cars: Query<(&Car, &RaceProgress)>,
    real: Res<Time<Real>>,
    perf: Res<LapPerf>,
    tunnel: Res<TunnelGuardStats>,
    mut since: Local<Option<f32>>,
    mut exit: MessageWriter<AppExit>,
) {
    if !opts.quit_after_finish || *state.get() != AppState::Finished {
        return;
    }
    let now = real.elapsed_secs();
    let start = *since.get_or_insert(now);
    let all_done = cars.iter().all(|(_, p)| p.finish_time.is_some());
    if now - start < 1.0 || (!all_done && now - start < 45.0) {
        return;
    }
    let mut rows: Vec<_> = cars.iter().collect();
    rows.sort_by_key(|(_, p)| p.place);
    for (c, p) in rows {
        info!(
            "RESULT place {} {} total {} best {} laps {:?}",
            p.place,
            c.name,
            p.finish_time.map(format_time).unwrap_or("DNF".into()),
            p.best_lap.map(format_time).unwrap_or("-".into()),
            p.lap_times
                .iter()
                .map(|t| format_time(*t))
                .collect::<Vec<_>>()
        );
    }
    info!(
        "PERF race avg_fps {:.1} over {:.1}s, tunnel_guard_interventions {}",
        perf.race_frames as f32 / perf.race_time.max(1e-3),
        perf.race_time,
        tunnel.interventions
    );
    exit.write(AppExit::Success);
}

#[derive(Resource, Default)]
struct TestState {
    timer: f32,
    step: u32,
    passed: u32,
    failed: u32,
    impact_max: f32,
    max_height: f32,
    escaped: bool,
    target: Vec3,
    stage_start_laps: u32,
    step_ticks: u32,
}

fn teleport(
    tf: Transform,
    vel: Vec3,
    pos: &mut Position,
    rot: &mut Rotation,
    lin: &mut LinearVelocity,
    ang: &mut AngularVelocity,
    st: &mut VehicleState,
) {
    pos.0 = tf.translation;
    rot.0 = tf.rotation;
    lin.0 = vel;
    ang.0 = Vec3::ZERO;
    st.prev_center = None;
    st.post_control_vel = vel;
    st.line_hint = None;
    st.offtrack_time = 0.0;
    st.upside_down_time = 0.0;
    st.outside_time = 0.0;
}

type PlayerQuery<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static Car,
        &'static mut Position,
        &'static mut Rotation,
        &'static mut LinearVelocity,
        &'static mut AngularVelocity,
        &'static mut VehicleState,
        &'static mut VehicleInput,
        &'static RaceProgress,
    ),
    Without<Collider>,
>;

/// Is there a barrier between the racing line and the car? (= the car is outside the walls)
fn beyond_wall(spatial: &SpatialQuery, track: &TrackData, p: Vec3) -> bool {
    let i = track.nearest_line_index(p, None);
    let a = track.line_point(i).pos + Vec3::Y * 0.7;
    let b = p + Vec3::Y * 0.7;
    let d = b - a;
    let filter = SpatialQueryFilter::from_mask(Layer::Barrier);
    match Dir3::new(d) {
        Ok(dir) => spatial
            .cast_ray(a, dir, d.length(), true, &filter)
            .is_some(),
        Err(_) => false,
    }
}

/// Is the point inside the circuit (above road or run-off, not beyond a wall)?
fn inside_track(spatial: &SpatialQuery, p: Vec3) -> bool {
    let filter = SpatialQueryFilter::from_mask([Layer::Road, Layer::Offroad]);
    spatial
        .cast_ray(p + Vec3::Y * 3.0, Dir3::NEG_Y, 12.0, true, &filter)
        .is_some()
}

/// 10 hard impacts at 300 km/h (nitro speed) into the barriers at different
/// places and angles; after each, the car must still be inside the circuit.
fn tunnel_test(
    time: Res<Time>,
    opts: Res<DebugOpts>,
    track: Res<TrackData>,
    spatial: SpatialQuery,
    mut ts: ResMut<TestState>,
    mut impacts: MessageReader<CarImpact>,
    mut cars: PlayerQuery,
    guard: Res<TunnelGuardStats>,
    mut exit: MessageWriter<AppExit>,
) {
    if opts.test.as_deref() != Some("tunnel") {
        return;
    }
    for m in impacts.read() {
        if m.is_player {
            ts.impact_max = ts.impact_max.max(m.strength);
        }
    }
    let Some((_, _, mut pos, mut rot, mut lin, mut ang, mut st, mut input, _)) =
        cars.iter_mut().find(|c| c.1.is_player)
    else {
        return;
    };
    ts.timer += time.delta_secs();
    const RUNS: u32 = 10;
    if ts.step.is_multiple_of(2) {
        // Launch phase (after a short delay).
        if ts.timer < 1.0 {
            return;
        }
        let run = ts.step / 2;
        if run >= RUNS {
            info!(
                "TEST tunnel: {}/{} impacts contained, {} escaped, guard interventions {}",
                ts.passed, RUNS, ts.failed, guard.interventions
            );
            exit.write(AppExit::Success);
            ts.step = u32::MAX - 1;
            return;
        }
        let n = track.line.len();
        let i = (run as usize * 97 + 13) % n;
        let lp = track.line_point(i);
        let left = Vec3::Y.cross(lp.tangent);
        let side = if run.is_multiple_of(2) { 1.0 } else { -1.0 };
        // Angles from 20° (glancing) to 90° (head-on) towards the wall.
        let angle = (20.0 + 70.0 * (run as f32 / (RUNS - 1) as f32)).to_radians();
        let dir = (lp.tangent * angle.cos() + left * side * angle.sin()).normalize();
        let start = lp.pos + Vec3::Y * 0.4 - dir * 6.0;
        let tf = Transform::from_translation(start).looking_to(dir, Vec3::Y);
        let speed = 83.4; // 300 km/h
        teleport(
            tf,
            dir * speed,
            &mut pos,
            &mut rot,
            &mut lin,
            &mut ang,
            &mut st,
        );
        st.nitro = 1.0;
        ts.impact_max = 0.0;
        ts.target = start;
        ts.timer = 0.0;
        ts.step += 1;
        info!(
            "TEST tunnel run {}: line pt {i} at {:.0?}, angle {:.0}°, 300 km/h",
            run + 1,
            start,
            angle.to_degrees()
        );
    } else if ts.step < u32::MAX - 1 {
        // Keep full throttle + nitro into the wall.
        *input = VehicleInput {
            throttle: 1.0,
            nitro: true,
            ..default()
        };
        ts.max_height = ts.max_height.max(pos.0.y - ts.target.y);
        // Sample containment every tick: the car must never be outside the walls.
        if !ts.escaped && beyond_wall(&spatial, &track, pos.0) {
            ts.escaped = true;
            warn!("TEST tunnel: car beyond a wall at {:.1?}", pos.0);
        }
        if ts.timer < 2.0 {
            return;
        }
        let ok = !ts.escaped && !beyond_wall(&spatial, &track, pos.0);
        if ok {
            ts.passed += 1;
        } else {
            ts.failed += 1;
        }
        info!(
            "TEST tunnel run {}: {} (max impact Δv {:.1} m/s, max rise {:.1} m, end pos {:.1?})",
            ts.step / 2 + 1,
            if ok { "contained" } else { "ESCAPED" },
            ts.impact_max,
            ts.max_height,
            pos.0
        );
        ts.escaped = false;
        ts.max_height = 0.0;
        ts.timer = 0.0;
        ts.step += 1;
    }
}

/// Shortcut test: after the car arms the lap, teleport it to just before the
/// last two checkpoints and the finish line. That must NOT count as a lap.
/// Then the autopilot drives a genuine lap, which must count.
fn shortcut_test(
    time: Res<Time>,
    opts: Res<DebugOpts>,
    track: Res<TrackData>,
    mut ts: ResMut<TestState>,
    mut cars: PlayerQuery,
    mut exit: MessageWriter<AppExit>,
    clock: Res<RaceClock>,
) {
    if opts.test.as_deref() != Some("shortcut") {
        return;
    }
    let Some((_, _, mut pos, mut rot, mut lin, mut ang, mut st, _, prog)) =
        cars.iter_mut().find(|c| c.1.is_player)
    else {
        return;
    };
    ts.timer += time.delta_secs();
    match ts.step {
        0 if prog.cps_total >= 2 => {
            // Armed (crossed cp_00, then cp_01). Jump ahead to before cp_14.
            let cp = &track.checkpoints[14];
            let lp = track.line_point(cp.line_index + track.line.len() - 6);
            let tf =
                Transform::from_translation(lp.pos + Vec3::Y * 0.4).looking_to(lp.tangent, Vec3::Y);
            teleport(
                tf,
                lp.tangent * 30.0,
                &mut pos,
                &mut rot,
                &mut lin,
                &mut ang,
                &mut st,
            );
            ts.stage_start_laps = prog.laps_done;
            ts.timer = 0.0;
            ts.step = 1;
            info!("TEST shortcut: teleported from cp_01 to before cp_14 (skipping cp_02..cp_13)");
        }
        1 if ts.timer > 12.0 => {
            // The car is still expected at cp_02 (shortcut crossings of cp_14/15/00 ignored);
            // it may have legitimately continued since, but no lap may have been counted.
            let ok = prog.laps_done == ts.stage_start_laps && prog.next_cp >= 2;
            info!(
                "TEST shortcut: after crossing cp_14, cp_15, cp_00 via shortcut: laps_done={} next_cp={} -> {}",
                prog.laps_done,
                prog.next_cp,
                if ok { "PASS (lap not counted)" } else { "FAIL" }
            );
            if ok {
                ts.passed += 1;
            } else {
                ts.failed += 1;
            }
            ts.step = 2;
        }
        2 if prog.laps_done > ts.stage_start_laps => {
            info!(
                "TEST shortcut: genuine lap counted after passing all checkpoints in order (lap time {}, race clock {}) -> PASS",
                prog.lap_times
                    .last()
                    .map(|t| format_time(*t))
                    .unwrap_or_default(),
                format_time(clock.time)
            );
            ts.passed += 1;
            info!("TEST shortcut: {} passed, {} failed", ts.passed, ts.failed);
            exit.write(AppExit::Success);
            ts.step = 3;
        }
        2 if ts.timer > 200.0 => {
            info!("TEST shortcut: FAIL (no genuine lap within 200 s)");
            exit.write(AppExit::Success);
            ts.step = 3;
        }
        _ => {}
    }
}

/// Reset test: manual reset, auto-reset when stranded off-track, auto-reset
/// when upside down.
fn reset_test(
    time: Res<Time>,
    opts: Res<DebugOpts>,
    track: Res<TrackData>,
    spatial: SpatialQuery,
    mut ts: ResMut<TestState>,
    mut cars: PlayerQuery,
    mut commands: Commands,
    mut resets: MessageWriter<ResetCar>,
    mut exit: MessageWriter<AppExit>,
) {
    if opts.test.as_deref() != Some("reset") {
        return;
    }
    let Some((e, _, mut pos, mut rot, mut lin, mut ang, mut st, mut input, prog)) =
        cars.iter_mut().find(|c| c.1.is_player)
    else {
        return;
    };
    ts.timer += time.delta_secs();
    let road = SpatialQueryFilter::from_mask(Layer::Road);
    let on_road = |p: Vec3| {
        spatial
            .cast_ray(p + Vec3::Y * 2.0, Dir3::NEG_Y, 6.0, true, &road)
            .is_some()
    };
    let report = |ts: &mut TestState, name: &str, ok: bool, detail: String| {
        info!(
            "TEST reset {name}: {} {detail}",
            if ok { "PASS" } else { "FAIL" }
        );
        if ok {
            ts.passed += 1;
        } else {
            ts.failed += 1;
        }
    };
    match ts.step {
        // 1) Manual reset after the autopilot has passed a few checkpoints.
        0 if prog.cps_total >= 3 => {
            commands.entity(e).remove::<AiDriver>();
            resets.write(ResetCar(e));
            ts.step = 1;
            ts.timer = 0.0;
        }
        1 if ts.timer > 0.5 => {
            let cp = prog
                .last_cp
                .map(|i| track.checkpoints[i].position)
                .unwrap_or_default();
            let d = pos.0.distance(cp);
            report(
                &mut ts,
                "manual",
                d < 6.0 && on_road(pos.0),
                format!("(car {d:.1} m from checkpoint {:?}, on road)", prog.last_cp),
            );
            // 2) Strand the car on the run-off, facing a wall, no input.
            let cp = &track.checkpoints[prog.last_cp.unwrap_or(0)];
            let right = cp.rotation * Vec3::X;
            let mut p = cp.position + right * (track.road_width * 0.5 + 3.0);
            if !inside_track(&spatial, p) {
                p = cp.position - right * (track.road_width * 0.5 + 3.0);
            }
            let tf = Transform::from_translation(p + Vec3::Y * 0.3).with_rotation(cp.rotation);
            teleport(
                tf,
                Vec3::ZERO,
                &mut pos,
                &mut rot,
                &mut lin,
                &mut ang,
                &mut st,
            );
            ts.target = p;
            ts.step = 2;
            ts.timer = 0.0;
        }
        2 => {
            *input = VehicleInput::default();
            let moved_to_road = on_road(pos.0) && pos.0.distance(ts.target) > 3.0;
            if moved_to_road || ts.timer > 6.0 {
                let (ok, t) = (moved_to_road && ts.timer > 2.9 && ts.timer < 4.0, ts.timer);
                report(
                    &mut ts,
                    "auto (off-track)",
                    ok,
                    format!("(reset after {t:.2} s off-track)"),
                );
                // 3) Flip the car upside down on the road.
                let tf = Transform::from_translation(pos.0 + Vec3::Y * 1.5)
                    .with_rotation(rot.0 * Quat::from_rotation_z(std::f32::consts::PI));
                ts.target = tf.translation;
                teleport(
                    tf,
                    Vec3::ZERO,
                    &mut pos,
                    &mut rot,
                    &mut lin,
                    &mut ang,
                    &mut st,
                );
                ts.step = 3;
                ts.timer = 0.0;
            }
        }
        3 => {
            *input = VehicleInput::default();
            let up = rot.0 * Vec3::Y;
            let reset_happened =
                up.y > 0.9 && ts.timer > 0.2 && st.upside_down_time == 0.0 && ts.timer > 2.5;
            if reset_happened || ts.timer > 8.0 {
                let (ok, t) = (reset_happened && ts.timer < 4.5, ts.timer);
                report(
                    &mut ts,
                    "auto (upside down)",
                    ok,
                    format!("(upright again after {t:.2} s)"),
                );
                info!("TEST reset: {} passed, {} failed", ts.passed, ts.failed);
                exit.write(AppExit::Success);
                ts.step = 4;
            }
        }
        _ => {}
    }
}

/// `RACER_TRACE=1`: one status line per second per car.
fn trace(
    real: Res<Time<Real>>,
    state: Res<State<AppState>>,
    clock: Res<RaceClock>,
    track: Res<TrackData>,
    cars: Query<(
        &Car,
        &Transform,
        &VehicleState,
        &VehicleInput,
        Option<&RaceProgress>,
    )>,
    mut last: Local<f32>,
) {
    if std::env::var("RACER_TRACE").is_err() {
        return;
    }
    let now = real.elapsed_secs();
    if now - *last < 1.0 {
        return;
    }
    *last = now;
    for (c, t, st, inp, p) in &cars {
        info!(
            "TRACE {:?} t={:.1} {} lineoff={:+.1} pos=({:.0},{:.1},{:.0}) v={:.0}km/h g={} off={:.1} line={:?} thr={:.2} brk={:.2} str={:.2} nitro={:.2}{} place={:?} lap={:?} cp={:?}",
            state.get(),
            clock.time,
            c.name,
            st.line_hint
                .map(|i| {
                    let lp = track.line_point(i);
                    (t.translation - lp.pos).dot(Vec3::Y.cross(lp.tangent))
                })
                .unwrap_or(0.0),
            t.translation.x,
            t.translation.y,
            t.translation.z,
            st.forward_speed * 3.6,
            st.grounded_wheels,
            st.offtrack_time,
            st.line_hint,
            inp.throttle,
            inp.brake,
            inp.steer,
            st.nitro,
            if st.nitro_active { "*" } else { "" },
            p.map(|p| p.place),
            p.map(|p| p.laps_done),
            p.map(|p| p.next_cp)
        );
    }
}

/// Nitro test: drive the start straight on autopilot, then (1) drift with the
/// handbrake for 1.5 s and measure the nitro gain, (2) follow an opponent
/// closely (slipstream) and measure the gain, (3) fire nitro on the back of the
/// straight and measure the speed gain vs. the 250 km/h cap.
fn nitro_test(
    time: Res<Time>,
    opts: Res<DebugOpts>,
    track: Res<TrackData>,
    mut ts: ResMut<TestState>,
    mut cars: PlayerQuery,
    mut commands: Commands,
    opponents: Res<OpponentSnapshot>,
    mut exit: MessageWriter<AppExit>,
) {
    if opts.test.as_deref() != Some("nitro") {
        return;
    }
    let Some((e, _, mut pos, mut rot, mut lin, mut ang, mut st, mut input, _)) =
        cars.iter_mut().find(|c| c.1.is_player)
    else {
        return;
    };
    ts.timer += time.delta_secs();
    let kmh = st.forward_speed * 3.6;
    match ts.step {
        // Stage 1: straight-line drift test at ~150 km/h on the start straight.
        0 => {
            // Main straight, racing line near the left edge: drift towards the right.
            let lp = track.line_point(385);
            let tf =
                Transform::from_translation(lp.pos + Vec3::Y * 0.4).looking_to(lp.tangent, Vec3::Y);
            teleport(
                tf,
                lp.tangent * 42.0,
                &mut pos,
                &mut rot,
                &mut lin,
                &mut ang,
                &mut st,
            );
            commands.entity(e).remove::<AiDriver>();
            st.nitro = 0.0;
            ts.timer = 0.0;
            ts.step = 1;
        }
        1 => {
            // Flick right with the handbrake, then counter-steer and hold the slide.
            let steer = if ts.timer < 0.5 { -0.8 } else { 0.25 };
            *input = VehicleInput {
                throttle: 1.0,
                steer,
                handbrake: ts.timer < 1.2,
                ..default()
            };
            ts.step_ticks += 1;
            if ts.step_ticks.is_multiple_of(6) {
                info!(
                    "DRIFT t={:.2} vf={:.1} vr={:.1} yaw={:.2} drifting={} beta={:.0}°",
                    ts.timer,
                    st.forward_speed,
                    st.lateral_speed,
                    ang.0.y,
                    st.drifting,
                    st.lateral_speed
                        .atan2(st.forward_speed.abs().max(1.0))
                        .to_degrees()
                );
            }
            if ts.timer > 1.5 {
                info!(
                    "TEST nitro drift: nitro 0.00 -> {:.2} in 1.5 s, speed 151 -> {:.0} km/h -> {}",
                    st.nitro,
                    kmh,
                    if st.nitro > 0.15 { "PASS" } else { "FAIL" }
                );
                ts.step = 2;
                ts.timer = 0.0;
            }
        }
        // Stage 2: full nitro on the main straight from 200 km/h.
        2 => {
            let lp = track.line_point(400);
            let tf =
                Transform::from_translation(lp.pos + Vec3::Y * 0.4).looking_to(lp.tangent, Vec3::Y);
            teleport(
                tf,
                lp.tangent * 200.0 / 3.6,
                &mut pos,
                &mut rot,
                &mut lin,
                &mut ang,
                &mut st,
            );
            st.nitro = 1.0;
            ts.impact_max = 0.0;
            ts.timer = 0.0;
            ts.step = 3;
        }
        3 => {
            *input = VehicleInput {
                throttle: 1.0,
                nitro: ts.timer > 0.2,
                ..default()
            };
            ts.impact_max = ts.impact_max.max(kmh);
            if ts.timer > 4.0 {
                info!(
                    "TEST nitro burst: 200 -> peak {:.0} km/h in 3.8 s (top speed without nitro is ~250), nitro left {:.2} -> {}",
                    ts.impact_max,
                    st.nitro,
                    if ts.impact_max > 262.0 {
                        "PASS"
                    } else {
                        "FAIL"
                    }
                );
                ts.step = 4;
                ts.timer = 0.0;
            }
        }
        // Stage 3: no nitro, same start: confirm the cap.
        4 => {
            let lp = track.line_point(400);
            let tf =
                Transform::from_translation(lp.pos + Vec3::Y * 0.4).looking_to(lp.tangent, Vec3::Y);
            teleport(
                tf,
                lp.tangent * 200.0 / 3.6,
                &mut pos,
                &mut rot,
                &mut lin,
                &mut ang,
                &mut st,
            );
            st.nitro = 0.0;
            ts.impact_max = 0.0;
            ts.timer = 0.0;
            ts.step = 5;
        }
        5 => {
            *input = VehicleInput {
                throttle: 1.0,
                ..default()
            };
            ts.impact_max = ts.impact_max.max(kmh);
            if ts.timer > 4.0 {
                info!(
                    "TEST nitro baseline: 200 -> peak {:.0} km/h in 3.8 s without nitro",
                    ts.impact_max
                );
                // Stage 4: slipstream — place the car 10 m behind an opponent on the straight.
                ts.step = 6;
                ts.timer = 0.0;
            }
        }
        6 => {
            // 12 m behind the fastest-moving opponent, same speed and heading.
            let Some((op, orot, ovel)) = opponents
                .0
                .iter()
                .copied()
                .max_by(|a, b| a.2.length().total_cmp(&b.2.length()))
            else {
                return;
            };
            if ovel.length() < 30.0 {
                return; // wait until they are at speed
            }
            let fwd = orot * Vec3::NEG_Z;
            let tf =
                Transform::from_translation(op - fwd * 12.0 + Vec3::Y * 0.1).with_rotation(orot);
            teleport(tf, ovel, &mut pos, &mut rot, &mut lin, &mut ang, &mut st);
            st.nitro = 0.0;
            ts.timer = 0.0;
            ts.step = 7;
        }
        7 => {
            // Follow with the autopilot so we stay in the wake.
            commands.entity(e).insert(AiDriver::for_player());
            ts.step = 8;
        }
        _ => {
            if ts.step == 8 && ts.timer > 2.0 {
                info!(
                    "TEST nitro slipstream: drafting={} nitro gain {:.2} over 2 s",
                    st.drafting, st.nitro
                );
                exit.write(AppExit::Success);
                ts.step = 99;
            }
        }
    }
}

#[derive(Resource, Default)]
struct OpponentSnapshot(Vec<(Vec3, Quat, Vec3)>);

fn snapshot_opponents(
    mut snap: ResMut<OpponentSnapshot>,
    cars: Query<(&Car, &Position, &Rotation, &LinearVelocity)>,
) {
    snap.0 = cars
        .iter()
        .filter(|c| !c.0.is_player)
        .map(|(_, p, r, v)| (p.0, r.0, v.0))
        .collect();
}

/// Flow test: pause freezes the race clock and physics, resume continues,
/// restart returns to the countdown with a fresh race, menu returns to the start screen.
fn flow_test(
    opts: Res<DebugOpts>,
    real: Res<Time<Real>>,
    state: Res<State<AppState>>,
    clock: Res<RaceClock>,
    paused: Res<crate::game_state::Paused>,
    cars: Query<(&Car, &Position)>,
    mut pause: MessageWriter<crate::game_state::TogglePause>,
    mut restart: MessageWriter<crate::game_state::RestartRace>,
    mut menu: MessageWriter<crate::game_state::BackToMenu>,
    mut exit: MessageWriter<AppExit>,
    mut step: Local<u32>,
    mut t0: Local<f32>,
    mut saved: Local<(f32, Vec3)>,
) {
    if opts.test.as_deref() != Some("flow") {
        return;
    }
    let now = real.elapsed_secs();
    let player = cars
        .iter()
        .find(|c| c.0.is_player)
        .map(|c| c.1.0)
        .unwrap_or_default();
    let report = |name: &str, ok: bool, detail: String| {
        info!(
            "TEST flow {name}: {} {detail}",
            if ok { "PASS" } else { "FAIL" }
        );
    };
    match *step {
        0 if *state.get() == AppState::Racing && clock.time > 4.0 => {
            pause.write(crate::game_state::TogglePause);
            *t0 = now;
            *step = 1;
        }
        1 if now - *t0 > 0.5 => {
            *saved = (clock.time, player);
            *t0 = now;
            *step = 2;
        }
        2 if now - *t0 > 2.0 => {
            let frozen = (clock.time - saved.0).abs() < 1e-4 && player.distance(saved.1) < 1e-3;
            report(
                "pause",
                paused.0 && frozen,
                format!(
                    "(clock {:.3} -> {:.3}, car moved {:.4} m in 2 s)",
                    saved.0,
                    clock.time,
                    player.distance(saved.1)
                ),
            );
            pause.write(crate::game_state::TogglePause);
            *t0 = now;
            *step = 3;
        }
        3 if now - *t0 > 1.0 => {
            report(
                "resume",
                !paused.0 && clock.time > saved.0 + 0.5,
                format!("(clock now {:.2})", clock.time),
            );
            restart.write(crate::game_state::RestartRace);
            *t0 = now;
            *step = 4;
        }
        4 if now - *t0 > 0.5 => {
            report(
                "restart",
                *state.get() == AppState::Countdown && clock.time == 0.0,
                format!("(state {:?}, clock {:.2})", state.get(), clock.time),
            );
            menu.write(crate::game_state::BackToMenu);
            *t0 = now;
            *step = 5;
        }
        5 if now - *t0 > 0.5 => {
            report(
                "menu",
                *state.get() == AppState::Menu,
                format!("(state {:?})", state.get()),
            );
            exit.write(AppExit::Success);
            *step = 6;
        }
        _ => {}
    }
}

/// Multi-touch test: inject OS-level `TouchInput` messages (the same messages
/// winit produces on iOS) for two, then three simultaneous fingers and check
/// the player's `VehicleInput` one frame later.
fn touch_test(
    opts: Res<DebugOpts>,
    state: Res<State<AppState>>,
    window: Query<(Entity, &Window), With<bevy::window::PrimaryWindow>>,
    mut touches: MessageWriter<bevy::input::touch::TouchInput>,
    cars: Query<(&Car, &VehicleInput)>,
    mode: Res<crate::input::InputMode>,
    mut exit: MessageWriter<AppExit>,
    mut step: Local<u32>,
) {
    use crate::input::{TouchButton, touch_layout};
    use bevy::input::touch::{TouchInput, TouchPhase};
    if opts.test.as_deref() != Some("touch") || *state.get() != AppState::Racing {
        return;
    }
    let Ok((win, w)) = window.single() else {
        return;
    };
    let layout = touch_layout(w.size());
    let center = |b: TouchButton| {
        layout
            .iter()
            .find(|(k, _)| *k == b)
            .map(|(_, r)| r.center())
            .unwrap_or_default()
    };
    let mut send = |id: u64, phase: TouchPhase, b: TouchButton| {
        touches.write(TouchInput {
            phase,
            position: center(b),
            window: win,
            force: None,
            id,
        });
    };
    let Some((_, input)) = cars.iter().find(|c| c.0.is_player) else {
        return;
    };
    *step += 1;
    match *step {
        1 => {
            send(1, TouchPhase::Started, TouchButton::SteerLeft);
            send(2, TouchPhase::Started, TouchButton::Nitro);
        }
        // Steering ramps in over a few frames.
        20 => {
            let ok = mode.touch
                && input.steer > 0.5
                && input.nitro
                && input.throttle == 1.0
                && input.brake == 0.0;
            info!(
                "TEST touch two fingers (steer-left + nitro): steer={:.2} nitro={} throttle={} brake={} -> {}",
                input.steer,
                input.nitro,
                input.throttle,
                input.brake,
                if ok { "PASS" } else { "FAIL" }
            );
            send(3, TouchPhase::Started, TouchButton::Brake);
        }
        25 => {
            let ok =
                input.steer > 0.5 && input.nitro && input.brake == 1.0 && input.throttle == 0.0;
            info!(
                "TEST touch three fingers (+ brake): steer={:.2} nitro={} throttle={} brake={} -> {}",
                input.steer,
                input.nitro,
                input.throttle,
                input.brake,
                if ok { "PASS" } else { "FAIL" }
            );
            send(1, TouchPhase::Ended, TouchButton::SteerLeft);
            send(3, TouchPhase::Ended, TouchButton::Brake);
            send(4, TouchPhase::Started, TouchButton::SteerRight);
        }
        45 => {
            let ok = input.steer < -0.5 && input.nitro && input.throttle == 1.0;
            info!(
                "TEST touch lift + new finger (steer-right, nitro still held): steer={:.2} nitro={} throttle={} -> {}",
                input.steer,
                input.nitro,
                input.throttle,
                if ok { "PASS" } else { "FAIL" }
            );
            send(2, TouchPhase::Ended, TouchButton::Nitro);
            send(4, TouchPhase::Ended, TouchButton::SteerRight);
            exit.write(AppExit::Success);
        }
        _ => {}
    }
}
