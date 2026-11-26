//! In-race HUD (Bevy UI): position, lap, lap times, best lap, speed, gear,
//! nitro bar, minimap with car dots, countdown, nitro speed lines and the
//! on-screen touch controls.

use bevy::{
    diagnostic::{DiagnosticsStore, FrameTimeDiagnosticsPlugin},
    prelude::*,
    window::PrimaryWindow,
};

use crate::{
    camera::{CameraMode, GameCamera},
    game_state::AppState,
    input::{InputMode, TouchButton, TouchState, touch_layout},
    race::{BestLap, LapCompleted, RaceClock, RaceProgress, TOTAL_LAPS, format_time},
    track_data::TrackData,
    vehicle::{Car, VehicleState},
};

pub const FONT: &str = "ui/fonts/RussoOne-Regular.ttf";
const MINIMAP_W: f32 = 240.0;
const SPEED_LINES: usize = 26;
/// Horizontal safe-area inset (landscape notch / Dynamic Island) on phones.
pub const SAFE_X: f32 = if cfg!(target_os = "ios") { 56.0 } else { 0.0 };

#[derive(Resource, Clone)]
pub struct UiFont(pub Handle<Font>);

#[derive(Component)]
struct HudRoot;
#[derive(Component)]
struct PosText;
#[derive(Component)]
struct LapText;
#[derive(Component)]
struct TimeText;
#[derive(Component)]
struct BestText;
#[derive(Component)]
struct SpeedText;
#[derive(Component)]
struct GearText;
#[derive(Component)]
struct NitroFill;
#[derive(Component)]
struct NitroLabel;
#[derive(Component)]
struct CenterText;
#[derive(Component)]
struct FpsText;
#[derive(Component)]
struct MinimapDot(Entity);
#[derive(Component)]
struct Minimap;
#[derive(Component)]
struct SpeedLine {
    angle: f32,
    phase: f32,
}
#[derive(Component)]
struct TouchButtonNode(TouchButton);
#[derive(Component)]
struct TouchLayer;

/// Transient centre-screen message ("FINAL LAP", "NEW BEST LAP!").
#[derive(Resource, Default)]
struct Banner {
    text: String,
    remaining: f32,
}

#[derive(Resource, Default)]
pub struct ShowFps(pub bool);

pub struct HudPlugin;

impl Plugin for HudPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(FrameTimeDiagnosticsPlugin::default())
            .init_resource::<Banner>()
            .insert_resource(ShowFps(std::env::var("RACER_FPS").is_ok()))
            .add_systems(PreStartup, load_font)
            .add_systems(Startup, spawn_hud)
            .add_systems(Update, spawn_minimap_dots)
            .add_systems(
                Update,
                (
                    hud_visibility,
                    update_texts,
                    update_minimap,
                    update_center_text,
                    update_speed_lines,
                    update_touch_buttons,
                    update_fps,
                    lap_banners,
                ),
            );
    }
}

fn load_font(mut commands: Commands, assets: Res<AssetServer>) {
    commands.insert_resource(UiFont(assets.load(FONT)));
}

pub fn text(font: &UiFont, s: impl Into<String>, size: f32, color: Color) -> impl Bundle {
    (
        Text::new(s),
        TextFont {
            font: font.0.clone().into(),
            font_size: FontSize::Px(size),
            ..default()
        },
        TextColor(color),
        TextShadow {
            offset: Vec2::splat(2.0),
            color: Color::srgba(0.0, 0.0, 0.0, 0.6),
        },
    )
}

const PANEL: Color = Color::srgba(0.04, 0.05, 0.08, 0.55);
const ACCENT: Color = Color::srgb(1.0, 0.82, 0.18);
const NITRO_COLOR: Color = Color::srgb(0.25, 0.8, 1.0);

