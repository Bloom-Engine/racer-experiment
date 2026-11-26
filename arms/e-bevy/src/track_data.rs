//! Static track / car data parsed from `assets/manifest.json` and
//! `assets/track/racing_line.json`.
//!
//! Both files are embedded at compile time with `include_str!`. They are small
//! (≈230 kB together), which keeps the gameplay data available synchronously on
//! every platform (no async JSON asset loader, no platform-specific bundle paths)
//! while the heavy assets (glTF, textures, audio) still stream through the
//! `AssetServer`.

use bevy::prelude::*;
use serde::Deserialize;

const MANIFEST_JSON: &str = include_str!("../assets/manifest.json");
const RACING_LINE_JSON: &str = include_str!("../assets/track/racing_line.json");

#[derive(Deserialize)]
struct Manifest {
    car: CarJson,
    track: TrackJson,
    environment: EnvJson,
}

#[derive(Deserialize)]
struct CarJson {
    file: String,
    variants: Vec<VariantJson>,
    materials: CarMaterialsJson,
}

#[derive(Deserialize)]
struct VariantJson {
    name: String,
    albedo_texture: String,
    paint_color_srgb: [f32; 3],
}

#[derive(Deserialize)]
struct CarMaterialsJson {
    brake_light: BrakeLightJson,
}

#[derive(Deserialize)]
struct BrakeLightJson {
    emissive_off: [f32; 3],
    emissive_on: [f32; 3],
    emissive_strength_on: f32,
}

#[derive(Deserialize)]
struct TrackJson {
    file: String,
    length_m: f32,
    road_width_m: f32,
    spawns: Vec<NodeJson>,
    checkpoints: Vec<CheckpointJson>,
    minimap: MinimapJson,
}

#[derive(Deserialize)]
struct NodeJson {
    position: [f32; 3],
    rotation: [f32; 4],
}

#[derive(Deserialize)]
struct CheckpointJson {
    position: [f32; 3],
    rotation: [f32; 4],
    box_size: [f32; 3],
    box_center_local: [f32; 3],
}

#[derive(Deserialize)]
struct MinimapJson {
    file: String,
    image_size_px: [f32; 2],
    pixels_per_metre: f32,
    offset_px: [f32; 2],
}

#[derive(Deserialize)]
struct EnvJson {
    sky: SkyJson,
    sun: SunJson,
    ambient: AmbientJson,
    fog: FogJson,
}

#[derive(Deserialize)]
struct SkyJson {
    background: FileJson,
}

#[derive(Deserialize)]
struct FileJson {
    file: String,
}

#[derive(Deserialize)]
struct SunJson {
    light_direction: [f32; 3],
    color_linear: [f32; 3],
}

#[derive(Deserialize)]
struct AmbientJson {
    sky_color_linear: [f32; 3],
}

#[derive(Deserialize)]
struct FogJson {
    color_srgb: [f32; 3],
    suggested_start_m: f32,
    suggested_end_m: f32,
}

#[derive(Deserialize)]
struct LinePointJson {
    x: f32,
    y: f32,
    z: f32,
    speed_kmh: f32,
}

/// A checkpoint trigger box in world space.
#[derive(Clone, Debug)]
pub struct Checkpoint {
    pub position: Vec3,
    pub rotation: Quat,
    /// Box centre in the checkpoint's local frame.
    pub center_local: Vec3,
    /// Half size `[across, up, along]`.
    pub half_size: Vec3,
    /// Index of the nearest racing-line point.
    pub line_index: usize,
}

impl Checkpoint {
    /// Transform a world point into the box frame (relative to the box centre).
    pub fn to_local(&self, p: Vec3) -> Vec3 {
        self.rotation.inverse() * (p - self.position) - self.center_local
    }

