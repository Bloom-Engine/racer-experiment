//! Audio with Bevy's built-in `bevy_audio`:
//! * 3-layer engine loop (idle/mid/high) pitched by `rpm / base_rpm` and
//!   crossfaded, so upshifts are audible as an RPM drop;
//! * a quieter opponent engine (nearest AI car);
//! * tyre screech loop driven by slip;
//! * one-shots: collisions, nitro, countdown beeps, finish fanfare.

use bevy::{
    audio::{AudioSinkPlayback, PlaybackMode, Volume},
    prelude::*,
};

use crate::{
    game_state::{AppState, Paused},
    race::{CarFinished, CountdownTick},
    vehicle::{Car, CarImpact, IDLE_RPM, NitroFired, VehicleState},
};

#[derive(Component)]
struct EngineLayer {
    base_rpm: f32,
    layer: usize,
}

#[derive(Component)]
struct OpponentEngine;

#[derive(Component)]
struct Screech;

#[derive(Resource)]
struct Sfx {
    collision_light: Handle<AudioSource>,
    collision_heavy: Handle<AudioSource>,
    nitro: Handle<AudioSource>,
    beep_short: Handle<AudioSource>,
    beep_long: Handle<AudioSource>,
    fanfare: Handle<AudioSource>,
}

pub struct GameAudioPlugin;

impl Plugin for GameAudioPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup_audio).add_systems(
            Update,
            (
                engine_audio,
                opponent_audio,
                screech_audio,
                one_shots,
                pause_audio,
            ),
        );
    }
}

const ENGINE_LAYERS: [(&str, f32); 3] = [
    ("audio/engine_idle.wav", 900.0),
    ("audio/engine_mid.wav", 4000.0),
    ("audio/engine_high.wav", 7500.0),
];

fn looped(handle: Handle<AudioSource>) -> impl Bundle {
    (
        AudioPlayer::new(handle),
        PlaybackSettings {
            mode: PlaybackMode::Loop,
            volume: Volume::Linear(0.0),
            ..default()
        },
    )
}

fn setup_audio(mut commands: Commands, assets: Res<AssetServer>) {
    for (i, (path, base)) in ENGINE_LAYERS.iter().enumerate() {
        commands.spawn((
            Name::new(format!("engine_layer_{i}")),
            EngineLayer {
                base_rpm: *base,
                layer: i,
            },
            looped(assets.load(*path)),
        ));
    }
    commands.spawn((OpponentEngine, looped(assets.load("audio/engine_mid.wav"))));
    commands.spawn((Screech, looped(assets.load("audio/tyre_screech_loop.wav"))));
    commands.insert_resource(Sfx {
        collision_light: assets.load("audio/collision_light.wav"),
        collision_heavy: assets.load("audio/collision_heavy.wav"),
        nitro: assets.load("audio/nitro_whoosh.wav"),
        beep_short: assets.load("audio/beep_short.wav"),
        beep_long: assets.load("audio/beep_long.wav"),
        fanfare: assets.load("audio/finish_fanfare.wav"),
    });
}

/// Crossfade weights for the three engine layers at a given RPM.
pub fn engine_weights(rpm: f32) -> [f32; 3] {
    let bases = [ENGINE_LAYERS[0].1, ENGINE_LAYERS[1].1, ENGINE_LAYERS[2].1];
    if rpm <= bases[0] {
        return [1.0, 0.0, 0.0];
    }
    if rpm >= bases[2] {
        return [0.0, 0.0, 1.0];
    }
    if rpm < bases[1] {
        let t = (rpm - bases[0]) / (bases[1] - bases[0]);
        [1.0 - t, t, 0.0]
    } else {
        let t = (rpm - bases[1]) / (bases[2] - bases[1]);
        [0.0, 1.0 - t, t]
    }
}

fn engine_audio(
    state: Res<State<AppState>>,
    cars: Query<(&Car, &VehicleState)>,
    mut layers: Query<(&EngineLayer, &mut AudioSink)>,
) {
    let Some((_, st)) = cars.iter().find(|(c, _)| c.is_player) else {
        return;
    };
    let active = state.get().in_race();
    let rpm = st.rpm.max(IDLE_RPM);
    let weights = engine_weights(rpm);
    // Brief dip right after an upshift sells the gear change.
    let shift_dip = if st.since_shift < 0.12 { 0.55 } else { 1.0 };
    let load = 0.55 + 0.45 * st.throttle.max(if st.nitro_active { 1.0 } else { 0.0 });
    for (layer, mut sink) in &mut layers {
        let pitch = (rpm / layer.base_rpm).clamp(0.4, 2.2);
        sink.set_speed(pitch);
        // Equal-power-ish crossfade.
        let w = weights[layer.layer].sqrt();
        let master = if active { 0.55 } else { 0.18 };
        sink.set_volume(Volume::Linear(w * load * shift_dip * master));
    }
}