fn spawn_hud(
    mut commands: Commands,
    font: Res<UiFont>,
    assets: Res<AssetServer>,
    track: Res<TrackData>,
) {
    let f = &*font;
    let map_rect = track.minimap_track_rect(40.0);
    let map_h = MINIMAP_W * map_rect.height() / map_rect.width();
    commands
        .spawn((
            HudRoot,
            Node {
                width: percent(100),
                height: percent(100),
                position_type: PositionType::Absolute,
                ..default()
            },
            Visibility::Hidden,
            // Let touches/clicks fall through to the game.
            Pickable::IGNORE,
        ))
        .with_children(|root| {
            // Speed lines (behind everything else).
            for i in 0..SPEED_LINES {
                let angle =
                    i as f32 / SPEED_LINES as f32 * std::f32::consts::TAU + 0.17 * (i % 3) as f32;
                root.spawn((
                    SpeedLine {
                        angle,
                        phase: (i as f32 * 0.37).fract(),
                    },
                    Node {
                        position_type: PositionType::Absolute,
                        width: px(6),
                        height: px(120),
                        ..default()
                    },
                    BackgroundColor(Color::srgba(0.85, 0.95, 1.0, 0.0)),
                    UiTransform::default(),
                    Visibility::Hidden,
                ));
            }

            // Top-left: position + lap + times.
            root.spawn((
                Node {
                    position_type: PositionType::Absolute,
                    left: px(16.0 + SAFE_X),
                    top: px(12),
                    flex_direction: FlexDirection::Column,
                    padding: UiRect::axes(px(14), px(8)),
                    border_radius: BorderRadius::all(px(10)),
                    ..default()
                },
                BackgroundColor(PANEL),
            ))
            .with_children(|p| {
                p.spawn((PosText, text(f, "1/4", 44.0, Color::WHITE)));
                p.spawn((LapText, text(f, "LAP 1/3", 22.0, ACCENT)));
                p.spawn((TimeText, text(f, "TIME 0:00.000", 18.0, Color::WHITE)));
                p.spawn((
                    BestText,
                    text(f, "BEST --:--.---", 18.0, Color::srgb(0.7, 0.9, 1.0)),
                ));
            });

            // Top-right: minimap.
            root.spawn((
                Minimap,
                Node {
                    position_type: PositionType::Absolute,
                    right: px(14.0 + SAFE_X),
                    top: px(12),
                    width: px(MINIMAP_W),
                    height: px(map_h),
                    border_radius: BorderRadius::all(px(12)),
                    ..default()
                },
                BackgroundColor(PANEL),
            ))
            .with_child((
                ImageNode {
                    rect: Some(map_rect),
                    ..ImageNode::new(assets.load(track.minimap_file.clone()))
                },
                Node {
                    width: percent(100),
                    height: percent(100),
                    ..default()
                },
            ));

            // Bottom centre: speed, gear, nitro.
            root.spawn(Node {
                position_type: PositionType::Absolute,
                bottom: px(14),
                left: percent(50),
                margin: UiRect::left(px(-150)),
                width: px(300),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                ..default()
            })
            .with_children(|p| {
                p.spawn(Node {
                    flex_direction: FlexDirection::Row,
                    align_items: AlignItems::FlexEnd,
                    column_gap: px(8),
                    ..default()
                })
                .with_children(|row| {
                    row.spawn((SpeedText, text(f, "0", 58.0, Color::WHITE)));
                    row.spawn(text(f, "km/h", 18.0, Color::srgb(0.85, 0.85, 0.85)));
                    row.spawn((GearText, text(f, "1", 30.0, ACCENT)));
                });
                p.spawn((
                    Node {
                        width: px(260),
                        height: px(16),
                        border: UiRect::all(px(2)),
                        border_radius: BorderRadius::all(px(8)),
                        margin: UiRect::top(px(4)),
                        overflow: Overflow::clip(),
                        ..default()
                    },
                    BorderColor::all(Color::srgba(1.0, 1.0, 1.0, 0.6)),
                    BackgroundColor(Color::srgba(0.0, 0.0, 0.0, 0.5)),
                ))
                .with_child((
                    NitroFill,
                    Node {
                        width: percent(30),
                        height: percent(100),
                        ..default()
                    },
                    BackgroundColor(NITRO_COLOR),
                ));
                p.spawn((NitroLabel, text(f, "NITRO", 14.0, NITRO_COLOR)));
            });

            // Centre text: countdown / banners.
            root.spawn(Node {
                position_type: PositionType::Absolute,
                width: percent(100),
                top: percent(28),
                justify_content: JustifyContent::Center,
                ..default()
            })
            .with_child((CenterText, text(f, "", 96.0, ACCENT)));

            // FPS (debug).
            root.spawn((
                FpsText,
                text(f, "", 14.0, Color::srgb(0.6, 1.0, 0.6)),
                Node {
                    position_type: PositionType::Absolute,
                    left: px(16),
                    bottom: px(8),
                    ..default()
                },
            ));

            // Touch controls.
            root.spawn((
                TouchLayer,
                Node {
                    position_type: PositionType::Absolute,
                    width: percent(100),
                    height: percent(100),
                    ..default()
                },
                Visibility::Hidden,
            ))
            .with_children(|layer| {
                for b in TouchButton::ALL {
                    layer
                        .spawn((
                            TouchButtonNode(b),
                            Node {
                                position_type: PositionType::Absolute,
                                border_radius: BorderRadius::MAX,
                                border: UiRect::all(px(3)),
                                padding: UiRect::all(px(14)),
                                ..default()
                            },
                            BackgroundColor(Color::srgba(0.0, 0.0, 0.0, 0.35)),
                            BorderColor::all(Color::srgba(1.0, 1.0, 1.0, 0.55)),
                        ))
                        .with_child((
                            ImageNode::new(assets.load(b.icon())),
                            Node {
                                width: percent(100),
                                height: percent(100),
                                ..default()
                            },
                        ));
                }
            });
        });
}

