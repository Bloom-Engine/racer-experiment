//! Chase camera (smoothed, speed-dependent FOV, shake) and a bumper camera.

use bevy::{
    anti_alias::fxaa::Fxaa, core_pipeline::tonemapping::Tonemapping, pbr::DistanceFog, prelude::*,
};

use crate::{
    game_state::AppState,
    track::SKY_RADIUS,
    track_data::TrackData,
    vehicle::{Car, CarImpact, MAX_SPEED, NITRO_MAX_SPEED, VehicleState},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CameraMode {
    #[default]
    Chase,
    Bumper,
}

#[derive(Component, Debug)]
pub struct GameCamera {
    pub mode: CameraMode,
    /// Smoothed heading used by the chase camera (lags behind the car in drifts).
    yaw_dir: Vec3,
    pos: Vec3,
    fov: f32,
    /// Shake energy, decays over time.
    trauma: f32,
    initialised: bool,
    menu_orbit: f32,
    /// Extra pull-back while nitro burns (smoothed), m.
    pull: f32,
}

#[derive(Message, Debug, Clone, Copy)]
pub struct ToggleCamera;

pub const BASE_FOV_DEG: f32 = 62.0;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<ToggleCamera>()
            .add_systems(Startup, spawn_camera)
            .add_systems(
                PostUpdate,
                update_camera.before(bevy::transform::TransformSystems::Propagate),
            )
            .add_systems(Update, (toggle_camera, add_impact_shake));
    }
}

fn spawn_camera(mut commands: Commands, track: Res<TrackData>) {
    let mobile = cfg!(any(target_os = "ios", target_os = "android"));
    let mut cam = commands.spawn((
        Camera3d::default(),
        GameCamera {
            mode: if std::env::var("RACER_CAMERA").is_ok_and(|v| v == "bumper") {
                CameraMode::Bumper
            } else {
                CameraMode::Chase
            },
            yaw_dir: Vec3::X,
            pos: Vec3::new(0.0, 5.0, 0.0),
            fov: BASE_FOV_DEG.to_radians(),
            trauma: 0.0,
            initialised: false,
            menu_orbit: 0.0,
            pull: 0.0,
        },
        Projection::Perspective(PerspectiveProjection {
            fov: BASE_FOV_DEG.to_radians(),
            near: 0.1,
            far: SKY_RADIUS * 1.8,
            ..default()
        }),
        Transform::from_xyz(-10.0, 6.0, 0.0).looking_at(Vec3::new(20.0, 0.0, 0.0), Vec3::Y),
        DistanceFog {
            color: track.fog_color,
            falloff: FogFalloff::Linear {
                start: track.fog_start,
                end: track.fog_end,
            },
            ..default()
        },
        Tonemapping::AgX,
    ));
    // MSAA is cheap on Apple's tile-based GPUs; on desktop 4x as well.
    if mobile {
        cam.insert((Msaa::Sample4,));
    } else {
        cam.insert((Msaa::Sample4, Fxaa::default()));
    }
}

fn toggle_camera(mut msgs: MessageReader<ToggleCamera>, mut cams: Query<&mut GameCamera>) {
    for _ in msgs.read() {
        for mut c in &mut cams {
            c.mode = match c.mode {
                CameraMode::Chase => CameraMode::Bumper,
                CameraMode::Bumper => CameraMode::Chase,
            };
        }
    }
}

fn add_impact_shake(mut msgs: MessageReader<CarImpact>, mut cams: Query<&mut GameCamera>) {
    for m in msgs.read() {
        if m.is_player {
            for mut c in &mut cams {
                c.trauma = (c.trauma + (m.strength / 15.0).min(1.0)).min(1.0);
            }
        }
    }
}

/// Cheap deterministic noise for shake.
fn noise(t: f32, seed: f32) -> f32 {
    (t * 13.1 + seed).sin() * 0.5
        + (t * 29.7 + seed * 2.3).sin() * 0.3
        + (t * 51.3 + seed * 4.1).sin() * 0.2
}

