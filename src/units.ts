/**
 * Unit systems and display formatting, matching ../activity-slicer.
 * Internal values are always meters; formatting is purely a display concern.
 */

export type DistanceUnit = 'km' | 'mi' | 'm';
export type ElevationUnit = 'm' | 'ft';

export interface Settings {
  distanceUnit: DistanceUnit;
  elevationUnit: ElevationUnit;
}

/** Meters per display unit (unit ids double as their labels). */
export const DISTANCE_UNIT_METERS: Record<DistanceUnit, number> = {
  km: 1000,
  mi: 1609.344, // exact
  m: 1,
};
export const ELEVATION_UNIT_METERS: Record<ElevationUnit, number> = {
  m: 1,
  ft: 0.3048, // exact
};

/** Distance in meters -> display number + unit label. */
export function formatDistance(meters: number, unit: DistanceUnit): string {
  if (!Number.isFinite(meters)) return '';
  return `${(meters / DISTANCE_UNIT_METERS[unit]).toFixed(2)} ${unit}`;
}

/** Altitude in meters -> feet or meters. */
export function formatAltitude(meters: number, unit: ElevationUnit): string {
  if (!Number.isFinite(meters)) return '';
  if (unit === 'ft') return `${(meters / ELEVATION_UNIT_METERS.ft).toFixed(0)} ft`;
  return `${meters.toFixed(1)} m`;
}

// --- locale defaults ---

/** Regions measuring distance in miles (the UK on roads, too). */
const MILE_REGIONS = new Set(['US', 'LR', 'MM', 'GB']);
/** Regions measuring elevation in feet (the UK's maps use meters). */
const FOOT_REGIONS = new Set(['US', 'LR', 'MM']);

/**
 * Units for the browser locale's region ("en-US" → US; a bare "en" maximizes
 * to its likely region, US). Metric when the region is unknown.
 */
function localeSettings(): Settings {
  let region: string | undefined;
  try {
    region = new Intl.Locale(navigator.language).maximize().region;
  } catch {
    // malformed or missing language tag
  }
  return {
    distanceUnit: region && MILE_REGIONS.has(region) ? 'mi' : 'km',
    elevationUnit: region && FOOT_REGIONS.has(region) ? 'ft' : 'm',
  };
}

// --- persistence ---

const KEY = 'route-maker-3d.settings';

const isDistanceUnit = (v: unknown): v is DistanceUnit =>
  v === 'km' || v === 'mi' || v === 'm';
const isElevationUnit = (v: unknown): v is ElevationUnit => v === 'm' || v === 'ft';

/** The settings the user has chosen; invalid or unknown fields are dropped. */
function loadChosen(): Partial<Settings> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const chosen: Partial<Settings> = {};
    if (isDistanceUnit(parsed.distanceUnit)) chosen.distanceUnit = parsed.distanceUnit;
    if (isElevationUnit(parsed.elevationUnit)) chosen.elevationUnit = parsed.elevationUnit;
    return chosen;
  } catch {
    return {};
  }
}

/** The user's chosen settings, with locale-derived values for the rest. */
export function loadSettings(): Settings {
  return { ...localeSettings(), ...loadChosen() };
}

/**
 * Persist settings the user changed (best-effort). Only chosen values are
 * stored: untouched settings keep following the locale.
 */
export function saveSettings(patch: Partial<Settings>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadChosen(), ...patch }));
  } catch {
    // ignore
  }
}
