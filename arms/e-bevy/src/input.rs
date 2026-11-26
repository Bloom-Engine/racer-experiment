//! Player input: keyboard, gamepad and multi-touch, merged into the player's
//! [`VehicleInput`], plus one-shot actions (camera, reset, pause).
//!
//! Touch is handled directly from [`Touches`] with our own hit-testing against
//! the on-screen button rectangles (shared with the HUD through
//! [`touch_layout`]). Every active touch is evaluated independently, so
//! steering + nitro (or any other combination) works at the same time.

use bevy::{input::touch::Touches, prelude::*, window::PrimaryWindow};

use crate::{
    ai::AiDriver,
    camera::ToggleCamera,
    game_state::{AppState, Paused, TogglePause},
    vehicle::{Car, ResetCar, VehicleInput},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TouchButton {
    SteerLeft,
    SteerRight,
    Brake,
    Nitro,
    Pause,
    Camera,
    Reset,
}

impl TouchButton {
    pub const ALL: [TouchButton; 7] = [
        TouchButton::SteerLeft,
        TouchButton::SteerRight,
        TouchButton::Brake,
        TouchButton::Nitro,
        TouchButton::Pause,
        TouchButton::Camera,
        TouchButton::Reset,
    ];

    pub fn icon(self) -> &'static str {
        match self {
            TouchButton::SteerLeft => "ui/icons/steer_left_128.png",
            TouchButton::SteerRight => "ui/icons/steer_right_128.png",
            TouchButton::Brake => "ui/icons/brake_128.png",
            TouchButton::Nitro => "ui/icons/nitro_128.png",
            TouchButton::Pause => "ui/icons/pause_128.png",
            TouchButton::Camera => "ui/icons/camera_128.png",
            TouchButton::Reset => "ui/icons/reset_128.png",
        }
    }
}

/// Screen rectangle (logical pixels, top-left origin) of each touch button for
/// a window of the given size. Used for both drawing and hit-testing.
pub fn touch_layout(size: Vec2) -> Vec<(TouchButton, Rect)> {
    let margin = 20.0;
    let side = margin + crate::hud::SAFE_X;
    let big = (size.y * 0.24).clamp(90.0, 150.0);
    let gap = 14.0;
    let small = (big * 0.5).max(52.0);
    let bottom = size.y - margin - big;
    let r = |x: f32, y: f32, s: f32| Rect::new(x, y, x + s, y + s);
    vec![
        (TouchButton::SteerLeft, r(side, bottom, big)),
        (TouchButton::SteerRight, r(side + big + gap, bottom, big)),
        (TouchButton::Brake, r(size.x - side - big, bottom, big)),
        (
            TouchButton::Nitro,
            r(size.x - side - 2.0 * big - gap, bottom, big),
        ),
        (
            TouchButton::Pause,
            r(size.x * 0.5 - small * 1.5 - gap, margin * 0.6, small),
        ),
        (
            TouchButton::Camera,
            r(size.x * 0.5 - small * 0.5, margin * 0.6, small),
        ),
        (
            TouchButton::Reset,
            r(size.x * 0.5 + small * 0.5 + gap, margin * 0.6, small),
        ),
    ]
}

/// Whether touch controls are shown and auto-acceleration is on.
#[derive(Resource, Debug)]
pub struct InputMode {
    pub touch: bool,
}

impl Default for InputMode {
    fn default() -> Self {
        Self {
            touch: cfg!(any(target_os = "ios", target_os = "android"))
                || std::env::var("RACER_TOUCH").is_ok_and(|v| v == "1"),
        }
    }
}

/// Which touch buttons are currently held (for HUD highlighting).
#[derive(Resource, Debug, Default)]
pub struct TouchState {
    pub held: Vec<TouchButton>,
}

pub struct InputPlugin;

impl Plugin for InputPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<InputMode>()
            .init_resource::<TouchState>()
            .add_systems(
                Update,
                (detect_touch_mode, player_input, action_input).chain(),
            );
    }
}

fn detect_touch_mode(
    touches: Res<Touches>,
    keys: Res<ButtonInput<KeyCode>>,
    mut mode: ResMut<InputMode>,
) {
    if !mode.touch && touches.iter_just_pressed().next().is_some() {
        mode.touch = true;
    }
    // A physical keyboard press on a touch device hides the touch overlay again.
    if mode.touch && keys.get_just_pressed().next().is_some() && !cfg!(target_os = "ios") {
        mode.touch = false;
    }
}

fn pressed_touch_buttons(touches: &Touches, window: &Window) -> Vec<TouchButton> {
    let layout = touch_layout(window.size());
    let mut held = Vec::new();
    for t in touches.iter() {
        let p = t.position();
        for (b, rect) in &layout {
            // Generous hit area: thumbs are imprecise.
            if rect.inflate(12.0).contains(p) && !held.contains(b) {
                held.push(*b);
            }
        }
    }
    held
}

