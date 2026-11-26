#!/usr/bin/env python3
"""Assemble assets/manifest.json from the build metadata and the files on disk."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "assets"
B = ROOT / "build"

VERSION = "1.0.0"


def load(name):
    return json.loads((B / name).read_text())


def r(x, nd=4):
    if isinstance(x, float):
        return round(x, nd)
    if isinstance(x, list):
        return [r(v, nd) for v in x]
    if isinstance(x, dict):
        return {k: r(v, nd) for k, v in x.items()}
    return x


def img_info(rel):
    with Image.open(A / rel) as im:
        return {"file": rel, "width": im.width, "height": im.height, "mode": im.mode}


def main():
    car = load("car_meta.json")
    trk = load("track_meta.json")
    sky = load("sky_meta.json")
    aud = load("audio_meta.json")
    ui = load("ui_meta.json")
    texm = load("texture_meta.json")

    sun_dir = sky["sun_direction"]
    light_dir = [-v for v in sun_dir]

    # ------------------------------------------------------------------ car
    variants = []
    for i, v in enumerate(car["variants"]):
        variants.append({
            "name": v, "khr_materials_variants_index": i, "material": f"car_paint_{v}",
            "albedo_texture": f"textures/car_body_{v}_albedo.png",
            "paint_color_srgb": texm["car_variants"][v]["paint_srgb"],
            "stripe_color_srgb": texm["car_variants"][v]["stripe_srgb"],
            "role": "player" if v == "red" else "opponent", "default": v == "red",
        })
    car_section = {
        "file": car["file"],
        "root_node": "car",
        "forward": [0, 0, -1], "up": [0, 1, 0], "right": [1, 0, 0],
        "origin": "ground level, centre of the wheelbase (midway between front and rear axle), centred left/right",
        "nodes": {
            "body": "body",
            "wheels": {k: {"node": k, "position": v["position"], "steers": k in ("wheel_FL", "wheel_FR"),
                           "driven": k in ("wheel_RL", "wheel_RR")} for k, v in car["wheels"].items()},
            "brake_lights": "brake_lights",
            "exhausts": {k: {"node": k, "position": v, "flow_direction_local": [0, 0, 1]} for k, v in car["exhausts"].items()},
            "collider": "collider_body",
        },
        "wheel_rotation": {
            "spin_axis_local": [1, 0, 0],
            "forward_rolling": "rotate about local +X by -distance/wheel_radius radians (top of the wheel moves towards -Z)",
            "steering": "rotate front wheel nodes about local +Y; positive = steer left",
            "note": "all four wheel nodes have identity rotation; left wheels use a mirrored mesh (wheel_left)",
        },
        "metrics": {
            "wheel_radius_m": car["wheel_radius_m"], "wheel_width_m": car["wheel_width_m"],
            "track_width_m": car["track_width_m"], "wheelbase_m": car["wheelbase_m"],
            "suggested_mass_kg": car["mass_kg"], "centre_of_mass_offset_m": car["centre_of_mass_offset_m"],
            "centre_of_mass_note": "relative to the car origin, in car-local axes",
            "body_dimensions_m": r(car["dimensions_m"], 3),
            "suggested_suspension_rest_length_m": 0.12,
            "suggested_max_speed_kmh": 260, "suggested_nitro_max_speed_kmh": 300,
        },
        "variants": variants,
        "variant_mechanism": ("KHR_materials_variants on the body paint primitive (default material car_paint_red); "
                              "engines without the extension can swap the baseColorTexture of material car_paint_red "
                              "to the variant's albedo_texture"),
        "materials": {
            "brake_light": {"material": "car_brake_light", "emissive_off": [0.35, 0.01, 0.005],
                            "emissive_on": [1.0, 0.04, 0.02], "emissive_strength_on": 4.0,
                            "note": "set emissiveFactor (and optionally KHR_materials_emissive_strength) at runtime when braking"},
            "headlight": {"material": "car_headlight", "emissive": [1.0, 0.97, 0.9]},
        },
        "collider": {"node": "collider_body", "type": "convex_hull", "triangles": car["triangles"]["collider_body"],
                     "hidden": True},
        "triangles": car["triangles"],
    }

    # ---------------------------------------------------------------- track
    first, last = trk["corners"][0], trk["corners"][-1]
    feats = [{"type": "start_finish_straight", "s_start": last["s_end"], "s_end": first["s_start"],
              "length_m": trk["length_m"] - last["s_end"] + first["s_start"],
              "note": "wraps through s=0 (the start/finish line): from the final corner exit to the first corner"}]
    s_sec = [c for c in trk["corners"] if c.get("s_section")]
    for c in trk["corners"]:
        if c["type"] in ("hairpin", "fast_sweeper"):
            feats.append({"type": c["type"], **{k: c[k] for k in ("s_start", "s_end", "s_apex", "direction", "angle_deg", "min_radius_m")}})
    if s_sec:
        feats.append({"type": "s_section", "s_start": s_sec[0]["s_start"], "s_end": s_sec[-1]["s_end"],
                      "corners": len(s_sec), "directions": [c["direction"] for c in s_sec]})
    h = trk["hill"]
    feats.append({"type": "hill", "s_start": h["s_start"], "s_end": h["s_end"], "s_crest": h["s_crest"],
                  "crest_elevation_m": h["crest_elevation_m"],
                  "note": f"elevation varies {h['lowest_elevation_m']:.1f} .. {h['crest_elevation_m']:.1f} m relative to the start line"})

    track_section = {
        "file": trk["file"],
        "root_node": "track",
        "length_m": trk["length_m"], "road_width_m": trk["road_width_m"], "kerb_width_m": trk["kerb_width_m"],
        "race_direction": "counter-clockwise seen from above; spawn/checkpoint empties face the race direction (local -Z)",
        "elevation_range_m": [trk["stats"]["elev_min"], trk["stats"]["elev_max"]],
        "max_grade_percent": trk["stats"]["max_grade_pct"],
        "min_corner_radius_m": trk["stats"]["min_radius_m"],
        "distance_parameter": "s = metres along the centreline from the start/finish line in race direction",
        "features": feats,
        "corners": trk["corners"],
        "nodes": {
            "visual": ["road", "kerbs", "barriers", "terrain"] + list(trk["scenery_groups"].keys()),
            "collision": {
                "col_road": {"surface": "asphalt", "suggested_friction": 1.0,
                             "description": "drivable surface: road + kerbs (kerbs flattened)"},
                "col_barriers": {"surface": "wall", "suggested_friction": 0.3, "height_m": trk["barrier_height_collision_m"],
                                 "description": "closed walls on both sides of the circuit, 4 m high (visual barrier 1 m)"},
                "col_terrain": {"surface": "offroad", "suggested_friction": 0.55, "suggested_rolling_drag": 3.0,
                                "description": "run-off (grass/gravel) between road edge and barriers, 3 cm below road level"},
            },
            "collision_hiding": ("collision nodes carry KHR_node_visibility {visible:false}, extras.collider=true and use "
                                 "material collider_invisible (baseColor alpha 0, alphaMode MASK) so they never render even "
                                 "in engines that ignore the extension; engines should not render them at all"),
        },
        "spawns": trk["spawns"],
        "spawn_note": "position = car origin (ground level, wheelbase centre); rotation turns the car's -Z forward into the race direction",
        "checkpoints": trk["checkpoints"],
        "checkpoint_note": ("cp_00 is the start/finish line. Trigger box: size [x across track, y up, z along track] in the "
                            "empty's local frame, centred at box_center_local (box bottom on the road surface). A lap "
                            "counts when cp_01..cp_NN were passed in order and then cp_00 is crossed."),
        "racing_line": {**trk["racing_line"], "format": "[{x,y,z,speed_kmh}] world space, y on the road surface, "
                        "first point at the start/finish line, closed loop (last point connects to the first)"},
        "minimap": {**trk["minimap"], "background": "transparent", "colors": {"road": "#FFFFFF", "outline": "#14161C",
                                                                              "start_line_and_direction": "#E61E1E"}},
        "terrain_bounds_xz": {"min_x": trk["terrain_bounds"][0], "min_z": trk["terrain_bounds"][1],
                              "max_x": trk["terrain_bounds"][2], "max_z": trk["terrain_bounds"][3]},
        "triangles": {"visual": trk["visual_triangles"], "collision": trk["collision_triangles"],
                      "visual_total": trk["visual_triangles_total"], "collision_total": trk["collision_triangles_total"],
                      "total": trk["visual_triangles_total"] + trk["collision_triangles_total"]},
        "draw_calls_static_visual": trk["draw_calls_static_visual"],
        "visual_materials": trk["unique_visual_materials"],
        "texture_reference": "track.glb and scenery.glb reference their textures as external files (../textures/*.png)",
    }

    # -------------------------------------------------------------- scenery
    protos = {}
    for pn, tris in trk["prototype_triangles"].items():
        protos[pn] = {"node": f"proto_{pn}", "triangles": tris, "instance_count": len(trk["instances"].get(pn, []))}
    scenery_section = {
        "file": trk["scenery_file"],
        "usage": ("track.glb already contains every scenery instance baked into the scenery_* nodes (merged by material, "
                  "static). For GPU instancing instead: hide/skip the scenery_* nodes of track.glb and instantiate the "
                  "proto_* nodes of scenery.glb with the transforms below (glTF TRS, world space)."),
        "prototype_front": "local -Z (printed faces of billboards/signs face -Z)",
        "prototypes": protos,
        "groups_in_track_glb": trk["scenery_groups"],
        "instances": trk["instances"],
        "instance_color_tint_note": "optional RGB multiplier applied to COLOR_0 for variation (trees)",
        "billboard_uv_rects": {k: {"uv_min": v[:2], "uv_max": v[2:]} for k, v in trk["billboard_uv_rects"].items()},
        "brands_note": "all brand names are invented for this project",
        "collision": "scenery has no colliders: everything stands behind the barriers (cones are decorative, on the run-off)",
    }

    # ---------------------------------------------------------- environment
    env = {
        "sky": {
            "background": {**img_info("sky/sky_equirect_2048x1024.png"), "projection": "equirectangular", "color_space": "sRGB"},
            "environment_lighting": {**img_info("sky/sky_env_256x128.png"), "projection": "equirectangular",
                                     "color_space": "sRGB", "note": "pre-blurred low-res version for IBL / ambient"},
            "mapping": ("u = 0.5 + atan2(dir.z, dir.x) / (2*pi); v = 0.5 - asin(dir.y) / pi (v=0 top). Identical to "
                        "three.js equirectangular mapping and Blender's default after glTF import; image centre = +X"),
        },
        "sun": {
            "direction": sun_dir, "direction_note": "unit vector from the scene TOWARDS the sun (world, glTF axes)",
            "light_direction": light_dir, "light_direction_note": "direction the light travels (for directional lights)",
            "azimuth_deg": sky["sun_azimuth_deg"], "elevation_deg": sky["sun_elevation_deg"],
            "azimuth_note": "measured in the x-z plane from +X towards +Z",
            "color_linear": sky["sun_color_linear"], "illuminance_lux": sky["sun_illuminance_lux"],
            "suggested_intensity_relative": 3.0,
        },
        "ambient": {"sky_color_linear": sky["sky_ambient_linear"], "ground_color_linear": [0.30, 0.33, 0.25],
                    "suggested_intensity_relative": 0.6},
        "fog": {"color_srgb": [0.72, 0.84, 0.96], "suggested_start_m": 250, "suggested_end_m": 1400},
    }

    # ------------------------------------------------------------- textures
    tex_list = []
    usage = {"asphalt": "road", "kerb": "kerbs", "grass": "terrain/run-off", "gravel": "gravel traps",
             "barrier": "barrier walls", "facade": "buildings"}
    for p in sorted((A / "textures").glob("*.png")):
        stem = p.stem
        base = stem.rsplit("_", 1)[0]
        kind = stem.rsplit("_", 1)[1]
        entry = img_info(f"textures/{p.name}")
        entry["map"] = kind
        entry["color_space"] = "sRGB" if kind == "albedo" else "linear"
        if base in texm["tile_metres"]:
            entry["tiling_metres"] = texm["tile_metres"][base]
            entry["usage"] = usage.get(base, base)
        elif base.startswith("car_body"):
            entry["usage"] = "car paint livery (u around body section, v along body)"
        elif base == "billboards":
            entry["usage"] = "billboard / sign atlas (see scenery.billboard_uv_rects)"
        if kind == "orm":
            entry["packing"] = "R=ambient occlusion, G=roughness, B=metallic"
        if kind == "normal":
            entry["convention"] = "tangent space, OpenGL / glTF (+Y up)"
        tex_list.append(entry)
    ground = {k: {m: f"textures/{k}_{m}.png" for m in ("albedo", "normal", "orm")} | {"tiling_metres": texm["tile_metres"][k]}
              for k in ("asphalt", "kerb", "grass", "gravel")}

    # ---------------------------------------------------------------- audio
    audio = {"format": {"wav": "PCM 16-bit, 44100 Hz, mono", "ogg": "Ogg Vorbis, 44100 Hz, mono"}, "sounds": aud,
             "engine_crossfade": {"layers": [{"sound": k, "base_rpm": aud[k]["base_rpm"]} for k in ("engine_idle", "engine_mid", "engine_high")],
                                  "note": "pitch each layer by current_rpm / base_rpm and crossfade between neighbours"}}

    # ------------------------------------------------------------------- ui
    ui_section = {"icons": ui, "icon_style": "flat, white (#FFFFFF) on transparent, 24x24 SVG view box",
                  "font": {"file": "ui/fonts/RussoOne-Regular.ttf", "family": "Russo One", "license": "SIL Open Font License 1.1",
                           "license_file": "ui/fonts/RussoOne-OFL.txt",
                           "copyright": "Copyright (c) 2011-2012, Jovanny Lemonad (jovanny.ru), with Reserved Font Name \"Russo\""}}

    # ---------------------------------------------------------------- files
    files = []
    for p in sorted(A.rglob("*")):
        if p.is_dir() or p.name in ("manifest.json", ".DS_Store") or p.parts[-2] == "reports":
            continue
        rel = p.relative_to(A).as_posix()
        if rel.startswith("previews/") or rel == "README.md":
            kind = "documentation"
        else:
            kind = {".glb": "model/gltf-binary", ".png": "image/png", ".svg": "image/svg+xml", ".wav": "audio/wav",
                    ".ogg": "audio/ogg", ".json": "application/json", ".ttf": "font/ttf", ".txt": "text/plain"}.get(p.suffix, "other")
        files.append({"path": rel, "type": kind, "bytes": p.stat().st_size,
                      "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})

    manifest = {
        "$schema": "./manifest.schema.json",
        "name": "race-assets",
        "version": VERSION,
        "description": "Procedural asset set for a small arcade racing game (stylised-realistic, bright daytime)",
        "rebuild_command": "make assets   (or: npm run assets)",
        "conventions": {
            "gltf_version": "2.0", "model_format": "glb", "units": "metre", "up_axis": "+Y", "forward_axis": "-Z",
            "handedness": "right", "pbr": "metallic-roughness",
            "texture_uv_origin": "top-left (glTF)", "normal_maps": "tangent space, OpenGL / glTF convention (+Y up)",
            "orm_packing": "R=ambient occlusion, G=roughness, B=metallic",
            "texture_sizes": "power of two, max 2048",
            "colliders": "hidden via KHR_node_visibility + extras.collider + invisible MASK material",
            "empties": "nodes without mesh, extras.empty=true",
        },
        "budgets": {
            "car_triangles_max": 25000, "car_triangles": car["triangles"]["visual_total"],
            "car_collider_triangles_max": 200, "car_collider_triangles": car["triangles"]["collider_body"],
            "track_scene_triangles_max": 300000,
            "track_scene_triangles": trk["visual_triangles_total"] + trk["collision_triangles_total"],
            "static_draw_calls_max": 40, "static_draw_calls": trk["draw_calls_static_visual"],
        },
        "car": car_section,
        "track": track_section,
        "scenery": scenery_section,
        "environment": env,
        "textures": {"ground_materials": ground, "all": tex_list},
        "audio": audio,
        "ui": ui_section,
        "previews": sorted(f"previews/{p.name}" for p in (A / "previews").glob("*.png")) if (A / "previews").exists() else [],
        "licenses": {
            "default": {"license": "CC0-1.0", "applies_to": "all models, textures, sky, audio, icons, data and previews",
                        "author": "procedurally generated by the scripts in /asset-src of this repository"},
            "exceptions": [{"path": "ui/fonts/RussoOne-Regular.ttf", "license": "OFL-1.1",
                            "license_file": "ui/fonts/RussoOne-OFL.txt",
                            "source": "https://github.com/google/fonts/tree/main/ofl/russoone"}],
            "third_party_assets": "none besides the font",
        },
        "files": files,
    }
    (A / "manifest.json").write_text(json.dumps(r(manifest, 5), indent=1, ensure_ascii=False) + "\n")
    print(f"  manifest: {len(files)} files listed")


if __name__ == "__main__":
    main()