fn hud_visibility(
    state: Res<State<AppState>>,
    mut root: Query<&mut Visibility, (With<HudRoot>, Without<TouchLayer>)>,
    mut touch: Query<&mut Visibility, (With<TouchLayer>, Without<HudRoot>)>,
    mode: Res<InputMode>,
) {
    let in_race = matches!(state.get(), AppState::Countdown | AppState::Racing);
    let want = if in_race {
        Visibility::Inherited
    } else {
        Visibility::Hidden
    };
    for mut v in &mut root {
        v.set_if_neq(want);
    }
    let want_touch = if in_race && mode.touch {
        Visibility::Inherited
    } else {
        Visibility::Hidden
    };
    for mut v in &mut touch {
        v.set_if_neq(want_touch);
    }
}

fn update_texts(
    cars: Query<(&Car, &VehicleState, Option<&RaceProgress>)>,
    clock: Res<RaceClock>,
    best: Res<BestLap>,
    mut q: ParamSet<(
        Query<&mut Text, With<PosText>>,
        Query<&mut Text, With<LapText>>,
        Query<&mut Text, With<TimeText>>,
        Query<&mut Text, With<BestText>>,
        Query<&mut Text, With<SpeedText>>,
        Query<&mut Text, With<GearText>>,
    )>,
    mut nitro: Query<(&mut Node, &mut BackgroundColor), With<NitroFill>>,
    time: Res<Time<Real>>,
) {
    let Some((_, st, prog)) = cars.iter().find(|(c, ..)| c.is_player) else {
        return;
    };
    let n_cars = cars.iter().count();
    let set = |t: &mut Text, s: String| {
        if t.0 != s {
            t.0 = s;
        }
    };
    if let Some(prog) = prog {
        for mut t in &mut q.p0() {
            set(&mut t, format!("{}/{}", prog.place, n_cars));
        }
        for mut t in &mut q.p1() {
            set(&mut t, format!("LAP {}/{}", prog.current_lap(), TOTAL_LAPS));
        }
        let lap_t = (clock.time - prog.lap_start).max(0.0);
        for mut t in &mut q.p2() {
            set(&mut t, format!("TIME {}", format_time(lap_t)));
        }
        let best_s = best
            .time
            .map(format_time)
            .unwrap_or_else(|| "--:--.---".into());
        for mut t in &mut q.p3() {
            set(&mut t, format!("BEST {best_s}"));
        }
    }
    for mut t in &mut q.p4() {
        set(&mut t, format!("{:.0}", st.speed_kmh()));
    }
    for mut t in &mut q.p5() {
        let g = if st.forward_speed < -0.5 {
            "R".to_string()
        } else {
            st.gear.to_string()
        };
        set(&mut t, g);
    }
    for (mut node, mut bg) in &mut nitro {
        let w = percent(st.nitro * 100.0);
        if node.width != w {
            node.width = w;
        }
        let c = if st.nitro_active {
            let pulse = 0.75 + 0.25 * (time.elapsed_secs() * 20.0).sin();
            Color::srgb(0.6 * pulse, 0.95 * pulse, 1.0)
        } else if st.nitro >= 0.15 {
            NITRO_COLOR
        } else {
            Color::srgb(0.25, 0.45, 0.55)
        };
        bg.set_if_neq(BackgroundColor(c));
    }
}

