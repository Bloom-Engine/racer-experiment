# Rebuild every asset in ./assets from scratch:   make assets   (or: npm run assets)
PY      ?= python3
BLENDER ?= blender
NODE    ?= node

.PHONY: assets clean check-tools validate verify previews

assets: check-tools node_modules
	rm -rf assets build
	mkdir -p assets build
	$(PY) asset-src/build_textures.py
	$(PY) asset-src/build_sky.py
	$(PY) asset-src/build_audio.py
	$(PY) asset-src/build_ui.py
	$(PY) asset-src/build_car.py
	$(PY) asset-src/build_track.py
	cp asset-src/manifest.schema.json assets/manifest.schema.json
	cp asset-src/ASSETS_README.md assets/README.md
	$(PY) asset-src/build_manifest.py
	$(MAKE) previews
	$(PY) asset-src/build_manifest.py
	$(MAKE) validate verify

previews:
	@echo "  rendering previews with Blender (log: build/blender.log)"
	@$(BLENDER) -b --factory-startup -P asset-src/render_previews.py > build/blender.log 2>&1 \
		|| (tail -30 build/blender.log; exit 1)
	@grep "  preview" build/blender.log

validate: node_modules
	$(NODE) asset-src/validate.mjs

verify:
	$(PY) asset-src/verify.py

node_modules: package.json
	npm install --no-fund --no-audit
	@touch node_modules

check-tools:
	@$(PY) -c "import numpy, scipy, PIL, soundfile" 2>/dev/null || \
		(echo "need Python 3 with numpy, scipy, Pillow, soundfile:  pip install -r asset-src/requirements.txt"; exit 1)
	@command -v $(BLENDER) >/dev/null || (echo "need Blender >= 4.2 on PATH (or BLENDER=/path/to/blender)"; exit 1)
	@command -v $(NODE) >/dev/null || (echo "need Node.js >= 18"; exit 1)

clean:
	rm -rf assets build
