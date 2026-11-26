// Typed subset of assets/manifest.json that the game consumes.
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface CarVariant {
  name: string;
  material: string;
  albedo_texture: string;
  role: 'player' | 'opponent';
  default: boolean;
}

export interface SpawnDef {
  name: string;
  position: Vec3;
  rotation: Quat;
  forward: Vec3;
}

export interface CheckpointDef {
  name: string;
  index: number;
  position: Vec3;
  rotation: Quat;
  forward: Vec3;
  box_size: Vec3;
  box_center_local: Vec3;
}

export interface SoundDef {
  wav: string;
  ogg: string;
  loop: boolean;
  base_rpm?: number;
}

export interface Manifest {
  car: {
    file: string;
    metrics: {
      wheel_radius_m: number;
      wheelbase_m: number;
      track_width_m: number;
      suggested_mass_kg: number;
      body_dimensions_m: { length: number; width_body: number; height: number };
      suggested_max_speed_kmh: number;
      suggested_nitro_max_speed_kmh: number;
    };
    variants: CarVariant[];
    materials: {
      brake_light: { material: string; emissive_off: Vec3; emissive_on: Vec3; emissive_strength_on: number };
    };
  };
  track: {
    file: string;
    length_m: number;
    road_width_m: number;
    spawns: SpawnDef[];
    checkpoints: CheckpointDef[];
    racing_line: { file: string; points: number };
    minimap: {
      file: string;
      image_size_px: [number, number];
      pixels_per_metre: number;
      offset_px: [number, number];
      world_bounds: { min_x: number; max_x: number; min_z: number; max_z: number };
    };
  };
  environment: {
    sky: { background: { file: string }; environment_lighting: { file: string } };
    sun: { direction: Vec3; color_linear: Vec3; suggested_intensity_relative: number };
    ambient: { sky_color_linear: Vec3; ground_color_linear: Vec3; suggested_intensity_relative: number };
    fog: { color_srgb: Vec3; suggested_start_m: number; suggested_end_m: number };
  };
  audio: { sounds: Record<string, SoundDef> };
  ui: {
    icons: Record<string, { svg: string; png_64: string; png_128: string; png_256: string }>;
    font: { file: string; family: string };
  };
}

export interface RacingLinePoint {
  x: number;
  y: number;
  z: number;
  speed_kmh: number;
}
