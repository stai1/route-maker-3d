import type { LonLat } from './model';

const R = 6371000; // earth radius, meters
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Cumulative distance (meters) at each point; [0] = 0. */
export function cumulativeDistances(points: LonLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  }
  return cum;
}

export function routeLength(points: LonLat[]): number {
  const cum = cumulativeDistances(points);
  return cum[cum.length - 1] ?? 0;
}

/** Linear interpolation along the polyline at distance d (meters). */
export function pointAlong(points: LonLat[], cum: number[], d: number): LonLat {
  if (d <= 0) return points[0];
  const total = cum[cum.length - 1];
  if (d >= total) return points[points.length - 1];
  let i = 1;
  while (cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
  const a = points[i - 1];
  const b = points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Sub-polyline between distances d0..d1 (meters) along the line. */
export function slicePolyline(
  points: LonLat[],
  cum: number[],
  d0: number,
  d1: number,
): LonLat[] {
  const total = cum[cum.length - 1] ?? 0;
  const a = Math.max(0, Math.min(d0, total));
  const b = Math.max(a, Math.min(d1, total));
  const out: LonLat[] = [pointAlong(points, cum, a)];
  for (let i = 0; i < points.length; i++) {
    if (cum[i] > a && cum[i] < b) out.push(points[i]);
  }
  out.push(pointAlong(points, cum, b));
  return out;
}

/** [[west, south], [east, north]] */
export function boundsOf(points: LonLat[]): [[number, number], [number, number]] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [[w, s], [e, n]];
}

/**
 * Insert interpolated vertices so no display segment exceeds maxSegMeters —
 * long straight segments would otherwise cut through hills when draped
 * (see spec: Route rendering).
 */
export function densify(points: LonLat[], maxSegMeters = 300, maxPoints = 5000): LonLat[] {
  if (points.length < 2) return points.slice();
  const out: LonLat[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversine(a, b);
    const n = Math.min(Math.ceil(d / maxSegMeters), Math.max(1, Math.floor((maxPoints - out.length) / (points.length - i))));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    if (out.length >= maxPoints) {
      out.push(points[points.length - 1]);
      break;
    }
  }
  return out;
}

/** Web-Mercator Y in [0,1] from latitude (degrees). */
export function mercatorY(lat: number): number {
  const phi = rad(Math.max(-85.051129, Math.min(85.051129, lat)));
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}
