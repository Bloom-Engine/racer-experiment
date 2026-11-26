//! Start screen, pause overlay and finish/results screen.
//!
//! Buttons use Bevy 0.20's headless `ui_widgets::Button`, which fires an
//! [`Activate`] event on click or tap (mouse and touch both go through
//! `bevy_picking`).

use bevy::{
    picking::hover::Hovered,
    prelude::*,
    ui::Pressed,
    ui_widgets::{Activate, Button},
};

use crate::{
    game_state::{AppState, BackToMenu, Paused, RestartRace, TogglePause},
    hud::{UiFont, text},
    input::InputMode,
    race::{BestLap, RaceProgress, TOTAL_LAPS, format_time},
    vehicle::Car,
};

#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    Start,
    Resume,
    Restart,
    Menu,
}

#[derive(Component)]
struct PauseScreen;

#[derive(Component)]
struct ResultsTable;

#[derive(Component)]
struct MenuBest;

const BTN: Color = Color::srgb(0.85, 0.12, 0.1);
const BTN_HOVER: Color = Color::srgb(0.95, 0.25, 0.18);
const BTN_PRESSED: Color = Color::srgb(0.65, 0.08, 0.06);
const OVERLAY: Color = Color::srgba(0.02, 0.03, 0.06, 0.72);
const ACCENT: Color = Color::srgb(1.0, 0.82, 0.18);

pub struct MenuPlugin;

impl Plugin for MenuPlugin {
    fn build(&self, app: &mut App) {
        app.add_observer(on_activate)
            .add_systems(OnEnter(AppState::Menu), spawn_start_screen)
            .add_systems(OnEnter(AppState::Finished), spawn_finish_screen)
            .add_systems(
                Update,
                (
                    button_colors,
                    pause_overlay,
                    menu_keys,
                    update_results.run_if(in_state(AppState::Finished)),
                ),
            );
    }
}

fn button(font: &UiFont, label: &str, action: MenuAction) -> impl Bundle {
    (
        Button,
        Hovered::default(),
        action,
        Node {
            width: px(260),
            height: px(64),
            margin: UiRect::all(px(8)),
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            border: UiRect::all(px(3)),
            border_radius: BorderRadius::all(px(14)),
            ..default()
        },
        BorderColor::all(Color::WHITE),
        BackgroundColor(BTN),
        children![text(font, label, 30.0, Color::WHITE)],
    )
}

fn overlay(state_scoped: Option<AppState>) -> impl Bundle {
    (
        Node {
            position_type: PositionType::Absolute,
            width: percent(100),
            height: percent(100),
            flex_direction: FlexDirection::Column,
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
            ..default()
        },
        BackgroundColor(OVERLAY),
        GlobalZIndex(10),
        DespawnOnExit(state_scoped.unwrap_or(AppState::Racing)),
    )
}

fn on_activate(
    activate: On<Activate>,
    actions: Query<&MenuAction>,
    mut next: ResMut<NextState<AppState>>,
    mut restart: MessageWriter<RestartRace>,
    mut pause: MessageWriter<TogglePause>,
    mut menu: MessageWriter<BackToMenu>,
    paused: Res<Paused>,
) {
    let Ok(action) = actions.get(activate.entity) else {
        return;
    };
    match action {
        MenuAction::Start => next.set(AppState::Countdown),
        MenuAction::Resume => {
            if paused.0 {
                pause.write(TogglePause);
            }
        }
        MenuAction::Restart => {
            restart.write(RestartRace);
        }
        MenuAction::Menu => {
            menu.write(BackToMenu);
        }
    }
}

fn button_colors(
    mut q: Query<(&Hovered, Has<Pressed>, &mut BackgroundColor), (With<Button>, With<MenuAction>)>,
) {
    for (hovered, pressed, mut bg) in &mut q {
        let c = if pressed {
            BTN_PRESSED
        } else if hovered.get() {
            BTN_HOVER
        } else {
            BTN
        };
        bg.set_if_neq(BackgroundColor(c));
    }
}

/// Keyboard shortcuts for the menus (Enter = primary action).
fn menu_keys(
    keys: Res<ButtonInput<KeyCode>>,
    gamepads: Query<&Gamepad>,
    state: Res<State<AppState>>,
    mut next: ResMut<NextState<AppState>>,
    mut restart: MessageWriter<RestartRace>,
) {
    let confirm = keys.just_pressed(KeyCode::Enter)
        || gamepads
            .iter()
            .any(|g| g.just_pressed(GamepadButton::South));
    if !confirm {
        return;
    }
    match state.get() {
        AppState::Menu => next.set(AppState::Countdown),
        AppState::Finished => {
            restart.write(RestartRace);
        }
        _ => {}
    }
}

fn spawn_start_screen(
    mut commands: Commands,
    font: Res<UiFont>,
    best: Res<BestLap>,
    mode: Res<InputMode>,
) {
    let f = &*font;
    let best_s = best
        .time
        .map(|t| format!("BEST LAP  {}", format_time(t)))
        .unwrap_or_else(|| "NO BEST LAP YET".into());
    let help = if mode.touch {
        "Auto-accelerate  |  LEFT / RIGHT steer  |  BRAKE  |  NITRO"
    } else {
        "WASD / arrows drive   SPACE handbrake/drift   SHIFT nitro\nR reset   C camera   P pause   F fps"
    };
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                width: percent(100),
                height: percent(100),
                flex_direction: FlexDirection::Column,
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
            BackgroundColor(Color::srgba(0.0, 0.0, 0.0, 0.25)),
            DespawnOnExit(AppState::Menu),
        ))
        .with_children(|p| {
            p.spawn(text(f, "APEX RUSH", 92.0, ACCENT));
            p.spawn(text(
                f,
                "3 laps  ·  4 cars  ·  one circuit",
                22.0,
                Color::WHITE,
            ));
            p.spawn((Node {
                height: px(28),
                ..default()
            },));
            p.spawn(button(f, "START", MenuAction::Start));
            p.spawn((MenuBest, text(f, best_s, 22.0, Color::srgb(0.7, 0.9, 1.0))));
            p.spawn((
                Node {
                    margin: UiRect::top(px(30)),
                    ..default()
                },
                children![(
                    text(f, help, 18.0, Color::srgb(0.9, 0.9, 0.9)),
                    TextLayout::justify(Justify::Center),
                )],
            ));
        });
}

