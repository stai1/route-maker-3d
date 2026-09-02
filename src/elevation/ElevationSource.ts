import { mercatorY } from '../geo';

const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const MAX_ELEVATION_ZOOM = 15;
const TILE_SIZE = 256;

interface Entry {
  /** RGBA pixel data, or null if the fetch failed. */
  data: Uint8ClampedArray | null;
  promise: Promise<Uint8ClampedArray | null> | null;
}

export interface ElevationSample {
  elevation: number;
  /** Tile keys this sample was read from (for pinning). */
  tiles: string[];
  zoom: number;
}

/**
 * Owns Terrarium elevation tiles for the elevation-profile feature,
 * independent of MapLibre's render-time terrain cache (see spec: Elevation data).
 *
 * - Decoded tiles are held in an LRU cache with a fixed budget.
 * - Tiles named by setPinned() are exempt from eviction (monotonic-refinement
 *   guarantee while a profile panel is open).
 */
export class ElevationSource {
  private cache = new Map<string, Entry>(); // Map preserves insertion order → LRU
  private pinned = new Set<string>();
  maxTiles = 128; // ~32 MB of RGBA

  private key(z: number, x: number, y: number): string {
    return `${z}/${x}/${y}`;
  }

  setPinned(keys: Iterable<string>): void {
    this.pinned = new Set(keys);
  }

  private touch(key: string, entry: Entry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private evict(): void {
    if (this.cache.size <= this.maxTiles) return;
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxTiles) break;
      if (this.pinned.has(key) || entry.promise) continue;
      this.cache.delete(key);
    }
  }

  private async fetchTile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
    try {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } catch {
      return null;
    }
  }

  async getTile(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
    const key = this.key(z, x, y);
    const existing = this.cache.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.promise ?? existing.data;
    }
    const entry: Entry = { data: null, promise: null };
    entry.promise = this.fetchTile(z, x, y).then((data) => {
      entry.data = data;
      entry.promise = null;
      return data;
    });
    this.cache.set(key, entry);
    this.evict();
    return entry.promise;
  }

  /** Decode elevation (meters) at a pixel of an RGBA tile. */
  private decode(data: Uint8ClampedArray, px: number, py: number): number {
    const i = (py * TILE_SIZE + px) * 4;
    return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
  }

  /**
   * Elevation at (lon, lat) at the given tile zoom, with bilinear
   * interpolation across the four surrounding samples (crossing tile
   * edges via neighboring tiles).
   */
  async sample(lon: number, lat: number, zoom: number): Promise<ElevationSample | null> {
    const z = Math.max(0, Math.min(MAX_ELEVATION_ZOOM, Math.round(zoom)));
    const worldPx = TILE_SIZE * Math.pow(2, z);
    const gx = (((lon + 180) / 360) % 1 + 1) % 1 * worldPx;
    const gy = mercatorY(lat) * worldPx;

    // sample centers at pixel + 0.5
    const x0 = Math.floor(gx - 0.5);
    const y0 = Math.floor(gy - 0.5);
    const fx = gx - 0.5 - x0;
    const fy = gy - 0.5 - y0;

    const corners: Array<[number, number, number]> = [
      [x0, y0, (1 - fx) * (1 - fy)],
      [x0 + 1, y0, fx * (1 - fy)],
      [x0, y0 + 1, (1 - fx) * fy],
      [x0 + 1, y0 + 1, fx * fy],
    ];

    const tiles = new Map<string, { z: number; x: number; y: number }>();
    const lookups: Array<{ key: string; px: number; py: number; w: number }> = [];
    for (const [cx, cy, w] of corners) {
      const px = ((cx % worldPx) + worldPx) % worldPx; // wrap longitude
      const py = Math.max(0, Math.min(worldPx - 1, cy)); // clamp latitude
      const tx = Math.floor(px / TILE_SIZE);
      const ty = Math.floor(py / TILE_SIZE);
      const key = this.key(z, tx, ty);
      tiles.set(key, { z, x: tx, y: ty });
      lookups.push({ key, px: px % TILE_SIZE, py: py % TILE_SIZE, w });
    }

    const loaded = new Map<string, Uint8ClampedArray | null>();
    await Promise.all(
      [...tiles.values()].map(async (t) => {
        loaded.set(this.key(t.z, t.x, t.y), await this.getTile(t.z, t.x, t.y));
      }),
    );

    let sum = 0;
    let wsum = 0;
    const used = new Set<string>();
    for (const { key, px, py, w } of lookups) {
      const data = loaded.get(key);
      if (!data) continue;
      sum += this.decode(data, px, py) * w;
      wsum += w;
      used.add(key);
    }
    if (wsum === 0) return null;
    return { elevation: sum / wsum, tiles: [...used], zoom: z };
  }
}
