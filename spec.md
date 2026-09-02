## Overview
Route Maker 3d is an application that allows a user to create routes by interacting with a map. The map is in 3D, like Google Earth in that the user can view the globe.

## Tech stack

### Rendering engine: MapLibre GL JS

The globe is rendered with **MapLibre GL JS** (BSD-3-Clause), a vector-first WebGL map engine. It runs **fully token-free** on open tiles and DEM data — no mandatory API key or cloud account (unlike Mapbox/Google) — which is a hard requirement for this project. It provides the pieces this spec depends on:

* A 3D globe projection (v5+) with pitch/tilt, plus 3D terrain from DEM tiles (`raster-dem`, `terrarium` encoding), rendered together.
* **Vector basemap rendering**, so place-name labels are drawn as upright, screen-space GPU billboards that stay crisp and do **not** warp onto the terrain mesh when tilted — the whole basemap (fills, lines, labels) is live vector geometry rather than draped raster imagery. This is the decisive advantage over a draped-raster engine for a labeled 3D-terrain map.
* GeoJSON `line` layers that auto-drape onto terrain at a constant screen-space width, and screen-anchored markers — the primitives the route rendering relies on (see below).
* A built-in, Google-Earth-like camera controller (see *Camera controls*).

**Trade-offs accepted:** MapLibre's globe is an *adaptive* projection (a true 3D sphere zoomed out, transitioning toward Mercator as you zoom in) rather than a fixed WGS84 ellipsoid, and it has no native 3D Tiles / photorealistic-mesh support. Neither matters for route drawing on terrain. File formats (KML/GPX) are handled by the app's own serialization layer, independent of the renderer (see *Route persistence & interchange*), so MapLibre's lack of native format ingestion is not a cost here.

### Toolchain

* **Language:** TypeScript (matching the 2D reference project).
* **UI framework:** React — the app chrome (route list and actions, route-details editor, elevation-profile panel, layer control; see *UI*) is built as React components. MapLibre owns the WebGL canvas; React manages the surrounding UI and app state, via `react-map-gl` / `@vis.gl/react-maplibre` or a thin hand-rolled wrapper around a single `Map`.
* **Bundler / dev server:** Vite (`maplibre-gl` bundles cleanly; its worker is handled by the standard build).
* **Deployment:** GitHub Pages via the `gh-pages` npm package, mirroring the reference project's manual `npm run deploy` flow (build, then publish `dist/` to the `gh-pages` branch — no CI workflow).
  * Set Vite's `base` to the repo path (e.g. `base: '/route-maker-3d/'`) so built asset URLs are correct under the project Pages path — the analog of the reference project's Parcel `--public-url .`.
  * Scripts: `dev` (Vite dev server), `build` (Vite build → `dist/`), `deploy` (`gh-pages -d dist`), matching the reference layout.

### Elevation data

