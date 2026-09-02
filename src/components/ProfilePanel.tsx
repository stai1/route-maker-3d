import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import type { LonLat, Route } from '../model';
import { boundsOf, cumulativeDistances, pointAlong } from '../geo';
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

export interface ProfileSelection {
  /** meters along the route */
  start: number;
  end: number;
}

interface Props {
  route: Route;
  map: MLMap;
  elevationSource: ElevationSource;
  unitSystem: UnitSystem;
  selection: ProfileSelection | null;
  onSelectionChange: (sel: ProfileSelection | null) => void;
  /** Route position under the graph cursor, for the map marker. */
  onHover: (p: LonLat | null) => void;
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
  selection,
  onSelectionChange,
  onHover,
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

  // full-route stats drive the graph's y-scaling (selection must not rescale it)
  const stats = useMemo(() => {
    const eles = samples.filter((s) => s.ele !== null).map((s) => s.ele!);
    if (!eles.length) return null;
    const total = samples[samples.length - 1]?.d ?? 0;
    return { min: Math.min(...eles), max: Math.max(...eles), total };
  }, [samples]);

  // header stats reflect the selection when one is active
  const headerStats = useMemo(() => {
    if (!stats) return null;
    const inRange = selection
      ? samples.filter((s) => s.d >= selection.start && s.d <= selection.end)
      : samples;
    const pts = inRange.filter((s) => s.ele !== null);
    if (pts.length < 2) return null;
    let gain = 0;
    let loss = 0;
    let maxGrade = -Infinity;
    let minGrade = Infinity;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const ele = pts[i].ele!;
      if (ele < minEle) minEle = ele;
      if (ele > maxEle) maxEle = ele;
      if (i > 0) {
        const dEle = ele - pts[i - 1].ele!;
        const dDist = pts[i].d - pts[i - 1].d;
        if (dEle > 0) gain += dEle;
        else loss -= dEle;
        if (dDist > 0) {
          const grade = (dEle / dDist) * 100;
          if (grade > maxGrade) maxGrade = grade;
          if (grade < minGrade) minGrade = grade;
        }
      }
    }
    const run = pts[pts.length - 1].d - pts[0].d;
    const avgGrade =
      run > 0 ? ((pts[pts.length - 1].ele! - pts[0].ele!) / run) * 100 : 0;
    return {
      total: selection ? selection.end - selection.start : stats.total,
      min: minEle,
      max: maxEle,
      gain,
      loss,
      maxGrade,
      minGrade,
      avgGrade,
    };
  }, [samples, selection, stats]);

  const grade = (v: number) => `${v.toFixed(1)}%`;

  // --- hover cursor: vertical line + tooltip + map marker ---
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const cum = useMemo(() => cumulativeDistances(route.points), [route.points]);

  const hoverInfo = useMemo(() => {
    if (hoverFrac === null || !stats || samples.length < 2) return null;
    const d = hoverFrac * stats.total;
    // bracketing samples (uniform spacing) for interpolation
    let i1 = samples.findIndex((s) => s.d >= d);
    if (i1 <= 0) i1 = 1;
    const s0 = samples[i1 - 1];
    const s1 = samples[i1];
    let ele: number | null = null;
    let segGrade: number | null = null;
    if (s0.ele !== null && s1.ele !== null && s1.d > s0.d) {
      const t = (d - s0.d) / (s1.d - s0.d);
      ele = s0.ele + (s1.ele - s0.ele) * t;
      segGrade = ((s1.ele - s0.ele) / (s1.d - s0.d)) * 100;
    }
    const [lon, lat] = pointAlong(route.points, cum, d);
    return { d, ele, grade: segGrade, lon, lat };
  }, [hoverFrac, samples, stats, cum, route.points]);

  // marker position flows up to the map; cleared on leave and unmount
  useEffect(() => {
    onHover(hoverInfo ? [hoverInfo.lon, hoverInfo.lat] : null);
  }, [hoverInfo]);
  useEffect(() => () => onHover(null), []);

  // --- shift+drag range selection ---
  const dragRef = useRef<{ startFrac: number; moved: boolean } | null>(null);

  const fracFromEvent = (e: React.PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };

  const onPlotPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // shift+drag or right-drag selects; the same click without a drag clears
    if (!(e.shiftKey || e.button === 2) || !stats) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startFrac: fracFromEvent(e), moved: false };
    onSelectionChange(null); // starting anew clears the old
  };

  const onPlotPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const hoverF = fracFromEvent(e);
    setHoverFrac(hoverF);
    const drag = dragRef.current;
    if (!drag || !stats) return;
    const frac = hoverF;
    if (!drag.moved && Math.abs(frac - drag.startFrac) * plotWidth < 3) return;
    drag.moved = true;
    onSelectionChange({
      start: Math.min(drag.startFrac, frac) * stats.total,
      end: Math.max(drag.startFrac, frac) * stats.total,
    });
  };

  const onPlotPointerUp = () => {
    dragRef.current = null;
  };

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
          {headerStats && (
            <span className={`profile-stats${selection ? ' selection-active' : ''}`}>
              <span className="stat-group">
                <span className="stat-cell">
                  <span className="stat stat-dist">
                    {formatDistance(headerStats.total, unitSystem)}
                  </span>
                </span>
              </span>
              <span className="stat-group">
                <span className="stat-cell">
                  min{' '}
                  <span className="stat stat-ele">
                    {formatAltitude(headerStats.min, unitSystem)}
                  </span>
                </span>
                <span className="stat-cell">
                  max{' '}
                  <span className="stat stat-ele">
                    {formatAltitude(headerStats.max, unitSystem)}
                  </span>
                </span>
              </span>
              <span className="stat-group">
                <span className="stat-cell">
                  gain{' '}
                  <span className="stat stat-ele">
                    {formatAltitude(headerStats.gain, unitSystem)}
                  </span>
                </span>
                <span className="stat-cell">
                  loss{' '}
                  <span className="stat stat-ele">
                    {formatAltitude(headerStats.loss, unitSystem)}
                  </span>
                </span>
              </span>
              <span className="stat-group">
                <span className="stat-cell">
                  max{' '}
                  <span className="stat stat-grade">{grade(headerStats.maxGrade)}</span>
                </span>
                <span className="stat-cell">
                  min{' '}
                  <span className="stat stat-grade">{grade(headerStats.minGrade)}</span>
                </span>
                <span className="stat-cell">
                  avg{' '}
                  <span className="stat stat-grade">{grade(headerStats.avgGrade)}</span>
                </span>
              </span>
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
          <div
            className="profile-plot"
            onPointerDown={onPlotPointerDown}
            onPointerMove={onPlotPointerMove}
            onPointerUp={onPlotPointerUp}
            onPointerLeave={() => setHoverFrac(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
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
              {selection && stats && (() => {
                const f0 = (selection.start / Math.max(stats.total, 1)) * W;
                const f1 = (selection.end / Math.max(stats.total, 1)) * W;
                return (
                  <>
                    <defs>
                      <clipPath id="profile-sel-clip">
                        <rect x={f0} y={0} width={Math.max(f1 - f0, 0)} height={H} />
                      </clipPath>
                    </defs>
                    {/* mild highlight, screen-blended so it brightens what's beneath */}
                    <rect
                      className="profile-sel-rect"
                      x={f0}
                      y={0}
                      width={Math.max(f1 - f0, 0)}
                      height={H}
                      fill="#6cf"
                      fillOpacity="0.18"
                    />
                    {/* bold the graph inside the selection */}
                    <polyline
                      points={path}
                      fill="none"
                      stroke="#6cf"
                      strokeWidth="3"
                      clipPath="url(#profile-sel-clip)"
                    />
                    <line x1={f0} x2={f0} y1={0} y2={H} stroke="#9fd4ff" strokeWidth="1" />
                    <line x1={f1} x2={f1} y1={0} y2={H} stroke="#9fd4ff" strokeWidth="1" />
                  </>
                );
              })()}
              {hoverFrac !== null && (
                <line
                  x1={hoverFrac * W}
                  x2={hoverFrac * W}
                  y1={0}
                  y2={H}
                  stroke="#ffffff"
                  strokeOpacity="0.55"
                  strokeWidth="0.75"
                />
              )}
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
            {hoverInfo && (
              <div
                className="profile-tooltip"
                style={{
                  left: `${(hoverInfo.d / Math.max(stats.total, 1)) * 100}%`,
                  transform:
                    hoverFrac !== null && hoverFrac > 0.8
                      ? 'translateX(calc(-100% - 8px))'
                      : 'translateX(8px)',
                }}
              >
                <div>{formatDistance(hoverInfo.d, unitSystem)}</div>
                <div>
                  {hoverInfo.ele !== null
                    ? formatAltitude(hoverInfo.ele, unitSystem)
                    : '–'}
                </div>
                <div>{hoverInfo.grade !== null ? grade(hoverInfo.grade) : '–'}</div>
              </div>
            )}
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
