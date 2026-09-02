import type { StyleSpecification } from 'maplibre-gl';

/**
 * Token-free basemaps (see spec: Base map & labels).
 * Dark (default) / Light are OpenFreeMap vector styles; Satellite is ESRI
 * raster imagery shown under the dark style's vector label layers so place
 * labels remain upright and legible over imagery.
 */

export type BasemapKind = 'dark' | 'light' | 'standard' | 'satellite';

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

export async function getBasemapStyle(kind: BasemapKind): Promise<StyleSpecification> {
  if (kind === 'dark') return fetchStyle(OFM_DARK);
  if (kind === 'light') return fetchStyle(OFM_LIGHT);
  if (kind === 'standard') return fetchStyle(OFM_BRIGHT); // OSM Bright: general-purpose full-color style

  // satellite: raster imagery base + the dark style's symbol (label) layers on top
  const base = await fetchStyle(OFM_DARK);
  return {
    ...base,
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
    layers: [
      { id: 'satellite-imagery', type: 'raster', source: 'satellite-imagery' },
      ...base.layers.filter((l) => l.type === 'symbol'),
    ],
  };
}
