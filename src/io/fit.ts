import FitParser from 'fit-file-parser';
import type { LonLat, Route } from '../model';
import { DEFAULT_COLOR, DEFAULT_OPACITY, DEFAULT_WIDTH } from '../model';

/**
 * FIT import (GPS geometry only), mirroring ../activity-slicer's parser
 * config: fit-file-parser in list mode with degree/meter units, keeping only
 * records that carry a position.
 */
export function fitToRoutes(
  buffer: ArrayBuffer,
  name: string,
): Promise<Omit<Route, 'id'>[]> {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list',
    });
    parser.parse(buffer, (error, data) => {
      if (error) {
        reject(new Error(String(error)));
        return;
      }
      const points: LonLat[] = (data.records ?? [])
        .filter(
          (r: { position_lat?: number; position_long?: number }) =>
            r.position_lat != null && r.position_long != null,
        )
        .map(
          (r: { position_lat: number; position_long: number }): LonLat => [
            r.position_long,
            r.position_lat,
          ],
        );
      if (points.length < 2) {
        reject(new Error('no GPS data found'));
        return;
      }
      resolve([
        {
          name,
          points,
          color: DEFAULT_COLOR,
          opacity: DEFAULT_OPACITY,
          width: DEFAULT_WIDTH,
        },
      ]);
    });
  });
}
