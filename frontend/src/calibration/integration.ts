import type {
  CalibrationProfile,
  TbrEpoch,
} from '@neuroscape/adaptive-planner';
import type { Profile } from './types.js';

const SUPPORTED_FEATURE_VERSION =
  'raw_welch_frontal_log_tbr_guided_baseline_protocol_v5';

interface LiveStartResponse {
  after_sample_index: number;
}

interface LiveEpochResponse {
  ready: boolean;
  available_samples?: number;
  required_samples?: number;
  end_sample_index?: number;
  log_tbr?: number | null;
  valid?: boolean;
  quality_score?: number;
  artifact_flags?: string[];
  theta?: number | null;
  beta?: number | null;
}

async function calibrationRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`/api/calibration${path}`, init);
  const payload = (await response.json()) as T & { detail?: string };
  if (!response.ok)
    throw new Error(
      payload.detail ?? `Calibration service failed (${response.status})`,
    );
  return payload;
}

export function toPlannerCalibrationProfile(
  profile: Profile,
): CalibrationProfile {
  const usable =
    profile.ready_to_continue &&
    profile.baseline_available &&
    profile.quality_status === 'pass' &&
    profile.baseline_log_tbr !== null &&
    profile.baseline_mad !== null &&
    profile.baseline_scale !== null &&
    profile.feature_version === SUPPORTED_FEATURE_VERSION;
  return {
    profileId: profile.session_id,
    participantId: profile.participant_id,
    baselineLogTbr: profile.baseline_log_tbr ?? 0,
    baselineMad: profile.baseline_mad ?? 0,
    baselineScale: profile.baseline_scale ?? 0,
    effectiveBaselineScale: profile.effective_baseline_scale,
    expectedEpochCount: 30,
    validEpochCount: profile.valid_epoch_count,
    invalidEpochCount: profile.invalid_epoch_count,
    baselineAvailable: usable,
    qualityStatus: usable ? 'pass' : 'fail',
    qualityIssues: [...profile.quality_issues],
    selfReportedFocus: profile.self_reported_focus,
    selfReportedDrowsiness: profile.self_reported_drowsiness,
    featureVersion: profile.feature_version,
  };
}

export class LiveEegEpochSource {
  #afterSampleIndex = -1;
  #recordingStartSampleIndex = -1;
  #epochNumber = 0;

  constructor(private readonly profileSessionId?: string) {}

  async start(): Promise<void> {
    const profilePath = this.profileSessionId
      ? `/live/start/${encodeURIComponent(this.profileSessionId)}`
      : '/live/start';
    const result = await calibrationRequest<LiveStartResponse>(profilePath, {
        method: 'POST',
      });
    this.#afterSampleIndex = result.after_sample_index;
    this.#recordingStartSampleIndex = result.after_sample_index;
    this.#epochNumber = 0;
  }

  rawCsv(): Promise<Blob> {
    return fetchRawEegCsv(this.#recordingStartSampleIndex);
  }

  async next(): Promise<TbrEpoch | null> {
    const result = await calibrationRequest<LiveEpochResponse>(
      `/live/epoch?after_sample_index=${this.#afterSampleIndex}`,
    );
    if (!result.ready || result.end_sample_index === undefined) return null;
    this.#afterSampleIndex = result.end_sample_index;
    this.#epochNumber += 1;
    return {
      timestampMs: this.#epochNumber * 10_000,
      logTbr: result.log_tbr ?? null,
      valid: result.valid === true,
      qualityScore: result.quality_score ?? 0,
      artifactFlags: result.artifact_flags ?? [],
      theta: result.theta ?? null,
      beta: result.beta ?? null,
    };
  }
}

interface ReplayProcessResponse {
  duration_seconds: number;
  epochs: Array<{
    timestamp_ms: number;
    theta: number | null;
    beta: number | null;
    log_tbr: number | null;
    valid: boolean;
    quality_score: number;
    artifact_flags: string[];
  }>;
}

export class ReplayEegEpochSource implements RawEegRecordingSource {
  #epochs: TbrEpoch[] = [];
  #index = 0;
  constructor(private readonly file: File) {}

