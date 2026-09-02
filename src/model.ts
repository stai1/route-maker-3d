export type LonLat = [number, number];

/**
 * Internal route model (see spec: Route persistence & interchange).
 * Geometry is 2D lon/lat; no elevation is stored.
 */
export interface Route {
  id: string;
  name: string;
  points: LonLat[];
  /** #RRGGBB */
  color: string;
  /** 0..1 */
  opacity: number;
  /** stroke width, screen px */
  width: number;
}

export const DEFAULT_COLOR = '#ff4d3d';
export const DEFAULT_OPACITY = 1;
export const DEFAULT_WIDTH = 4;

export function newRoute(name: string): Route {
  return {
    id: crypto.randomUUID(),
    name,
    points: [],
    color: DEFAULT_COLOR,
    opacity: DEFAULT_OPACITY,
    width: DEFAULT_WIDTH,
  };
}
