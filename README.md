# ArtCraft Pose Studio

Standalone browser pose studio for ArtCraft's Female Doll mannequin (migrated from PhotoCraft-work).

## Run
    python3 -m http.server 8010 --bind 127.0.0.1
    # open http://127.0.0.1:8010/

Save pose / Download posed model / Render image go to the browser's download folder.

## Layout
- `index.html`, `assets/` - app page, CSS, built `pose-app.js`
- `artcraft-engine/` - source (`browser/`), upstream ArtCraft pin, CLI; rebuild: `cd artcraft-engine && npm ci && npm run build:browser`
- `models/` - source GLBs; `poses/` - saved pose JSON; `exports/` - default standing pose loaded by the app
- `artcraft_cli.py`, `artcraft_mannequin.py`, `tests/`, `README-artcraft.md` - headless CLI
- `notes/interactive-viewer.md` - design notes and provenance/licenses
