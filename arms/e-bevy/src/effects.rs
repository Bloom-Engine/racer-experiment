//! Procedural effects: skid marks (pooled quads) and impact sparks.

use bevy::{
    light::{NotShadowCaster, NotShadowReceiver},
    prelude::*,
};

use crate::{
    game_state::AppState,
    vehicle::{Car, CarImpact, VehicleState, WHEEL_POS},
};

const SKID_POOL: usize = 360;
const SKID_SEGMENT: f32 = 0.7;
const SPARKS_PER_IMPACT: usize = 12;

#[derive(Resource)]
struct SkidPool {
    entities: Vec<Entity>,
    next: usize,
}

#[derive(Component, Default)]
struct SkidTrail {
    last: [Option<Vec3>; 2],
}

#[derive(Component)]
struct SkidMark;

#[derive(Component)]
struct Spark {
    vel: Vec3,
    life: f32,
}

#[derive(Resource)]
struct SparkAssets {
    mesh: Handle<Mesh>,
    material: Handle<StandardMaterial>,
}

/// Small xorshift PRNG (deterministic, no extra dependency).
#[derive(Resource)]
struct Rng(u32);

impl Rng {
    fn next_f32(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

pub struct EffectsPlugin;

impl Plugin for EffectsPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(Rng(0x9e37_79b9))
            .add_systems(Startup, setup_effects)
            .add_systems(
                Update,
                (add_trails, skid_marks, spawn_sparks, update_sparks)
                    .run_if(not(in_state(AppState::Loading))),
            )
            .add_systems(OnEnter(AppState::Countdown), clear_skids);
    }
}

fn setup_effects(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let quad = meshes.add(Plane3d::new(Vec3::Y, Vec2::splat(0.5)).mesh());
    let mat = materials.add(StandardMaterial {
        base_color: Color::srgba(0.03, 0.03, 0.03, 0.55),
        alpha_mode: AlphaMode::Blend,
        unlit: true,
        depth_bias: 50.0,
        ..default()
    });
    let entities = (0..SKID_POOL)
        .map(|_| {
            commands
                .spawn((
                    SkidMark,
                    Mesh3d(quad.clone()),
                    MeshMaterial3d(mat.clone()),
                    Transform::default(),
                    Visibility::Hidden,
                    NotShadowCaster,
                    NotShadowReceiver,
                ))
                .id()
        })
        .collect();
    commands.insert_resource(SkidPool { entities, next: 0 });

    commands.insert_resource(SparkAssets {
        mesh: meshes.add(Cuboid::new(0.06, 0.06, 0.25)),
        material: materials.add(StandardMaterial {
            base_color: Color::srgb(1.0, 0.7, 0.2),
            emissive: LinearRgba::rgb(12.0, 6.0, 1.0),
            unlit: true,
            ..default()
        }),
    });
}

fn add_trails(mut commands: Commands, cars: Query<Entity, (With<Car>, Without<SkidTrail>)>) {
    for e in &cars {
        commands.entity(e).insert(SkidTrail::default());
    }
}

fn clear_skids(pool: Res<SkidPool>, mut vis: Query<&mut Visibility, With<SkidMark>>) {
    for e in &pool.entities {
        if let Ok(mut v) = vis.get_mut(*e) {
            *v = Visibility::Hidden;
        }
    }
}

fn skid_marks(
    mut pool: ResMut<SkidPool>,
    mut cars: Query<(&Transform, &VehicleState, &mut SkidTrail), With<Car>>,
    mut marks: Query<(&mut Transform, &mut Visibility), (With<SkidMark>, Without<Car>)>,
) {
    for (tf, st, mut trail) in &mut cars {
        let marking = st.slip > 0.3 && st.grounded_wheels >= 3;
        for (k, wheel) in [2usize, 3].into_iter().enumerate() {
            if !marking {
                trail.last[k] = None;
                continue;
            }
            let local = Vec3::new(WHEEL_POS[wheel].x, 0.03, WHEEL_POS[wheel].z);
            let p = tf.transform_point(local);
            let Some(last) = trail.last[k] else {
                trail.last[k] = Some(p);
                continue;
            };
            let d = p - last;
            let len = d.length();
            if len < SKID_SEGMENT {
                continue;
            }
            trail.last[k] = Some(p);
            if len > 4.0 {
                continue; // teleported / reset
            }
            let e = pool.entities[pool.next];
            pool.next = (pool.next + 1) % pool.entities.len();
            if let Ok((mut mt, mut mv)) = marks.get_mut(e) {
                let up = tf.rotation * Vec3::Y;
                mt.translation = (p + last) * 0.5;
                mt.rotation = Transform::IDENTITY.looking_to(d, up).rotation;
                mt.scale = Vec3::new(0.24, 1.0, len + 0.05);
                *mv = Visibility::Inherited;
            }
        }
    }
}

fn spawn_sparks(
    mut commands: Commands,
    mut impacts: MessageReader<CarImpact>,
    assets: Res<SparkAssets>,
    mut rng: ResMut<Rng>,
    sparks: Query<(), With<Spark>>,
) {
    let mut budget = 80usize.saturating_sub(sparks.iter().count());
    for m in impacts.read() {
        if m.strength < 4.0 {
            continue;
        }
        for _ in 0..SPARKS_PER_IMPACT.min(budget) {
            budget -= 1;
            let dir =
                Vec3::new(rng.next_f32(), rng.next_f32().abs() + 0.3, rng.next_f32()).normalize();
            let vel = dir * (4.0 + m.strength * 0.6 * (rng.next_f32().abs() + 0.3));
            commands.spawn((
                Spark {
                    vel,
                    life: 0.35 + 0.3 * rng.next_f32().abs(),
                },
                Mesh3d(assets.mesh.clone()),
                MeshMaterial3d(assets.material.clone()),
                Transform::from_translation(m.position + Vec3::Y * 0.6).looking_to(vel, Vec3::Y),
                NotShadowCaster,
            ));
        }
    }
}

fn update_sparks(
    mut commands: Commands,
    time: Res<Time>,
    mut sparks: Query<(Entity, &mut Spark, &mut Transform)>,
) {
    let dt = time.delta_secs();
    for (e, mut s, mut t) in &mut sparks {
        s.life -= dt;
        if s.life <= 0.0 {
            commands.entity(e).despawn();
            continue;
        }
        s.vel.y -= 9.81 * dt;
        t.translation += s.vel * dt;
        t.scale = Vec3::splat((s.life * 3.0).min(1.0));
    }
}
