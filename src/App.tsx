import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import MapView from './map/MapView';
import LayerMenu from './components/LayerMenu';
import ProfilePanel from './components/ProfilePanel';
import SettingsModal from './components/SettingsModal';
import StyleFields from './components/StyleFields';
import { formatDistance, loadSettings, saveSettings, type Settings } from './units';
import { ElevationSource } from './elevation/ElevationSource';
import { newRoute, type LonLat, type Route } from './model';
import { cumulativeDistances, densify, routeLength, slicePolyline } from './geo';
import { kmlToRoutes, kmzToRoutes, routesToKml } from './io/kml';
import { gpxToRoutes, routeToGpx } from './io/gpx';
import { tcxToRoutes } from './io/tcx';
import { fitToRoutes } from './io/fit';
import {
  buildShareUrl,
  takeShareFromHash,
  type SharedRoute,
  type ShareStyle,
} from './io/share';
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

interface SharingState {
  routeId: string;
  /** Link-only: editing it doesn't rename the route. */
  name: string;
  includeStyle: boolean;
  style: ShareStyle;
  includeLayers: boolean;
}

/**
 * Share link the page was opened with, taken before MapView reads its camera
 * from the hash: a link's camera params never apply (the route fit wins).
 */
const initialShare = takeShareFromHash();
const initialLayers = initialShare instanceof Error ? undefined : initialShare?.layers;

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
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [copied, setCopied] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // layers start as a share link sets them, so the default basemap never flashes
  const [basemap, setBasemap] = useState<BasemapKind>(initialLayers?.basemap ?? 'dark');
  const [showLabels, setShowLabels] = useState(initialLayers?.showLabels ?? true);
  const [hillshade, setHillshade] = useState(initialLayers?.hillshade ?? 0.2);
  const [buildings, setBuildings] = useState(initialLayers?.buildings ?? false);
  const [exaggeration, setExaggeration] = useState(initialLayers?.exaggeration ?? 1);
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
  /** Bumped on each Reverse so the profile can mirror its zoom window. */
  const [reverseNonce, setReverseNonce] = useState(0);

  // selection is scoped to the open profile of the selected route
  useEffect(() => {
    setProfileSelection(null);
  }, [selectedId, profileOpen]);

  // only a setting the user touches is saved; the rest keep following the locale
  const updateSettings = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    saveSettings(patch);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const elevationSource = useMemo(() => new ElevationSource(), []);

  const selectedRoute = routes.find((r) => r.id === selectedId) ?? null;
  /** The route the elevation profile describes: the live draft while editing. */
  const profileRoute = editing ? editing.draft : selectedRoute;

  // editing the route geometry invalidates any profile range selection
  useEffect(() => {
    if (editing) setProfileSelection(null);
  }, [editing?.draft.points]);

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
    if (!profileSelection || !profileRoute || profileRoute.points.length < 2) {
      return { type: 'FeatureCollection', features: [] };
    }
    const cum = cumulativeDistances(profileRoute.points);
    const seg = slicePolyline(
      profileRoute.points,
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
            color: profileRoute.color,
            opacity: profileRoute.opacity,
            width: profileRoute.width,
          },
          geometry: { type: 'LineString', coordinates: densify(seg) },
        },
      ],
    };
  }, [profileSelection, profileRoute]);

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
    setSharing(null);
    setProfileOpen(true); // live elevation profile during create/edit
    setEditing({
      draft: newRoute(`Route ${routes.length + 1}`),
      isNew: true,
      activeIndex: -1,
    });
  };

  const startEdit = (route: Route) => {
    setSharing(null);
    setProfileOpen(true); // live elevation profile during create/edit
    setSelectedId(route.id);
    setEditing({
      draft: structuredClone(route),
      isNew: false,
      activeIndex: route.points.length - 1,
    });
  };

  const duplicate = (route: Route) => {
    const newRoute = structuredClone(route);
    newRoute.id = crypto.randomUUID();
    // Finder-style unique name: strip any " (n)" suffix to get the base,
    // then use the smallest number not taken by an existing route name
    const base = route.name.replace(/ \([0-9]+\)$/, '');
    const names = new Set(routes.map((r) => r.name));
    let n = 1;
    while (names.has(`${base} (${n})`)) n++;
    newRoute.name = `${base} (${n})`;
    setRoutes((rs) => {
      const index = rs.findIndex((r) => r.id === route.id);
      const result = [...rs];
      result.splice(index + 1, 0, newRoute);
      return result;
    });
    setSelectedId(newRoute.id);
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
  const reverse = () => {
    setEditing((e) => {
      if (!e || e.draft.points.length < 2) return e;
      return {
        ...e,
        activeIndex:
          e.activeIndex >= 0 ? e.draft.points.length - 1 - e.activeIndex : -1,
        draft: { ...e.draft, points: e.draft.points.slice().reverse() },
      };
    });
    setReverseNonce((n) => n + 1);
  };

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
    // map clicks never close an open profile or share panel: ignore
    // empty-map deselects
    if (id === null && (profileOpen || sharing)) return;
    // the share panel belongs to its route
    if (sharing && id !== sharing.routeId) setSharing(null);
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
        } else if (name.endsWith('.tcx')) {
          imported = tcxToRoutes(await file.text());
        } else if (name.endsWith('.fit')) {
          imported = await fitToRoutes(
            await file.arrayBuffer(),
            file.name.replace(/\.fit$/i, ''),
          );
        } else {
          throw new Error(
            'unsupported file type (use .kml, .kmz, .gpx, .tcx, or .fit)',
          );
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
    if (sharing?.routeId === route.id) setSharing(null);
    if (selectedId === route.id) {
      setSelectedId(null);
      setProfileOpen(false);
    }
  };

  // --- sharing ---

  const startShare = (route: Route) => {
    setSelectedId(route.id);
    setSharing({
      routeId: route.id,
      name: route.name,
      includeStyle: false,
      style: { color: route.color, opacity: route.opacity, width: route.width },
      includeLayers: false,
    });
  };

  const updateSharing = (patch: Partial<SharingState>) =>
    setSharing((s) => (s ? { ...s, ...patch } : s));

  const sharedRoute = sharing ? routes.find((r) => r.id === sharing.routeId) : undefined;
  // rebuilt live as the panel's fields and the layers control change
  const shareUrl = useMemo(
    () =>
      sharing && sharedRoute
        ? buildShareUrl(
            sharedRoute.points,
            sharing.name.trim(),
            sharing.includeStyle ? sharing.style : null,
            sharing.includeLayers
              ? { basemap, showLabels, buildings, hillshade, exaggeration }
              : null,
          )
        : '',
    [sharing, sharedRoute, basemap, showLabels, buildings, hillshade, exaggeration],
  );

  // "Copied" describes the current link only
  useEffect(() => setCopied(false), [shareUrl]);

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      alert('Copy failed; select the link and copy it manually.');
    }
  };

  /** Add a route from a share link; opening its profile fits the camera to it. */
  const openShare = (share: SharedRoute | Error) => {
    if (share instanceof Error) {
      alert(`Couldn't open the shared route: ${share.message}`);
      return;
    }
    const { layers } = share;
    if (layers?.basemap !== undefined) setBasemap(layers.basemap);
    if (layers?.showLabels !== undefined) setShowLabels(layers.showLabels);
    if (layers?.buildings !== undefined) setBuildings(layers.buildings);
    if (layers?.hillshade !== undefined) setHillshade(layers.hillshade);
    if (layers?.exaggeration !== undefined) setExaggeration(layers.exaggeration);

    const route: Route = { ...newRoute(share.name), ...share.style, points: share.points };
    setRoutes((rs) => [...rs, { ...route, name: route.name || `Route ${rs.length + 1}` }]);
    // while editing, the list is locked: the route just joins it
    if (!editing) {
      setSharing(null);
      setSelectedId(route.id);
      setProfileOpen(true);
    }
    if (share.truncatedFrom) {
      alert(
        `This link appears to be cut off: got ${share.points.length} of ` +
          `${share.truncatedFrom} points. Showing the partial route.`,
      );
    }
  };

  // the link the page was opened with (via ref: StrictMode re-runs effects)
  const initialShareRef = useRef(initialShare);
  useEffect(() => {
    const share = initialShareRef.current;
    initialShareRef.current = null;
    if (share) openShare(share);
  }, []);

  // a link pasted into an open tab changes only the hash, without a reload
  useEffect(() => {
    const onHashChange = () => {
      const share = takeShareFromHash();
      if (share) openShare(share);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });

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
            accept=".kml,.kmz,.gpx,.tcx,.fit"
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
              {formatDistance(routeLength(editing.draft.points), settings.distanceUnit)}
            </p>
            <label>
              Name
              <input
                type="text"
                value={editing.draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </label>
            <StyleFields value={editing.draft} onChange={updateDraft} />
            <div className="button-row">
              <button onClick={reverse} disabled={editing.draft.points.length < 2}>
                Reverse
              </button>
              <button
                className={profileOpen ? 'active' : ''}
                onClick={() => setProfileOpen((v) => !v)}
              >
                Elevation Profile
              </button>
            </div>
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

        {sharing && sharedRoute && (
          <div className="details-section">
            <h2>Share route</h2>
            <label>
              Name
              <input
                type="text"
                value={sharing.name}
                placeholder="Default name"
                onChange={(e) => updateSharing({ name: e.target.value })}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={sharing.includeStyle}
                onChange={(e) => updateSharing({ includeStyle: e.target.checked })}
              />
              Include style
            </label>
            <fieldset className="share-style" disabled={!sharing.includeStyle}>
              <StyleFields
                value={sharing.style}
                onChange={(patch) =>
                  updateSharing({ style: { ...sharing.style, ...patch } })
                }
              />
            </fieldset>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={sharing.includeLayers}
                onChange={(e) => updateSharing({ includeLayers: e.target.checked })}
              />
              Include map layers
            </label>
            <p className="hint">
              Basemap, labels, 3D buildings, hillshade, and terrain, as currently set
              in the layers control.
            </p>
            <label>
              Link
              <input
                type="text"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <p className="hint">{shareUrl.length.toLocaleString()} characters</p>
            <div className="button-row">
              <button className="primary" onClick={() => void copyShareUrl()}>
                {copied ? 'Copied' : 'Copy Link'}
              </button>
              <button onClick={() => setSharing(null)}>Close</button>
            </div>
          </div>
        )}
      </aside>

      <div className="main-column">
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
        </div>

        {profileOpen && profileRoute && map && (
          <ProfilePanel
            key={profileRoute.id}
            route={profileRoute}
            map={map}
            elevationSource={elevationSource}
            distanceUnit={settings.distanceUnit}
            elevationUnit={settings.elevationUnit}
            selection={profileSelection}
            onSelectionChange={setProfileSelection}
            onHover={setProfileHover}
            fitOnOpen={!editing}
            reverseNonce={reverseNonce}
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
                  top: Math.min(contextMenu.y, window.innerHeight - 222),
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {item('Edit', () => startEdit(route))}
                {item('Duplicate', () => duplicate(route))}
                {item('Show Elevation Profile', () => setProfileOpen(true))}
                {item('Export KML', () => exportKml(route))}
                {item('Export GPX', () => exportGpx(route))}
                {item('Share', () => startShare(route))}
                {item('Delete', () => deleteRoute(route), 'danger')}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
