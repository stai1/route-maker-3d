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
  routesFC: FeatureCollection;
  handlesFC: FeatureCollection;
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
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1 });
      // globe projection (MapLibre v5)
      (map as any).setProjection?.({ type: 'globe' });

      if (!map.getSource('routes')) {
        map.addSource('routes', { type: 'geojson', data: p.routesFC as any });
      }
      if (!map.getSource('handles')) {
        map.addSource('handles', { type: 'geojson', data: p.handlesFC as any });
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
            for (const id of ['terrain-dem', 'routes', 'handles']) {
              if (previous.sources?.[id]) keepSources[id] = previous.sources[id];
            }
            const keepIds = ['route-selected-casing', 'routes-line', 'route-handles'];
            const keepLayers = (previous.layers ?? []).filter((l) =>
              keepIds.includes(l.id),
            );
            return {
              ...next,
              sources: { ...next.sources, ...keepSources },
              layers: [...next.layers, ...keepLayers],
              terrain: previous.terrain,
              projection: previous.projection ?? (next as any).projection,
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
    if (map.getLayer('route-selected-casing')) {
      map.setFilter('route-selected-casing', [
        '==',
        ['get', 'id'],
        !props.editing && props.selectedId ? props.selectedId : '',
      ] as any);
    }
  }, [props.routesFC, props.handlesFC, props.selectedId, props.editing]);

  return <div ref={containerRef} className="map-container" />;
}
