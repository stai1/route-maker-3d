import type { DistanceUnit, ElevationUnit, Settings } from '../units';

interface Props {
  settings: Settings;
  /** Called with only the changed setting. */
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

/** Settings modal: distance and elevation units (defaults follow the locale). */
export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <label>
          Distance units
          <select
            value={settings.distanceUnit}
            onChange={(e) => onChange({ distanceUnit: e.target.value as DistanceUnit })}
          >
            <option value="km">Kilometers</option>
            <option value="mi">Miles</option>
            <option value="m">Meters</option>
          </select>
        </label>
        <label>
          Elevation units
          <select
            value={settings.elevationUnit}
            onChange={(e) => onChange({ elevationUnit: e.target.value as ElevationUnit })}
          >
            <option value="m">Meters</option>
            <option value="ft">Feet</option>
          </select>
        </label>
        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
