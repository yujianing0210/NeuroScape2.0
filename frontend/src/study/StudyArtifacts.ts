import { mockCalibrationProfile } from '@neuroscape/adaptive-planner';
import type {
  AdaptiveTraceRecord,
  RecordedSession,
} from '@neuroscape/contracts';
import JSZip from 'jszip';
import type { CapturedAudio } from '../audio/AudioEngine.js';

export interface StudyArtifact {
  filename: string;
  mimeType: string;
  content: Blob;
}
export interface StudyArtifactBundle {
  participantId: string;
  sessionId: string;
  folderName: string;
  files: StudyArtifact[];
}
export type BackendSaveState = {
  status: 'idle' | 'saving' | 'saved' | 'failed';
  directory?: string;
  error?: string;
};

const json = (value: unknown) =>
  new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
const SAVE_REQUEST_TIMEOUT_MS = 30_000;
const saveFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, {
    ...init,
    signal: AbortSignal.timeout(SAVE_REQUEST_TIMEOUT_MS),
  }).catch((error) => {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new Error(
        'Saving timed out. Check that the local study recorder is running, then retry.',
      );
    throw error;
  });
const lines = (values: readonly unknown[]) =>
  new Blob(
    [
      values.map((value) => JSON.stringify(value)).join('\n') +
        (values.length ? '\n' : ''),
    ],
    { type: 'application/x-ndjson' },
  );
