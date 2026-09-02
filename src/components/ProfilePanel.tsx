import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { Route } from '../model';
import { boundsOf } from '../geo';
import { ElevationSource, MAX_ELEVATION_ZOOM } from '../elevation/ElevationSource';
import { makeProfileSamples, type ProfileSample } from '../elevation/profile';
import { MILE_METERS, formatAltitude, formatDistance, type UnitSystem } from '../units';

/** "Nice" tick values (1/2/5 × 10^n steps) covering [min, max]. */
function niceTicks(min: number, max: number, targetCount: number): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const step0 = span / targetCount;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step =
    [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= targetCount + 1) ??
    10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step / 1e6; v += step) {
    out.push(v);
  }
  return out;
}

const tickNumber = (v: number) =>
  Math.abs(v % 1) < 1e-9 ? v.toFixed(0) : v.toFixed(1);

interface Props {
  route: Route;
  map: MLMap;
  elevationSource: ElevationSource;
  unitSystem: UnitSystem;
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
export default function ProfilePanel({
  route,
  map,
  elevationSource,
  unitSystem,
  onClose,
}: Props) {
  const [samples, setSamples] = useState<ProfileSample[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(800);

  // track the panel's width so x-tick density adapts to available space
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => setPlotWidth(Math.max(100, el.clientWidth - 24));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

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

  // axis ticks, computed as "nice" values in the display units; y positions use
  // the same meters→pixel mapping as the drawn line so gridlines align with it
  const axes = useMemo(() => {
    if (!stats) return null;
    const spanM = Math.max(stats.max - stats.min, 10);
    const distScale =
      unitSystem === 'miles/feet' ? 1 / MILE_METERS : unitSystem === 'meters/meters' ? 1 : 1 / 1000;
    const distUnit =
      unitSystem === 'miles/feet' ? 'mi' : unitSystem === 'meters/meters' ? 'm' : 'km';
    const eleScale = unitSystem === 'miles/feet' ? 1 / 0.3048 : 1;
    const eleUnit = unitSystem === 'miles/feet' ? 'ft' : 'm';

    // one x tick per ~50px of plot width
    const xTickCount = Math.max(2, Math.floor(plotWidth / 50));
    const xTicks = niceTicks(0, stats.total * distScale, xTickCount)
      .map((v) => ({
        frac: v / distScale / Math.max(stats.total, 1),
        label: `${tickNumber(v)} ${distUnit}`,
      }))
      .filter((t) => t.frac <= 0.97);
    const yTicks = niceTicks(stats.min * eleScale, stats.max * eleScale, 4)
      .map((v) => {
        const meters = v / eleScale;
        const y = H - ((meters - stats.min) / spanM) * (H - 20) - 10;
        return { frac: y / H, label: `${tickNumber(v)} ${eleUnit}` };
      })
      .filter((t) => t.frac >= 0.06 && t.frac <= 0.98);
    return { xTicks, yTicks };
  }, [stats, unitSystem, plotWidth]);

  return (
    <div className="profile-panel" ref={panelRef}>
      <div className="profile-header">
        <span className="profile-title">
          Elevation profile — {route.name}
          {stats && (
            <span className="profile-stats">
              {' '}
              · {formatDistance(stats.total, unitSystem)} · min{' '}
              {formatAltitude(stats.min, unitSystem)} · max{' '}
              {formatAltitude(stats.max, unitSystem)}
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
        <>
          <div className="profile-plot">
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
              {axes?.yTicks.map((t) => (
                <line
                  key={`y${t.frac}`}
                  x1={0}
                  x2={W}
                  y1={t.frac * H}
                  y2={t.frac * H}
                  stroke="#ffffff"
                  strokeOpacity="0.12"
                  strokeWidth="0.5"
                />
              ))}
              {axes?.xTicks.map((t) => (
                <line
                  key={`x${t.frac}`}
                  x1={t.frac * W}
                  x2={t.frac * W}
                  y1={0}
                  y2={H}
                  stroke="#ffffff"
                  strokeOpacity="0.12"
                  strokeWidth="0.5"
                />
              ))}
            </svg>
            {/* labels live in HTML — text inside the stretched SVG would distort */}
            {axes?.yTicks.map((t) => (
              <span
                key={`yl${t.frac}`}
                className="profile-tick-y"
                style={{ top: `${t.frac * 100}%` }}
              >
                {t.label}
              </span>
            ))}
          </div>
          <div className="profile-xaxis">
            {axes?.xTicks.map((t) => (
              <span
                key={`xl${t.frac}`}
                className="profile-tick-x"
                style={{
                  left: `${t.frac * 100}%`,
                  transform: t.frac < 0.03 ? 'none' : 'translateX(-50%)',
                }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
