//! Race rules: countdown, checkpoints (in order), laps, timing, positions,
//! finishing, resets to the last checkpoint and the persisted best lap.

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::{
    ai::AiDriver,
    game_state::{AppState, DebugOpts},
    persist,
    physics::FixedGameSystems,
    track_data::TrackData,
    vehicle::{Car, ResetCar, VehicleInput, VehicleState},
};

pub const TOTAL_LAPS: u32 = 3;
pub const COUNTDOWN_SECS: f32 = 3.0;

/// Per-car race progress.
#[derive(Component, Debug, Clone, Default)]
pub struct RaceProgress {
    /// Completed laps.
    pub laps_done: u32,
    /// Index of the checkpoint that must be crossed next.
    pub next_cp: usize,
    /// Number of valid checkpoint crossings so far (the first cp_00 crossing included).
    pub cps_total: u32,
    /// Last checkpoint crossed (reset location); `None` = still on the grid.
    pub last_cp: Option<usize>,
    pub lap_start: f32,
    pub lap_times: Vec<f32>,
    pub best_lap: Option<f32>,
    /// Total race time when finished.
    pub finish_time: Option<f32>,
    pub finish_place: Option<usize>,
    /// Current place 1..=4.
    pub place: usize,
    /// Continuous progress score used for ranking.
    pub score: f32,
    prev_center: Option<Vec3>,
}

impl RaceProgress {
    /// Lap currently being driven, 1-based and clamped for display.
    pub fn current_lap(&self) -> u32 {
        (self.laps_done + 1).min(TOTAL_LAPS)
    }
}

/// Race clock (advances with the fixed timestep, so it stops when paused).
#[derive(Resource, Debug, Default)]
pub struct RaceClock {
    pub time: f32,
    pub countdown: f32,
    /// Seconds since GO, used to show "GO!" briefly.
    pub since_go: f32,
    pub finishers: usize,
}

#[derive(Resource, Debug, Default)]
pub struct BestLap {
    pub time: Option<f32>,
    /// Set when the player beat the stored best during this race.
    pub new_record: bool,
}

#[derive(Message, Debug, Clone, Copy)]
pub struct CountdownTick(pub u8);

#[derive(Message, Debug, Clone, Copy)]
pub struct LapCompleted {
    pub car: Entity,
    pub is_player: bool,
    pub lap: u32,
    pub time: f32,
}

#[derive(Message, Debug, Clone, Copy)]
pub struct CarFinished {
    pub car: Entity,
    pub is_player: bool,
    pub place: usize,
}

#[derive(Message, Debug, Clone, Copy)]
pub struct CheckpointPassed {
    pub car: Entity,
    pub index: usize,
}

pub struct RacePlugin;

impl Plugin for RacePlugin {
    fn build(&self, app: &mut App) {
        let best = persist::load().best_lap_s;
        app.insert_resource(BestLap {
            time: best,
            new_record: false,
        })
        .init_resource::<RaceClock>()
        .add_message::<CountdownTick>()
        .add_message::<LapCompleted>()
        .add_message::<CarFinished>()
        .add_message::<CheckpointPassed>()
        .add_systems(OnEnter(AppState::Menu), reset_race)
        .add_systems(
            OnEnter(AppState::Countdown),
            (reset_race, start_countdown).chain(),
        )
        .add_systems(
            FixedUpdate,
            (
                countdown.run_if(in_state(AppState::Countdown)),
                (race_clock, checkpoints, ranking)
                    .chain()
                    .run_if(in_state(AppState::Racing).or_else(in_state(AppState::Finished))),
                handle_resets,
            )
                .chain()
                .in_set(FixedGameSystems::Race),
        )
        .add_systems(Update, player_finished.run_if(in_state(AppState::Racing)))
        .add_systems(OnEnter(AppState::Finished), enable_player_autopilot);
    }
}

fn place_car(
    tf: Transform,
    pos: &mut Position,
    rot: &mut Rotation,
    lin: &mut LinearVelocity,
    ang: &mut AngularVelocity,
    transform: &mut Transform,
) {
    pos.0 = tf.translation;
    rot.0 = tf.rotation;
    lin.0 = Vec3::ZERO;
    ang.0 = Vec3::ZERO;
    *transform = tf;
}

