import { useState } from 'react';
import type { BasemapKind } from '../map/basemaps';

interface Props {
  basemap: BasemapKind;
  onBasemap: (k: BasemapKind) => void;
  showLabels: boolean;
  onShowLabels: (v: boolean) => void;
  hillshade: number;
  onHillshade: (v: number) => void;
  buildings: boolean;
  onBuildings: (v: boolean) => void;
  exaggeration: number;
  onExaggeration: (v: number) => void;
}

const BASEMAPS: Array<{ kind: BasemapKind; label: string }> = [
  { kind: 'dark', label: 'Dark' },
  { kind: 'light', label: 'Light' },
  { kind: 'satellite', label: 'Satellite' },
];

/**
 * Standard web-map layers control: a collapsed button with a layers icon
 * that expands (hover or click) into a menu — radio options for the
 * basemap, checkboxes for overlays.
 */
export default function LayerMenu({
  basemap,
  onBasemap,
  showLabels,
  onShowLabels,
  hillshade,
  onHillshade,
  buildings,
  onBuildings,
  exaggeration,
  onExaggeration,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="layer-menu"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {!open ? (
        <button
          className="layer-menu-toggle"
          aria-label="Layers"
          title="Layers"
          onClick={() => setOpen(true)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 3l9 5-9 5-9-5 9-5zm0 11.3l6.8-3.78L21 11.7l-9 5-9-5 2.2-1.18L12 14.3zm0 4l6.8-3.78L21 15.7l-9 5-9-5 2.2-1.18L12 18.3z" />
          </svg>
        </button>
      ) : (
        <div className="layer-menu-panel">
          {BASEMAPS.map(({ kind, label }) => (
            <label key={kind}>
              <input
                type="radio"
                name="basemap"
                checked={basemap === kind}
                onChange={() => onBasemap(kind)}
              />
              {label}
            </label>
          ))}
          <hr />
          <label>
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => onShowLabels(e.target.checked)}
            />
            Labels
          </label>
          <label>
            <input
              type="checkbox"
              checked={buildings}
              onChange={(e) => onBuildings(e.target.checked)}
            />
            3D buildings
          </label>
          <hr />
          <label
            className="slider-row"
            title="Hillshade intensity — right-click to reset to 20%"
            onContextMenu={(e) => {
              e.preventDefault();
              onHillshade(0.2);
            }}
          >
            <span>Hillshade {Math.round(hillshade * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={hillshade}
              onChange={(e) => onHillshade(Number(e.target.value))}
            />
          </label>
          <label
            className="slider-row"
            title="Terrain exaggeration — right-click to reset to 1×"
            onContextMenu={(e) => {
              e.preventDefault();
              onExaggeration(1);
            }}
          >
            <span>Terrain ×{exaggeration.toFixed(1)}</span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={exaggeration}
              onChange={(e) => onExaggeration(Number(e.target.value))}
            />
          </label>
        </div>
      )}
    </div>
  );
}
