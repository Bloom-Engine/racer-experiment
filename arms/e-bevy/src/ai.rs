//! AI drivers: follow the manifest racing line with a pure-pursuit steering
//! controller and a braking-distance speed planner, vary their line, overtake
//! or queue behind other cars, use nitro on straights and recover when stuck.
//!
//! AI cars are physical bodies driven through the same [`VehicleInput`] /
//! vehicle model as the player — no ghosting, no teleporting.

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::{
    game_state::DebugOpts,
    physics::{FixedGameSystems, Layer},
    race::RaceProgress,
    track_data::TrackData,
    vehicle::{Car, ResetCar, VehicleInput, VehicleState},
};

#[derive(Component, Debug, Clone)]
pub struct AiDriver {
    /// Multiplier on the racing-line speed profile.
    pub skill: f32,
    /// Corner-entry braking used for planning, m/s².
    pub plan_decel: f32,
    /// Lateral offset from the racing line (m, +left).
    pub lane: f32,
    lane_target: f32,
    phase: f32,
    stuck_time: f32,
    reverse_time: f32,
    /// Apply catch-up / slow-down relative to the player.
    pub rubber_band: bool,
    /// Amplitude of the slow lateral line variation, m.
    pub wander: f32,
}

impl AiDriver {
    pub fn new(skill: f32, phase: f32) -> Self {
        Self {
            skill,
            plan_decel: 15.0,
            lane: 0.0,
            lane_target: 0.0,
            phase,
            stuck_time: 0.0,
            reverse_time: 0.0,
            rubber_band: true,
            wander: 1.3,
        }
    }

    /// Autopilot for the player's car (after the finish, or in tests).
    pub fn for_player() -> Self {
        Self {
            rubber_band: false,
            wander: 0.0,
            ..Self::new(1.18, 0.0)
        }
    }
}

/// Base skills for the three opponents (index 1..=3). Tuned so a clean,
/// committed player wins and a sloppy one doesn't (see NOTES.md).
pub const AI_SKILLS: [f32; 3] = [1.22, 1.17, 1.12];

/// Passive nitro fill for the AI (it does not drift), per second.
const AI_NITRO_FILL: f32 = 0.025;

pub struct AiPlugin;

impl Plugin for AiPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, attach_ai_drivers).add_systems(
            FixedUpdate,
            (compute_lane_limits, ai_drive)
                .chain()
                .in_set(FixedGameSystems::Input),
        );
    }
}

fn attach_ai_drivers(
    mut commands: Commands,
    cars: Query<(Entity, &Car), (Added<Car>, Without<AiDriver>)>,
    opts: Res<DebugOpts>,
) {
    for (e, car) in &cars {
        if car.is_player {
            if opts.autopilot {
                let mut d = AiDriver::for_player();
                if let Some(s) = opts.player_skill {
                    d.skill = s;
                }
                commands.entity(e).insert(d);
            }
        } else {
            let skill = AI_SKILLS[(car.index - 1) % AI_SKILLS.len()];
            commands
                .entity(e)
                .insert(AiDriver::new(skill, car.index as f32 * 2.1));
        }
    }
}

