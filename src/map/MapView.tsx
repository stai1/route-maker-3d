import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap, MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import { getBasemapStyle, type BasemapKind } from './basemaps';
import type { LonLat } from '../model';

const TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export interface MapViewProps {
  basemap: BasemapKind;
  showLabels: boolean;
  /** Relief-shading intensity 0..1 (0 hides the layer); drives hillshade-exaggeration. */
  hillshade: number;
  /** 3D building extrusions (from the vector tiles' building heights). */
  buildings: boolean;
  /** Terrain exaggeration multiplier (display-only; elevation queries stay true). */
  exaggeration: number;
  routesFC: FeatureCollection;
  handlesFC: FeatureCollection;
  /** Bolded sub-route for the elevation profile's range selection. */
  selectionFC: FeatureCollection;
  selectedId: string | null;
  editing: boolean;
  onReady: (map: MLMap) => void;
  onSelect: (id: string | null) => void;
  /** Insert a point after the active point. */
  onAddPoint: (p: LonLat) => void;
  /** Make a placed point the active point. */
  onSelectHandle: (index: number) => void;
  onMoveHandle: (index: number, p: LonLat) => void;
  /** Delete the active point (right-click, matching the 2D editor). */
  onDeleteActive: () => void;
}

const EMPTY_STYLE = { version: 8 as const, sources: {}, layers: [] };

/** Daytime sky: deep azure zenith fading to pale haze at the horizon. */
const SKY_DAY = {
  'sky-color': '#2e6bb3',
  'horizon-color': '#cfe4f7',
  'fog-color': '#6289ab',
  'sky-horizon-blend': 0.7,
  'horizon-fog-blend': 0.8,
  'fog-ground-blend': 0.75,
};

/** Dusk sky for the dark basemap: indigo zenith with a muted amber horizon glow. */
const SKY_DUSK = {
  'sky-color': '#0e1a38',
  'horizon-color': '#2d2119',
  'fog-color': '#1a141c',
  'sky-horizon-blend': 0.5,
  'horizon-fog-blend': 0.8,
  'fog-ground-blend': 0.75,
};

/**
 * Apply the sky palette with a pitch-aware atmosphere halo.
 *
 * atmosphere-blend expressions only understand zoom, not pitch — but at a
 * shallow (high-pitch) camera angle the halo covers most of the screen and
 * obscures the globe. So we scale the halo's strength down as pitch rises
 * (full below 20°, fading to 0.2 by 60°) and re-apply on pitch changes.
 */
function applySky(map: MLMap, basemap: BasemapKind): void {
  const pitch = map.getPitch();
  const pitchFactor = 1 - Math.min(Math.max((pitch - 10) / 50, 0), 1) * 0.8;
  (map as any).setSky?.({
    ...(basemap === 'dark' ? SKY_DUSK : SKY_DAY),
    'atmosphere-blend': [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      pitchFactor,
      10,
      pitchFactor,
      12,
      0,
    ],
  });
}

/** Labels are the basemap's symbol layers; toggling them shows/hides all text. */
function applyLabelVisibility(map: MLMap, show: boolean): void {
  try {
    for (const layer of map.getStyle()?.layers ?? []) {
      if (layer.type === 'symbol') {
        map.setLayoutProperty(layer.id, 'visibility', show ? 'visible' : 'none');
      }
    }
  } catch {
    // style not ready; style.load will re-apply
  }
}

interface CameraState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Restore camera position/orientation from query params (lng, lat, z, b, p). */
function cameraFromUrl(): CameraState | null {
  const q = new URLSearchParams(location.search);
  const lng = parseFloat(q.get('lng') ?? '');
  const lat = parseFloat(q.get('lat') ?? '');
  const zoom = parseFloat(q.get('z') ?? '');
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) {
    return null;
  }
  return {
    center: [lng, lat],
    zoom,
    bearing: parseFloat(q.get('b') ?? '') || 0,
    pitch: parseFloat(q.get('p') ?? '') || 0,
  };
}

