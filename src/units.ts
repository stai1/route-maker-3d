/**
 * Unit systems and display formatting, matching ../activity-slicer.
 * Internal values are always meters; formatting is purely a display concern.
 */

export type UnitSystem = 'km/meters' | 'miles/feet' | 'meters/meters';

export interface Settings {
  unitSystem: UnitSystem;
}

export const DEFAULT_SETTINGS: Settings = {
  unitSystem: 'km/meters',
};

export const MILE_METERS = 1609.344; // exact
const FOOT_METERS = 0.3048;
const KM_METERS = 1000;

/** Distance in meters -> display number + unit label. */
export function formatDistance(meters: number, sys: UnitSystem): string {
  if (!Number.isFinite(meters)) return '';
  if (sys === 'miles/feet') return `${(meters / MILE_METERS).toFixed(2)} mi`;
  if (sys === 'meters/meters') return `${meters.toFixed(2)} m`;
  return `${(meters / KM_METERS).toFixed(2)} km`;
}

/** Altitude in meters -> feet or meters. */
export function formatAltitude(meters: number, sys: UnitSystem): string {
  if (!Number.isFinite(meters)) return '';
  if (sys === 'miles/feet') return `${(meters / FOOT_METERS).toFixed(0)} ft`;
  return `${meters.toFixed(1)} m`;
}

// --- persistence ---

const KEY = 'route-maker-3d.settings';

const isUnitSystem = (v: unknown): v is UnitSystem =>
  v === 'km/meters' || v === 'miles/feet' || v === 'meters/meters';

/** Load settings from localStorage, falling back to defaults for missing/invalid. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      unitSystem: isUnitSystem(parsed.unitSystem)
        ? parsed.unitSystem
        : DEFAULT_SETTINGS.unitSystem,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Persist settings to localStorage (best-effort). */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
