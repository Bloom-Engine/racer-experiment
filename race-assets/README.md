# race-assets

Reproducible, procedurally generated asset set for a small arcade racing game: car, circuit, scenery, sky,
audio, UI icons, manifest. See **[assets/README.md](assets/README.md)** for contents and conventions.

```sh
make assets      # or: npm run assets — rebuilds ./assets from scratch, validates and verifies
```

* `asset-src/` — all generator scripts (Python + numpy for content, Node for the Khronos glTF validator and the
  JSON-Schema check, headless Blender for preview renders only)
* `asset-src/vendor/fonts/russo-one/` — the only third-party input (Russo One, SIL OFL 1.1)
* `assets/` — generated output (committed so downstream projects can use it without the toolchain)

Requirements: Python ≥ 3.10 + `pip install -r asset-src/requirements.txt`, Blender ≥ 4.2, Node ≥ 18.