fn pause_overlay(
    mut commands: Commands,
    paused: Res<Paused>,
    existing: Query<Entity, With<PauseScreen>>,
    font: Res<UiFont>,
    state: Res<State<AppState>>,
) {
    if !paused.is_changed() {
        return;
    }
    if paused.0 && existing.is_empty() {
        let f = &*font;
        commands
            .spawn((PauseScreen, overlay(Some(*state.get()))))
            .with_children(|p| {
                p.spawn(text(f, "PAUSED", 72.0, ACCENT));
                p.spawn(button(f, "RESUME", MenuAction::Resume));
                p.spawn(button(f, "RESTART", MenuAction::Restart));
                p.spawn(button(f, "MENU", MenuAction::Menu));
            });
    } else if !paused.0 {
        for e in &existing {
            commands.entity(e).despawn();
        }
    }
}

fn spawn_finish_screen(mut commands: Commands, font: Res<UiFont>) {
    let f = &*font;
    commands
        .spawn(overlay(Some(AppState::Finished)))
        .with_children(|p| {
            p.spawn(text(f, "RACE FINISHED", 64.0, ACCENT));
            p.spawn((
                ResultsTable,
                Node {
                    flex_direction: FlexDirection::Column,
                    margin: UiRect::vertical(px(18)),
                    padding: UiRect::all(px(16)),
                    border_radius: BorderRadius::all(px(12)),
                    ..default()
                },
                BackgroundColor(Color::srgba(1.0, 1.0, 1.0, 0.06)),
            ));
            p.spawn(Node {
                flex_direction: FlexDirection::Row,
                ..default()
            })
            .with_children(|row| {
                row.spawn(button(f, "RESTART", MenuAction::Restart));
                row.spawn(button(f, "MENU", MenuAction::Menu));
            });
        });
}

/// Rebuild the results table while AI cars are still finishing.
fn update_results(
    mut commands: Commands,
    font: Res<UiFont>,
    tables: Query<Entity, With<ResultsTable>>,
    cars: Query<(&Car, &RaceProgress)>,
    best: Res<BestLap>,
    mut last_key: Local<String>,
) {
    let Ok(table) = tables.single() else { return };
    let mut rows: Vec<(&Car, &RaceProgress)> = cars.iter().collect();
    rows.sort_by_key(|(_, p)| p.place);
    // Only rebuild when something visible changed.
    let key: String = rows
        .iter()
        .map(|(c, p)| format!("{}{}{:?}{};", c.name, p.place, p.finish_time, p.laps_done))
        .collect::<String>()
        + &format!("{}", best.new_record);
    if *last_key == key {
        return;
    }
    *last_key = key;
    let f = &*font;
    commands.entity(table).despawn_children();
    commands.entity(table).with_children(|t| {
        for (car, prog) in &rows {
            let total = prog
                .finish_time
                .map(format_time)
                .unwrap_or_else(|| format!("lap {}/{}", prog.current_lap(), TOTAL_LAPS));
            let best_lap = prog.best_lap.map(format_time).unwrap_or_else(|| "-".into());
            let color = if car.is_player { ACCENT } else { Color::WHITE };
            t.spawn(Node {
                flex_direction: FlexDirection::Row,
                column_gap: px(28),
                ..default()
            })
            .with_children(|r| {
                r.spawn((
                    text(f, format!("{}.", prog.place), 28.0, color),
                    Node {
                        width: px(44),
                        ..default()
                    },
                ));
                r.spawn((
                    Node {
                        width: px(22),
                        height: px(22),
                        margin: UiRect::top(px(6)),
                        border_radius: BorderRadius::MAX,
                        ..default()
                    },
                    BackgroundColor(car.color),
                ));
                r.spawn((
                    text(f, car.name.clone(), 28.0, color),
                    Node {
                        width: px(130),
                        ..default()
                    },
                ));
                r.spawn((
                    text(f, total, 28.0, color),
                    Node {
                        width: px(150),
                        ..default()
                    },
                ));
                r.spawn(text(
                    f,
                    format!("best {best_lap}"),
                    22.0,
                    Color::srgb(0.75, 0.85, 1.0),
                ));
            });
        }
        if let Some((_, prog)) = rows.iter().find(|(c, _)| c.is_player) {
            let laps: Vec<String> = prog
                .lap_times
                .iter()
                .enumerate()
                .map(|(i, t)| format!("L{} {}", i + 1, format_time(*t)))
                .collect();
            t.spawn((
                text(f, laps.join("    "), 20.0, Color::srgb(0.85, 0.85, 0.85)),
                Node {
                    margin: UiRect::top(px(14)),
                    ..default()
                },
            ));
        }
        if best.new_record {
            t.spawn(text(f, "NEW BEST LAP!", 26.0, Color::srgb(0.3, 1.0, 0.45)));
        }
    });
}