/// Put every car back on the grid with fresh state.
fn reset_race(
    mut commands: Commands,
    track: Res<TrackData>,
    mut clock: ResMut<RaceClock>,
    mut best: ResMut<BestLap>,
    opts: Res<DebugOpts>,
    mut cars: Query<(
        Entity,
        &Car,
        &mut Position,
        &mut Rotation,
        &mut LinearVelocity,
        &mut AngularVelocity,
        &mut Transform,
        &mut VehicleState,
        &mut VehicleInput,
    )>,
) {
    *clock = RaceClock::default();
    best.new_record = false;
    for (e, car, mut p, mut r, mut l, mut a, mut t, mut st, mut input) in &mut cars {
        let spawn = track.spawns[car.index % track.spawns.len()];
        // Drop from a few cm so the suspension settles instead of popping.
        let spawn = spawn.with_translation(spawn.translation + Vec3::Y * 0.05);
        place_car(spawn, &mut p, &mut r, &mut l, &mut a, &mut t);
        *st = VehicleState::default();
        *input = VehicleInput::default();
        let mut ec = commands.entity(e);
        ec.insert(RaceProgress {
            place: car.index + 1,
            ..default()
        });
        if car.is_player && !opts.autopilot {
            ec.remove::<AiDriver>();
        }
    }
}

fn start_countdown(mut clock: ResMut<RaceClock>) {
    clock.countdown = COUNTDOWN_SECS + 0.8; // short settle before "3"
}

fn countdown(
    time: Res<Time>,
    mut clock: ResMut<RaceClock>,
    mut ticks: MessageWriter<CountdownTick>,
    mut next: ResMut<NextState<AppState>>,
) {
    let before = clock.countdown;
    clock.countdown -= time.delta_secs();
    let after = clock.countdown;
    for n in [3u8, 2, 1] {
        let t = n as f32;
        if before > t && after <= t {
            ticks.write(CountdownTick(n));
        }
    }
    if after <= 0.0 {
        ticks.write(CountdownTick(0));
        clock.countdown = 0.0;
        next.set(AppState::Racing);
    }
}

fn race_clock(time: Res<Time>, mut clock: ResMut<RaceClock>) {
    clock.time += time.delta_secs();
    clock.since_go += time.delta_secs();
}

fn checkpoints(
    track: Res<TrackData>,
    mut clock: ResMut<RaceClock>,
    mut best: ResMut<BestLap>,
    mut cars: Query<(Entity, &Car, &Position, &Rotation, &mut RaceProgress)>,
    mut laps: MessageWriter<LapCompleted>,
    mut finished: MessageWriter<CarFinished>,
    mut passed: MessageWriter<CheckpointPassed>,
) {
    let n_cp = track.checkpoints.len();
    for (e, car, pos, rot, mut prog) in &mut cars {
        let center = pos.0 + rot.0 * Vec3::Y * 0.6;
        let Some(prev) = prog.prev_center.replace(center) else {
            continue;
        };
        if prog.finish_time.is_some() {
            continue;
        }
        // Only the *next* checkpoint is tested: crossing any other one (e.g. after
        // a shortcut) is ignored, so laps only count with every checkpoint in order.
        let cp_index = prog.next_cp;
        let cp = &track.checkpoints[cp_index];
        if !cp.crossed(prev, center) {
            continue;
        }
        prog.cps_total += 1;
        prog.last_cp = Some(cp_index);
        prog.next_cp = (cp_index + 1) % n_cp;
        passed.write(CheckpointPassed {
            car: e,
            index: cp_index,
        });

        // Crossing cp_00 after the full sequence completes a lap. The very first
        // crossing (from the grid behind the line) only arms the sequence.
        if cp_index == 0 && prog.cps_total > 1 {
            let lap_time = clock.time - prog.lap_start;
            prog.lap_start = clock.time;
            prog.laps_done += 1;
            prog.lap_times.push(lap_time);
            prog.best_lap = Some(prog.best_lap.map_or(lap_time, |b: f32| b.min(lap_time)));
            laps.write(LapCompleted {
                car: e,
                is_player: car.is_player,
                lap: prog.laps_done,
                time: lap_time,
            });
            if car.is_player && best.time.is_none_or(|b| lap_time < b) {
                best.time = Some(lap_time);
                best.new_record = true;
                if let Err(err) = persist::store(&persist::SaveData {
                    best_lap_s: Some(lap_time),
                }) {
                    warn!("could not save best lap: {err}");
                }
            }
            if prog.laps_done >= TOTAL_LAPS {
                clock.finishers += 1;
                prog.finish_time = Some(clock.time);
                prog.finish_place = Some(clock.finishers);
                finished.write(CarFinished {
                    car: e,
                    is_player: car.is_player,
                    place: clock.finishers,
                });
            }
        }
    }
}