    /// Did the segment `a -> b` cross the checkpoint plane in race direction
    /// (local −Z) inside the box's width/height?
    pub fn crossed(&self, a: Vec3, b: Vec3) -> bool {
        let la = self.to_local(a);
        let lb = self.to_local(b);
        if !(la.z >= 0.0 && lb.z < 0.0) {
            return false;
        }
        let t = la.z / (la.z - lb.z);
        let hit = la.lerp(lb, t);
        hit.x.abs() <= self.half_size.x && hit.y.abs() <= self.half_size.y
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LinePoint {
    pub pos: Vec3,
    /// Target speed from the speed profile, m/s.
    pub speed: f32,
    /// Cumulative distance from point 0, metres.
    pub s: f32,
    /// Unit tangent (race direction), horizontal.
    pub tangent: Vec3,
}

#[derive(Clone, Debug)]
pub struct CarVariant {
    pub name: String,
    pub albedo_texture: String,
    pub paint_color: Color,
}

/// All static data the game needs about the car, track and environment.
#[derive(Resource, Clone, Debug)]
pub struct TrackData {
    pub car_file: String,
    pub track_file: String,
    pub variants: Vec<CarVariant>,
    pub brake_emissive_off: LinearRgba,
    pub brake_emissive_on: LinearRgba,
    pub track_length: f32,
    pub road_width: f32,
    pub spawns: Vec<Transform>,
    pub checkpoints: Vec<Checkpoint>,
    pub line: Vec<LinePoint>,
    pub line_length: f32,
    pub minimap_file: String,
    pub minimap_size_px: Vec2,
    pub minimap_k: f32,
    pub minimap_offset: Vec2,
    pub sky_file: String,
    pub sun_direction: Vec3,
    pub sun_color: Color,
    pub ambient_color: Color,
    pub fog_color: Color,
    pub fog_start: f32,
    pub fog_end: f32,
}

fn v3(a: [f32; 3]) -> Vec3 {
    Vec3::from_array(a)
}

fn quat(a: [f32; 4]) -> Quat {
    Quat::from_xyzw(a[0], a[1], a[2], a[3]).normalize()
}

impl TrackData {
    pub fn load() -> Self {
        let m: Manifest =
            serde_json::from_str(MANIFEST_JSON).expect("assets/manifest.json is valid");
        let raw_line: Vec<LinePointJson> =
            serde_json::from_str(RACING_LINE_JSON).expect("racing_line.json is valid");

        // Racing line with cumulative distance and tangents (closed loop).
        let n = raw_line.len();
        let mut line: Vec<LinePoint> = raw_line
            .iter()
            .map(|p| LinePoint {
                pos: Vec3::new(p.x, p.y, p.z),
                speed: p.speed_kmh / 3.6,
                s: 0.0,
                tangent: Vec3::NEG_Z,
            })
            .collect();
        let mut s = 0.0;
        for i in 0..n {
            line[i].s = s;
            let next = line[(i + 1) % n].pos;
            let prev = line[(i + n - 1) % n].pos;
            let t = (next - prev) * Vec3::new(1.0, 0.0, 1.0);
            line[i].tangent = t.normalize_or(Vec3::NEG_Z);
            s += line[i].pos.distance(next);
        }
        let line_length = s;

        let nearest_line = |p: Vec3| -> usize {
            line.iter()
                .enumerate()
                .min_by(|a, b| {
                    a.1.pos
                        .distance_squared(p)
                        .total_cmp(&b.1.pos.distance_squared(p))
                })
                .map(|(i, _)| i)
                .unwrap_or(0)
        };

        let checkpoints = m
            .track
            .checkpoints
            .iter()
            .map(|c| {
                let position = v3(c.position);
                Checkpoint {
                    position,
                    rotation: quat(c.rotation),
                    center_local: v3(c.box_center_local),
                    half_size: v3(c.box_size) * 0.5,
                    line_index: nearest_line(position),
                }
            })
            .collect();

        let spawns = m
            .track
            .spawns
            .iter()
            .map(|s| Transform::from_translation(v3(s.position)).with_rotation(quat(s.rotation)))
            .collect();

        let bl = &m.car.materials.brake_light;
        let srgb = |c: [f32; 3]| Color::srgb(c[0], c[1], c[2]);
        let lin = |c: [f32; 3], k: f32| LinearRgba::rgb(c[0] * k, c[1] * k, c[2] * k);

        TrackData {
            car_file: m.car.file,
            track_file: m.track.file,
            variants: m
                .car
                .variants
                .into_iter()
                .map(|v| CarVariant {
                    name: v.name,
                    albedo_texture: v.albedo_texture,
                    paint_color: srgb(v.paint_color_srgb),
                })
                .collect(),
            brake_emissive_off: lin(bl.emissive_off, 1.0),
            brake_emissive_on: lin(bl.emissive_on, bl.emissive_strength_on),
            track_length: m.track.length_m,
            road_width: m.track.road_width_m,
            spawns,
            checkpoints,
            line,
            line_length,
            minimap_file: m.track.minimap.file,
            minimap_size_px: Vec2::from_array(m.track.minimap.image_size_px),
            minimap_k: m.track.minimap.pixels_per_metre,
            minimap_offset: Vec2::from_array(m.track.minimap.offset_px),
            sky_file: m.environment.sky.background.file,
            sun_direction: v3(m.environment.sun.light_direction).normalize(),
            sun_color: Color::linear_rgb(
                m.environment.sun.color_linear[0],
                m.environment.sun.color_linear[1],
                m.environment.sun.color_linear[2],
            ),
            ambient_color: Color::linear_rgb(
                m.environment.ambient.sky_color_linear[0],
                m.environment.ambient.sky_color_linear[1],
                m.environment.ambient.sky_color_linear[2],
            ),
            fog_color: srgb(m.environment.fog.color_srgb),
            fog_start: m.environment.fog.suggested_start_m,
            fog_end: m.environment.fog.suggested_end_m,
        }
    }

    /// Nearest racing-line index. With a hint, only a window around the hint is
    /// searched (cheap per-tick tracking); without one the whole line is scanned.
    pub fn nearest_line_index(&self, p: Vec3, hint: Option<usize>) -> usize {
        let n = self.line.len();
        let dist = |i: usize| self.line[i].pos.distance_squared(p);
        match hint {
            Some(h) => {
                let mut best = h % n;
                let mut best_d = dist(best);
                for off in 1..=24 {
                    for i in [(h + off) % n, (h + n - off) % n] {
                        let d = dist(i);
                        if d < best_d {
                            best = i;
                            best_d = d;
                        }
                    }
                }
                // Lost track of the car (teleport / reset): fall back to a full scan.
                if best_d > 40.0 * 40.0 {
                    self.nearest_line_index(p, None)
                } else {
                    best
                }
            }
            None => (0..n)
                .min_by(|&a, &b| dist(a).total_cmp(&dist(b)))
                .unwrap_or(0),
        }
    }

    /// Distance along the racing line of point `p`, given its nearest index.
    pub fn line_s(&self, p: Vec3, idx: usize) -> f32 {
        let lp = &self.line[idx];
        let along = (p - lp.pos).dot(lp.tangent);
        (lp.s + along).rem_euclid(self.line_length)
    }

    pub fn line_point(&self, i: usize) -> &LinePoint {
        &self.line[i % self.line.len()]
    }

    /// Pixel rectangle of the minimap image that contains the circuit (plus margin).
    pub fn minimap_track_rect(&self, margin_px: f32) -> Rect {
        let mut r = Rect::EMPTY;
        for lp in &self.line {
            r = r.union_point(self.world_to_minimap(lp.pos));
        }
        let r = r.inflate(margin_px);
        Rect::from_corners(r.min.max(Vec2::ZERO), r.max.min(self.minimap_size_px))
    }

    /// World XZ → minimap pixel coordinates (top-left origin).
    pub fn world_to_minimap(&self, p: Vec3) -> Vec2 {
        Vec2::new(p.x, p.z) * self.minimap_k + self.minimap_offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses() {
        let t = TrackData::load();
        assert_eq!(t.spawns.len(), 4);
        assert_eq!(t.checkpoints.len(), 16);
        assert!(t.line.len() > 200);
        assert!((t.line_length - 2210.0).abs() < 250.0);
        // checkpoint line indices are in race order
        for w in t.checkpoints.windows(2) {
            assert!(w[1].line_index > w[0].line_index);
        }
    }

    #[test]
    fn spawn_faces_race_direction() {
        let t = TrackData::load();
        let fwd = t.spawns[0].rotation * Vec3::NEG_Z;
        assert!(fwd.x > 0.99, "race starts towards +X, got {fwd}");
    }

    #[test]
    fn checkpoint_crossing() {
        let t = TrackData::load();
        let cp = &t.checkpoints[0];
        let fwd = cp.rotation * Vec3::NEG_Z;
        let p = cp.position + Vec3::Y;
        assert!(cp.crossed(p - fwd, p + fwd));
        assert!(
            !cp.crossed(p + fwd, p - fwd),
            "reverse crossing must not count"
        );
        let far = cp.rotation * Vec3::X * 40.0;
        assert!(!cp.crossed(p - fwd + far, p + fwd + far), "outside the box");
    }
}
