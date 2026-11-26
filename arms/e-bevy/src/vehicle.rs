//! Arcade vehicle: raycast suspension on a dynamic rigid body, plus direct
//! velocity shaping for drive, grip, steering, drifting and nitro.
//!
//! The model is deliberately *not* a tyre simulation. Suspension uses real
//! spring forces at the four wheel positions (so the car follows hills, pitches
//! and rolls), but longitudinal drive, lateral grip and yaw are applied as
//! velocity changes towards targets. That keeps it forgiving and predictable
//! at 250+ km/h while collisions are still resolved by the physics engine.

use avian3d::prelude::*;
use bevy::{gltf::GltfMaterialName, prelude::*, world_serialization::WorldInstanceReady};

use crate::{
    game_state::AppState,
    physics::{FixedGameSystems, Layer, Surface},
    track_data::TrackData,
};

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

pub const CAR_MASS: f32 = 1420.0;
pub const WHEEL_RADIUS: f32 = 0.34;
/// Wheel hub positions (car-local, origin at ground level / wheelbase centre).
/// Order: FL, FR, RL, RR.
pub const WHEEL_POS: [Vec3; 4] = [
    Vec3::new(-0.83, WHEEL_RADIUS, -1.35),
    Vec3::new(0.83, WHEEL_RADIUS, -1.35),
    Vec3::new(-0.83, WHEEL_RADIUS, 1.35),
    Vec3::new(0.83, WHEEL_RADIUS, 1.35),
];
pub const WHEEL_NAMES: [&str; 4] = ["wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR"];

/// Suspension ray origin height above the car origin.
const SUSP_TOP: f32 = 0.59;
/// Static sag under the car's weight.
const SUSP_SAG: f32 = 0.08;
/// Spring rest length (ray distance at which the spring force is zero).
const SUSP_REST: f32 = SUSP_TOP + SUSP_SAG;
/// Max ray length: beyond this the wheel is in the air.
const SUSP_MAX: f32 = SUSP_TOP + 0.25;
const SUSP_K: f32 = CAR_MASS * 9.81 / 4.0 / SUSP_SAG;
const SUSP_DAMP: f32 = 3400.0;

/// 253 km/h: the car settles at ~250 km/h displayed on the main straight.
pub const MAX_SPEED: f32 = 70.3;
/// 300 km/h with nitro.
pub const NITRO_MAX_SPEED: f32 = 83.4;
const ACCEL: f32 = 13.5;
const NITRO_ACCEL: f32 = 11.0;
const BRAKE_DECEL: f32 = 26.0;
const REVERSE_MAX: f32 = 12.0;
const REVERSE_ACCEL: f32 = 8.0;
const COAST_DECEL: f32 = 1.8;
const HANDBRAKE_DECEL: f32 = 3.0;
const OFFROAD_MAX_FACTOR: f32 = 0.55;
const OFFROAD_DRAG: f32 = 3.0;

/// Lateral grip: fraction of sideways velocity removed per second (exp. rate).
const GRIP: f32 = 9.0;
const DRIFT_GRIP: f32 = 1.4;
const OFFROAD_GRIP_FACTOR: f32 = 0.6;
/// Part of the sideways speed scrubbed in a drift that is given back as forward speed.
const DRIFT_SPEED_RETAIN: f32 = 0.8;
/// Max slip angle while drifting (rad): yaw that would exceed it is cancelled.
const MAX_DRIFT_ANGLE: f32 = 0.6;
/// Max yaw rate (rad/s) at low and at top speed.
const YAW_LOW: f32 = 2.1;
const YAW_HIGH: f32 = 0.8;
const DRIFT_YAW_BOOST: f32 = 1.5;
const YAW_RESPONSE: f32 = 9.0;
/// Extra downward acceleration per (m/s)² while grounded.
const DOWNFORCE: f32 = 0.0011;

/// Nitro: fill rates (per second) and drain rate.
pub const NITRO_FILL_DRIFT: f32 = 0.20;
pub const NITRO_FILL_DRAFT: f32 = 0.12;
const NITRO_DRAIN: f32 = 0.30;
/// Minimum charge to start a burst.
const NITRO_MIN_START: f32 = 0.15;
/// Instant kick on activation, m/s.
const NITRO_KICK: f32 = 2.5;