fn spawn_minimap_dots(
    mut commands: Commands,
    new_cars: Query<(Entity, &Car), Added<Car>>,
    minimap: Query<Entity, With<Minimap>>,
) {
    let Ok(map) = minimap.single() else { return };
    for (e, car) in &new_cars {
        let size = if car.is_player { 14.0 } else { 10.0 };
        let dot = commands
            .spawn((
                MinimapDot(e),
                Node {
                    position_type: PositionType::Absolute,
                    width: px(size),
                    height: px(size),
                    border: UiRect::all(px(2)),
                    border_radius: BorderRadius::MAX,
                    ..default()
                },
                BackgroundColor(car.color),
                BorderColor::all(if car.is_player {
                    Color::WHITE
                } else {
                    Color::BLACK
                }),
                ZIndex(if car.is_player { 2 } else { 1 }),
            ))
            .id();
        commands.entity(map).add_child(dot);
    }
}

fn update_minimap(
    track: Res<TrackData>,
    cars: Query<&Transform, With<Car>>,
    mut dots: Query<(&MinimapDot, &mut Node)>,
) {
    let rect = track.minimap_track_rect(40.0);
    let scale = MINIMAP_W / rect.width();
    for (dot, mut node) in &mut dots {
        let Ok(t) = cars.get(dot.0) else { continue };
        let uv = (track.world_to_minimap(t.translation) - rect.min) * scale;
        let half = match node.width {
            Val::Px(w) => w * 0.5,
            _ => 5.0,
        };
        let (l, tp) = (px(uv.x - half), px(uv.y - half));
        if node.left != l || node.top != tp {
            node.left = l;
            node.top = tp;
        }
    }
}

fn update_center_text(
    state: Res<State<AppState>>,
    clock: Res<RaceClock>,
    mut banner: ResMut<Banner>,
    time: Res<Time>,
    mut q: Query<(&mut Text, &mut TextColor), With<CenterText>>,
) {
    banner.remaining -= time.delta_secs();
    let (s, color) = match state.get() {
        AppState::Countdown => {
            let c = clock.countdown;
            if c > 3.0 {
                (String::new(), ACCENT)
            } else {
                (format!("{}", c.ceil() as u32), ACCENT)
            }
        }
        AppState::Racing if clock.since_go < 1.0 => ("GO!".to_string(), Color::srgb(0.3, 1.0, 0.4)),
        AppState::Racing if banner.remaining > 0.0 => (banner.text.clone(), Color::WHITE),
        _ => (String::new(), ACCENT),
    };
    for (mut t, mut c) in &mut q {
        if t.0 != s {
            t.0 = s.clone();
        }
        c.set_if_neq(TextColor(color));
    }
}

fn lap_banners(
    mut laps: MessageReader<LapCompleted>,
    best: Res<BestLap>,
    mut banner: ResMut<Banner>,
) {
    for l in laps.read() {
        if !l.is_player || l.lap >= TOTAL_LAPS {
            continue;
        }
        let lap_label = if l.lap + 1 == TOTAL_LAPS {
            "FINAL LAP".to_string()
        } else {
            format!("LAP {}", l.lap + 1)
        };
        banner.text = if best.new_record && best.time == Some(l.time) {
            format!("{lap_label}\nNEW BEST {}", format_time(l.time))
        } else {
            format!("{lap_label}\n{}", format_time(l.time))
        };
        banner.remaining = 2.5;
    }
}