  async start(): Promise<void> {
    const samples = parseRawEegCsv(await this.file.text());
    const result = await calibrationRequest<ReplayProcessResponse>(
      '/live/replay/process',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples }) },
    );
    this.#epochs = result.epochs.map((epoch) => ({
      timestampMs: epoch.timestamp_ms,
      theta: epoch.theta,
      beta: epoch.beta,
      logTbr: epoch.log_tbr,
      valid: epoch.valid,
      qualityScore: epoch.quality_score,
      artifactFlags: epoch.artifact_flags,
    }));
    this.#index = 0;
  }

  async next(sessionTimestampMs = 0): Promise<TbrEpoch | null> {
    const epoch = this.#epochs[this.#index];
    if (!epoch || epoch.timestampMs > sessionTimestampMs) return null;
    this.#index += 1;
    return structuredClone(epoch);
  }

  rawCsv(): Promise<Blob> {
    return Promise.resolve(this.file.slice(0, this.file.size, 'text/csv'));
  }
}

const requiredRawColumns = ['sample_index', 'monotonic_timestamp', 'tp9', 'af7', 'af8', 'tp10'];
export function parseRawEegCsv(csv: string): Array<Record<string, unknown>> {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('EEG CSV is empty.');
  const headers = lines[0]!.split(',').map((value) => value.trim());
  const missing = requiredRawColumns.filter((name) => !headers.includes(name));
  if (missing.length) throw new Error(`EEG CSV is missing required columns: ${missing.join(', ')}`);
  const numeric = new Set(['sample_index', 'monotonic_timestamp', 'session_elapsed_seconds', 'tp9', 'af7', 'af8', 'tp10', 'aux_right', 'hsi_tp9', 'hsi_af7', 'hsi_af8', 'hsi_tp10', 'acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z']);
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split(',');
    if (values.length !== headers.length) throw new Error(`Malformed EEG CSV row ${rowIndex + 2}.`);
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const value = values[index]?.trim() ?? '';
      if (numeric.has(header)) {
        if (!value && header !== 'session_elapsed_seconds' && header !== 'aux_right' && !header.startsWith('hsi_') && !header.startsWith('acc_') && !header.startsWith('gyro_'))
          throw new Error(`Missing ${header} at EEG CSV row ${rowIndex + 2}.`);
        const parsed = value === '' ? null : Number(value);
        if (parsed !== null && !Number.isFinite(parsed)) throw new Error(`Malformed ${header} at EEG CSV row ${rowIndex + 2}.`);
        row[header] = parsed;
      } else if (header === 'headband_on' || header === 'blink' || header === 'jaw_clench')
        row[header] = value === 'true' || value === 'True' || value === '1';
    });
    row.session_elapsed_seconds ??= null;
    return row;
  });
}

export interface RawEegRecordingSource {
  rawCsv(): Promise<Blob>;
}

export class LiveRawEegRecorder implements RawEegRecordingSource {
  #afterSampleIndex = -1;

  async start(): Promise<void> {
    const result = await calibrationRequest<LiveStartResponse>(
      '/live/recording/start',
      { method: 'POST' },
    );
    this.#afterSampleIndex = result.after_sample_index;
  }

  rawCsv(): Promise<Blob> {
    return fetchRawEegCsv(this.#afterSampleIndex);
  }
}

async function fetchRawEegCsv(afterSampleIndex: number): Promise<Blob> {
  const response = await fetch(
    `/api/calibration/live/raw.csv?after_sample_index=${afterSampleIndex}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    throw new Error(
      payload.detail ?? `Raw EEG export failed (${response.status})`,
    );
  }
  return response.blob();
}
