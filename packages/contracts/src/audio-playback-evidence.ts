export type AudioPlaybackEvidenceStatus =
  | 'PLAN_APPLIED'
  | 'RUNTIME_ACTIVATED'
  | 'AUDIO_STARTED'
  | 'AUDIO_FINISHED'
  | 'AUDIO_FAILED';

export type AudioPlaybackEndReason =
  'natural' | 'planned_end' | 'cancelled' | 'replaced' | 'session_ended';

export type AudioPlaybackTerminalStatus =
  | 'PLAYED'
  | 'ASSET_LOAD_FAILED'
  | 'SOURCE_CREATION_FAILED'
  | 'AUDIO_START_FAILED'
  | 'RUNTIME_CANCELLED';

export interface AudioPlaybackEvidence {
  adaptationId: string;
  elementId: string;
  assetId: string;
  layer: 'ambient' | 'action' | 'event';
  status: AudioPlaybackEvidenceStatus;
  timestampMs: number;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  audioStartMs?: number;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
  audioEndMs?: number;
  endReason?: AudioPlaybackEndReason;
  failureCode?: string;
  failureReason?: string;
  /** Exactly one terminal outcome is emitted for each activated one-shot. */
  playbackTerminalStatus?: AudioPlaybackTerminalStatus;
  decision2RequestStartMs?: number;
  decision2ResponseMs?: number;
  patchValidationCompleteMs?: number;
  planAppliedMs?: number;
  eligibleCandidateCount?: number;
  retrievedCandidateIds?: string[];
  recentlyUsedAssetIds?: string[];
  selectedAssetIds?: string[];
  selectedByDecision2?: boolean;
  systemGenerated?: boolean | 'scene_transition_locomotion';
  validated?: boolean;
}

/** General execution evidence for every source; adaptationId is deliberately optional. */
export interface AudioExecutionDiagnostic {
  adaptationId?: string;
  sourceId: string;
  assetId: string;
  layer: 'ambient' | 'action' | 'event';
  playbackState: 'loading' | 'playing' | 'stopped' | 'error';
  timestampMs: number;
  audioStartMs?: number;
  audioEndMs?: number;
  errorCode?: string;
  errorMessage?: string;
}