fn opponent_audio(
    state: Res<State<AppState>>,
    cars: Query<(&Car, &Transform, &VehicleState)>,
    mut sink: Query<&mut AudioSink, With<OpponentEngine>>,
) {
    let Ok(mut sink) = sink.single_mut() else {
        return;
    };
    let Some((_, player_tf, _)) = cars.iter().find(|(c, ..)| c.is_player) else {
        return;
    };
    let nearest = cars
        .iter()
        .filter(|(c, ..)| !c.is_player)
        .map(|(_, t, s)| (t.translation.distance(player_tf.translation), s.rpm))
        .min_by(|a, b| a.0.total_cmp(&b.0));
    let (vol, pitch) = match nearest {
        Some((d, rpm)) if state.get().in_race() => (
            (1.0 - d / 60.0).clamp(0.0, 1.0).powi(2) * 0.35,
            (rpm / 4000.0).clamp(0.4, 2.0),
        ),
        _ => (0.0, 1.0),
    };
    sink.set_speed(pitch);
    sink.set_volume(Volume::Linear(vol));
}

fn screech_audio(
    cars: Query<(&Car, &VehicleState)>,
    mut sink: Query<&mut AudioSink, With<Screech>>,
    time: Res<Time<Real>>,
    mut level: Local<f32>,
) {
    let Ok(mut sink) = sink.single_mut() else {
        return;
    };
    let Some((_, st)) = cars.iter().find(|(c, _)| c.is_player) else {
        return;
    };
    let target = if st.grounded_wheels > 0 { st.slip } else { 0.0 };
    let k = 1.0 - (-10.0 * time.delta_secs()).exp();
    *level += (target - *level) * k;
    sink.set_volume(Volume::Linear(*level * 0.5));
    sink.set_speed(0.9 + 0.2 * *level);
}

fn one_shot(commands: &mut Commands, h: &Handle<AudioSource>, volume: f32) {
    commands.spawn((
        AudioPlayer::new(h.clone()),
        PlaybackSettings::DESPAWN.with_volume(Volume::Linear(volume)),
    ));
}

fn one_shots(
    mut commands: Commands,
    sfx: Option<Res<Sfx>>,
    mut impacts: MessageReader<CarImpact>,
    mut nitro: MessageReader<NitroFired>,
    mut ticks: MessageReader<CountdownTick>,
    mut finished: MessageReader<CarFinished>,
    cars: Query<(&Car, &Transform)>,
    time: Res<Time<Real>>,
    mut last_impact: Local<f32>,
) {
    let Some(sfx) = sfx else { return };
    let now = time.elapsed_secs();
    let player_pos = cars
        .iter()
        .find(|(c, _)| c.is_player)
        .map(|(_, t)| t.translation)
        .unwrap_or_default();
    for m in impacts.read() {
        // Player impacts, or AI impacts close to the player.
        let dist = m.position.distance(player_pos);
        if (!m.is_player && dist > 40.0) || now - *last_impact < 0.2 {
            continue;
        }
        *last_impact = now;
        let atten = if m.is_player {
            1.0
        } else {
            0.5 * (1.0 - dist / 40.0)
        };
        if m.strength > 9.0 {
            one_shot(&mut commands, &sfx.collision_heavy, 0.9 * atten);
        } else {
            one_shot(
                &mut commands,
                &sfx.collision_light,
                (0.3 + m.strength / 15.0).min(0.8) * atten,
            );
        }
    }
    for m in nitro.read() {
        if m.is_player {
            one_shot(&mut commands, &sfx.nitro, 0.8);
        }
    }
    for t in ticks.read() {
        if t.0 == 0 {
            one_shot(&mut commands, &sfx.beep_long, 0.7);
        } else {
            one_shot(&mut commands, &sfx.beep_short, 0.7);
        }
    }
    for f in finished.read() {
        if f.is_player {
            one_shot(&mut commands, &sfx.fanfare, 0.8);
        }
    }
}

fn pause_audio(paused: Res<Paused>, sinks: Query<&AudioSink>) {
    if !paused.is_changed() {
        return;
    }
    for s in &sinks {
        if paused.0 {
            s.pause();
        } else {
            s.play();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_one() {
        for rpm in (500..8000).step_by(250) {
            let w = engine_weights(rpm as f32);
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-4);
        }
    }
}
