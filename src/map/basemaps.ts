import type { StyleSpecification } from 'maplibre-gl';

/**
 * Token-free basemaps (see spec: Base map & labels).
 * Dark (default) / Light / Standard are OpenFreeMap vector styles. Satellite
 * and Hybrid are ESRI raster imagery under vector layers from the standard
 * (Bright) style: Satellite carries a sparse label whitelist; Hybrid carries
 * roads and all labels.
 */

export type BasemapKind = 'dark' | 'light' | 'standard' | 'satellite' | 'hybrid';

const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark';
const OFM_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const OFM_BRIGHT = 'https://tiles.openfreemap.org/styles/bright';
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

async function fetchStyle(url: string): Promise<StyleSpecification> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load basemap style: ${url}`);
  return res.json();
}

// Density of along-road name repetition, applied to every basemap: px between
// repeated anchors on a line (style default is 250) — higher = sparser names.
const ROAD_NAME_SPACING = 500;

/** Set symbol-spacing on road-name layers (line-placed text, not shields). */
function applyRoadNameSpacing(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((l) => {
      const layout = (l as any).layout ?? {};
      if (
        l.type === 'symbol' &&
        (l as any)['source-layer'] === 'transportation_name' &&
        !layout['icon-image']
      ) {
        return { ...l, layout: { ...layout, 'symbol-spacing': ROAD_NAME_SPACING } };
      }
      return l;
    }),
  };
}

export async function getBasemapStyle(kind: BasemapKind): Promise<StyleSpecification> {
  if (kind === 'dark') return applyRoadNameSpacing(await fetchStyle(OFM_DARK));
  if (kind === 'light') return applyRoadNameSpacing(await fetchStyle(OFM_LIGHT));
  if (kind === 'standard') {
    // OSM Bright: general-purpose full-color style
    return applyRoadNameSpacing(await fetchStyle(OFM_BRIGHT));
  }

  // satellite/hybrid: raster imagery base + vector layers from the standard
  // (Bright) style on top.
  //
  // Satellite carries a sparse label set: whitelist by OpenMapTiles
  // source-layer (stable schema, unlike style layer ids; fails safe if new
  // layers appear) — places and water names only — plus a density filter that
  // inflates each label's collision box so the collision engine thins labels
  // to keep that spacing (text-padding default is 2px).
  //
  // Hybrid carries roads (transportation line layers) and ALL symbol layers,
  // unfiltered.
  const SATELLITE_LABEL_SOURCE_LAYERS = new Set([
    'place',
    'water_name',
    'waterway',
  ]);
  const SATELLITE_LABEL_PADDING = 16;
  const base = applyRoadNameSpacing(await fetchStyle(OFM_BRIGHT));
  const overlay =
    kind === 'hybrid'
      ? base.layers
          .filter(
            (l) =>
              l.type === 'symbol' ||
              (l.type === 'line' && (l as any)['source-layer'] === 'transportation'),
          )
          .map((l) => {
            if (l.type === 'line') {
              // half-opacity roads: readable over imagery without hiding it
              return { ...l, paint: { ...(l as any).paint, 'line-opacity': 0.5 } };
            }
            const sourceLayer = (l as any)['source-layer'];
            const layout = (l as any).layout ?? {};
            if (sourceLayer === 'transportation_name' && !layout['icon-image']) {
              // road names ship as muted grey with no effective halo (styled
              // for Bright's pale background); over imagery use white text
              // with a dark halo. Shields have icon backgrounds — left as is.
              return {
                ...l,
                paint: {
                  ...(l as any).paint,
                  'text-color': '#ffffff',
                  'text-halo-color': 'rgba(0, 0, 0, 0.75)',
                  'text-halo-width': 1.2,
                },
              };
            }
            return l;
          })
      : base.layers
          .filter(
            (l) =>
              l.type === 'symbol' &&
              SATELLITE_LABEL_SOURCE_LAYERS.has((l as any)['source-layer']),
          )
          .map((l) => ({
            ...l,
            layout: { ...(l as any).layout, 'text-padding': SATELLITE_LABEL_PADDING },
          }));
  return {
    ...base,
    layers: [
      { id: 'satellite-imagery', type: 'raster', source: 'satellite-imagery' },
      ...overlay,
    ],
    sources: {
      ...base.sources,
      'satellite-imagery': {
        type: 'raster',
        tiles: [ESRI_IMAGERY],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          'Imagery &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    },
  };
}
