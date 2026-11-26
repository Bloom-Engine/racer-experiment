"""Blender (headless) preview renderer.

    blender -b --factory-startup -P asset-src/render_previews.py -- [car] [track]

Imports the *exported* .glb files (so this also proves they load in a real
importer), lights them with the sky texture + sun from the manifest, and
writes assets/previews/*.png. Collision nodes are hidden.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
A = ROOT / "assets"
PREV = A / "previews"
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
WHAT = set(argv) or {"car", "track"}


def gl2bl(v):
    """glTF (x, y-up, z) -> Blender (x, -z, z-up)."""
    return Vector((v[0], -v[2], v[1]))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    try:
        sc.eevee.taa_render_samples = 32
        sc.eevee.use_shadows = True
    except AttributeError:
        pass
    return sc


def setup_world(sc, manifest, sky_strength=1.0, sun_strength=4.0):
    world = bpy.data.worlds.new("sky")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(A / manifest["environment"]["sky"]["background"]["file"]))
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = sky_strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    sun_cfg = manifest["environment"]["sun"]
    d = gl2bl(sun_cfg["direction"]).normalized()
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = sun_strength
    sun.color = sun_cfg["color_linear"]
    sun.angle = math.radians(1.5)
    ob = bpy.data.objects.new("sun", sun)
    ob.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    sc.collection.objects.link(ob)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.name.startswith(("collider", "col_")):
            o.hide_render = True
            o.hide_viewport = True
    return new


def camera(sc, loc, target, lens=50, ortho=None):
    cam = bpy.data.cameras.new("cam")
    cam.lens = lens
    cam.clip_end = 6000
    if ortho:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho
    ob = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    sc.camera = ob
    return ob


def render(sc, name, w, h):
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.render.filepath = str(PREV / name)
    bpy.ops.render.render(write_still=True)
    print("  preview", name)


def set_variant(objs, variant):
    """Swap the body paint material to another KHR_materials_variants material."""
    mat = bpy.data.materials.get(f"car_paint_{variant}")
    if mat is None:
        return
    for o in objs:
        if o.type != "MESH":
            continue
        for slot in o.material_slots:
            if slot.material and slot.material.name.startswith("car_paint_"):
                slot.material = mat


def car_previews(manifest):
    sc = reset()
    setup_world(sc, manifest)
    import_glb(A / manifest["car"]["file"])
    bpy.ops.mesh.primitive_plane_add(size=40)
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("ground")
    gm.use_nodes = True
    bsdf = gm.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.32, 0.33, 0.34, 1)
    bsdf.inputs["Roughness"].default_value = 0.8
    ground.data.materials.append(gm)
    tgt = (0, 0, 0.55)
    # Blender coords: car front is -Y_gl? glTF -Z (front) == Blender +Y
    views = {
        "car_front34.png": (5.2, 6.2, 1.9),
        "car_rear34.png": (-5.0, -6.4, 2.2),
        "car_side.png": (8.5, 0.0, 1.0),
    }
    for name, loc in views.items():
        camera(sc, loc, tgt, lens=50)
        render(sc, name, 1280, 720)
    # all four colour variants side by side
    for o in list(bpy.data.objects):          # clear camera + the single preview car
        if o.type in ("CAMERA", "MESH", "EMPTY") and o is not ground:
            bpy.data.objects.remove(o)
    for i, v in enumerate(manifest["car"]["variants"]):
        objs = import_glb(A / manifest["car"]["file"])
        for o in objs:
            if o.parent is None:
                o.location.x += (i - 1.5) * 3.0
        set_variant(objs, v["name"])
    camera(sc, (9.0, 10.5, 5.0), (0, 0, 0.3), lens=40)
    render(sc, "car_variants.png", 1600, 800)


def track_previews(manifest):
    sc = reset()
    setup_world(sc, manifest)
    import_glb(A / manifest["track"]["file"])
    mm = manifest["track"]["minimap"]
    b = mm["world_bounds"]
    cx, cz = (b["min_x"] + b["max_x"]) / 2, (b["min_z"] + b["max_z"]) / 2
    span = max(b["max_x"] - b["min_x"], b["max_z"] - b["min_z"])
    cam = camera(sc, gl2bl((cx, 900, cz)), gl2bl((cx, 0, cz)), ortho=span * 1.02)
    cam.data.clip_end = 3000
    render(sc, "track_top.png", 1600, 1600)
    bpy.data.objects.remove(cam)
    # start grid: place the four car variants on the spawns, camera behind/above spawn 4
    spawns = manifest["track"]["spawns"]
    for sp, v in zip(spawns, manifest["car"]["variants"]):
        objs = import_glb(A / manifest["car"]["file"])
        root = [o for o in objs if o.parent is None][0]
        root.location = gl2bl(sp["position"])
        root.rotation_mode = "XYZ"
        root.rotation_euler = (0, 0, math.radians(sp["yaw_deg"]))
        set_variant(objs, v["name"])
    last = spawns[-1]
    fwd = Vector(last["forward"])
    pos = Vector(last["position"]) - fwd * 9.0 + Vector((0, 3.2, 0))
    tgt = Vector(spawns[0]["position"]) + fwd * 25.0
    cam = camera(sc, gl2bl(pos), gl2bl(tgt), lens=28)
    render(sc, "track_start_grid.png", 1600, 900)
    bpy.data.objects.remove(cam)
    # hairpin overview: elevated, from the outside of the corner
    rl = json.loads((A / manifest["track"]["racing_line"]["file"]).read_text())
    hp = [f for f in manifest["track"]["features"] if f["type"] == "hairpin"][0]
    i = int(round(hp["s_apex"] / manifest["track"]["racing_line"]["spacing_m"])) % len(rl)
    apex = Vector((rl[i]["x"], rl[i]["y"], rl[i]["z"]))
    before = Vector((rl[i - 12]["x"], rl[i - 12]["y"], rl[i - 12]["z"]))
    approach = Vector((apex.x - before.x, 0, apex.z - before.z)).normalized()
    cam_pos = apex - approach * 110 + Vector((0, 45, 0))      # behind the approaching cars, elevated
    camera(sc, gl2bl(cam_pos), gl2bl(apex), lens=35)
    render(sc, "track_hairpin.png", 1600, 900)


def main():
    manifest = json.loads((A / "manifest.json").read_text())
    PREV.mkdir(parents=True, exist_ok=True)
    if "car" in WHAT:
        car_previews(manifest)
    if "track" in WHAT:
        track_previews(manifest)


main()