Elevation comes from **AWS Terrain Tiles** (Terrarium encoding) at `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. These are self-hostable / token-free, satisfying the no-token requirement. Each pixel decodes to meters via:

```
elevation = (red * 256 + green + blue / 256) - 32768
```

Tiles are in Web Mercator (EPSG:3857), addressed by `{z}/{x}/{y}`.

The elevation data serves two consumers: the **rendered terrain mesh** and the **elevation-profile feature**.

* **Terrain mesh:** MapLibre renders 3D terrain directly from a `raster-dem` source pointed at the Terrarium tiles, with `encoding: 'terrarium'` set explicitly (the default is `mapbox`; a wrong encoding silently yields wrong elevations). Enabled via `map.setTerrain({ source, exaggeration })`.
* **Elevation profile:** an **`ElevationSource`** module owns this, independent of MapLibre's render-time terrain (whose tile cache serves the camera, not our routes, and can drop/coarsen tiles as they scroll off-screen). It fetches Terrarium tiles, decodes them (RGB → meters, off the main thread where practical), caches the decoded height grids (keyed by `z/x/y`), and samples elevation at a route's points via **bilinear interpolation** across the four surrounding samples (reading neighboring tiles from cache at edges).

The elevation profile is a **visualization only** — it is not persisted with the route and not exported. This admits a simpler, camera-LOD-driven model rather than always fetching max-resolution data.

**Selecting a route for its profile fits the camera to the route's bounds**, which forces the covering tiles to load so the whole route is sampled (no gaps for off-screen portions).

**Monotonic refinement.** Sampling resolution follows whatever tile detail is available (camera-LOD, like Google Earth coarsening when zoomed out), but while the profile panel is open the profile may only get **finer, never coarser**:

* Each sample records the zoom of the tile it was read from. When higher-zoom tiles become available (e.g. the camera zooms into part of the route), affected samples are re-read and **upgraded**; when tiles are discarded or coarsened, the profile keeps its existing higher-resolution values. Resolution is a per-sample high-water mark.
* To guarantee a panned-away segment never *loses* resolution, the **tiles backing the current best-resolution samples of the active route are pinned** (non-evictable) in the `ElevationSource` cache for as long as the profile panel is open, and released when it closes. This is the key reason the profile uses our own cache rather than MapLibre's query: only a route-membership-keyed cache can pin by route (MapLibre's cache pins by what's on screen).
* Sampling density along the line is derived from route length and a target horizontal resolution, **capped at a maximum sample count**, so the profile stays a bounded, small array regardless of route length.

**Cache eviction.** Decoded height grids (a 256×256 tile ≈ 256 KB of floats) are held in an **LRU cache with a fixed budget** (by approximate bytes / tile count); unpinned grids beyond the budget are evicted least-recently-used. The active route's pinned tiles (above) are exempt while its profile panel is open. A very large route thus stays bounded in memory except for its own pinned covering tiles while being actively viewed; the density cap keeps that set reasonable.

### Base map & labels

The basemap is a **vector-tile style**, so labels are rendered by MapLibre as upright, screen-space text that stays crisp on tilted 3D terrain (no draped-raster warping). Basemaps are token-free. An on-map **layer control** lets the user choose between three layers; **Dark is the default**:

* **Dark** (default), **Light**, and **Standard** — free vector styles from OpenFreeMap (Dark / Positron / Bright respectively; open-licensed community styles, keyless). "Standard" is OSM Bright, the general-purpose full-color style. Switching styles is a `map.setStyle(...)` call.
* **Satellite** — a raster imagery layer (e.g. ESRI World Imagery via XYZ, attribution required) shown under a **whitelisted subset** of the Standard style's vector label layers, so labels remain upright and legible over imagery. The whitelist keys on OpenMapTiles source-layers (stable schema; fails safe if the style gains new layers): place names and water names — airports, POIs, road names/shields, and one-way arrows are excluded. A **density filter** further thins the remaining labels by inflating their collision boxes (`text-padding` raised from the default 2px to 16px), letting MapLibre's collision engine enforce the spacing.
* **Hybrid** — the same imagery base as Satellite, but overlaid with **roads** (the Standard style's transportation line layers, drawn at **50% opacity** so they read without hiding the imagery) and **all** of its labels, unfiltered (no whitelist or density filter). Road-name text (line-placed symbols) is re-styled for legibility over imagery — white with a dark halo (the source style's muted grey + transparent halo washes out over imagery). One-way arrows keep the source style's `icon-opacity` 0.5, matching the road opacity; road shields keep their own icon backgrounds and are unchanged.

Across **all basemaps**, along-road name repetition is thinned by raising `symbol-spacing` on road-name layers (distance between repeated name anchors along a road) from the style default of 250px to 500px; road shields (icon-backed) are unaffected.

Because labels come from the vector style itself, there is no separate label source to design or maintain. Minor known behaviors to watch: labels behind a hill can "show through" (mitigated with MapLibre's `text-occlusion-opacity`), and slight label pop-in as DEM tiles load.

A **hillshade overlay** (MapLibre's `hillshade` layer type, computed on the GPU from the same Terrarium DEM tiles as the terrain — token-free, no extra tile source) adds relief shading so mountain shapes read clearly where the basemap has no texture (undeveloped areas). It sits below the label layers and works over all three basemaps.

**3D buildings** are rendered with a `fill-extrusion` layer over the OpenMapTiles vector source the basemaps already load — the tiles carry per-building heights (`render_height` / `render_min_height`); the stock styles merely render them flat. No extra tile source or style is needed (OpenFreeMap's "3D" style is just this technique). Shown from zoom 14 — the tiles' building layer spans z13–14, but z13 carries only merged footprints (not useful), so only full-detail z14 buildings are displayed (beyond z14 the renderer overzooms). Colored to match the active basemap, below labels, toggleable (opacity 0.85). **Known limitation, accepted:** buildings occlude draped route lines passing behind or under them — with terrain enabled, draped layers are baked into the ground texture while extrusions are depth-tested 3D geometry, and neither layer order nor extrusion translucency lets the lines show through. Workaround: toggle 3D buildings off in the layers menu when tracing routes through dense areas.

The **sky** uses MapLibre's `sky` style property with a realistic gradient matched to the basemap: a **daytime** palette over Light and Satellite (deep azure zenith blending to pale haze at the horizon) and a **dusk** palette over Dark (indigo zenith with a muted amber horizon glow). Both blend fog into the ground and show the atmosphere halo when zoomed out to the globe (faded out at close zooms, and scaled down as camera pitch rises — at shallow angles the halo would otherwise cover most of the screen and obscure the globe).

### Route rendering (mapping requirements to MapLibre)

* **Line follows the Earth contour + constant on-screen width.** Each route is a GeoJSON `LineString` in a `line` layer. With terrain enabled, MapLibre auto-drapes lines onto the terrain so they follow the contour, and `line-width` is specified in screen pixels — giving constant on-screen width regardless of tilt or zoom. Long straight segments should be densified (interpolated vertices) so a segment between far-apart points doesn't cut through hills; watch for z-fighting flicker of co-planar draped lines at high exaggeration.
* **Point handles as on-screen circles.** Each route vertex is a screen-anchored handle — a `circle`-layer feature (or a draggable `Marker`) sized in screen pixels, so handles read as constant-size circles regardless of distance, matching the 2D editor's handles.
* **Multiple routes / editing / per-route style.** Each route is its own GeoJSON source + line/handle layers, so many routes render at once and can be toggled/edited independently, with per-route color and stroke width driven by feature/layer paint properties. Editing (click to append a vertex; drag a handle to move it) updates the source data via `getSource(id).setData(...)`; an existing editor such as **Terra Draw** (MapLibre adapter) is a candidate for the interaction layer. The route-creation tool is a mode toggled by a UI button (not always active); a route is finalized on save and remains editable afterward.

### Route persistence & interchange

File formats are a **serialization concern of the app, independent of the rendering engine.** The app owns an **internal route model** (ordered lon/lat vertices + per-route style: color, opacity, stroke width). All import/export converts between a file format and this model; the map library is only an instrument — it renders the model, and edits made on the map flow back into the model. Geometry is stored as **2D lon/lat** with no elevation: the model carries no elevation at all (it is a profile-only visualization derived on demand — see *Elevation data*), and draping onto terrain for display stays the renderer's job.

**KML/KMZ is the primary format** — it carries per-route style losslessly and matches the Google-Earth premise of the app. Import and export are hand-implemented against the internal model (a small XML read/write, e.g. via `@tmcw/togeojson` for parsing plus a matching writer), not delegated to the renderer:

* Each route ↔ a `<Placemark>` with a `<LineString>`; multiple routes group under a `<Document>`/`<Folder>`.
* Style ↔ a native `<LineStyle>` with `<color>` and `<width>`. KML color is **`aabbggrr`** (alpha, then blue-green-red — reverse of RGB); the serializer converts to/from our `#RRGGBB` + opacity.
* Coordinates are written as 2D lon/lat (no Z), consistent with the model; draping on display is left to the renderer.
* **KMZ** is a ZIP wrapping `doc.kml`; support reading both, export plain KML by default and KMZ when bundling is needed.