/// Seconds off-track / upside down before the automatic reset.
pub const AUTO_RESET_TIME: f32 = 3.0;

/// Gear table: upper bound of each gear in km/h.
const GEAR_TOP_KMH: [f32; 6] = [60.0, 100.0, 140.0, 180.0, 220.0, 310.0];
pub const IDLE_RPM: f32 = 900.0;
pub const REDLINE_RPM: f32 = 7500.0;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

#[derive(Component, Debug, Clone)]
pub struct Car {
    pub index: usize,
    pub is_player: bool,
    pub name: String,
    pub color: Color,
}

/// Driver commands, written by the input system (player) or the AI.
#[derive(Component, Debug, Default, Clone, Copy)]
pub struct VehicleInput {
    /// 0..1
    pub throttle: f32,
    /// 0..1 (also reverse when slow)
    pub brake: f32,
    /// -1..1, positive = left (matches the asset convention: +Y rotation steers left)
    pub steer: f32,
    pub handbrake: bool,
    pub nitro: bool,
}

#[derive(Component, Debug, Clone)]
pub struct VehicleState {
    /// Signed forward speed, m/s.
    pub forward_speed: f32,
    pub lateral_speed: f32,
    pub grounded_wheels: u8,
    pub wheel_offroad: [bool; 4],
    /// Ray hit distance per wheel (SUSP_MAX when airborne).
    pub wheel_dist: [f32; 4],
    pub wheel_spin: f32,
    pub steer_visual: f32,
    pub drifting: bool,
    /// 0..1 how hard the car is sliding (for audio, skid marks, smoke).
    pub slip: f32,
    /// 0..1 nitro charge.
    pub nitro: f32,
    pub nitro_active: bool,
    pub gear: u8,
    pub rpm: f32,
    pub braking: bool,
    /// Held on the grid (menu / countdown).
    pub hold: bool,
    pub offtrack_time: f32,
    pub upside_down_time: f32,
    /// Seconds with no track surface anywhere below the car (escaped the circuit).
    pub outside_time: f32,
    /// Velocity right after our control step, to measure collision impulses.
    pub post_control_vel: Vec3,
    /// Centre position at the previous fixed step (tunnel guard).
    pub prev_center: Option<Vec3>,
    /// Throttle as applied (for audio).
    pub throttle: f32,
    /// Seconds since the last upshift (gear-change feel).
    pub since_shift: f32,
    /// Nearest racing-line index (cached for cheap tracking).
    pub line_hint: Option<usize>,
    /// Slipstream: time spent close behind another car this tick.
    pub drafting: bool,
}

impl Default for VehicleState {
    fn default() -> Self {
        Self {
            forward_speed: 0.0,
            lateral_speed: 0.0,
            grounded_wheels: 0,
            wheel_offroad: [false; 4],
            wheel_dist: [SUSP_TOP; 4],
            wheel_spin: 0.0,
            steer_visual: 0.0,
            drifting: false,
            slip: 0.0,
            nitro: 0.35,
            nitro_active: false,
            gear: 1,
            rpm: IDLE_RPM,
            braking: false,
            hold: true,
            offtrack_time: 0.0,
            upside_down_time: 0.0,
            outside_time: 0.0,
            post_control_vel: Vec3::ZERO,
            prev_center: None,
            throttle: 0.0,
            since_shift: 10.0,
            line_hint: None,
            drafting: false,
        }
    }
}

impl VehicleState {
    pub fn speed_kmh(&self) -> f32 {
        self.forward_speed.abs() * 3.6
    }
}

/// Handles to per-car visual parts, filled in when the car's glTF scene is ready.
#[derive(Component, Debug, Default)]
pub struct CarVisual {
    pub wheels: [Option<Entity>; 4],
    pub brake_material: Option<Handle<StandardMaterial>>,
    pub flames: Vec<Entity>,
}

