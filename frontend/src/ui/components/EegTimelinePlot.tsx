import type { RecordedSession } from '@neuroscape/contracts';
import { audioActivePeriods } from '../summary/index.js';

const WIDTH = 960,
  LEFT = 92,
  RIGHT = 20,
  DURATION_MS = 600_000;
const plotWidth = WIDTH - LEFT - RIGHT;
export type EegMetricKey = 'theta' | 'beta' | 'tbr';
export type EegDisplayRanges = Record<EegMetricKey, [number, number]>;
const finite = (values: Array<number | null | undefined>) =>
  values.filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  );
const paddedRange = (values: number[]): [number, number] => {
  if (!values.length) return [0, 1];
  const min = Math.min(...values),
    max = Math.max(...values),
    padding = Math.max((max - min) * 0.08, Math.abs(max || min) * 0.02, 1e-6);
  return [min - padding, max + padding];
};
export function sharedEegRanges(
  recordings: RecordedSession[],
): EegDisplayRanges {
  const metrics = recordings.flatMap((recording) =>
    (recording.eegMetrics ?? []).filter((metric) => metric.valid),
  );
  return {
    theta: paddedRange(finite(metrics.map((item) => item.theta))),
    beta: paddedRange(finite(metrics.map((item) => item.beta))),
    tbr: paddedRange(
      finite(metrics.flatMap((item) => [item.tbr, item.tbrBaseline])),
    ),
  };
}
const xAt = (timestampMs: number) =>
  LEFT +
  (Math.max(0, Math.min(DURATION_MS, timestampMs)) / DURATION_MS) * plotWidth;