pub fn update_camera(
    time: Res<Time>,
    real: Res<Time<Real>>,
    state: Res<State<AppState>>,
    cars: Query<(&Transform, &Car, &VehicleState), Without<GameCamera>>,
    mut cams: Query<(&mut Transform, &mut Projection, &mut GameCamera)>,
) {
    let Some((car_tf, _, st)) = cars.iter().find(|(_, c, _)| c.is_player) else {
        return;
    };
    let Ok((mut tf, mut proj, mut cam)) = cams.single_mut() else {
        return;
    };
    // Use real time so the camera still settles when the game is paused.
    let dt = real.delta_secs().min(0.05);
    let t = time.elapsed_secs();
    // Cars are root entities, so their (interpolated) Transform is world space.
    let car_pos = car_tf.translation;
    let rot = car_tf.rotation;
    let fwd = rot * Vec3::NEG_Z;
    let flat_fwd = Vec3::new(fwd.x, 0.0, fwd.z).normalize_or(Vec3::X);

    if *state.get() == AppState::Menu {
        // Slow orbit around the grid as a backdrop for the start screen.
        cam.menu_orbit += dt * 0.12;
        let a = cam.menu_orbit;
        let offset = Vec3::new(a.cos() * 14.0, 4.5, a.sin() * 14.0);
        *tf = Transform::from_translation(car_pos + offset).looking_at(car_pos + Vec3::Y, Vec3::Y);
        cam.initialised = false;
        set_fov(&mut proj, BASE_FOV_DEG.to_radians());
        return;
    }

    let speed = st.forward_speed.abs();
    let speed_n = (speed / MAX_SPEED).min(1.3);

    // FOV: widen with speed, extra kick while nitro burns.
    let mut target_fov = BASE_FOV_DEG + 9.0 * speed_n;
    if st.nitro_active {
        target_fov += 7.0 * (speed / NITRO_MAX_SPEED).max(0.5);
    }
    let fov_rate = if st.nitro_active { 6.0 } else { 3.0 };
    cam.fov += (target_fov.to_radians() - cam.fov) * (1.0 - (-fov_rate * dt).exp());
    let fov = cam.fov;
    set_fov(&mut proj, fov);

    // Shake: high-speed rumble + impact trauma.
    cam.trauma = (cam.trauma - dt * 1.6).max(0.0);
    let speed_shake = ((speed * 3.6 - 170.0) / 130.0).clamp(0.0, 1.0) * 0.025
        + if st.nitro_active { 0.02 } else { 0.0 };
    let shake_amt = speed_shake + cam.trauma * cam.trauma * 0.35;
    let shake = Vec3::new(noise(t, 1.0), noise(t, 7.0), noise(t, 13.0)) * shake_amt;

    match cam.mode {
        CameraMode::Chase => {
            if !cam.initialised {
                cam.yaw_dir = flat_fwd;
                cam.pos = car_pos - flat_fwd * 7.0 + Vec3::Y * 2.6;
                cam.initialised = true;
            }
            // Heading lags behind the car so drifts show the car's angle.
            let k = 1.0 - (-4.5 * dt).exp();
            cam.yaw_dir = cam.yaw_dir.lerp(flat_fwd, k).normalize_or(flat_fwd);
            // Nitro pushes the camera back a little (and eases in/out).
            let pull_target = if st.nitro_active { 1.2 } else { 0.0 };
            cam.pull += (pull_target - cam.pull) * (1.0 - (-3.0 * dt).exp());
            let dist = 6.4 + 0.8 * speed_n + cam.pull;
            let height = 2.3 + 0.25 * speed_n;
            let desired = car_pos - cam.yaw_dir * dist + Vec3::Y * height;
            // Horizontal position is rigidly attached to the (smoothed) heading:
            // positional smoothing would lag proportionally to speed (~20 m at
            // 300 km/h). Swing comes from the heading lag, bounce from the height.
            let ky = 1.0 - (-6.0 * dt).exp();
            let mut p = cam.pos;
            p.x = desired.x;
            p.z = desired.z;
            p.y += (desired.y - p.y) * ky;
            // Never drop below the car's roof line (e.g. landing from the crest).
            p.y = p.y.max(car_pos.y + 1.2);
            cam.pos = p;
            let look = car_pos + Vec3::Y * 1.1 + cam.yaw_dir * 4.0;
            *tf = Transform::from_translation(p + shake).looking_at(look + shake * 0.5, Vec3::Y);
        }
        CameraMode::Bumper => {
            cam.initialised = false;
            let p = car_pos + rot * Vec3::new(0.0, 0.95, -1.9);
            let look = p + fwd * 10.0;
            *tf = Transform::from_translation(p + shake * 0.4).looking_at(look, rot * Vec3::Y);
        }
    }
}

fn set_fov(proj: &mut Projection, fov: f32) {
    if let Projection::Perspective(p) = proj
        && (p.fov - fov).abs() > 1e-4
    {
        p.fov = fov;
    }
}
