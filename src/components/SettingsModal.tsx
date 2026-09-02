import type { Settings, UnitSystem } from '../units';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

/** Settings modal: unit system (matching ../activity-slicer's systems). */
export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <label>
          Units
          <select
            value={settings.unitSystem}
            onChange={(e) =>
              onChange({ ...settings, unitSystem: e.target.value as UnitSystem })
            }
          >
            <option value="km/meters">distance: km / elevation: meters</option>
            <option value="miles/feet">distance: miles / elevation: feet</option>
            <option value="meters/meters">distance: meters / elevation: meters</option>
          </select>
        </label>
        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
