import type { LonLat, Route } from '../model';
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_WIDTH } from '../model';

/**
 * GPX is a geometry interchange: 2D lon/lat only.
 * No <ele> (elevation is a profile-only visualization) and no styling
 * (see spec: Route persistence & interchange).
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function routeToGpx(route: Route): string {
  const pts = route.points
    .map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="route-maker-3d" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(route.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Import brings in geometry and assigns a default style (see spec). */
export function gpxToRoutes(gpxText: string): Omit<Route, 'id'>[] {
  const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid GPX');
  }

  const routes: Omit<Route, 'id'>[] = [];
  const collect = (containerTag: string, pointTag: string) => {
    for (const el of Array.from(doc.getElementsByTagName(containerTag))) {
      const points: LonLat[] = [];
      for (const pt of Array.from(el.getElementsByTagName(pointTag))) {
        const lat = parseFloat(pt.getAttribute('lat') ?? '');
        const lon = parseFloat(pt.getAttribute('lon') ?? '');
        if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
      }
      if (points.length < 2) continue;
      const name =
        el.getElementsByTagName('name')[0]?.textContent?.trim() || 'Imported route';
      routes.push({
        name,
        points,
        color: DEFAULT_COLOR,
        opacity: DEFAULT_OPACITY,
        width: DEFAULT_WIDTH,
      });
    }
  };
  collect('trk', 'trkpt');
  collect('rte', 'rtept');
  return routes;
}
