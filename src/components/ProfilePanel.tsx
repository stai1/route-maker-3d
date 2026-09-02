import { useEffect, useMemo, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { Route } from '../model';
import { boundsOf } from '../geo';
import { ElevationSource, MAX_ELEVATION_ZOOM } from '../elevation/ElevationSource';
import { makeProfileSamples, type ProfileSample } from '../elevation/profile';

interface Props {
  route: Route;
  map: MLMap;
  elevationSource: ElevationSource;
  onClose: () => void;
}

/**
 * Elevation profile panel (see spec: Elevation data).
 *
 * - Opening fits the camera to the route bounds, forcing coverage.
 * - Resolution follows camera LOD with monotonic refinement: samples only
 *   ever upgrade to higher-zoom reads; tiles backing current best samples
 *   are pinned in the ElevationSource until the panel closes.
 */
export default function ProfilePanel({ route, map, elevationSource, onClose }: Props) {
  const [samples, setSamples] = useState<ProfileSample[]>([]);

  useEffect(() => {
    if (route.points.length < 2) return;
    let alive = true;
    const arr = makeProfileSamples(route.points);
    const sampleTiles = new Map<number, string[]>();
    setSamples([...arr]);

    const currentZoom = () =>
      Math.max(0, Math.min(MAX_ELEVATION_ZOOM, Math.ceil(map.getZoom()) + 1));

    const refine = async (targetZ: number, restrictToView: boolean) => {
      const bounds = restrictToView ? map.getBounds() : null;
      let changed = false;
      for (const [i, s] of arr.entries()) {
        if (!alive) return;
        if (s.z >= targetZ) continue; // monotonic: never downgrade
        if (bounds && !bounds.contains([s.lon, s.lat])) continue;
        const r = await elevationSource.sample(s.lon, s.lat, targetZ);
        if (!alive) return;
        if (r) {
          s.ele = r.elevation;
          s.z = r.zoom;
          sampleTiles.set(i, r.tiles);
          changed = true;
        }
      }
      if (changed) {
        setSamples([...arr]);
        elevationSource.setPinned(new Set([...sampleTiles.values()].flat()));
      }
    };

    // fit to route bounds so the whole route is covered (see spec)
    map.fitBounds(boundsOf(route.points), { padding: 80, duration: 600 });
    map.once('idle', () => {
      if (alive) void refine(currentZoom(), false);
    });
    const onMoveEnd = () => void refine(currentZoom(), true);
    map.on('moveend', onMoveEnd);

    return () => {
      alive = false;
      map.off('moveend', onMoveEnd);
      elevationSource.setPinned([]); // release pins when the panel closes
    };
  }, [route.id]);

  const stats = useMemo(() => {
    const eles = samples.filter((s) => s.ele !== null).map((s) => s.ele!);
    if (!eles.length) return null;
    const total = samples[samples.length - 1]?.d ?? 0;
    return { min: Math.min(...eles), max: Math.max(...eles), total };
  }, [samples]);

  const W = 800;
  const H = 150;
  const path = useMemo(() => {
    if (!stats) return '';
    const span = Math.max(stats.max - stats.min, 10); // avoid a flat line filling the panel
    const pts = samples
      .filter((s) => s.ele !== null)
      .map((s) => {
        const x = (s.d / Math.max(stats.total, 1)) * W;
        const y = H - ((s.ele! - stats.min) / span) * (H - 20) - 10;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
    return pts.join(' ');
  }, [samples, stats]);

  const km = (m: number) => (m / 1000).toFixed(m >= 100000 ? 0 : 1);

  return (
    <div className="profile-panel">
      <div className="profile-header">
        <span className="profile-title">
          Elevation profile — {route.name}
          {stats && (
            <span className="profile-stats">
              {' '}
              · {km(stats.total)} km · min {Math.round(stats.min)} m · max{' '}
              {Math.round(stats.max)} m
            </span>
          )}
        </span>
        <button onClick={onClose}>✕</button>
      </div>
      {route.points.length < 2 ? (
        <div className="profile-empty">Route has no geometry.</div>
      ) : !stats ? (
        <div className="profile-empty">Loading elevation…</div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="profile-svg"
        >
          <polyline points={path} fill="none" stroke="#6cf" strokeWidth="1.5" />
          <polygon
            points={`0,${H} ${path} ${W},${H}`}
            fill="#6cf"
            opacity="0.15"
            stroke="none"
          />
        </svg>
      )}
    </div>
  );
}
