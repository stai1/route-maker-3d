import type { Route } from '../model';

type RouteStyle = Pick<Route, 'color' | 'opacity' | 'width'>;

interface Props {
  value: RouteStyle;
  onChange: (patch: Partial<RouteStyle>) => void;
}

/** Color (with opacity) and width inputs, shared by the edit and share panels. */
export default function StyleFields({ value, onChange }: Props) {
  return (
    <>
      <label>
        Color
        <span className="color-row">
          <input
            type="color"
            value={value.color}
            onChange={(e) => onChange({ color: e.target.value })}
          />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(value.opacity * 100)}
            onChange={(e) => onChange({ opacity: Number(e.target.value) / 100 })}
          />
          <span className="opacity-label">{Math.round(value.opacity * 100)}%</span>
        </span>
      </label>
      <label>
        Width
        <input
          type="number"
          min={1}
          max={20}
          value={value.width}
          onChange={(e) => onChange({ width: Math.max(1, Number(e.target.value) || 1) })}
        />
      </label>
    </>
  );
}
