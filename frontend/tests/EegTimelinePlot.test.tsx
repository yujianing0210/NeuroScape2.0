import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EegTimelinePlot,
  sharedEegRanges,
} from '../src/ui/components/EegTimelinePlot.js';
import { recordedSession } from './recordingFixtures.js';

const session = () => {
  const recording = recordedSession();
  recording.metadata.durationMs = 600_000;
  recording.eegMetrics = [
    {
      timestampMs: 0,
      theta: 0.1,
      beta: 0.05,
      tbr: -0.4,
      tbrBaseline: -0.35,
      valid: true,
      qualityScore: 0.95,
      artifactFlags: [],
    },
    {
      timestampMs: 10_000,
      theta: null,
      beta: null,
      tbr: null,
      tbrBaseline: -0.35,
      valid: false,
      qualityScore: 0.1,
      artifactFlags: ['blink'],
    },
    {
      timestampMs: 20_000,
      theta: 0.2,
      beta: 0.08,
      tbr: -0.2,
      tbrBaseline: -0.35,
      valid: true,
      qualityScore: 0.9,
      artifactFlags: [],
    },
  ];
  recording.decisionEvents = [{ timestampMs: 15_000, type: 'decision-1' }];
  return recording;
};
describe('EegTimelinePlot', () => {
  it('renders shared-axis TBR baseline, sound lanes, ticks, decisions, and invalid gaps', () => {
    const html = renderToStaticMarkup(
      <EegTimelinePlot recording={session()} title="Adaptive" />,
    );
    expect(html).toContain('log-TBR');
    expect(html).toContain('calibration baseline');
    expect(html).toContain('Sound Timeline');
    expect(html).toContain('body/action');
    expect(html).toContain('10 min');
    expect(html).toContain('D1');
    expect(html).toContain('Gaps indicate');
    expect((html.match(/<polyline/g) ?? []).length).toBeGreaterThan(4);
  });
  it('uses a shared raw range across two recordings', () => {
    const a = session(),
      b = session();
    b.eegMetrics![0]!.theta = 2;
    const ranges = sharedEegRanges([a, b]);
    expect(ranges.theta[0]).toBeLessThan(0.1);
    expect(ranges.theta[1]).toBeGreaterThan(2);
  });
  it('renders non-adaptive data without decision markers', () => {
    const recording = session();
    recording.decisionEvents = [];
    expect(
      renderToStaticMarkup(
        <EegTimelinePlot recording={recording} title="Non-Adaptive" />,
      ),
    ).not.toContain('>D1<');
  });
});