export default function MapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /**
   * Set on handle-mousedown, consumed by the next click: the DOM click that
   * follows a handle press/drag must not add a point. A flag (not a rendered-
   * features query) because the selection re-renders the handles source, and
   * queryRenderedFeatures can return empty mid-retile.
   */
  const suppressClickRef = useRef(false);

  // create the map once
  useEffect(() => {
    const initialCam = cameraFromUrl();
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: EMPTY_STYLE,
      center: initialCam?.center ?? [0, 20],
      zoom: initialCam?.zoom ?? 1.6,
      bearing: initialCam?.bearing ?? 0,
      pitch: initialCam?.pitch ?? 0,
      maxPitch: 90, // allow tilting all the way up to horizontal (see spec: Camera controls)
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    // keyboard camera panning is out of scope (see spec: Camera controls)
    map.keyboard.disable();

    // center-on-my-location button (the 2D route maker's ⦿ control); top-right,
    // in the controls column below the layers menu (kept clear of the
    // elevation-profile panel along the bottom)
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        fitBoundsOptions: { maxZoom: 16 }, // match the 2D app's zoom-16 recenter
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      'top-right',
    );

    // keep camera position/orientation in the query params so refresh restores it
    const writeCameraToUrl = () => {
      const c = map.getCenter();
      const q = new URLSearchParams(location.search);
      q.set('lng', c.lng.toFixed(5));
      q.set('lat', c.lat.toFixed(5));
      q.set('z', map.getZoom().toFixed(2));
      q.set('b', map.getBearing().toFixed(1));
      q.set('p', map.getPitch().toFixed(1));
      history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
    };
    map.on('moveend', writeCameraToUrl);
    map.on('rotateend', writeCameraToUrl);
    map.on('pitchend', writeCameraToUrl);

    // keep the atmosphere halo scaled to the camera angle (see applySky)
    map.on('pitch', () => {
      if (map.getStyle()) applySky(map, propsRef.current.basemap);
    });

    const applyContent = () => {
      const p = propsRef.current;
      // terrain (see spec: Elevation data > Terrain mesh)
      if (!map.getSource('terrain-dem')) {
        map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: [TERRAIN_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
          attribution: 'Terrain: Mapzen/AWS Open Data terrain tiles',
        });
      }
      map.setTerrain({ source: 'terrain-dem', exaggeration: p.exaggeration });
      // globe projection (MapLibre v5)
      (map as any).setProjection?.({ type: 'globe' });

      // realistic sky, matched to the basemap: dusk over dark, daytime otherwise
      applySky(map, p.basemap);

      // hillshade: relief shading from the same DEM tiles (separate source, per
      // the MapLibre terrain example), inserted below labels so text stays clean
      if (!map.getSource('hillshade-dem')) {
        map.addSource('hillshade-dem', {
          type: 'raster-dem',
          tiles: [TERRAIN_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
        });
      }
      const firstSymbolId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
      if (!map.getLayer('hillshade')) {
        map.addLayer(
          {
            id: 'hillshade',
            type: 'hillshade',
            source: 'hillshade-dem',
            layout: { visibility: p.hillshade > 0 ? 'visible' : 'none' },
            paint: { 'hillshade-exaggeration': p.hillshade },
          } as any,
          firstSymbolId,
        );
      } else {
        // style merges append kept layers at the end; restore position under labels
        if (firstSymbolId) map.moveLayer('hillshade', firstSymbolId);
        map.setLayoutProperty('hillshade', 'visibility', p.hillshade > 0 ? 'visible' : 'none');
        map.setPaintProperty('hillshade', 'hillshade-exaggeration', p.hillshade);
      }

      // 3D buildings: the OpenMapTiles vector source we already load carries
      // per-building heights (render_height / render_min_height); the stock
      // styles just render them flat. One fill-extrusion layer makes them 3D.
      if (map.getSource('openmaptiles')) {
        const buildingColor =
          p.basemap === 'light' || p.basemap === 'standard' ? '#d9d3c9' : '#2f3644';
        if (!map.getLayer('buildings-3d')) {
          map.addLayer(
            {
              id: 'buildings-3d',
              type: 'fill-extrusion',
              source: 'openmaptiles',
              'source-layer': 'building',
              minzoom: 14, // z13 exists but only as merged footprints — not useful; show full-detail buildings only
              layout: { visibility: p.buildings ? 'visible' : 'none' },
              paint: {
                'fill-extrusion-color': buildingColor,
                'fill-extrusion-height': ['get', 'render_height'],
                'fill-extrusion-base': ['get', 'render_min_height'],
                // Known limitation, left unfixed: extrusions occlude draped route
                // lines passing behind/under them (draped layers live in the
                // ground texture; extrusions are depth-tested 3D geometry).
                // Opacity does not let the draped lines show through either.
                'fill-extrusion-opacity': 0.85,
              },
            } as any,
            firstSymbolId,
          );
        } else {
          if (firstSymbolId) map.moveLayer('buildings-3d', firstSymbolId);
          map.setLayoutProperty(
            'buildings-3d',
            'visibility',
            p.buildings ? 'visible' : 'none',
          );
          map.setPaintProperty('buildings-3d', 'fill-extrusion-color', buildingColor);
        }
      }

      if (!map.getSource('routes')) {
        map.addSource('routes', { type: 'geojson', data: p.routesFC as any });
      }
      if (!map.getSource('handles')) {
        map.addSource('handles', { type: 'geojson', data: p.handlesFC as any });
      }
      if (!map.getSource('selection')) {
        map.addSource('selection', { type: 'geojson', data: p.selectionFC as any });
      }
      if (!map.getLayer('route-selected-casing')) {
        map.addLayer({
          id: 'route-selected-casing',
          type: 'line',
          source: 'routes',
          filter: ['==', ['get', 'id'], p.selectedId ?? ''],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            // soft glow rather than a hard outline
            'line-color': '#ffffff',
            'line-width': ['+', ['to-number', ['get', 'width']], 8],
            'line-opacity': 0.35,
            'line-blur': 4,
          },
        } as any);
      }
      if (!map.getLayer('routes-line')) {
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-opacity': ['to-number', ['get', 'opacity']],
            'line-width': ['to-number', ['get', 'width']],
          },
        } as any);
      }
      if (!map.getLayer('route-selection-segment')) {
        // bold overlay of the profile-selected span, above the route line
        map.addLayer({
          id: 'route-selection-segment',
          type: 'line',
          source: 'selection',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-opacity': ['to-number', ['get', 'opacity']],
            'line-width': ['+', ['to-number', ['get', 'width']], 3],
          },
        } as any);
      }
      if (!map.getLayer('route-handles')) {
        map.addLayer({
          id: 'route-handles',
          type: 'circle',
          source: 'handles',
          paint: {
            'circle-radius': 6,
            // the active point is green, like the 2D editor
            'circle-color': [
              'case',
              ['boolean', ['get', 'active'], false],
              '#37d67a',
              '#ffffff',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': ['get', 'color'],
          },
        } as any);
      }
      applyLabelVisibility(map, p.showLabels);
    };

    map.on('style.load', applyContent);

    // --- interactions ---

    const featuresAt = (e: MapMouseEvent, layer: string) => {
      if (!map.getLayer(layer)) return [];
      const pad = 5;
      return map.queryRenderedFeatures(
        [
          [e.point.x - pad, e.point.y - pad],
          [e.point.x + pad, e.point.y + pad],
        ],
        { layers: [layer] },
      );
    };

    const handleCoords = (f: { geometry: unknown }): LonLat => {
      const c = (f.geometry as { coordinates: number[] }).coordinates;
      return [c[0], c[1]];
    };

    // reset before the layer-scoped mousedown may set it (registration order matters)
    map.on('mousedown', () => {
      suppressClickRef.current = false;
    });

    map.on('click', (e) => {
      const p = propsRef.current;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (p.editing) {
        const ctrl = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        const handleHits = featuresAt(e, 'route-handles');
        if (ctrl && handleHits.length) {
          // ctrl/cmd+click a point: add a new point at that point's location
          p.onAddPoint(handleCoords(handleHits[0]));
          return;
        }
        // plain click on a handle selects via mousedown; don't also add
        if (handleHits.length) return;
        p.onAddPoint([e.lngLat.lng, e.lngLat.lat]);
      } else {
        const hits = featuresAt(e, 'routes-line');
        p.onSelect(hits.length ? String(hits[0].properties?.id) : null);
      }
    });

    // mousedown on a point: select it as the active point and begin dragging
    map.on('mousedown', 'route-handles', (e) => {
      const p = propsRef.current;
      if (!p.editing || !e.features?.length) return;
      // ctrl/cmd is snap-add (handled on click), not select/drag
      if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return;
      e.preventDefault(); // keeps dragPan from engaging
      const index = Number(e.features[0].properties?.index);
      p.onSelectHandle(index);
      suppressClickRef.current = true;
      const onMove = (ev: MapMouseEvent) => {
        let target: LonLat = [ev.lngLat.lng, ev.lngLat.lat];
        // ctrl/cmd while dragging: snap to another point under the cursor
        if (ev.originalEvent.ctrlKey || ev.originalEvent.metaKey) {
          const hits = featuresAt(ev, 'route-handles').filter(
            (f) => Number(f.properties?.index) !== index,
          );
          if (hits.length) target = handleCoords(hits[0]);
        }
        propsRef.current.onMoveHandle(index, target);
      };
      map.on('mousemove', onMove);
      map.once('mouseup', () => {
        map.off('mousemove', onMove);
        // suppressClickRef stays set; the trailing click consumes it
      });
    });

    // right-click deletes the active point (anywhere on the map, like the 2D editor)
    map.on('contextmenu', (e) => {
      const p = propsRef.current;
      if (!p.editing) return;
      e.preventDefault();
      e.originalEvent.preventDefault();
      p.onDeleteActive();
    });

    // cursors
    map.on('mouseenter', 'routes-line', () => {
      if (!propsRef.current.editing) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'routes-line', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'route-handles', () => {
      if (propsRef.current.editing) map.getCanvas().style.cursor = 'move';
    });
    map.on('mouseleave', 'route-handles', () => {
      map.getCanvas().style.cursor = '';
    });

    propsRef.current.onReady(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // label visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (map) applyLabelVisibility(map, props.showLabels);
  }, [props.showLabels]);

  // live hillshade intensity
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (map.getLayer('hillshade')) {
        map.setLayoutProperty(
          'hillshade',
          'visibility',
          props.hillshade > 0 ? 'visible' : 'none',
        );
        map.setPaintProperty('hillshade', 'hillshade-exaggeration', props.hillshade);
      }
    } catch {
      // style not ready; style.load applies it
    }
  }, [props.hillshade]);

  // buildings toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (map.getLayer('buildings-3d')) {
        map.setLayoutProperty(
          'buildings-3d',
          'visibility',
          props.buildings ? 'visible' : 'none',
        );
      }
    } catch {
      // style not ready; style.load applies it
    }
  }, [props.buildings]);

  // live terrain exaggeration (re-scales the mesh without refetching tiles)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (map.getSource('terrain-dem')) {
        map.setTerrain({ source: 'terrain-dem', exaggeration: props.exaggeration });
      }
    } catch {
      // style not ready; style.load applies it
    }
  }, [props.exaggeration]);

  // no zoom on double-click while editing (matches the 2D editor's dblclick suppression)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (props.editing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [props.editing]);

  // basemap switching (setStyle wipes sources/layers; style.load re-applies them)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    getBasemapStyle(props.basemap)
      .then((style) => {
        if (cancelled) return;
        // Carry our runtime additions (terrain + route sources/layers) into the
        // new style so the style diff doesn't tear them down — otherwise the
        // terrain source is destroyed and the mesh briefly flattens while DEM
        // tiles re-fetch and the mesh rebuilds.
        map.setStyle(style, {
          transformStyle: (previous, next) => {
            if (!previous) return next;
            const keepSources: Record<string, any> = {};
            for (const id of [
              'terrain-dem',
              'hillshade-dem',
              'routes',
              'handles',
              'selection',
            ]) {
              if (previous.sources?.[id]) keepSources[id] = previous.sources[id];
            }
            const keepIds = [
              'hillshade',
              'buildings-3d',
              'route-selected-casing',
              'routes-line',
              'route-selection-segment',
              'route-handles',
            ];
            const keepLayers = (previous.layers ?? []).filter((l) =>
              keepIds.includes(l.id),
            );
            // Insert overlays at the same position applyContent uses (under the
            // first symbol layer). If transformStyle merely appended them, the
            // style diff would see a reorder on every switch and express it as
            // removeLayer+addLayer — and re-adding a layer marks its source for
            // tile reload (spurious DEM refetches on basemap switches).
            const overlays = keepLayers.filter(
              (l) => l.id === 'hillshade' || l.id === 'buildings-3d',
            );
            const routeLayers = keepLayers.filter(
              (l) => l.id !== 'hillshade' && l.id !== 'buildings-3d',
            );
            const layers = [...next.layers];
            const symbolIdx = layers.findIndex((l) => l.type === 'symbol');
            layers.splice(symbolIdx < 0 ? layers.length : symbolIdx, 0, ...overlays);
            layers.push(...routeLayers);
            return {
              ...next,
              sources: { ...next.sources, ...keepSources },
              layers,
              terrain: previous.terrain,
              projection: previous.projection ?? (next as any).projection,
              sky: (previous as any).sky ?? (next as any).sky,
            };
          },
        });
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [props.basemap]);

  // data / selection sync
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const routesSrc = map.getSource('routes') as maplibregl.GeoJSONSource | undefined;
    if (routesSrc) routesSrc.setData(props.routesFC as any);
    const handlesSrc = map.getSource('handles') as maplibregl.GeoJSONSource | undefined;
    if (handlesSrc) handlesSrc.setData(props.handlesFC as any);
    const selectionSrc = map.getSource('selection') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (selectionSrc) selectionSrc.setData(props.selectionFC as any);
    if (map.getLayer('route-selected-casing')) {
      map.setFilter('route-selected-casing', [
        '==',
        ['get', 'id'],
        !props.editing && props.selectedId ? props.selectedId : '',
      ] as any);
    }
  }, [props.routesFC, props.handlesFC, props.selectionFC, props.selectedId, props.editing]);

  return <div ref={containerRef} className="map-container" />;
}