**GPX is a geometry interchange** for fitness/GPS tools. Exported GPX carries **geometry only** — route vertices as 2D lon/lat, consistent with the internal model. Elevation is not exported (`<ele>` is omitted): elevation in this app is a profile-only visualization derived on demand, not stored data (see *Elevation data*), so consumers re-derive it if needed. Styling (color/width) has no standard GPX representation and is likewise not exported. GPX **import** brings in geometry and assigns a default style. (Carries over the reference project's GPX import/export.)

### Camera controls

We use **MapLibre's built-in camera handlers**, which are Google-Earth-like by default:

* **Left drag** — pan.
* **Scroll / pinch** — zoom.
* **Right drag / Ctrl+left drag / two-finger drag** — rotate (bearing) and pitch.

`maxPitch` is set to **90°** so the camera can tilt all the way up to horizontal, but not above it (pitch is measured from straight-down = 0° to the horizon = 90°). Keyboard camera panning is out of scope (MapLibre's keyboard handler can be disabled).

## Reference project

There is already a basic 2D route maker at `../route-maker`. Features to bring in:
  * Mouse interaction mechanisms for route creation (clicking, dragging, keypress+click, etc.).
  * GPX import/export (as geometry — see *Tech stack → Route persistence & interchange*).

## UI

The app supports multiple routes at once. The core UI is a **route list** plus a set of actions, and a mutually-exclusive **view mode** vs. **create/edit mode**.

### Route list & selection

* A **list of all routes** is shown. Clicking a route in the list **selects** it; clicking a route on the map also selects it. Selection is shared — the two stay in sync, and at most one route is selected at a time.
* **Right-clicking a route in the list** selects it and opens a **context menu** of per-route actions:
  * **Edit** — enters **create/edit mode** on that route.
  * **Show Elevation Profile** — opens a **panel showing the route's elevation-profile graph** (see *Tech stack → Elevation data*; opening the panel is what fits the camera to the route bounds and begins profile computation).
  * **Export KML** — exports that route as a KML file.
  * **Export GPX** — exports that route as GPX (geometry only).
  * **Delete** — removes the route, after a confirmation prompt.
* Buttons alongside the list: **New Route** (enters create/edit mode on a fresh route — the tool is not always active) and **Import** (KML/KMZ/GPX; multiple files can be selected at once — failures are reported per file without blocking the rest).

### Create/edit mode

* While a route is being **created or edited**, the route list is **disabled** (no switching selection or acting on other routes), and a **route-details section** is shown for the route in progress, containing:
  * **Name**
  * **Color** — a color picker supporting **alpha/opacity**.
  * **Width** — stroke width.
* Editing the route geometry uses the map interaction mechanisms (click to add points, drag handles to move them; see *Reference project* and *Tech stack → Route rendering*).
* The mode ends on **Save** or **Cancel**:
  * **Save** — finalizes the route (geometry + details) and exits create/edit mode.
  * **Cancel** — discards changes made in this session and exits create/edit mode.
* On exit, the route list is re-enabled.

### Geolocate control

A **center-on-my-location button** (MapLibre's standard `GeolocateControl`) recenters the camera on the user's position (zoom ≈ 16, matching the 2D route maker's ⦿ control) and shows a location dot with an accuracy circle, tracking the position while active. Requires a secure context (localhost / HTTPS) and the user granting the browser's geolocation permission.

### Base map layer control

Map controls are arranged as a **single column at the top right** (layers control, then geolocate), keeping the bottom of the map clear for the elevation-profile panel.

A standard web-map **layers control** (collapsed button with a layers icon; expands on hover/click) switches the basemap between **Dark** (default), **Light**, **Standard**, **Satellite**, and **Hybrid** as radio options (see *Tech stack → Base map & labels*), and includes **Labels** (on by default) and **3D buildings** (off by default, since buildings occlude drawn routes — see *Base map & labels*) overlay checkboxes, a **Hillshade intensity slider** (0–100%, default 20%, driving the DEM-derived relief layer's `hillshade-exaggeration`; 0% hides the layer; right-click resets to 20%), and a **terrain exaggeration slider** (0×–3×, default 1×; right-click resets to 1×). Exaggeration is display-only — elevation profiles and queries stay true to the data.

## Misc details
* The route line should follow the contour of the Earth mesh. The line should appear at a constant width on the screen (i.e. unaffected by angle of viewing or distance from the camera). The handles at each point of the route (as in the 2D route maker) should also appear as circles on the screen. (Realized per *Tech stack → Route rendering*.)
* Camera controls are specified in *Tech stack → Camera controls*.
* Per-route color and stroke width persist via KML/KMZ (see *Tech stack → Route persistence & interchange*).