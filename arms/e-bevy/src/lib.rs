//! Apex Rush — a small arcade racer built with Bevy + avian3d.
//!
//! Each gameplay area is its own plugin; see `NOTES.md` for the architecture.

pub mod ai;
pub mod audio;
pub mod camera;
pub mod effects;
pub mod game_state;
pub mod hud;
pub mod input;
pub mod menu;
pub mod persist;
pub mod physics;
pub mod race;
pub mod testing;
pub mod track;
pub mod track_data;
pub mod vehicle;

use bevy::{prelude::*, window::WindowMode};

/// Asset folder relative to the executable. Bevy looks next to the binary by
/// default (correct for `cargo run` and iOS bundles, where the executable sits
/// at the bundle root). A macOS `.app` keeps resources in `Contents/Resources`.
fn asset_dir() -> String {
    let in_macos_bundle = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.ends_with("Contents/MacOS")))
        .unwrap_or(false);
    if cfg!(target_os = "macos")
        && in_macos_bundle
        && std::env::var_os("CARGO_MANIFEST_DIR").is_none()
    {
        "../Resources/assets".into()
    } else {
        "assets".into()
    }
}

pub fn run() {
    let mobile = cfg!(any(target_os = "ios", target_os = "android"));
    let window = Window {
        title: "Apex Rush".into(),
        resolution: (1280, 720).into(),
        mode: if mobile {
            WindowMode::BorderlessFullscreen(MonitorSelection::Primary)
        } else {
            WindowMode::Windowed
        },
        prefers_home_indicator_hidden: true,
        prefers_status_bar_hidden: true,
        ..default()
    };
    App::new()
        .insert_resource(ClearColor(Color::srgb(0.62, 0.78, 0.95)))
        .insert_resource(track_data::TrackData::load())
        .add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(window),
                    ..default()
                })
                .set(AssetPlugin {
                    file_path: asset_dir(),
                    ..default()
                }),
        )
        .add_plugins((
            game_state::GameStatePlugin,
            physics::GamePhysicsPlugin,
            track::TrackPlugin,
            vehicle::VehiclePlugin,
            input::InputPlugin,
            camera::CameraPlugin,
            ai::AiPlugin,
            race::RacePlugin,
            hud::HudPlugin,
            menu::MenuPlugin,
            audio::GameAudioPlugin,
            effects::EffectsPlugin,
            testing::TestingPlugin,
        ))
        .run();
}