/// Free road (asphalt + kerbs) to the left / right of each racing-line point,
/// measured once by raycasting the `col_road` collider. The racing line hugs
/// the edges in places, so lane offsets must be limited per point.
#[derive(Resource, Debug)]
pub struct LaneLimits {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl LaneLimits {
    /// Clamp a lateral offset (+left) so the car (half-width ~1 m) stays on asphalt.
    pub fn clamp(&self, i: usize, lane: f32) -> f32 {
        let i = i % self.left.len();
        let hi = (self.left[i] - 1.4).max(0.0);
        let lo = -(self.right[i] - 1.4).max(0.0);
        lane.clamp(lo, hi)
    }
}

fn compute_lane_limits(
    mut commands: Commands,
    limits: Option<Res<LaneLimits>>,
    track: Res<TrackData>,
    spatial: SpatialQuery,
    ready: Res<crate::track::TrackReady>,
    cars: Query<(), With<Car>>,
) {
    // Wait until the colliders are in the physics world (cars exist by then).
    if limits.is_some() || !ready.0 || cars.is_empty() {
        return;
    }
    let road = SpatialQueryFilter::from_mask(Layer::Road);
    let free = |p: Vec3, dir: Vec3| -> f32 {
        let mut last_ok = 0.0;
        let mut d = 0.5;
        while d <= 12.0 {
            let q = p + dir * d + Vec3::Y * 3.0;
            if spatial.cast_ray(q, Dir3::NEG_Y, 8.0, true, &road).is_none() {
                break;
            }
            last_ok = d;
            d += 0.5;
        }
        last_ok
    };
    let mut left = Vec::with_capacity(track.line.len());
    let mut right = Vec::with_capacity(track.line.len());
    for lp in &track.line {
        let l = Vec3::Y.cross(lp.tangent);
        left.push(free(lp.pos, l));
        right.push(free(lp.pos, -l));
    }
    let min_l = left.iter().cloned().fold(f32::MAX, f32::min);
    let min_r = right.iter().cloned().fold(f32::MAX, f32::min);
    if min_l + min_r < 4.0 && left.iter().all(|v| *v == 0.0) {
        // Colliders not queryable yet; try again next tick.
        return;
    }
    info!("lane limits computed (min free left {min_l:.1} m, right {min_r:.1} m)");
    commands.insert_resource(LaneLimits { left, right });
}

fn ai_drive(
    time: Res<Time>,
    track: Res<TrackData>,
    mut drivers: Query<(
        Entity,
        &Car,
        &mut AiDriver,
        &mut VehicleInput,
        &mut VehicleState,
        &Position,
        &Rotation,
        Option<&RaceProgress>,
    )>,
    others: Query<(
        Entity,
        &Car,
        &Position,
        &LinearVelocity,
        Option<&RaceProgress>,
    )>,
    mut resets: MessageWriter<ResetCar>,
    limits: Option<Res<LaneLimits>>,
) {
    let dt = time.delta_secs();
    let Some(limits) = limits else { return };
    if dt <= 0.0 {
        return;
    }
    let t = time.elapsed_secs();
    let n = track.line.len();
    let len = track.line_length;
    let snapshot: Vec<(Entity, Vec3, Vec3)> =
        others.iter().map(|(e, _, p, v, _)| (e, p.0, v.0)).collect();
    let player_score = others
        .iter()
        .find(|(_, c, ..)| c.is_player)
        .and_then(|(.., p)| p.map(|p| p.score));

    for (entity, car, mut ai, mut input, mut st, pos, rot, prog) in &mut drivers {
        let p = pos.0;
        let fwd = rot.0 * Vec3::NEG_Z;
        let left = rot.0 * Vec3::NEG_X;
        let speed = st.forward_speed;
        let idx = track.nearest_line_index(p, st.line_hint);
        st.line_hint = Some(idx);
        let here = track.line_point(idx);

        if st.hold {
            *input = VehicleInput::default();
            ai.stuck_time = 0.0;
            continue;
        }

        // --- Speed planning ---------------------------------------------------
        let mut skill = ai.skill;
        if ai.rubber_band
            && let (Some(ps), Some(me)) = (player_score, prog)
        {
            // Score unit = one checkpoint segment (~138 m).
            let diff = (me.score - ps).clamp(-3.0, 3.0);
            skill *= 1.0 - 0.025 * diff;
        }
        let horizon = (speed.max(0.0).powi(2) / (2.0 * ai.plan_decel) + 25.0).min(260.0);
        let mut target_speed = f32::MAX;
        let mut k = 0;
        loop {
            let lp = track.line_point(idx + k);
            let dist = (lp.s - here.s).rem_euclid(len);
            if dist > horizon || k > n {
                break;
            }
            let v_corner = lp.speed * skill;
            let v_allowed = (v_corner * v_corner + 2.0 * ai.plan_decel * dist).sqrt();
            target_speed = target_speed.min(v_allowed);
            k += 1;
        }

        // --- Traffic: overtake or queue ----------------------------------------
        let mut wander = (t * 0.11 + ai.phase).sin() * ai.wander;
        let mut follow_speed = f32::MAX;
        for (oe, op, ov) in &snapshot {
            if *oe == entity {
                continue;
            }
            let rel = *op - p;
            let ahead = rel.dot(fwd);
            let lat = rel.dot(left);
            if (0.0..28.0).contains(&ahead) && lat.abs() < 3.4 {
                let their_speed = ov.dot(fwd);
                if speed > their_speed - 1.0 {
                    // Pull out to the side with more room relative to them.
                    let side = if lat > 0.0 { -1.0 } else { 1.0 };
                    wander = ai.lane + side * 3.6;
                    if ahead < 9.0 && lat.abs() < 2.2 {
                        follow_speed = follow_speed.min(their_speed - 0.5);
                    }
                }
            }
        }
        // Limit by the free road a little ahead of the car.
        let ahead_idx = idx + 3;
        ai.lane_target = limits.clamp(ahead_idx, wander.clamp(-3.6, 3.6));
        let lane_rate = 2.2 * dt;
        ai.lane += (ai.lane_target - ai.lane).clamp(-lane_rate, lane_rate);
        let target_speed = target_speed.min(follow_speed.max(8.0));

        // --- Steering (pure pursuit on the offset line) ------------------------
        let look = 7.0 + speed.abs() * 0.32;
        let j = idx + (look / 5.0).ceil() as usize;
        let lp = track.line_point(j);
        let lp_left = Vec3::Y.cross(lp.tangent);
        let target = lp.pos + lp_left * limits.clamp(j, ai.lane);
        let to = target - p;
        let angle = to.dot(left).atan2(to.dot(fwd));
        let mut steer = (angle * 2.4).clamp(-1.0, 1.0);

        // --- Throttle / brake ----------------------------------------------------
        let (mut throttle, mut brake) = if speed < target_speed - 0.5 {
            (1.0, 0.0)
        } else if speed > target_speed + 1.5 {
            (0.0, ((speed - target_speed) / 6.0).clamp(0.25, 1.0))
        } else {
            (0.35, 0.0)
        };

        // --- Stuck recovery ----------------------------------------------------------
        if ai.reverse_time > 0.0 {
            ai.reverse_time -= dt;
            throttle = 0.0;
            brake = 1.0;
            steer = -steer.signum();
        } else if speed.abs() < 1.5 && throttle > 0.0 {
            ai.stuck_time += dt;
            if ai.stuck_time > 1.6 {
                ai.reverse_time = 1.3;
            }
        } else if speed > 5.0 {
            ai.stuck_time = 0.0;
        }
        if ai.stuck_time > 7.0 {
            ai.stuck_time = 0.0;
            ai.reverse_time = 0.0;
            resets.write(ResetCar(entity));
        }

        // --- Nitro on long straights ---------------------------------------------
        if !car.is_player {
            st.nitro = (st.nitro + AI_NITRO_FILL * dt).min(1.0);
        }
        let straight_ahead = (0..30).all(|k| track.line_point(idx + k).speed * skill > speed + 8.0);
        let nitro = (st.nitro_active || st.nitro > 0.45)
            && straight_ahead
            && steer.abs() < 0.25
            && speed > 30.0;

        *input = VehicleInput {
            throttle,
            brake,
            steer,
            handbrake: false,
            nitro,
        };
    }
}
