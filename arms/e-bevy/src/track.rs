//! Track scene, static colliders, sky and lighting.

use avian3d::prelude::*;
use bevy::{
    asset::RenderAssetUsages,
    light::{CascadeShadowConfigBuilder, NotShadowCaster, NotShadowReceiver},
    mesh::{Indices, PrimitiveTopology},
    prelude::*,
    world_serialization::WorldInstanceReady,
};

use crate::{
    game_state::{AppState, DebugOpts},
    physics::{Layer, Surface},
    track_data::TrackData,
    vehicle::{CarsSpawned, spawn_cars},
};

#[derive(Component)]
pub struct TrackRoot;

/// Sky dome, follows the active camera.
#[derive(Component)]
pub struct SkyDome;

/// Set when the track colliders have been built.
#[derive(Resource, Default)]
pub struct TrackReady(pub bool);

pub const SKY_RADIUS: f32 = 2600.0;

pub struct TrackPlugin;

impl Plugin for TrackPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TrackReady>()
            .add_systems(Startup, setup_environment)
            .add_observer(on_track_ready)
            .add_systems(Update, finish_loading.run_if(in_state(AppState::Loading)))
            .add_systems(
                PostUpdate,
                follow_sky
                    .after(crate::camera::update_camera)
                    .before(TransformSystems::Propagate),
            );
    }
}

fn setup_environment(
    mut commands: Commands,
    assets: Res<AssetServer>,
    track: Res<TrackData>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // Sun. The manifest suggests 100 klx; Bevy's default camera exposure is
    // calibrated for much lower values, so we use a relative intensity.
    let mobile = cfg!(target_os = "ios") || cfg!(target_os = "android");
    commands.spawn((
        DirectionalLight {
            color: track.sun_color,
            illuminance: 9_000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::default().looking_to(track.sun_direction, Vec3::Y),
        CascadeShadowConfigBuilder {
            num_cascades: if mobile { 1 } else { 2 },
            minimum_distance: 0.5,
            first_cascade_far_bound: 30.0,
            maximum_distance: if mobile { 60.0 } else { 140.0 },
            overlap_proportion: 0.2,
        }
        .build(),
    ));
    commands.insert_resource(GlobalAmbientLight {
        color: track.ambient_color,
        brightness: 1400.0,
        ..default()
    });

    // Sky dome with the manifest's equirectangular mapping.
    let sky_tex = assets.load(track.sky_file.clone());
    commands.spawn((
        SkyDome,
        Mesh3d(meshes.add(sky_dome_mesh(SKY_RADIUS, 48, 24))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color_texture: Some(sky_tex),
            unlit: true,
            fog_enabled: false,
            cull_mode: None,
            ..default()
        })),
        Transform::default(),
        NotShadowCaster,
        NotShadowReceiver,
    ));

    commands.spawn((
        TrackRoot,
        WorldAssetRoot(assets.load(GltfAssetLabel::Scene(0).from_asset(track.track_file.clone()))),
    ));
}

/// UV sphere whose UVs follow the asset README mapping:
/// `u = 0.5 + atan2(d.z, d.x) / 2π`, `v = 0.5 − asin(d.y) / π`.
/// Iterating the longitude from −π to π keeps `u` monotonic, so there is no seam.
pub fn sky_dome_mesh(radius: f32, segments: u32, rings: u32) -> Mesh {
    use std::f32::consts::PI;
    let mut positions = Vec::new();
    let mut uvs = Vec::new();
    let mut normals = Vec::new();
    for r in 0..=rings {
        let lat = PI / 2.0 - PI * r as f32 / rings as f32; // +90° .. -90°
        for s in 0..=segments {
            let phi = -PI + 2.0 * PI * s as f32 / segments as f32;
            let d = Vec3::new(lat.cos() * phi.cos(), lat.sin(), lat.cos() * phi.sin());
            positions.push((d * radius).to_array());
            normals.push((-d).to_array());
            uvs.push([0.5 + phi / (2.0 * PI), 0.5 - lat / PI]);
        }
    }
    let mut indices = Vec::new();
    let w = segments + 1;
    for r in 0..rings {
        for s in 0..segments {
            let a = r * w + s;
            let b = a + w;
            indices.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::RENDER_WORLD,
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, normals)
    .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, uvs)
    .with_inserted_indices(Indices::U32(indices))
}

/// When the track glTF is instantiated: build static trimesh colliders from the
/// hidden `col_*` nodes and hide them. (Bevy does not implement
/// `KHR_node_visibility`, so the nodes would otherwise be drawn with the
/// invisible material, costing three extra draw calls.)
fn on_track_ready(
    ready: On<WorldInstanceReady>,
    roots: Query<(), With<TrackRoot>>,
    children: Query<&Children>,
    names: Query<&Name>,
    mesh_q: Query<&Mesh3d>,
    meshes: Res<Assets<Mesh>>,
    mut commands: Commands,
    mut track_ready: ResMut<TrackReady>,
) {
    if roots.get(ready.entity).is_err() {
        return;
    }
    let mut built = 0;
    for node in children.iter_descendants(ready.entity) {
        let Ok(name) = names.get(node) else { continue };
        let (surface, layer, friction) = match name.as_str() {
            "col_road" => (Surface::Road, Layer::Road, 1.0),
            "col_terrain" => (Surface::Offroad, Layer::Offroad, 0.55),
            "col_barriers" => (Surface::Barrier, Layer::Barrier, 0.05),
            _ => continue,
        };
        commands.entity(node).insert(Visibility::Hidden);
        // The node itself or its primitive children carry the meshes.
        let targets: Vec<Entity> = std::iter::once(node)
            .chain(children.iter_descendants(node))
            .filter(|e| mesh_q.get(*e).is_ok())
            .collect();
        for e in targets {
            let Ok(m) = mesh_q.get(e) else { continue };
            let Some(mesh) = meshes.get(&m.0) else {
                error!("collision mesh for {name} not loaded");
                continue;
            };
            let Some(collider) = Collider::trimesh_from_mesh(mesh) else {
                error!("could not build trimesh collider for {name}");
                continue;
            };
            commands.entity(e).insert((
                RigidBody::Static,
                collider,
                CollisionLayers::new(layer, [Layer::Car]),
                Friction::new(friction).with_combine_rule(CoefficientCombine::Min),
                Restitution::new(0.1),
                surface,
            ));
            built += 1;
        }
    }
    info!("track ready: {built} static colliders");
    track_ready.0 = built >= 3;
}

fn finish_loading(
    track_ready: Res<TrackReady>,
    mut spawned: ResMut<CarsSpawned>,
    mut commands: Commands,
    assets: Res<AssetServer>,
    track: Res<TrackData>,
    mut next: ResMut<NextState<AppState>>,
    opts: Res<DebugOpts>,
    mut frames: Local<u32>,
) {
    if !track_ready.0 {
        return;
    }
    if !spawned.0 {
        spawn_cars(&mut commands, &assets, &track);
        spawned.0 = true;
        return;
    }
    // Give the colliders a couple of frames to enter the physics world.
    *frames += 1;
    if *frames > 3 {
        next.set(if opts.autostart || opts.test.is_some() {
            AppState::Countdown
        } else {
            AppState::Menu
        });
    }
}

fn follow_sky(
    cams: Query<&Transform, (With<Camera3d>, Without<SkyDome>)>,
    mut sky: Query<&mut Transform, With<SkyDome>>,
) {
    let Some(cam) = cams.iter().next() else {
        return;
    };
    for mut t in &mut sky {
        t.translation = cam.translation;
    }
}
