export type State =
  | 'IDLE'
  | 'CONNECTION_CHECK'
  | 'READY'
  | 'ACCLIMATION'
  | 'ACCLIMATION_COMPLETE'
  | 'BLOCK_READY'
  | 'BLOCK_RECORDING'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'ERROR';

export type Condition = 'guided_breathing_baseline';
export interface WavePoint {
  sample_index: number;
  af7: number;
  af8: number;
}
export interface BaselineTask {
  task_id: string;
  sequence_number: number;
  condition: Condition;
  condition_label: string;
  condition_block_number: number;
  is_redo: boolean;
  redo_of_block_id: string | null;
  redo_reason: string[] | null;
}
export interface EEGQuality {
  status: 'pass' | 'invalid';
  reasons: string[];
  expected_epochs: number;
  total_epochs: number;
  valid_epochs: number;
  invalid_epochs: number;
  blink_epochs: number;
  packet_completeness: number;
  rejection_counts: Record<string, number>;
  channel_contributions: Record<string, number>;
  epoch_tbrs: (number | null)[];
}
export interface CalibrationBlock extends BaselineTask {
  block_id: string;
  actual_sequence_number: number;
  duration_seconds: number | null;
  completed_automatically: boolean | null;
  self_report: {
    focus: number | null;
    drowsiness: number | null;
    investigator_notes: string;
    unable_to_judge: boolean;
  } | null;
  eeg_quality: EEGQuality | null;
  eligible_for_baseline?: boolean;
  included_in_baseline: boolean;
}

export interface Status {
  state: State;
  session: { participant_id: string; session_id: string } | null;
  local_ipv4: string;
  osc_port: number;
  connection: {
    connected: boolean;
    total_eeg_samples: number;
    estimated_sample_rate_hz: number;
    last_packet_age_seconds: number | null;
    headband_on: boolean | null;
    hsi: Record<string, number | null>;
    packet_completeness: number;
    real_data_seconds: number;
    blink_events_session: number;
  };
  waveform: WavePoint[];
  markers: { event: string; session_elapsed_seconds: number }[];
  timing: {
    acclimation_duration_seconds: number;
    baseline_duration_seconds: number;
    active_elapsed_seconds: number;
    active_remaining_seconds: number;
    total_recorded_seconds: number;
  };
  protocol: {
    original_schedule: BaselineTask[];
    pending_tasks: BaselineTask[];
    next_block: BaselineTask | null;
    current_block: CalibrationBlock | null;
    completed_blocks: CalibrationBlock[];
    acclimation_attempts: Array<{
      attempt: number;
      completed_automatically: boolean;
      accepted: boolean | null;
    }>;
    current_acclimation: { attempt: number } | null;
    redos_planned: boolean;
    collection_decision: string;
  };
  processing_stage?: string;
}

export interface Profile {
  participant_id: string;
  session_id: string;
  sampling_rate_hz: number;
  feature_version: string;
  baseline_log_tbr: number | null;
  baseline_mad: number | null;
  baseline_scale: number | null;
  effective_baseline_scale: number;
  expected_epoch_count: 30;
  valid_epoch_count: number;
  invalid_epoch_count: number;
  baseline_available: boolean;
  collection_decision: 'ready_to_continue' | 'insufficient_after_redo';
  ready_to_continue: boolean;
  quality_status: 'pass' | 'fail';
  quality_issues: string[];
  self_reported_focus: number | null;
  self_reported_drowsiness: number | null;
  selected_baseline_id: string | null;
  blocks: CalibrationBlock[];
  quality: {
    packet_completeness: number;
    valid_frontal_fraction: number;
    baseline_summary: {
      channel_contributions: Record<string, number>;
    };
  };
}
