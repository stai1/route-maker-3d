import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import MapView from './map/MapView';
import LayerMenu from './components/LayerMenu';
import ProfilePanel from './components/ProfilePanel';
import SettingsModal from './components/SettingsModal';
import { formatDistance, loadSettings, saveSettings, type Settings } from './units';
import { ElevationSource } from './elevation/ElevationSource';
import { newRoute, type LonLat, type Route } from './model';
import { cumulativeDistances, densify, routeLength, slicePolyline } from './geo';
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
  const [showLabels, setShowLabels] = useState(true);
  const [hillshade, setHillshade] = useState(0.2);
  const [buildings, setBuildings] = useState(false);
  const [exaggeration, setExaggeration] = useState(1);
  const [map, setMap] = useState<MLMap | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    routeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Profile range selection, meters along the selected route. */
  const [profileSelection, setProfileSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  /** Route position under the profile-graph cursor. */
  const [profileHover, setProfileHover] = useState<LonLat | null>(null);

  // selection is scoped to the open profile of the selected route
  useEffect(() => {
    setProfileSelection(null);
  }, [selectedId, profileOpen]);

  const updateSettings = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };
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

  // bolded sub-route on the map for the profile's range selection
  const selectionFC = useMemo<FeatureCollection>(() => {
    if (!profileSelection || !selectedRoute || selectedRoute.points.length < 2) {
      return { type: 'FeatureCollection', features: [] };
    }
    const cum = cumulativeDistances(selectedRoute.points);
    const seg = slicePolyline(
      selectedRoute.points,
      cum,
      profileSelection.start,
      profileSelection.end,
    );
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            color: selectedRoute.color,
            opacity: selectedRoute.opacity,
            width: selectedRoute.width,
          },
          geometry: { type: 'LineString', coordinates: densify(seg) },
        },
      ],
    };
  }, [profileSelection, selectedRoute]);

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

  const startEdit = (route: Route) => {
    setProfileOpen(false);
    setSelectedId(route.id);
    setEditing({
      draft: structuredClone(route),
      isNew: false,
      activeIndex: route.points.length - 1,
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
    // map clicks never close an open profile: ignore empty-map deselects
    if (id === null && profileOpen) return;
    setSelectedId(id);
    if (id === null) setProfileOpen(false);
  };

  // --- import/export ---

  const onImportFiles = async (files: File[]) => {
    const withIds: Route[] = [];
    const failures: string[] = [];
    for (const file of files) {
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
          throw new Error('unsupported file type (use .kml, .kmz, or .gpx)');
        }
        withIds.push(...imported.map((r) => ({ ...r, id: crypto.randomUUID() })));
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (withIds.length) {
      setRoutes((rs) => [...rs, ...withIds]);
      setSelectedId(withIds[withIds.length - 1].id);
    }
    if (failures.length) {
      alert(`Import failed for:\n${failures.join('\n')}`);
    }
  };

  const safeName = (route: Route) => route.name.replace(/[^\w-]+/g, '_') || 'route';

  const exportKml = (route: Route) =>
    download(
      `${safeName(route)}.kml`,
      routesToKml([route]),
      'application/vnd.google-earth.kml+xml',
    );

  const exportGpx = (route: Route) =>
    download(`${safeName(route)}.gpx`, routeToGpx(route), 'application/gpx+xml');

  const deleteRoute = (route: Route) => {
    if (!confirm(`Delete "${route.name}"?`)) return;
    setRoutes((rs) => rs.filter((r) => r.id !== route.id));
    if (selectedId === route.id) {
      setSelectedId(null);
      setProfileOpen(false);
    }
  };

  const listDisabled = editing !== null;

  return (
    <div id="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Route Maker 3D</h1>
          <button
            className="icon-button"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>

        <div className={`list-section${listDisabled ? ' disabled' : ''}`}>
          <div className="button-row">
            <button className="primary" onClick={startNew} disabled={listDisabled}>
              + New Route
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={listDisabled}>
              Import
            </button>
          </div>

          <ul className="route-list">
            {routes.length === 0 && <li className="empty">No routes yet</li>}
            {routes.map((r) => (
              <li
                key={r.id}
                className={r.id === selectedId ? 'selected' : ''}
                onClick={() => select(r.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (listDisabled) return;
                  select(r.id);
                  setContextMenu({ routeId: r.id, x: e.clientX, y: e.clientY });
                }}
              >
                <span
                  className="swatch"
                  style={{ background: r.color, opacity: r.opacity }}
                />
                <span className="route-name">{r.name}</span>
              </li>
            ))}
          </ul>

          <input
            ref={fileInputRef}
            type="file"
            accept=".kml,.kmz,.gpx"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void onImportFiles(files);
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
              {formatDistance(routeLength(editing.draft.points), settings.unitSystem)}
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
          showLabels={showLabels}
          hillshade={hillshade}
          buildings={buildings}
          exaggeration={exaggeration}
          routesFC={routesFC}
          handlesFC={handlesFC}
          selectionFC={selectionFC}
          hoverPoint={profileHover}
          selectedId={selectedId}
          editing={editing !== null}
          onReady={setMap}
          onSelect={select}
          onAddPoint={addPoint}
          onSelectHandle={selectHandle}
          onMoveHandle={moveHandle}
          onDeleteActive={deleteActive}
        />

        <LayerMenu
          basemap={basemap}
          onBasemap={setBasemap}
          showLabels={showLabels}
          onShowLabels={setShowLabels}
          hillshade={hillshade}
          onHillshade={setHillshade}
          buildings={buildings}
          onBuildings={setBuildings}
          exaggeration={exaggeration}
          onExaggeration={setExaggeration}
        />

        {profileOpen && selectedRoute && !editing && map && (
          <ProfilePanel
            key={selectedRoute.id}
            route={selectedRoute}
            map={map}
            elevationSource={elevationSource}
            unitSystem={settings.unitSystem}
            selection={profileSelection}
            onSelectionChange={setProfileSelection}
            onHover={setProfileHover}
            onClose={() => setProfileOpen(false)}
          />
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {contextMenu &&
        (() => {
          const route = routes.find((r) => r.id === contextMenu.routeId);
          if (!route) return null;
          const close = () => setContextMenu(null);
          const item = (label: string, action: () => void, className = '') => (
            <button
              className={className}
              onClick={() => {
                close();
                action();
              }}
            >
              {label}
            </button>
          );
          return (
            <div
              className="context-menu-overlay"
              onMouseDown={close}
              onContextMenu={(e) => {
                e.preventDefault();
                close();
              }}
            >
              <div
                className="context-menu"
                style={{
                  left: Math.min(contextMenu.x, window.innerWidth - 200),
                  top: Math.min(contextMenu.y, window.innerHeight - 190),
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {item('Edit', () => startEdit(route))}
                {item('Show Elevation Profile', () => setProfileOpen(true))}
                {item('Export KML', () => exportKml(route))}
                {item('Export GPX', () => exportGpx(route))}
                {item('Delete', () => deleteRoute(route), 'danger')}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
