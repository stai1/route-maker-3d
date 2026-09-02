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

/** Tick label with decimals adapted to the step size (finer steps when zoomed). */
const fmtTick = (v: number, step: number) => {
  const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(dec);
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max);

/**
 * Smallest zoomable x-window, meters. The effective minimum is
 * min(this, route length) — so routes shorter than this are not zoomable.
 */
const MIN_ZOOM_WINDOW_METERS = 100;

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

  /** Visible x-window as fractions of the route [0..1]. */
  const [view, setView] = useState({ start: 0, end: 1 });
  const viewSpan = view.end - view.start;
  /** Normalize the y-axis to the visible portion (default: whole route). */
  const [fitY, setFitY] = useState(false);

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

    // fit to route bounds so the whole route is covered (see spec).
    // resize first: the panel docks below the map, shrinking its container,
    // and the fit must be computed against the new size
    map.resize();
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
    const total = selection ? selection.end - selection.start : stats.total;
    if (pts.length < 2) {
      // too few samples in range (tiny selection): keep the stat displays
      // mounted with blank values so the layout doesn't jitter
      return {
        total,
        min: null,
        max: null,
        gain: null,
        loss: null,
        maxGrade: null,
        minGrade: null,
        avgGrade: null,
      } as const;
    }
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
      total,
      min: minEle,
      max: maxEle,
      gain,
      loss,
      maxGrade,
      minGrade,
      avgGrade,
    };
  }, [samples, selection, stats]);

  const grade = (v: number | null) => (v !== null ? `${v.toFixed(1)}%` : '–');
  const alt = (v: number | null) =>
    v !== null ? formatAltitude(v, unitSystem) : '–';

  /** Screen fraction (0..1 across the plot) → meters along the route. */
  const screenFracToD = (f: number) =>
    stats ? (view.start + f * viewSpan) * stats.total : 0;

  // wheel: vertical = zoom about the cursor, horizontal = pan.
  // Native non-passive listener — React's synthetic wheel can't preventDefault.
  const plotElRef = useRef<HTMLDivElement | null>(null);
  const hasPlot = stats !== null && route.points.length >= 2;
  const totalRef = useRef(0);
  totalRef.current = stats?.total ?? 0;
  useEffect(() => {
    const el = plotElRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // scroll right advances the view forward along the route
        setView((v) => {
          const span = v.end - v.start;
          const start = clamp(v.start + (e.deltaX / rect.width) * span, 0, 1 - span);
          return { start, end: start + span };
        });
      } else {
        // scroll up zooms in, down zooms out, anchored at the cursor
        const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        const total = totalRef.current;
        const minSpan = total > 0 ? Math.min(MIN_ZOOM_WINDOW_METERS / total, 1) : 1;
        setView((v) => {
          const span = v.end - v.start;
          const newSpan = clamp(span * Math.exp(e.deltaY * 0.002), minSpan, 1);
          const anchor = v.start + frac * span;
          const start = clamp(anchor - frac * newSpan, 0, 1 - newSpan);
          return { start, end: start + newSpan };
        });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [hasPlot]);

  // y-range: whole route, or the visible portion when "fit Y to view" is on
  const yRange = useMemo(() => {
    if (!stats) return null;
    let min = stats.min;
    let max = stats.max;
    if (fitY) {
      const d0 = view.start * stats.total;
      const d1 = view.end * stats.total;
      const eles = samples
        .filter((s) => s.ele !== null && s.d >= d0 && s.d <= d1)
        .map((s) => s.ele!);
      if (eles.length) {
        min = Math.min(...eles);
        max = Math.max(...eles);
      }
    }
    return { min, span: Math.max(max - min, 10) };
  }, [stats, samples, fitY, view]);

  // --- scrollbar ---
  const thumbDragRef = useRef<{
    x0: number;
    start0: number;
    trackWidth: number;
  } | null>(null);

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    thumbDragRef.current = {
      x0: e.clientX,
      start0: view.start,
      trackWidth: e.currentTarget.parentElement!.clientWidth,
    };
  };

  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = thumbDragRef.current;
    if (!t) return;
    setView((v) => {
      const span = v.end - v.start;
      const start = clamp(t.start0 + (e.clientX - t.x0) / t.trackWidth, 0, 1 - span);
      return { start, end: start + span };
    });
  };

  const onThumbPointerUp = () => {
    thumbDragRef.current = null;
  };

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // thumb handles its own drags
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setView((v) => {
      const span = v.end - v.start;
      const start = clamp(frac - span / 2, 0, 1 - span);
      return { start, end: start + span };
    });
  };

  // --- hover cursor: vertical line + tooltip + map marker ---
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const cum = useMemo(() => cumulativeDistances(route.points), [route.points]);

  const hoverInfo = useMemo(() => {
    if (hoverFrac === null || !stats || samples.length < 2) return null;
    const d = (view.start + hoverFrac * viewSpan) * stats.total;
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
  }, [hoverFrac, samples, stats, cum, route.points, view]);

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

  // alt/option+press: smoothly pan the camera to the route location under the
  // cursor, following while dragging until mouseup or the modifier is released
  const followCameraRef = useRef(false);

  const panCameraToFrac = (frac: number) => {
    if (!stats) return;
    const [lon, lat] = pointAlong(route.points, cum, screenFracToD(frac));
    map.easeTo({
      center: [lon, lat],
      duration: 100,
      easing: (t) => 1 - Math.pow(1 - t, 3), // cubic ease-out
    });
  };

  useEffect(() => {
    // modifier released without a pointer event: stop following
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') followCameraRef.current = false;
    };
    window.addEventListener('keyup', onKeyUp);
    return () => window.removeEventListener('keyup', onKeyUp);
  }, []);

  const onPlotPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !stats) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.altKey) {
      followCameraRef.current = true;
      panCameraToFrac(fracFromEvent(e));
      return; // camera-follow mode; no selection
    }
    // left-drag selects; a left click without a drag clears
    dragRef.current = { startFrac: fracFromEvent(e), moved: false };
    onSelectionChange(null); // starting anew clears the old
  };

  const onPlotPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const hoverF = fracFromEvent(e);
    setHoverFrac(hoverF);
    if (followCameraRef.current) {
      if (e.altKey) panCameraToFrac(hoverF);
      else followCameraRef.current = false;
      return;
    }
    const drag = dragRef.current;
    if (!drag || !stats) return;
    const frac = hoverF;
    if (!drag.moved && Math.abs(frac - drag.startFrac) * plotWidth < 3) return;
    drag.moved = true;
    const d0 = screenFracToD(drag.startFrac);
    const d1 = screenFracToD(frac);
    onSelectionChange({ start: Math.min(d0, d1), end: Math.max(d0, d1) });
  };

  const onPlotPointerUp = () => {
    dragRef.current = null;
    followCameraRef.current = false;
  };

  const W = 800;
  const H = 150;
  const path = useMemo(() => {
    if (!stats || !yRange) return '';
    const pts = samples
      .filter((s) => s.ele !== null)
      .map((s) => {
        const x = ((s.d / Math.max(stats.total, 1) - view.start) / viewSpan) * W;
        const y = H - ((s.ele! - yRange.min) / yRange.span) * (H - 20) - 10;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
    return pts.join(' ');
  }, [samples, stats, yRange, view]);

  // axis ticks, computed as "nice" values in the display units; y positions use
  // the same meters→pixel mapping as the drawn line so gridlines align with it
  const axes = useMemo(() => {
    if (!stats || !yRange) return null;
    const distScale =
      unitSystem === 'miles/feet' ? 1 / MILE_METERS : unitSystem === 'meters/meters' ? 1 : 1 / 1000;
    const distUnit =
      unitSystem === 'miles/feet' ? 'mi' : unitSystem === 'meters/meters' ? 'm' : 'km';
    const eleScale = unitSystem === 'miles/feet' ? 1 / 0.3048 : 1;
    const eleUnit = unitSystem === 'miles/feet' ? 'ft' : 'm';

    // one x tick per ~50px of plot width, over the visible distance window
    const xTickCount = Math.max(2, Math.floor(plotWidth / 50));
    const xVals = niceTicks(
      view.start * stats.total * distScale,
      view.end * stats.total * distScale,
      xTickCount,
    );
    const xStep = xVals.length > 1 ? xVals[1] - xVals[0] : 1;
    const xTicks = xVals
      .map((v) => ({
        frac: (v / distScale / Math.max(stats.total, 1) - view.start) / viewSpan,
        label: `${fmtTick(v, xStep)} ${distUnit}`,
      }))
      .filter((t) => t.frac >= 0 && t.frac <= 0.97);

    const yVals = niceTicks(
      yRange.min * eleScale,
      (yRange.min + yRange.span) * eleScale,
      4,
    );
    const yStep = yVals.length > 1 ? yVals[1] - yVals[0] : 1;
    const yTicks = yVals
      .map((v) => {
        const meters = v / eleScale;
        const y = H - ((meters - yRange.min) / yRange.span) * (H - 20) - 10;
        return { frac: y / H, label: `${fmtTick(v, yStep)} ${eleUnit}` };
      })
      .filter((t) => t.frac >= 0.06 && t.frac <= 0.98);
    return { xTicks, yTicks };
  }, [stats, yRange, unitSystem, plotWidth, view]);

  return (
    <div className="profile-panel" ref={panelRef}>
      <div className="profile-header">
        <span className="profile-title">Elevation profile — {route.name}</span>
        <label
          className="profile-fit-y"
          title="Normalize the elevation axis to the visible portion of the graph"
        >
          <input
            type="checkbox"
            checked={fitY}
            onChange={(e) => setFitY(e.target.checked)}
          />
          Fit Y to view
        </label>
        <button onClick={onClose}>✕</button>
      </div>
      {headerStats && (
        <div className={`profile-stats${selection ? ' selection-active' : ''}`}>
              <span className="stat-group">
                <span className="stat-cell">
                  <span className="stat stat-dist">
                    {formatDistance(headerStats.total, unitSystem)}
                  </span>
                </span>
              </span>
              <span className="stat-group">
                <span className="stat-cell">
                  min <span className="stat stat-ele">{alt(headerStats.min)}</span>
                </span>
                <span className="stat-cell">
                  max <span className="stat stat-ele">{alt(headerStats.max)}</span>
                </span>
              </span>
              <span className="stat-group">
                <span className="stat-cell">
                  gain <span className="stat stat-ele">{alt(headerStats.gain)}</span>
                </span>
                <span className="stat-cell">
                  loss <span className="stat stat-ele">{alt(headerStats.loss)}</span>
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
        </div>
      )}
      {route.points.length < 2 ? (
        <div className="profile-empty">Route has no geometry.</div>
      ) : !stats ? (
        <div className="profile-empty">Loading elevation…</div>
      ) : (
        <>
          <div
            className="profile-plot"
            ref={plotElRef}
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
                const toX = (d: number) =>
                  ((d / Math.max(stats.total, 1) - view.start) / viewSpan) * W;
                const f0 = toX(selection.start);
                const f1 = toX(selection.end);
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
                  left: `${(hoverFrac ?? 0) * 100}%`,
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
          {viewSpan < 0.999 && (
            <div className="profile-scrollbar" onPointerDown={onTrackPointerDown}>
              <div
                className="profile-scrollbar-thumb"
                style={{ left: `${view.start * 100}%`, width: `${viewSpan * 100}%` }}
                onPointerDown={onThumbPointerDown}
                onPointerMove={onThumbPointerMove}
                onPointerUp={onThumbPointerUp}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
