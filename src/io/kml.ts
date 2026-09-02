import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { LonLat, Route } from '../model';
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_WIDTH } from '../model';

/**
 * KML/KMZ import/export against the internal route model
 * (see spec: Route persistence & interchange).
 *
 * KML <color> is aabbggrr — alpha first, then blue-green-red.
 */

function toKmlColor(color: string, opacity: number): string {
  const r = color.slice(1, 3);
  const g = color.slice(3, 5);
  const b = color.slice(5, 7);
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${a}${b}${g}${r}`.toLowerCase();
}

function fromKmlColor(kml: string): { color: string; opacity: number } {
  const s = kml.trim().toLowerCase().padStart(8, 'f');
  const a = parseInt(s.slice(0, 2), 16);
  const b = s.slice(2, 4);
  const g = s.slice(4, 6);
  const r = s.slice(6, 8);
  return { color: `#${r}${g}${b}`, opacity: a / 255 };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function routesToKml(routes: Route[]): string {
  const placemarks = routes
    .map((route) => {
      // 2D lon/lat, no Z (consistent with the internal model)
      const coords = route.points.map(([lon, lat]) => `${lon},${lat}`).join(' ');
      return `    <Placemark>
      <name>${esc(route.name)}</name>
      <Style>
        <LineStyle>
          <color>${toKmlColor(route.color, route.opacity)}</color>
          <width>${route.width}</width>
        </LineStyle>
      </Style>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Routes</name>
${placemarks}
  </Document>
</kml>
`;
}

export function routesToKmz(routes: Route[]): Uint8Array {
  return zipSync({ 'doc.kml': strToU8(routesToKml(routes)) });
}

interface ParsedStyle {
  color?: string;
  opacity?: number;
  width?: number;
}

function parseLineStyle(styleEl: Element | null): ParsedStyle {
  const out: ParsedStyle = {};
  const line = styleEl?.getElementsByTagName('LineStyle')[0];
  if (!line) return out;
  const colorText = line.getElementsByTagName('color')[0]?.textContent;
  if (colorText) {
    const { color, opacity } = fromKmlColor(colorText);
    out.color = color;
    out.opacity = opacity;
  }
  const widthText = line.getElementsByTagName('width')[0]?.textContent;
  if (widthText) {
    const w = parseFloat(widthText);
    if (Number.isFinite(w) && w > 0) out.width = w;
  }
  return out;
}

export function kmlToRoutes(kmlText: string): Omit<Route, 'id'>[] {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid KML');
  }

  // shared styles by id (styleUrl="#id")
  const sharedStyles = new Map<string, ParsedStyle>();
  for (const styleEl of Array.from(doc.getElementsByTagName('Style'))) {
    const id = styleEl.getAttribute('id');
    if (id) sharedStyles.set(id, parseLineStyle(styleEl));
  }

  const routes: Omit<Route, 'id'>[] = [];
  for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
    const lineString = pm.getElementsByTagName('LineString')[0];
    if (!lineString) continue;
    const coordsText = lineString.getElementsByTagName('coordinates')[0]?.textContent ?? '';
    const points: LonLat[] = [];
    for (const token of coordsText.trim().split(/\s+/)) {
      const [lon, lat] = token.split(',').map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
    }
    if (points.length < 2) continue;

    // inline <Style> takes precedence; else resolve <styleUrl>#id
    let style = parseLineStyle(pm.getElementsByTagName('Style')[0] ?? null);
    if (style.color === undefined && style.width === undefined) {
      const url = pm.getElementsByTagName('styleUrl')[0]?.textContent?.trim();
      if (url?.startsWith('#')) style = sharedStyles.get(url.slice(1)) ?? {};
    }

    const name =
      pm.getElementsByTagName('name')[0]?.textContent?.trim() || 'Imported route';
    routes.push({
      name,
      points,
      color: style.color ?? DEFAULT_COLOR,
      opacity: style.opacity ?? DEFAULT_OPACITY,
      width: style.width ?? DEFAULT_WIDTH,
    });
  }
  return routes;
}

/** KMZ is a ZIP wrapping doc.kml (see spec). */
export function kmzToRoutes(buffer: ArrayBuffer): Omit<Route, 'id'>[] {
  const files = unzipSync(new Uint8Array(buffer));
  const kmlName =
    Object.keys(files).find((n) => n.toLowerCase() === 'doc.kml') ??
    Object.keys(files).find((n) => n.toLowerCase().endsWith('.kml'));
  if (!kmlName) throw new Error('KMZ contains no KML document');
  return kmlToRoutes(strFromU8(files[kmlName]));
}
