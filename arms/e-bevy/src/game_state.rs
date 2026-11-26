//! Top-level game flow: app states, pause handling and test/debug options.

use bevy::prelude::*;

#[derive(States, Default, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppState {
    /// Waiting for the track scene + colliders.
    #[default]
    Loading,
    /// Start screen.
    Menu,
    /// 3-2-1-GO. Cars are on the grid and held.
    Countdown,
    /// Race in progress.
    Racing,
    /// The player has finished; results screen, AI keeps driving.
    Finished,
}

impl AppState {
    pub fn in_race(self) -> bool {
        matches!(
            self,
            AppState::Countdown | AppState::Racing | AppState::Finished
        )
    }
}

/// Pause flag. Pausing stops `Time<Virtual>`, which also stops the fixed
/// timestep (physics, race clock, AI).
#[derive(Resource, Default, Debug)]
pub struct Paused(pub bool);

pub fn not_paused(p: Res<Paused>) -> bool {
    !p.0
}

/// Message: toggle pause (keyboard, touch button, gamepad, pause-menu button).
#[derive(Message, Debug, Clone, Copy)]
pub struct TogglePause;

/// Message: restart the race from the grid.
#[derive(Message, Debug, Clone, Copy)]
pub struct RestartRace;

/// Message: return to the start screen.
#[derive(Message, Debug, Clone, Copy)]
pub struct BackToMenu;

/// Debug / automated-test switches, read once from environment variables.
///
/// * `RACER_AUTOSTART=1`  skip the start screen
/// * `RACER_AUTOPILOT=1`  the AI drives the player car
/// * `RACER_TEST=tunnel`  wall-tunnelling stress test (see `testing.rs`)
/// * `RACER_TEST=shortcut` checkpoint shortcut test
/// * `RACER_TEST=reset`   auto/manual reset test
/// * `RACER_SCREENSHOT=dir` periodic screenshots into `dir`
/// * `RACER_QUIT_AFTER_FINISH=1` exit when the results screen is reached
/// * `RACER_PLAYER_SKILL=x` autopilot speed factor (default 1.0)
#[derive(Resource, Debug, Default, Clone)]
pub struct DebugOpts {
    pub autostart: bool,
    pub autopilot: bool,
    pub test: Option<String>,
    pub screenshot_dir: Option<String>,
    pub quit_after_finish: bool,
    pub player_skill: Option<f32>,
}

impl DebugOpts {
    pub fn from_env() -> Self {
        let flag = |k: &str| std::env::var(k).is_ok_and(|v| v == "1" || v == "true");
        DebugOpts {
            autostart: flag("RACER_AUTOSTART"),
            autopilot: flag("RACER_AUTOPILOT"),
            test: std::env::var("RACER_TEST").ok(),
            screenshot_dir: std::env::var("RACER_SCREENSHOT").ok(),
            quit_after_finish: flag("RACER_QUIT_AFTER_FINISH"),
            player_skill: std::env::var("RACER_PLAYER_SKILL")
                .ok()
                .and_then(|v| v.parse().ok()),
        }
    }
}

pub struct GameStatePlugin;

impl Plugin for GameStatePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<AppState>()
            .init_resource::<Paused>()
            .insert_resource(DebugOpts::from_env())
            .add_message::<TogglePause>()
            .add_message::<RestartRace>()
            .add_message::<BackToMenu>()
            .add_systems(Update, (handle_pause, handle_restart, handle_back_to_menu))
            .add_systems(OnExit(AppState::Racing), unpause)
            .add_systems(OnEnter(AppState::Menu), unpause);
    }
}

fn handle_pause(
    mut msgs: MessageReader<TogglePause>,
    mut paused: ResMut<Paused>,
    mut time: ResMut<Time<Virtual>>,
    state: Res<State<AppState>>,
) {
    for _ in msgs.read() {
        // Pausing only makes sense while the race is running.
        if !matches!(state.get(), AppState::Countdown | AppState::Racing) && !paused.0 {
            continue;
        }
        paused.0 = !paused.0;
        if paused.0 {
            time.pause();
        } else {
            time.unpause();
        }
    }
}

fn unpause(mut paused: ResMut<Paused>, mut time: ResMut<Time<Virtual>>) {
    paused.0 = false;
    time.unpause();
}

fn handle_restart(
    mut msgs: MessageReader<RestartRace>,
    mut next: ResMut<NextState<AppState>>,
    mut paused: ResMut<Paused>,
    mut time: ResMut<Time<Virtual>>,
) {
    if msgs.read().count() > 0 {
        paused.0 = false;
        time.unpause();
        // Countdown's OnEnter puts every car back on the grid. Going through
        // Menu->Countdown would also work, but re-entering the same state needs
        // `set_forced` semantics; an explicit hop is clearer.
        next.set(AppState::Countdown);
    }
}

fn handle_back_to_menu(mut msgs: MessageReader<BackToMenu>, mut next: ResMut<NextState<AppState>>) {
    if msgs.read().count() > 0 {
        next.set(AppState::Menu);
    }
}
