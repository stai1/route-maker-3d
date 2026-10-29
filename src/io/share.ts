import type { LonLat, Route } from '../model';
import type { BasemapKind } from '../map/basemaps';

/**
 * Share links (see spec: Sharing). A route travels in the URL hash fragment —
 * never sent to the server, so long routes aren't limited by request-URL size:
 *
 *   #name=…&color=ff4d3d&opacity=1&width=4&basemap=dark&labels=1&buildings=0
 *    &hillshade=0.2&terrain=1&n=1234&route=<encoded polyline>
 *
 * Only `route` is required. The polyline goes last and `n` (its point count)
 * before it, so a link cut off by a messenger loses points, not parameters,
 * and the loss is detectable.
 */

const BASEMAPS: BasemapKind[] = ['dark', 'light', 'standard', 'satellite', 'hybrid'];

/** Camera params (written by MapView); a share link's route fit overrides them. */
const CAMERA_KEYS = ['lng', 'lat', 'z', 'b', 'p'];
const SHARE_KEYS = [
  'name',
  'color',
  'opacity',
  'width',
  'basemap',
  'labels',
  'buildings',
  'hillshade',
  'terrain',
  'n',
  'route',
];

export type ShareStyle = Pick<Route, 'color' | 'opacity' | 'width'>;

export interface ShareLayers {
  basemap: BasemapKind;
  showLabels: boolean;
  buildings: boolean;
  hillshade: number;
  exaggeration: number;
}

export interface SharedRoute {
  points: LonLat[];
  /** Empty: the receiver names it with the default scheme. */
  name: string;
  style?: Partial<ShareStyle>;
  layers?: Partial<ShareLayers>;
  /** Point count the link was made with, when fewer points arrived. */
  truncatedFrom?: number;
}

// --- Encoded Polyline Algorithm Format (Google), 1e5 precision, lat before lng ---

function encodeValue(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (n >= 0x20) {
    out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>>= 5;
  }
  return out + String.fromCharCode(n + 63);
}

export function encodePolyline(points: LonLat[]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lng, lat] of points) {
    // delta between rounded values, so rounding error doesn't accumulate
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    out += encodeValue(latE5 - prevLat) + encodeValue(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return out;
}

/**
 * Decode up to the last complete point; a trailing partial point (a cut-off
 * link) is dropped. Throws on characters outside the format's alphabet or
 * out-of-range coordinates.
 */
export function decodePolyline(s: string): LonLat[] {
  const points: LonLat[] = [];
  const values: number[] = [];
  let shift = 0;
  let acc = 0;
  let lat = 0;
  let lng = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 63;
    if (c < 0 || c > 63) throw new Error('invalid route data');
    acc |= (c & 0x1f) << shift;
    shift += 5;
    if (c & 0x20) {
      // valid deltas fit in 6 chunks (|delta| ≤ 360e5 → < 2^30 zigzagged)
      if (shift >= 30) throw new Error('invalid route data');
      continue;
    }
    values.push(acc & 1 ? ~(acc >> 1) : acc >> 1);
    shift = 0;
    acc = 0;
    if (values.length === 2) {
      lat += values[0];
      lng += values[1];
      values.length = 0;
      if (Math.abs(lat) > 90e5 || Math.abs(lng) > 180e5) {
        throw new Error('invalid route data');
      }
      points.push([lng / 1e5, lat / 1e5]);
    }
  }
  return points;
}

// --- links ---

const hex = (color: string) => color.replace(/^#/, '').toLowerCase();
const round2 = (v: number) => String(Math.round(v * 100) / 100);

export function buildShareUrl(
  points: LonLat[],
  name: string,
  style: ShareStyle | null,
  layers: ShareLayers | null,
): string {
  const params: [string, string][] = [];
  if (name) params.push(['name', name]);
  if (style) {
    params.push(
      ['color', hex(style.color)],
      ['opacity', round2(style.opacity)],
      ['width', String(style.width)],
    );
  }
  if (layers) {
    params.push(
      ['basemap', layers.basemap],
      ['labels', layers.showLabels ? '1' : '0'],
      ['buildings', layers.buildings ? '1' : '0'],
      ['hillshade', round2(layers.hillshade)],
      ['terrain', round2(layers.exaggeration)],
    );
  }
  params.push(['n', String(points.length)], ['route', encodePolyline(points)]);
  // a fresh URL (not location.href): the sender's camera never leaks in
  const hash = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${location.origin}${location.pathname}#${hash}`;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Parse a number param clamped to [min, max]; undefined if absent/invalid. */
function num(q: URLSearchParams, key: string, min: number, max: number) {
  const v = parseFloat(q.get(key) ?? '');
  return Number.isFinite(v) ? clamp(v, min, max) : undefined;
}

function bool(q: URLSearchParams, key: string) {
  const v = q.get(key);
  return v === '1' ? true : v === '0' ? false : undefined;
}

/** Drop keys whose value failed validation, so defaults apply to them. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function parseShare(q: URLSearchParams): SharedRoute {
  // a cut-off link can end inside a %XX escape, which URLSearchParams leaves
  // undecoded; drop it with the rest of the partial point
  const encoded = (q.get('route') ?? '').replace(/%[0-9a-f]?$/i, '');
  const points = decodePolyline(encoded);
  if (points.length < 2) throw new Error('the route has fewer than 2 points');

  const color = q.get('color') ?? '';
  const basemap = q.get('basemap') as BasemapKind | null;
  const style = defined({
    color: /^[0-9a-f]{6}$/i.test(color) ? `#${color.toLowerCase()}` : undefined,
    opacity: num(q, 'opacity', 0, 1),
    width: num(q, 'width', 1, 20),
  });
  const layers = defined({
    basemap: basemap && BASEMAPS.includes(basemap) ? basemap : undefined,
    showLabels: bool(q, 'labels'),
    buildings: bool(q, 'buildings'),
    hillshade: num(q, 'hillshade', 0, 1),
    exaggeration: num(q, 'terrain', 0, 3),
  });
  const expected = parseInt(q.get('n') ?? '', 10);
  return {
    points,
    name: q.get('name')?.trim() ?? '',
    style,
    layers,
    truncatedFrom: expected > points.length ? expected : undefined,
  };
}

/**
 * Take a share link out of the URL hash: returns null when the hash holds no
 * route, an Error when it holds an invalid one. Share and camera params are
 * stripped from the URL either way, so a refresh doesn't re-add the route and
 * the camera fits the route rather than any camera params in the link.
 */
export function takeShareFromHash(): SharedRoute | Error | null {
  const q = new URLSearchParams(location.hash.slice(1));
  if (!q.has('route')) return null;
  let result: SharedRoute | Error;
  try {
    result = parseShare(q);
  } catch (err) {
    result = err instanceof Error ? err : new Error(String(err));
  }
  for (const key of [...SHARE_KEYS, ...CAMERA_KEYS]) q.delete(key);
  const rest = q.toString();
  history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`,
  );
  return result;
}
