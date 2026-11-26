//! Physics setup: avian3d plugin, collision layers, surface tags and the
//! anti-tunnelling guard.

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::vehicle::{Car, VehicleState};

#[derive(PhysicsLayer, Default, Clone, Copy, Debug)]
pub enum Layer {
    #[default]
    Default,
    /// Drivable asphalt + kerbs (`col_road`).
    Road,
    /// Run-off grass / gravel (`col_terrain`).
    Offroad,
    /// Closed 4 m walls (`col_barriers`).
    Barrier,
    /// Car bodies.
    Car,
}

/// Surface type of a static track collider, looked up from suspension ray hits.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Road,
    Offroad,
    Barrier,
}

/// Counts how often the tunnelling guard had to step in (exposed for tests/HUD debug).
#[derive(Resource, Default, Debug)]
pub struct TunnelGuardStats {
    pub interventions: u32,
}

/// System set for game logic that must run in the fixed step *before* the
/// physics step (inputs -> AI -> vehicle forces).
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum FixedGameSystems {
    Guard,
    Input,
    Vehicle,
    Race,
}

pub struct GamePhysicsPlugin;

impl Plugin for GamePhysicsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(PhysicsPlugins::default())
            // 60 Hz fixed step matches the target frame rate on phones; interpolation
            // smooths rendering on 120 Hz displays.
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(SubstepCount(4))
            .init_resource::<TunnelGuardStats>()
            .configure_sets(
                FixedUpdate,
                (
                    FixedGameSystems::Guard,
                    FixedGameSystems::Input,
                    FixedGameSystems::Vehicle,
                    FixedGameSystems::Race,
                )
                    .chain(),
            )
            .add_systems(FixedUpdate, tunnel_guard.in_set(FixedGameSystems::Guard));
    }
}

/// Belt-and-braces protection against wall tunnelling.
///
/// Cars already use [`SweptCcd`] and the barrier colliders are closed 4 m
/// solids, but at 300 km/h a single missed contact would put a car outside the
/// circuit. Each fixed step we cast a ray from the car's previous centre to its
/// current centre against the barrier layer only. A car's centre is always
/// ≥ 1 m from a wall it touches, so a hit means the centre went *through* a
/// wall face: move it back to the safe side and reflect its velocity.
fn tunnel_guard(
    spatial: SpatialQuery,
    mut cars: Query<
        (
            &mut Position,
            &Rotation,
            &mut LinearVelocity,
            &mut VehicleState,
        ),
        // Car bodies carry their collider on a child entity, so `Without<Collider>`
        // proves to the scheduler that this query is disjoint from `SpatialQuery`.
        (With<Car>, Without<Collider>),
    >,
    mut stats: ResMut<TunnelGuardStats>,
) {
    let filter = SpatialQueryFilter::from_mask(Layer::Barrier);
    for (mut pos, rot, mut vel, mut state) in &mut cars {
        let up = rot.0 * Vec3::Y;
        let cur = pos.0 + up * 0.7;
        let Some(prev) = state.prev_center else {
            state.prev_center = Some(cur);
            continue;
        };
        let delta = cur - prev;
        let len = delta.length();
        if len > 1e-3
            && len < 50.0
            && let Ok(dir) = Dir3::new(delta)
            && let Some(hit) = spatial.cast_ray(prev, dir, len, true, &filter)
        {
            // Move back to just in front of the wall and bounce.
            let safe = prev + *dir * (hit.distance - 1.2).max(0.0);
            pos.0 += safe - cur;
            let n = hit.normal;
            let vn = vel.0.dot(n);
            if vn < 0.0 {
                vel.0 -= n * vn * 1.3;
            }
            stats.interventions += 1;
            warn!(
                "tunnel guard: car moved {len:.2} m through a barrier, pushed back (total {})",
                stats.interventions
            );
            state.prev_center = Some(safe);
            continue;
        }
        state.prev_center = Some(cur);
    }
}