fn update_speed_lines(
    window: Query<&Window, With<PrimaryWindow>>,
    cars: Query<(&Car, &VehicleState)>,
    cams: Query<&GameCamera>,
    time: Res<Time>,
    mut lines: Query<(
        &SpeedLine,
        &mut Node,
        &mut UiTransform,
        &mut BackgroundColor,
        &mut Visibility,
    )>,
) {
    let Ok(w) = window.single() else { return };
    let Some((_, st)) = cars.iter().find(|(c, _)| c.is_player) else {
        return;
    };
    let size = w.size();
    let center = size * 0.5;
    let bumper = cams.iter().any(|c| c.mode == CameraMode::Bumper);
    let intensity = if st.nitro_active {
        1.0
    } else {
        ((st.speed_kmh() - 215.0) / 60.0).clamp(0.0, 0.45)
    } * if bumper { 1.2 } else { 1.0 };
    let t = time.elapsed_secs();
    for (line, mut node, mut tf, mut bg, mut vis) in &mut lines {
        if intensity <= 0.01 {
            vis.set_if_neq(Visibility::Hidden);
            continue;
        }
        vis.set_if_neq(Visibility::Inherited);
        // Lines stream outward from the screen centre towards the edges.
        let cycle = (t * 2.6 + line.phase).fract();
        let dir = Vec2::new(line.angle.cos(), line.angle.sin());
        let radius = size.length() * (0.28 + 0.3 * cycle);
        let p = center + dir * radius;
        let len = 60.0 + 140.0 * cycle;
        node.left = px(p.x - 3.0);
        node.top = px(p.y - len * 0.5);
        node.height = px(len);
        // Node is vertical; rotate it to point along `dir` (UI y axis points down).
        tf.rotation = Rot2::radians(line.angle - std::f32::consts::FRAC_PI_2);
        let alpha = intensity * 0.85 * (1.0 - cycle) * (cycle * 4.0).min(1.0);
        bg.0 = Color::srgba(0.85, 0.95, 1.0, alpha);
    }
}

fn update_touch_buttons(
    window: Query<&Window, With<PrimaryWindow>>,
    held: Res<TouchState>,
    mut buttons: Query<(&TouchButtonNode, &mut Node, &mut BackgroundColor)>,
) {
    let Ok(w) = window.single() else { return };
    let layout = touch_layout(w.size());
    for (b, mut node, mut bg) in &mut buttons {
        if let Some((_, r)) = layout.iter().find(|(k, _)| *k == b.0) {
            let (l, t, wd, ht) = (px(r.min.x), px(r.min.y), px(r.width()), px(r.height()));
            if node.left != l || node.top != t || node.width != wd || node.height != ht {
                node.left = l;
                node.top = t;
                node.width = wd;
                node.height = ht;
            }
        }
        let active = held.held.contains(&b.0);
        let c = match (b.0, active) {
            (TouchButton::Nitro, true) => Color::srgba(0.2, 0.7, 1.0, 0.7),
            (TouchButton::Brake, true) => Color::srgba(1.0, 0.25, 0.2, 0.7),
            (_, true) => Color::srgba(1.0, 1.0, 1.0, 0.45),
            _ => Color::srgba(0.0, 0.0, 0.0, 0.35),
        };
        bg.set_if_neq(BackgroundColor(c));
    }
}

fn update_fps(
    show: Res<ShowFps>,
    keys: Res<ButtonInput<KeyCode>>,
    mut show_mut: Local<Option<bool>>,
    diagnostics: Res<DiagnosticsStore>,
    mut q: Query<&mut Text, With<FpsText>>,
) {
    let on = show_mut.get_or_insert(show.0);
    if keys.just_pressed(KeyCode::KeyF) {
        *on = !*on;
    }
    let s = if *on {
        diagnostics
            .get(&FrameTimeDiagnosticsPlugin::FPS)
            .and_then(|d| d.smoothed())
            .map(|v| format!("{v:.0} FPS"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    for mut t in &mut q {
        if t.0 != s {
            t.0 = s.clone();
        }
    }
}