/// Marker on the glTF scene root of a car (child of the physics body).
#[derive(Component)]
pub struct CarSceneRoot {
    pub car: Entity,
}

/// Collision impact on a car (from the physics step), strength in m/s of Δv.
#[derive(Message, Debug, Clone, Copy)]
pub struct CarImpact {
    pub car: Entity,
    pub strength: f32,
    pub is_player: bool,
    pub position: Vec3,
}

/// Request to put a car back on the track at its last checkpoint.
#[derive(Message, Debug, Clone, Copy)]
pub struct ResetCar(pub Entity);

/// Nitro just fired (for audio / FX).
#[derive(Message, Debug, Clone, Copy)]
pub struct NitroFired {
    pub car: Entity,
    pub is_player: bool,
}

/// Flag set once the cars have been spawned.
#[derive(Resource, Debug, Default)]
pub struct CarsSpawned(pub bool);

pub struct VehiclePlugin;

impl Plugin for VehiclePlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<CarImpact>()
            .add_message::<ResetCar>()
            .add_message::<NitroFired>()
            .init_resource::<CarsSpawned>()
            .add_observer(on_car_scene_ready)
            .add_systems(
                FixedUpdate,
                (detect_impacts, vehicle_physics)
                    .chain()
                    .in_set(FixedGameSystems::Vehicle),
            )
            .add_systems(
                Update,
                (update_hold, update_car_visuals).run_if(not(in_state(AppState::Loading))),
            );
    }
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

pub const CAR_NAMES: [&str; 4] = ["YOU", "BLUE", "YELLOW", "BLACK"];

/// Spawn the four cars on the grid. Called once the track colliders exist.
pub fn spawn_cars(commands: &mut Commands, assets: &AssetServer, track: &TrackData) {
    let scene = assets.load(GltfAssetLabel::Scene(0).from_asset(track.car_file.clone()));
    for (i, spawn) in track.spawns.iter().enumerate().take(4) {
        let variant = &track.variants[i % track.variants.len()];
        let car = commands
            .spawn((
                Name::new(format!("car_{}", variant.name)),
                Car {
                    index: i,
                    is_player: i == 0,
                    name: CAR_NAMES[i].to_string(),
                    color: variant.paint_color,
                },
                VehicleInput::default(),
                VehicleState::default(),
                CarVisual::default(),
                *spawn,
                Visibility::default(),
                car_body_bundle(),
            ))
            .id();
        commands.entity(car).with_children(|c| {
            c.spawn((
                Collider::cuboid(1.96, 0.74, 4.4),
                Transform::from_xyz(0.0, 0.73, 0.0),
                CollisionLayers::new(
                    Layer::Car,
                    [Layer::Car, Layer::Barrier, Layer::Road, Layer::Offroad],
                ),
                Friction::new(0.05).with_combine_rule(CoefficientCombine::Min),
                Restitution::new(0.15),
            ));
            c.spawn((WorldAssetRoot(scene.clone()), CarSceneRoot { car }));
        });
    }
}

fn car_body_bundle() -> impl Bundle {
    (
        RigidBody::Dynamic,
        Mass(CAR_MASS),
        // Lower than the real CoM (0.46 m) for an arcade-stable car.
        CenterOfMass::new(0.0, 0.32, -0.08),
        AngularInertia::new(Vec3::new(2400.0, 2700.0, 650.0)),
        NoAutoMass,
        NoAutoCenterOfMass,
        NoAutoAngularInertia,
        AngularDamping(0.6),
        LinearDamping(0.0),
        SweptCcd::default(),
        TransformInterpolation,
        SleepingDisabled,
    )
}

