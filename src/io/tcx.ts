import type { LonLat, Route } from '../model';
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_WIDTH } from '../model';

/**
 * TCX import (GPS geometry only), mirroring ../activity-slicer's parser:
 * Trackpoint → Position → LatitudeDegrees / LongitudeDegrees via DOMParser.
 * Both Activities and Courses are imported, one route each.
 */

const text = (el: Element | null | undefined): string | undefined =>
  el?.textContent?.trim() || undefined;

const num = (v: string | undefined): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function trackPoints(container: Element): LonLat[] {
  const points: LonLat[] = [];
  for (const tp of Array.from(container.getElementsByTagName('Trackpoint'))) {
    const pos = tp.getElementsByTagName('Position')[0];
    const lat = num(text(pos?.getElementsByTagName('LatitudeDegrees')[0]));
    const lon = num(text(pos?.getElementsByTagName('LongitudeDegrees')[0]));
    if (lat !== undefined && lon !== undefined) points.push([lon, lat]);
  }
  return points;
}

export function tcxToRoutes(tcxText: string): Omit<Route, 'id'>[] {
  const doc = new DOMParser().parseFromString(tcxText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid TCX');
  }

  const routes: Omit<Route, 'id'>[] = [];
  const add = (points: LonLat[], name: string) => {
    if (points.length < 2) return;
    routes.push({
      name,
      points,
      color: DEFAULT_COLOR,
      opacity: DEFAULT_OPACITY,
      width: DEFAULT_WIDTH,
    });
  };

  for (const act of Array.from(doc.getElementsByTagName('Activity'))) {
    add(
      trackPoints(act),
      text(act.getElementsByTagName('Id')[0]) ??
        act.getAttribute('Sport') ??
        'Imported activity',
    );
  }
  for (const course of Array.from(doc.getElementsByTagName('Course'))) {
    add(
      trackPoints(course),
      text(course.getElementsByTagName('Name')[0]) ?? 'Imported course',
    );
  }
  return routes;
}