fn player_input(
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    touches: Res<Touches>,
    gamepads: Query<&Gamepad>,
    window: Query<&Window, With<PrimaryWindow>>,
    mode: Res<InputMode>,
    mut touch_state: ResMut<TouchState>,
    mut cars: Query<(&Car, &mut VehicleInput), Without<AiDriver>>,
    paused: Res<Paused>,
) {
    let held = window
        .single()
        .map(|w| pressed_touch_buttons(&touches, w))
        .unwrap_or_default();
    touch_state.held = held.clone();
    let touch_held = |b: TouchButton| held.contains(&b);

    let k = |codes: &[KeyCode]| codes.iter().any(|c| keys.pressed(*c));
    let mut throttle: f32 = if k(&[KeyCode::ArrowUp, KeyCode::KeyW]) {
        1.0
    } else {
        0.0
    };
    let mut brake: f32 = if k(&[KeyCode::ArrowDown, KeyCode::KeyS]) {
        1.0
    } else {
        0.0
    };
    let mut steer_digital: f32 = 0.0;
    if k(&[KeyCode::ArrowLeft, KeyCode::KeyA]) {
        steer_digital += 1.0;
    }
    if k(&[KeyCode::ArrowRight, KeyCode::KeyD]) {
        steer_digital -= 1.0;
    }
    let mut handbrake = k(&[KeyCode::Space]);
    let mut nitro = k(&[KeyCode::ShiftLeft, KeyCode::ShiftRight]);

    // Touch: auto-accelerate, steer buttons, brake, nitro (all multi-touch).
    if mode.touch {
        if touch_held(TouchButton::SteerLeft) {
            steer_digital += 1.0;
        }
        if touch_held(TouchButton::SteerRight) {
            steer_digital -= 1.0;
        }
        if touch_held(TouchButton::Brake) {
            brake = 1.0;
        } else {
            throttle = 1.0;
        }
        nitro |= touch_held(TouchButton::Nitro);
    }

    // Gamepad (analog steering wins when used).
    let mut steer_analog: Option<f32> = None;
    for pad in &gamepads {
        let x = pad.left_stick().x;
        if x.abs() > 0.12 {
            steer_analog = Some(-x);
        }
        throttle = throttle.max(pad.get(GamepadButton::RightTrigger2).unwrap_or(0.0));
        brake = brake.max(pad.get(GamepadButton::LeftTrigger2).unwrap_or(0.0));
        handbrake |= pad.pressed(GamepadButton::South);
        nitro |= pad.pressed(GamepadButton::East) || pad.pressed(GamepadButton::RightTrigger);
    }

    if paused.0 {
        return;
    }
    let dt = time.delta_secs().min(0.05);
    for (car, mut input) in &mut cars {
        if !car.is_player {
            continue;
        }
        input.throttle = throttle.clamp(0.0, 1.0);
        input.brake = brake.clamp(0.0, 1.0);
        input.handbrake = handbrake;
        input.nitro = nitro;
        input.steer = match steer_analog {
            Some(a) => a,
            None => {
                // Keyboard/touch steering ramps in quickly and recentres faster.
                let target = steer_digital.clamp(-1.0, 1.0);
                let rate = if target == 0.0 || target.signum() != input.steer.signum() {
                    9.0
                } else {
                    5.5
                };
                let delta = (target - input.steer).clamp(-rate * dt, rate * dt);
                input.steer + delta
            }
        };
    }
}

fn action_input(
    keys: Res<ButtonInput<KeyCode>>,
    touches: Res<Touches>,
    gamepads: Query<&Gamepad>,
    window: Query<&Window, With<PrimaryWindow>>,
    mode: Res<InputMode>,
    state: Res<State<AppState>>,
    paused: Res<Paused>,
    cars: Query<(Entity, &Car)>,
    mut toggle_cam: MessageWriter<ToggleCamera>,
    mut pause: MessageWriter<TogglePause>,
    mut reset: MessageWriter<ResetCar>,
) {
    let mut cam = keys.just_pressed(KeyCode::KeyC);
    let mut do_pause = keys.just_pressed(KeyCode::KeyP) || keys.just_pressed(KeyCode::Escape);
    let mut do_reset = keys.just_pressed(KeyCode::KeyR);
    for pad in &gamepads {
        cam |= pad.just_pressed(GamepadButton::North);
        do_pause |= pad.just_pressed(GamepadButton::Start);
        do_reset |= pad.just_pressed(GamepadButton::West);
    }
    if mode.touch
        && let Ok(w) = window.single()
    {
        let layout = touch_layout(w.size());
        for t in touches.iter_just_pressed() {
            for (b, rect) in &layout {
                if rect.inflate(8.0).contains(t.position()) {
                    match b {
                        TouchButton::Camera => cam = true,
                        TouchButton::Pause => do_pause = true,
                        TouchButton::Reset => do_reset = true,
                        _ => {}
                    }
                }
            }
        }
    }

    if cam {
        toggle_cam.write(ToggleCamera);
    }
    if do_pause {
        pause.write(TogglePause);
    }
    if do_reset && !paused.0 && *state.get() == AppState::Racing {
        for (e, car) in &cars {
            if car.is_player {
                reset.write(ResetCar(e));
            }
        }
    }
}