/// Configure a car's glTF instance: per-car paint & brake-light materials,
/// hide the collider mesh, find wheel nodes, add nitro flames.
fn on_car_scene_ready(
    ready: On<WorldInstanceReady>,
    roots: Query<&CarSceneRoot>,
    children: Query<&Children>,
    names: Query<&Name>,
    mats: Query<(&MeshMaterial3d<StandardMaterial>, &GltfMaterialName)>,
    cars: Query<&Car>,
    mut visuals: Query<&mut CarVisual>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut meshes: ResMut<Assets<Mesh>>,
    assets: Res<AssetServer>,
    track: Res<TrackData>,
    mut commands: Commands,
) {
    let Ok(root) = roots.get(ready.entity) else {
        return;
    };
    let Ok(car) = cars.get(root.car) else {
        return;
    };
    let variant = &track.variants[car.index % track.variants.len()];
    let paint_texture: Option<Handle<Image>> =
        (car.index != 0).then(|| assets.load(variant.albedo_texture.clone()));

    let mut wheels = [None; 4];
    let mut brake_material = None;
    let mut flames = Vec::new();
    let flame_mesh = meshes.add(Cone::new(0.09, 0.7).mesh().resolution(10));
    let flame_mat = materials.add(StandardMaterial {
        base_color: Color::srgba(0.4, 0.7, 1.0, 0.85),
        emissive: LinearRgba::rgb(2.0, 5.0, 14.0),
        unlit: true,
        alpha_mode: AlphaMode::Add,
        ..default()
    });

    for e in children.iter_descendants(ready.entity) {
        if let Ok(name) = names.get(e) {
            let n = name.as_str();
            if n == "collider_body" {
                commands.entity(e).insert(Visibility::Hidden);
            } else if let Some(i) = WHEEL_NAMES.iter().position(|w| *w == n) {
                wheels[i] = Some(e);
            } else if n == "exhaust_L" || n == "exhaust_R" {
                // Cone points +Y by default; the exhaust flows along local +Z.
                let flame = commands
                    .spawn((
                        Mesh3d(flame_mesh.clone()),
                        MeshMaterial3d(flame_mat.clone()),
                        Transform::from_xyz(0.0, 0.0, 0.35)
                            .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
                        Visibility::Hidden,
                        bevy::light::NotShadowCaster,
                    ))
                    .id();
                commands.entity(e).add_child(flame);
                flames.push(flame);
            }
        }
        if let Ok((mat, mat_name)) = mats.get(e) {
            match mat_name.0.as_str() {
                "car_paint_red" => {
                    if let Some(tex) = &paint_texture
                        && let Some(base) = materials.get(&mat.0)
                    {
                        let mut m = base.clone();
                        m.base_color_texture = Some(tex.clone());
                        let h = materials.add(m);
                        commands.entity(e).insert(MeshMaterial3d(h));
                    }
                }
                "car_brake_light" => {
                    if let Some(base) = materials.get(&mat.0) {
                        let mut m = base.clone();
                        m.emissive = track.brake_emissive_off;
                        let h = materials.add(m);
                        brake_material = Some(h.clone());
                        commands.entity(e).insert(MeshMaterial3d(h));
                    }
                }
                _ => {}
            }
        }
    }

    if let Ok(mut v) = visuals.get_mut(root.car) {
        v.wheels = wheels;
        v.brake_material = brake_material;
        v.flames = flames;
    }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/// Gear and RPM from forward speed. Returns (gear 1..=6, rpm).
pub fn gear_and_rpm(speed_kmh: f32) -> (u8, f32) {
    let v = speed_kmh.abs();
    let mut lo = 0.0;
    for (i, &hi) in GEAR_TOP_KMH.iter().enumerate() {
        if v < hi || i == GEAR_TOP_KMH.len() - 1 {
            let frac = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
            let bottom = if i == 0 { IDLE_RPM + 300.0 } else { 4200.0 };
            return ((i + 1) as u8, bottom + (REDLINE_RPM - bottom) * frac);
        }
        lo = hi;
    }
    (6, REDLINE_RPM)
}

fn update_hold(state: Res<State<AppState>>, mut cars: Query<&mut VehicleState>) {
    let hold = matches!(state.get(), AppState::Menu | AppState::Countdown);
    for mut s in &mut cars {
        if s.hold != hold {
            s.hold = hold;
        }
    }
}

/// Compare the velocity after the previous physics step with the velocity we
/// left the car with: the horizontal difference is the collision impulse.
fn detect_impacts(
    cars: Query<(Entity, &Car, &LinearVelocity, &Position, &VehicleState)>,
    mut impacts: MessageWriter<CarImpact>,
) {
    for (e, car, vel, pos, state) in &cars {
        let dv = (vel.0 - state.post_control_vel) * Vec3::new(1.0, 0.0, 1.0);
        let strength = dv.length();
        if strength > 2.5 {
            impacts.write(CarImpact {
                car: e,
                strength,
                is_player: car.is_player,
                position: pos.0,
            });
        }
    }
}

fn vehicle_physics(
    time: Res<Time>,
    spatial: SpatialQuery,
    surfaces: Query<&Surface>,
    mut cars: Query<(Entity, &Car, &VehicleInput, &mut VehicleState, Forces)>,
    mut resets: MessageWriter<ResetCar>,
    mut nitro_fired: MessageWriter<NitroFired>,
    state: Res<State<AppState>>,
) {
    let dt = time.delta_secs();
    if dt <= 0.0 {
        return;
    }
    let ground_filter = SpatialQueryFilter::from_mask([Layer::Road, Layer::Offroad]);
    let racing = matches!(state.get(), AppState::Racing | AppState::Finished);

    // Snapshot for slipstream detection.
    // (A second query reading `LinearVelocity` would conflict with `Forces`.)
    let snapshot: Vec<(Entity, Vec3, Vec3)> = cars
        .iter()
        .map(|(e, _, _, _, f)| (e, f.position(), f.linear_velocity()))
        .collect();

    for (entity, car, input, mut st, mut forces) in &mut cars {
        let pos = forces.position();
        let rot = forces.rotation();
        let fwd = rot * Vec3::NEG_Z;
        let right = rot * Vec3::X;
        let up = rot * Vec3::Y;

        // --- Suspension -----------------------------------------------------
        let mut grounded = 0u8;
        let mut normal_sum = Vec3::ZERO;
        let mut offroad_count = 0;
        let down = Dir3::new(-up).unwrap_or(Dir3::NEG_Y);
        for (i, wheel) in WHEEL_POS.iter().enumerate() {
            let local = Vec3::new(wheel.x, SUSP_TOP, wheel.z);
            let origin = pos + rot * local;
            st.wheel_offroad[i] = false;
            match spatial.cast_ray(origin, down, SUSP_MAX, true, &ground_filter) {
                Some(hit) => {
                    st.wheel_dist[i] = hit.distance;
                    grounded += 1;
                    normal_sum += hit.normal;
                    if surfaces
                        .get(hit.entity)
                        .is_ok_and(|s| *s == Surface::Offroad)
                    {
                        st.wheel_offroad[i] = true;
                        offroad_count += 1;
                    }
                    let compression = SUSP_REST - hit.distance;
                    let point_vel = forces.velocity_at_point(origin).dot(up);
                    let mut f = SUSP_K * compression - SUSP_DAMP * point_vel;
                    // Bump stop when nearly bottomed out.
                    if hit.distance < SUSP_TOP - 0.18 {
                        f += SUSP_K * 4.0 * (SUSP_TOP - 0.18 - hit.distance);
                    }
                    forces.apply_force_at_point(up * f.max(0.0), origin);
                }
                None => st.wheel_dist[i] = SUSP_MAX,
            }
        }
        st.grounded_wheels = grounded;
        let ground_n = if grounded > 0 {
            normal_sum.normalize_or(Vec3::Y)
        } else {
            Vec3::Y
        };
        let offroad = grounded > 0 && offroad_count * 2 >= grounded;

        let mut v = forces.linear_velocity();
        let vf = v.dot(fwd);
        let vr = v.dot(right);
        st.forward_speed = vf;
        st.lateral_speed = vr;

        // --- Driver inputs (held on grid) -----------------------------------
        let (throttle, brake, steer, handbrake, nitro_btn) = if st.hold {
            (0.0, 0.0, 0.0, true, false)
        } else {
            (
                input.throttle.clamp(0.0, 1.0),
                input.brake.clamp(0.0, 1.0),
                input.steer.clamp(-1.0, 1.0),
                input.handbrake,
                input.nitro,
            )
        };
        st.throttle = throttle;

        // --- Nitro ----------------------------------------------------------
        if nitro_btn && !st.nitro_active && st.nitro >= NITRO_MIN_START && racing {
            st.nitro_active = true;
            if grounded > 0 {
                v += fwd * NITRO_KICK;
            }
            nitro_fired.write(NitroFired {
                car: entity,
                is_player: car.is_player,
            });
        }
        if st.nitro_active {
            st.nitro -= NITRO_DRAIN * dt;
            if st.nitro <= 0.0 || !nitro_btn {
                st.nitro = st.nitro.max(0.0);
                st.nitro_active = false;
            }
        }

        // Slipstream: another car 4..22 m ahead, within ~3 m laterally, similar heading.
        st.drafting = false;
        if vf > 25.0 {
            for (oe, op, ov) in &snapshot {
                if *oe == entity {
                    continue;
                }
                let d = *op - pos;
                let ahead = d.dot(fwd);
                if (4.0..22.0).contains(&ahead)
                    && d.dot(right).abs() < 3.0
                    && ov.normalize_or_zero().dot(fwd) > 0.9
                {
                    st.drafting = true;
                    break;
                }
            }
        }
        if racing && !st.nitro_active {
            let mut fill = 0.0;
            if st.drifting && grounded > 0 {
                fill += NITRO_FILL_DRIFT * (vf.abs() / 30.0).min(1.0);
            }
            if st.drafting {
                fill += NITRO_FILL_DRAFT;
            }
            st.nitro = (st.nitro + fill * dt).min(1.0);
        }

        // --- Ground handling ------------------------------------------------
        if grounded > 0 {
            let traction = (grounded as f32 / 2.0).min(1.0);
            let fwd_g = (fwd - ground_n * fwd.dot(ground_n)).normalize_or(fwd);
            let right_g = (right - ground_n * right.dot(ground_n)).normalize_or(right);

            let mut vmax = if st.nitro_active {
                NITRO_MAX_SPEED
            } else {
                MAX_SPEED
            };
            if offroad {
                vmax *= OFFROAD_MAX_FACTOR;
            }

            // Longitudinal
            let mut a = 0.0;
            st.braking = false;
            if throttle > 0.0 {
                if vf < -0.5 {
                    a += BRAKE_DECEL * throttle; // braking out of reverse
                } else if vf < vmax {
                    let x = (vf / vmax).clamp(0.0, 1.0);
                    a += ACCEL * throttle * (1.0 - x * x);
                } else {
                    a -= 2.5; // above vmax (e.g. nitro ended): settle down
                }
            }
            if st.nitro_active && vf < vmax {
                a += NITRO_ACCEL;
            }
            if brake > 0.0 {
                if vf > 0.5 {
                    a -= BRAKE_DECEL * brake;
                    st.braking = true;
                } else if vf > -REVERSE_MAX {
                    a -= REVERSE_ACCEL * brake;
                }
            }
            if throttle == 0.0 && brake == 0.0 && !st.nitro_active {
                a -= COAST_DECEL * vf.signum() * (vf.abs() / 3.0).min(1.0);
            }
            if handbrake && !st.drifting {
                a -= HANDBRAKE_DECEL * vf.signum() * (vf.abs() / 3.0).min(1.0);
                st.braking |= vf.abs() > 1.0;
            }
            if offroad {
                a -= OFFROAD_DRAG * vf.signum() * (vf.abs() / 5.0).min(1.0);
            }
            if st.hold {
                // Keep the car parked on the grid.
                a = -vf * 8.0;
            }
            v += fwd_g * a * traction * dt;

            // Drift state machine
            let speed = vf.abs();
            if !st.drifting && handbrake && !st.hold && speed > 12.0 && steer.abs() > 0.2 {
                st.drifting = true;
            }
            if st.drifting && (speed < 8.0 || (!handbrake && vr.abs() < 2.5)) {
                st.drifting = false;
            }

            // Lateral grip
            let mut grip = if st.drifting {
                if handbrake {
                    DRIFT_GRIP
                } else {
                    DRIFT_GRIP * 2.2
                }
            } else if handbrake {
                GRIP * 0.5
            } else {
                GRIP
            };
            if offroad {
                grip *= OFFROAD_GRIP_FACTOR;
            }
            if st.hold {
                grip = 30.0;
            }
            let vr_g = v.dot(right_g);
            let removed = vr_g * (1.0 - (-grip * traction * dt).exp());
            v -= right_g * removed;
            if st.drifting && vf > 0.0 {
                // Arcade drift: keep momentum by turning lost sideways speed into forward speed.
                let gain = removed.abs() * DRIFT_SPEED_RETAIN;
                if v.dot(fwd_g) + gain < vmax {
                    v += fwd_g * gain;
                }
            }

            // Downforce
            v -= ground_n * DOWNFORCE * vf * vf * dt;

            // Yaw control
            let speed_factor = (speed / 7.0).min(1.0);
            let dir = if vf < -0.5 { -1.0 } else { 1.0 };
            let t = (speed / NITRO_MAX_SPEED).min(1.0);
            let mut max_yaw = YAW_LOW + (YAW_HIGH - YAW_LOW) * t.sqrt();
            if st.drifting {
                max_yaw *= DRIFT_YAW_BOOST;
            }
            let mut target_yaw = steer * max_yaw * speed_factor * dir;
            if st.drifting {
                // Hold the drift angle: rotating further into the slide (yaw in the
                // same direction as the sideways velocity grows it) is cancelled
                // beyond MAX_DRIFT_ANGLE, so drifts don't turn into spins.
                let beta = vr.atan2(vf.abs().max(1.0));
                if beta.abs() > MAX_DRIFT_ANGLE && target_yaw * vr > 0.0 {
                    let over = ((beta.abs() - MAX_DRIFT_ANGLE) / 0.2).min(1.0);
                    target_yaw *= 1.0 - over;
                }
            }
            let mut w = forces.angular_velocity();
            let w_up = w.dot(up);
            let new_up = w_up + (target_yaw - w_up) * (1.0 - (-YAW_RESPONSE * traction * dt).exp());
            w += up * (new_up - w_up);
            // Damp roll/pitch wobble from the suspension a little.
            let w_other = w - up * w.dot(up);
            w -= w_other * (1.0 - (-2.5 * dt).exp());
            *forces.angular_velocity_mut() = w;

            st.slip = if speed > 5.0 {
                ((vr.abs() - 1.5) / 6.0).clamp(0.0, 1.0)
            } else {
                0.0
            };
            if st.braking && speed > 15.0 && brake > 0.8 {
                st.slip = st.slip.max(0.35);
            }
        } else {
            st.drifting = false;
            st.slip = 0.0;
            st.braking = false;
            // Airborne: gently rotate upright so jumps/crashes land on the wheels.
            let mut w = forces.angular_velocity();
            let axis = up.cross(Vec3::Y);
            w += axis * 3.0 * dt;
            w *= 1.0 - (0.8 * dt).min(1.0);
            *forces.angular_velocity_mut() = w;
        }

        // Nothing on this circuit needs a fast upward velocity (max grade ~6.5 %):
        // clamping it stops hard wall hits from launching cars over the barriers.
        let max_up = 6.0 + vf.abs() * 0.07;
        if v.y > max_up {
            v.y = max_up;
        }
        *forces.linear_velocity_mut() = v;
        st.post_control_vel = v;

        // --- Gearbox (cosmetic, drives audio + HUD) -----------------------------
        let (gear, rpm) = gear_and_rpm(vf * 3.6);
        if gear > st.gear {
            st.since_shift = 0.0;
        }
        st.since_shift += dt;
        st.gear = gear;
        // Revving on the grid with throttle.
        let target_rpm = if st.hold || grounded == 0 {
            IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * 0.6 * input.throttle.clamp(0.0, 1.0)
        } else {
            rpm
        };
        st.rpm += (target_rpm - st.rpm) * (1.0 - (-12.0 * dt).exp());

        // --- Visual wheel state ------------------------------------------------
        st.wheel_spin = (st.wheel_spin - vf * dt / WHEEL_RADIUS).rem_euclid(std::f32::consts::TAU);
        let steer_target = steer * 0.5 * (1.0 - 0.6 * (vf.abs() / MAX_SPEED).min(1.0));
        st.steer_visual += (steer_target - st.steer_visual) * (1.0 - (-14.0 * dt).exp());

        // --- Auto reset ------------------------------------------------------------
        if !st.hold {
            let fully_offroad = grounded == 0 || offroad_count == grounded;
            if fully_offroad {
                st.offtrack_time += dt;
            } else {
                st.offtrack_time = 0.0;
            }
            // Containment: airborne with no road/run-off below at all means the
            // car has left the circuit. Reset quickly instead of waiting 3 s.
            if grounded == 0
                && spatial
                    .cast_ray(pos + Vec3::Y * 2.0, Dir3::NEG_Y, 60.0, true, &ground_filter)
                    .is_none()
            {
                st.outside_time += dt;
            } else {
                st.outside_time = 0.0;
            }
            if st.outside_time > 0.5 {
                st.outside_time = 0.0;
                warn!("car {} left the circuit, resetting", car.name);
                resets.write(ResetCar(entity));
            }
            if up.y < 0.3 {
                st.upside_down_time += dt;
            } else {
                st.upside_down_time = 0.0;
            }
            if st.offtrack_time > AUTO_RESET_TIME
                || st.upside_down_time > AUTO_RESET_TIME
                || pos.y < -40.0
            {
                st.offtrack_time = 0.0;
                st.upside_down_time = 0.0;
                resets.write(ResetCar(entity));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

fn update_car_visuals(
    cars: Query<(&VehicleState, &CarVisual)>,
    mut transforms: Query<&mut Transform>,
    mut vis: Query<&mut Visibility>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    track: Res<TrackData>,
    time: Res<Time>,
) {
    for (st, visual) in &cars {
        for (i, wheel) in visual.wheels.iter().enumerate() {
            let Some(w) = wheel else { continue };
            if let Ok(mut t) = transforms.get_mut(*w) {
                let base = WHEEL_POS[i];
                let y = (SUSP_TOP - st.wheel_dist[i] + WHEEL_RADIUS)
                    .clamp(WHEEL_RADIUS - 0.2, WHEEL_RADIUS + 0.12);
                t.translation = Vec3::new(base.x, y, base.z);
                let steer = if i < 2 { st.steer_visual } else { 0.0 };
                t.rotation = Quat::from_rotation_y(steer) * Quat::from_rotation_x(st.wheel_spin);
            }
        }
        if let Some(h) = &visual.brake_material {
            let target = if st.braking {
                track.brake_emissive_on
            } else {
                track.brake_emissive_off
            };
            // Only touch the asset when the state flips (avoids re-uploading every frame).
            if let Some(m) = materials.get(h)
                && m.emissive != target
                && let Some(mut m) = materials.get_mut(h)
            {
                m.emissive = target;
            }
        }
        for f in &visual.flames {
            if let Ok(mut v) = vis.get_mut(*f) {
                let want = if st.nitro_active {
                    Visibility::Inherited
                } else {
                    Visibility::Hidden
                };
                if *v != want {
                    *v = want;
                }
            }
            if st.nitro_active
                && let Ok(mut t) = transforms.get_mut(*f)
            {
                let flicker = 0.8
                    + 0.4
                        * (time.elapsed_secs() * 60.0 + f.index_u32() as f32)
                            .sin()
                            .abs();
                t.scale = Vec3::new(1.0, flicker, 1.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gears_increase_with_speed() {
        let mut last = 0;
        for kmh in (0..300).step_by(5) {
            let (g, rpm) = gear_and_rpm(kmh as f32);
            assert!(g >= last);
            assert!((IDLE_RPM..=REDLINE_RPM).contains(&rpm));
            last = g;
        }
        assert_eq!(gear_and_rpm(250.0).0, 6);
    }

    #[test]
    fn rpm_drops_on_upshift() {
        let (_, before) = gear_and_rpm(59.0);
        let (_, after) = gear_and_rpm(61.0);
        assert!(after < before - 1500.0);
    }
}