const csvCell = (value: unknown) =>
  `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = (headers: string[], rows: unknown[][]) =>
  new Blob(
    [
      [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') +
        '\n',
    ],
    { type: 'text/csv' },
  );

function trace(recording: RecordedSession, kind: AdaptiveTraceRecord['kind']) {
  return recording.adaptiveTrace.filter((item) => item.kind === kind);
}

export function createStudyArtifactBundle(
  recording: RecordedSession,
  audio: CapturedAudio | null,
  errors: readonly string[] = [],
  rawEeg: Blob | null = null,
): StudyArtifactBundle {
  const participantId = recording.metadata.participantId ?? 'UNASSIGNED';
  const sessionId = recording.metadata.sessionId;
  const recordedErrors = trace(recording, 'llm-error').map(
    (item) => `${item.timestampMs}ms · ${item.summary}`,
  );
  const allErrors = [...recordedErrors, ...errors];
  const files: StudyArtifact[] = [
    {
      filename: 'calibration-profile.json',
      mimeType: 'application/json',
      content: json(recording.calibrationProfile ?? mockCalibrationProfile),
    },
    {
      filename: 'eeg-epochs.csv',
      mimeType: 'text/csv',
      content: csv(
        ['timestampMs', 'theta', 'beta', 'logTbr', 'tbrBaseline', 'valid', 'qualityScore', 'artifactFlags'],
        (recording.eegMetrics ?? []).map((item) => [
          item.timestampMs, item.theta, item.beta, item.tbr, item.tbrBaseline,
          item.valid, item.qualityScore, item.artifactFlags.join('|'),
        ]),
      ),
    },
    {
      filename: 'attention-states.csv',
      mimeType: 'text/csv',
      content: csv(
        [
          'timestampMs',
          'currentLogTbr',
          'baselineLogTbr',
          'baselineMad',
          'baselineScale',
          'effectiveBaselineScale',
          'deltaFromBaseline',
          'tbrRatioToBaseline',
          'tbrPercentChange',
          'robustDeltaFromBaseline',
          'baselineRelation',
          'trajectory',
          'robustDeltaSlope',
          'measurementConfidence',
          'signalQuality',
          'stateEstimationVersion',
          'trend',
          'variabilityMad',
          'sustainedElevatedWindows',
          'sustainedReducedWindows',
          'phase',
          'confidence',
          'validEpochCount',
        ],
        recording.neuroStates.map((item) => {
          const attention = item.attention;
          const baseline =
            attention && 'baselineLogTbr' in attention
              ? attention
              : undefined;
          return [
            item.timestampMs,
            attention?.currentLogTbr,
            baseline?.baselineLogTbr,
            baseline?.baselineMad,
            baseline?.baselineScale,
            baseline?.effectiveBaselineScale,
            baseline?.deltaFromBaseline,
            baseline?.tbrRatioToBaseline,
            baseline?.tbrPercentChange,
            baseline?.robustDeltaFromBaseline,
            baseline?.baselineRelation,
            attention?.trajectory,
            baseline?.robustDeltaSlope,
            attention?.measurementConfidence,
            attention?.signalQuality,
            attention?.stateEstimationVersion,
            attention?.trend,
            attention?.variabilityMad,
            baseline?.sustainedElevatedWindows,
            baseline?.sustainedReducedWindows,
            attention?.phase,
            item.confidence,
            attention?.validEpochCount,
          ];
        }),
      ),
    },
    {
      filename: 'eligibility-decisions.jsonl',
      mimeType: 'application/x-ndjson',
      content: lines(trace(recording, 'eligibility')),
    },
    {
      filename: 'decision-1.jsonl',
      mimeType: 'application/x-ndjson',
      content: lines(trace(recording, 'decision-1')),
    },
    {
      filename: 'decision-2.jsonl',
      mimeType: 'application/x-ndjson',
      content: lines(trace(recording, 'decision-2')),
    },
    {
      filename: 'scene-journey-plans.jsonl',
      mimeType: 'application/x-ndjson',
      content: lines(recording.sceneJourneyPlans),
    },
    {
      filename: 'runtime-events.jsonl',
      mimeType: 'application/x-ndjson',
      content: lines(
        [
          ...recording.sessionEvents.map((item) => ({
            ...item,
            stream: 'session',
          })),
          ...recording.plannerEvents.map((item) => ({
            ...item,
            stream: 'planner',
          })),
        ].sort((a, b) => a.timestampMs - b.timestampMs),
      ),
    },
    {
      filename: 'final-session-bundle.json',
      mimeType: 'application/json',
      content: json(recording),
    },
    {
      filename: 'errors.log',
      mimeType: 'text/plain',
      content: new Blob(
        [
          allErrors.length
            ? `${allErrors.join('\n')}\n`
            : 'No recorded finalization errors.\n',
        ],
        {
          type: 'text/plain',
        },
      ),
    },
  ];
  if (audio)
    files.push({
      filename: `spatial-audio-mix.${audio.extension}`,
      mimeType: audio.mimeType,
      content: audio.blob,
    });
  if (rawEeg)
    files.push({
      filename: 'raw_eeg.csv',
      mimeType: 'text/csv',
      content: rawEeg,
    });
  const manifest = {
    participantId,
    sessionId,
    createdAt: new Date().toISOString(),
    schemaVersion: '1.0',
    logicalDurationMs: recording.metadata.durationMs,
    runMode: recording.metadata.runMode,
    plannerMode: recording.metadata.plannerMode,
    capturedAudioDurationMs: audio?.durationMs ?? null,
    audioMimeType: audio?.mimeType ?? null,
    errorCount: allErrors.length,
    files: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      bytes: file.content.size,
    })),
  };
  files.unshift({
    filename: 'manifest.json',
    mimeType: 'application/json',
    content: json(manifest),
  });
  return {
    participantId,
    sessionId,
    folderName: `${participantId}/${sessionId}`,
    files,
  };
}

export async function saveBundleToBackend(
  bundle: StudyArtifactBundle,
): Promise<string> {
  await uploadBundleToBackend(bundle);
  const prefix = `/api/study/sessions/${encodeURIComponent(bundle.participantId)}/${encodeURIComponent(bundle.sessionId)}`;
  const finalized = await saveFetch(`${prefix}/finalize`, { method: 'POST' });
  if (!finalized.ok)
    throw new Error(
      `Failed to finalize local study folder: HTTP ${finalized.status}`,
    );
  const result = (await finalized.json()) as { directory?: string };
  return result.directory ?? bundle.folderName;
}

export async function uploadBundleToBackend(
  bundle: StudyArtifactBundle,
): Promise<void> {
  const prefix = `/api/study/sessions/${encodeURIComponent(bundle.participantId)}/${encodeURIComponent(bundle.sessionId)}`;
  const health = await saveFetch('/api/study/health');
  if (!health.ok) throw new Error('Local study recorder is unavailable.');
  for (const file of bundle.files) {
    const response = await saveFetch(
      `${prefix}/artifacts/${encodeURIComponent(file.filename)}`,
      {
        method: 'PUT',
        headers: { 'content-type': file.mimeType },
        body: file.content,
      },
    );
    if (!response.ok)
      throw new Error(
        `Failed to save ${file.filename}: HTTP ${response.status}`,
      );
  }
}

export async function downloadStudyZip(
  bundle: StudyArtifactBundle,
): Promise<void> {
  const zip = new JSZip();
  for (const file of bundle.files) zip.file(file.filename, file.content);
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 4 },
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `neuroscape-${bundle.participantId}-${bundle.sessionId}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}
