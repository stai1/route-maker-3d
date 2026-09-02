import type { LonLat } from '../model';
import { cumulativeDistances, pointAlong } from '../geo';

export interface ProfileSample {
  /** distance along route, meters */
  d: number;
  lon: number;
  lat: number;
  /** best-known elevation (meters), null until first read */
  ele: number | null;
  /** zoom the current value was read at; -1 = never read. High-water mark. */
  z: number;
}

/** Max samples per profile — keeps the array bounded regardless of route length (see spec). */
export const MAX_PROFILE_SAMPLES = 2000;

/** Target sample spacing along the route, meters. */
export const PROFILE_SAMPLE_SPACING = 5;

/** Sample positions along the route: target resolution derived from length, capped. */
export function makeProfileSamples(points: LonLat[]): ProfileSample[] {
  if (points.length < 2) return [];
  const cum = cumulativeDistances(points);
  const total = cum[cum.length - 1];
  const n = Math.min(
    MAX_PROFILE_SAMPLES,
    Math.max(2, Math.floor(total / PROFILE_SAMPLE_SPACING) + 2),
  );
  const samples: ProfileSample[] = [];
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    const [lon, lat] = pointAlong(points, cum, d);
    samples.push({ d, lon, lat, ele: null, z: -1 });
  }
  return samples;
}
