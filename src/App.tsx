import { useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import MapView from './map/MapView';
import ProfilePanel from './components/ProfilePanel';
import { ElevationSource } from './elevation/ElevationSource';
import { newRoute, type LonLat, type Route } from './model';
import { densify, routeLength } from './geo';
import { kmlToRoutes, kmzToRoutes, routesToKml } from './io/kml';
import { gpxToRoutes, routeToGpx } from './io/gpx';
import type { BasemapKind } from './map/basemaps';

interface EditingState {
  draft: Route;
  isNew: boolean;
  /**
   * The active point ("previous point" in the 2D editor): new points insert
   * after it, and right-click deletes it. -1 = none.
   */
  activeIndex: number;
}

function download(name: string, data: string | Uint8Array, mime: string) {
  const blob = new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKind>('dark');
  const [map, setMap] = useState<MLMap | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const elevationSource = useMemo(() => new ElevationSource(), []);

  const selectedRoute = routes.find((r) => r.id === selectedId) ?? null;

  // routes to display: editing draft replaces its original / is appended
  const displayRoutes = useMemo(() => {
    if (!editing) return routes;
    const others = routes.filter((r) => r.id !== editing.draft.id);
    return [...others, editing.draft];
  }, [routes, editing]);

  const routesFC = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: displayRoutes
        .filter((r) => r.points.length >= 2)
        .map(
          (r): Feature => ({
            type: 'Feature',
            properties: {
              id: r.id,
              color: r.color,
              opacity: r.opacity,
              width: r.width,
            },
            geometry: {
              type: 'LineString',
              coordinates: densify(r.points),
            },
          }),
        ),
    }),
    [displayRoutes],
  );

  const handlesFC = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: editing
        ? editing.draft.points.map(
            (p, index): Feature => ({
              type: 'Feature',
              properties: {
                index,
                color: editing.draft.color,
                active: index === editing.activeIndex,
              },
              geometry: { type: 'Point', coordinates: p },
            }),
          )
        : [],
    }),
    [editing],
  );

  // --- create/edit mode ---

  const startNew = () => {
    setProfileOpen(false);
    setEditing({
      draft: newRoute(`Route ${routes.length + 1}`),
      isNew: true,
      activeIndex: -1,
    });
  };

  const startEdit = () => {
    if (!selectedRoute) return;
    setProfileOpen(false);
    setEditing({
      draft: structuredClone(selectedRoute),
      isNew: false,
      activeIndex: selectedRoute.points.length - 1,
    });
  };

  const updateDraft = (patch: Partial<Route>) =>
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));

  /** Insert after the active point; the new point becomes active. */
  const addPoint = (p: LonLat) =>
    setEditing((e) => {
      if (!e) return e;
      const points = e.draft.points.slice();
      const at = e.activeIndex + 1;
      points.splice(at, 0, p);
      return { ...e, activeIndex: at, draft: { ...e.draft, points } };
    });

  const selectHandle = (index: number) =>
    setEditing((e) => (e ? { ...e, activeIndex: index } : e));

  const moveHandle = (index: number, p: LonLat) =>
    setEditing((e) => {
      if (!e) return e;
      const points = e.draft.points.slice();
      points[index] = p;
      return { ...e, draft: { ...e.draft, points } };
    });

  /** Delete the active point; its predecessor becomes active (2D editor semantics). */
  const deleteActive = () =>
    setEditing((e) => {
      if (!e || e.activeIndex < 0) return e;
      const points = e.draft.points.filter((_, i) => i !== e.activeIndex);
      const activeIndex =
        e.activeIndex > 0 ? e.activeIndex - 1 : points.length ? 0 : -1;
      return { ...e, activeIndex, draft: { ...e.draft, points } };
    });

  /** Reverse route direction; the active point follows its point. */
  const reverse = () =>
    setEditing((e) => {
      if (!e || e.draft.points.length < 2) return e;
      return {
        ...e,
        activeIndex:
          e.activeIndex >= 0 ? e.draft.points.length - 1 - e.activeIndex : -1,
        draft: { ...e.draft, points: e.draft.points.slice().reverse() },
      };
    });

  const save = () => {
    if (!editing) return;
    const { draft, isNew } = editing;
    setRoutes((rs) =>
      isNew ? [...rs, draft] : rs.map((r) => (r.id === draft.id ? draft : r)),
    );
    setSelectedId(draft.id);
    setEditing(null);
  };

  const cancel = () => setEditing(null);

  // --- selection ---

  const select = (id: string | null) => {
    if (editing) return; // list & selection disabled while editing
    setSelectedId(id);
    if (id === null) setProfileOpen(false);
  };

  // --- import/export ---

  const onImportFile = async (file: File) => {
    try {
      const name = file.name.toLowerCase();
      let imported: Omit<Route, 'id'>[];
      if (name.endsWith('.kmz')) {
        imported = kmzToRoutes(await file.arrayBuffer());
      } else if (name.endsWith('.kml')) {
        imported = kmlToRoutes(await file.text());
      } else if (name.endsWith('.gpx')) {
        imported = gpxToRoutes(await file.text());
      } else {
        throw new Error('Unsupported file type (use .kml, .kmz, or .gpx)');
      }
      const withIds = imported.map((r) => ({ ...r, id: crypto.randomUUID() }));
      setRoutes((rs) => [...rs, ...withIds]);
      if (withIds.length) setSelectedId(withIds[withIds.length - 1].id);
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const exportKml = () =>
    download('routes.kml', routesToKml(routes), 'application/vnd.google-earth.kml+xml');

  const exportGpx = () => {
    if (!selectedRoute) return;
    const safe = selectedRoute.name.replace(/[^\w-]+/g, '_') || 'route';
    download(`${safe}.gpx`, routeToGpx(selectedRoute), 'application/gpx+xml');
  };

  const listDisabled = editing !== null;

  return (
    <div id="app">
      <aside className="sidebar">
        <h1>Route Maker 3D</h1>

        <div className={`list-section${listDisabled ? ' disabled' : ''}`}>
          <button className="primary" onClick={startNew} disabled={listDisabled}>
            + New Route
          </button>

          <ul className="route-list">
            {routes.length === 0 && <li className="empty">No routes yet</li>}
            {routes.map((r) => (
              <li
                key={r.id}
                className={r.id === selectedId ? 'selected' : ''}
                onClick={() => select(r.id)}
              >
                <span
                  className="swatch"
                  style={{ background: r.color, opacity: r.opacity }}
                />
                <span className="route-name">{r.name}</span>
              </li>
            ))}
          </ul>

          <div className="button-row">
            <button onClick={startEdit} disabled={listDisabled || !selectedRoute}>
              Edit
            </button>
            <button
              className={profileOpen ? 'active' : ''}
              onClick={() => setProfileOpen((v) => !v)}
              disabled={listDisabled || !selectedRoute}
            >
              Show Elevation Profile
            </button>
          </div>

          <div className="button-row">
            <button onClick={() => fileInputRef.current?.click()} disabled={listDisabled}>
              Import
            </button>
            <button onClick={exportKml} disabled={listDisabled || routes.length === 0}>
              Export KML
            </button>
            <button onClick={exportGpx} disabled={listDisabled || !selectedRoute}>
              Export GPX
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".kml,.kmz,.gpx"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {editing && (
          <div className="details-section">
            <h2>{editing.isNew ? 'New route' : 'Edit route'}</h2>
            <p className="hint">
              Click to add a point after the active (green) point. Click a point to
              make it active; drag to move it (hold Ctrl/Cmd to snap to another
              point). Ctrl/Cmd+click a point to add a new point on top of it.
              Right-click to delete the active point.
            </p>
            <p className="distance">
              {(routeLength(editing.draft.points) / 1000).toFixed(2)} km ·{' '}
              {(routeLength(editing.draft.points) / 1609.344).toFixed(2)} mi
            </p>
            <label>
              Name
              <input
                type="text"
                value={editing.draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </label>
            <label>
              Color
              <span className="color-row">
                <input
                  type="color"
                  value={editing.draft.color}
                  onChange={(e) => updateDraft({ color: e.target.value })}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(editing.draft.opacity * 100)}
                  onChange={(e) =>
                    updateDraft({ opacity: Number(e.target.value) / 100 })
                  }
                />
                <span className="opacity-label">
                  {Math.round(editing.draft.opacity * 100)}%
                </span>
              </span>
            </label>
            <label>
              Width
              <input
                type="number"
                min={1}
                max={20}
                value={editing.draft.width}
                onChange={(e) =>
                  updateDraft({ width: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </label>
            <button onClick={reverse} disabled={editing.draft.points.length < 2}>
              Reverse
            </button>
            <div className="button-row">
              <button
                className="primary"
                onClick={save}
                disabled={editing.draft.points.length < 2}
                title={
                  editing.draft.points.length < 2
                    ? 'Add at least 2 points'
                    : undefined
                }
              >
                Save
              </button>
              <button onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}
      </aside>

      <div className="map-wrap">
        <MapView
          basemap={basemap}
          routesFC={routesFC}
          handlesFC={handlesFC}
          selectedId={selectedId}
          editing={editing !== null}
          onReady={setMap}
          onSelect={select}
          onAddPoint={addPoint}
          onSelectHandle={selectHandle}
          onMoveHandle={moveHandle}
          onDeleteActive={deleteActive}
        />

        <div className="layer-control">
          {(['dark', 'light', 'satellite'] as const).map((k) => (
            <button
              key={k}
              className={basemap === k ? 'active' : ''}
              onClick={() => setBasemap(k)}
            >
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>

        {profileOpen && selectedRoute && !editing && map && (
          <ProfilePanel
            key={selectedRoute.id}
            route={selectedRoute}
            map={map}
            elevationSource={elevationSource}
            onClose={() => setProfileOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