export function EegTimelinePlot({
  recording,
  title,
  compact = false,
  ranges,
}: {
  recording: RecordedSession;
  title: string;
  compact?: boolean;
  ranges?: EegDisplayRanges;
}) {
  const metrics = recording.eegMetrics ?? [],
    sounds = audioActivePeriods(recording);
  if (!metrics.length)
    return (
      <section className="eeg-plot">
        <h3>{title}</h3>
        <p>No EEG metric history recorded.</p>
      </section>
    );
  const displayRanges = ranges ?? sharedEegRanges([recording]);
  const tracks: Array<{ key: EegMetricKey; label: string; color: string }> = [
    { key: 'theta', label: 'Theta', color: '#71d8ff' },
    { key: 'beta', label: 'Beta', color: '#f7bf69' },
    { key: 'tbr', label: 'log-TBR', color: '#c6ff8f' },
  ];
  const trackHeight = compact ? 70 : 82,
    soundTop = 14 + tracks.length * trackHeight,
    soundHeight = compact ? 92 : 116,
    height = soundTop + soundHeight + 34;
  const segments = (key: EegMetricKey, top: number) => {
    const [min, max] = displayRanges[key],
      span = Math.max(max - min, 1e-12),
      result: string[][] = [];
    let current: string[] = [];
    metrics.forEach((metric) => {
      const value = metric[key];
      if (!metric.valid || value === null || !Number.isFinite(value)) {
        if (current.length) result.push(current);
        current = [];
        return;
      }
      current.push(
        `${xAt(metric.timestampMs)},${top + 54 - ((value - min) / span) * 44}`,
      );
    });
    if (current.length) result.push(current);
    return result;
  };
  const lanes = ['ambient', 'action', 'event'] as const;
  return (
    <section className="eeg-plot">
      <h3>{title}</h3>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label={`${title} Theta, Beta, log-TBR with calibration baseline and sound timeline from zero to ten minutes`}
      >
        {[0, 2, 4, 6, 8, 10].map((minute) => (
          <line
            key={`grid-${minute}`}
            x1={LEFT + (minute / 10) * plotWidth}
            y1="5"
            x2={LEFT + (minute / 10) * plotWidth}
            y2={height - 28}
            stroke="rgba(255,255,255,.08)"
          />
        ))}
        {tracks.map((track, index) => {
          const top = 12 + index * trackHeight,
            [min, max] = displayRanges[track.key],
            span = Math.max(max - min, 1e-12),
            baselinePoints =
              track.key === 'tbr'
                ? metrics
                    .filter((metric) => Number.isFinite(metric.tbrBaseline))
                    .map(
                      (metric) =>
                        `${xAt(metric.timestampMs)},${top + 54 - ((metric.tbrBaseline - min) / span) * 44}`,
                    )
                    .join(' ')
                : '';
          return (
            <g key={track.key}>
              <text x="4" y={top + 20} fill={track.color}>
                {track.label}
              </text>
              <text
                x="4"
                y={top + 38}
                fill="rgba(255,255,255,.55)"
                fontSize="10"
              >
                {min.toPrecision(3)}–{max.toPrecision(3)}
              </text>
              <line
                x1={LEFT}
                y1={top + 58}
                x2={WIDTH - RIGHT}
                y2={top + 58}
                stroke="rgba(255,255,255,.16)"
              />
              {segments(track.key, top).map((points, segment) => (
                <polyline
                  key={segment}
                  points={points.join(' ')}
                  fill="none"
                  stroke={track.color}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {baselinePoints && (
                <>
                  <polyline
                    points={baselinePoints}
                    fill="none"
                    stroke="#e6a5ff"
                    strokeWidth="1.5"
                    strokeDasharray="7 4"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={WIDTH - RIGHT - 4}
                    y={top + 8}
                    textAnchor="end"
                    fill="#e6a5ff"
                    fontSize="9"
                  >
                    calibration baseline
                  </text>
                </>
              )}
            </g>
          );
        })}
        <text x="4" y={soundTop + 18} fill="#d6d0ef">
          Sound Timeline
        </text>
        {lanes.map((lane, index) => (
          <g key={lane}>
            <text
              x="18"
              y={soundTop + 40 + index * 22}
              fill="rgba(255,255,255,.58)"
              fontSize="10"
            >
              {lane === 'action' ? 'body/action' : lane}
            </text>
            <line
              x1={LEFT}
              y1={soundTop + 36 + index * 22}
              x2={WIDTH - RIGHT}
              y2={soundTop + 36 + index * 22}
              stroke="rgba(255,255,255,.12)"
            />
          </g>
        ))}
        {sounds.map((sound, index) => {
          const lane = lanes.indexOf(sound.category);
          if (lane < 0) return null;
          const x = xAt(sound.startMs),
            width = Math.max(2, xAt(sound.endMs) - x);
          return (
            <rect
              key={`${sound.key}-${sound.startMs}-${index}`}
              x={x}
              y={soundTop + 28 + lane * 22}
              width={width}
              height="14"
              rx="3"
              fill={
                sound.category === 'ambient'
                  ? '#8bcf9f'
                  : sound.category === 'action'
                    ? '#a98cdb'
                    : '#f0a36d'
              }
              opacity=".8"
            >
              <title>{`${sound.category} · ${sound.assetId} · ${Math.round(sound.startMs / 1000)}–${Math.round(sound.endMs / 1000)}s`}</title>
            </rect>
          );
        })}
        {(recording.decisionEvents ?? []).map((event, index) => {
          const x = xAt(event.timestampMs),
            color = event.type === 'decision-1' ? '#ff7ea8' : '#fff176';
          return (
            <g key={`${event.type}-${event.timestampMs}-${index}`}>
              <line
                x1={x}
                y1="4"
                x2={x}
                y2={height - 28}
                stroke={color}
                strokeDasharray={event.type === 'decision-1' ? '5 3' : '2 3'}
              />
              <text
                x={x + 3}
                y={11 + (index % 2) * 11}
                fill={color}
                fontSize="9"
              >
                {event.type === 'decision-1' ? 'D1' : 'D2'}
              </text>
            </g>
          );
        })}
        {[0, 2, 4, 6, 8, 10].map((minute) => (
          <g key={minute}>
            <line
              x1={LEFT + (minute / 10) * plotWidth}
              y1={height - 26}
              x2={LEFT + (minute / 10) * plotWidth}
              y2={height - 21}
              stroke="white"
            />
            <text
              x={LEFT + (minute / 10) * plotWidth}
              y={height - 6}
              fill="rgba(255,255,255,.65)"
              fontSize="10"
              textAnchor="middle"
            >
              {minute} min
            </text>
          </g>
        ))}
      </svg>
      <p className="eeg-plot-legend">
        Real-time log-TBR and the persisted calibration baseline share one Y
        axis. Gaps indicate missing or invalid EEG windows. D1 = Decision 1; D2
        = Decision 2.
      </p>
    </section>
  );
}