/// Continuous progress score → places.
fn ranking(
    track: Res<TrackData>,
    mut cars: Query<(&Position, &mut VehicleState, &mut RaceProgress)>,
) {
    let n_cp = track.checkpoints.len();
    let len = track.line_length;
    for (pos, mut st, mut prog) in &mut cars {
        let idx = track.nearest_line_index(pos.0, st.line_hint);
        st.line_hint = Some(idx);
        let s_car = track.line_s(pos.0, idx);
        let next = &track.checkpoints[prog.next_cp];
        let prev = &track.checkpoints[(prog.next_cp + n_cp - 1) % n_cp];
        let s_next = track.line[next.line_index].s;
        let s_prev = track.line[prev.line_index].s;
        let seg = (s_next - s_prev).rem_euclid(len).max(1.0);
        let d = (s_car - s_prev).rem_euclid(len);
        // Cars slightly *behind* the previous checkpoint wrap to ~len: treat as 0.
        let frac = if d > seg + 50.0 {
            0.0
        } else {
            (d / seg).clamp(0.0, 0.999)
        };
        prog.score = match prog.finish_place {
            Some(p) => 10_000.0 - p as f32,
            None => prog.cps_total as f32 + frac,
        };
    }
    let mut order: Vec<(f32, usize)> = Vec::new();
    for (i, (_, _, prog)) in cars.iter().enumerate() {
        order.push((prog.score, i));
    }
    order.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut places = vec![0; order.len()];
    for (rank, (_, i)) in order.iter().enumerate() {
        places[*i] = rank + 1;
    }
    for (i, (_, _, mut prog)) in cars.iter_mut().enumerate() {
        if prog.place != places[i] {
            prog.place = places[i];
        }
    }
}

/// Put a car back on the track at its last checkpoint (or its grid slot).
fn handle_resets(
    mut msgs: MessageReader<ResetCar>,
    track: Res<TrackData>,
    mut cars: Query<(
        Entity,
        &Car,
        &RaceProgress,
        &mut Position,
        &mut Rotation,
        &mut LinearVelocity,
        &mut AngularVelocity,
        &mut Transform,
        &mut VehicleState,
    )>,
) {
    let requests: Vec<Entity> = msgs.read().map(|m| m.0).collect();
    if requests.is_empty() {
        return;
    }
    let others: Vec<(Entity, Vec3)> = cars.iter().map(|c| (c.0, c.3.0)).collect();
    for target in requests {
        let Ok((e, car, prog, mut p, mut r, mut l, mut a, mut t, mut st)) = cars.get_mut(target)
        else {
            continue;
        };
        let base = match prog.last_cp {
            Some(i) => {
                let cp = &track.checkpoints[i];
                Transform::from_translation(cp.position).with_rotation(cp.rotation)
            }
            None => track.spawns[car.index % track.spawns.len()],
        };
        let right = base.rotation * Vec3::X;
        // Pick a lateral slot that is free of other cars.
        let mut chosen = base.translation;
        for off in [0.0, 4.0, -4.0, 2.0, -2.0] {
            let cand = base.translation + right * off;
            if others
                .iter()
                .all(|(oe, op)| *oe == e || op.distance(cand) > 6.0)
            {
                chosen = cand;
                break;
            }
        }
        let tf = base.with_translation(chosen + Vec3::Y * 0.4);
        place_car(tf, &mut p, &mut r, &mut l, &mut a, &mut t);
        st.prev_center = None;
        st.offtrack_time = 0.0;
        st.upside_down_time = 0.0;
        st.nitro_active = false;
        st.drifting = false;
        st.post_control_vel = Vec3::ZERO;
        st.line_hint = None;
        info!("reset car {} to checkpoint {:?}", car.name, prog.last_cp);
    }
}

fn player_finished(mut msgs: MessageReader<CarFinished>, mut next: ResMut<NextState<AppState>>) {
    if msgs.read().any(|m| m.is_player) {
        next.set(AppState::Finished);
    }
}

/// After the flag the AI takes over the player's car for a cool-down lap.
fn enable_player_autopilot(mut commands: Commands, cars: Query<(Entity, &Car)>) {
    for (e, car) in &cars {
        if car.is_player {
            commands.entity(e).insert(AiDriver::for_player());
        }
    }
}

pub fn format_time(t: f32) -> String {
    let t = t.max(0.0);
    let m = (t / 60.0).floor() as u32;
    let s = t - m as f32 * 60.0;
    format!("{m}:{s:06.3}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_format() {
        assert_eq!(format_time(0.0), "0:00.000");
        assert_eq!(format_time(75.5), "1:15.500");
    }
}
