import type { SessionTimestampMs } from './neuro-state.js';
import type { DistancePolicy, PlaybackPolicy } from './scene-journey-plan.js';

export type Vector3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export interface ListenerState {
  worldPosition: Vector3;
  orientation: Quaternion;
  velocity: Vector3;
  semanticLocation: string;
}

export interface AmbientState {
  id: string;
  adaptationId?: string;
  assetId: string;
  mode: 'global' | 'localized';
  worldPosition?: Vector3;
  gain: number;
  active: boolean;
  lifecycle?: EventLifecycle;
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
}

export type ActionAttachment = 'head' | 'chest' | 'feet' | 'body';

export interface ActionState {
  id: string;
  adaptationId?: string;
  assetId: string;
  attachment: ActionAttachment;
  relativePosition: Vector3;
  worldPosition: Vector3;
  gain: number;
  active: boolean;
  lifecycle?: EventLifecycle;
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
}

export type EventLifecycle = 'waiting' | 'active' | 'finished';

export interface EventState {
  id: string;
  adaptationId?: string;
  assetId: string;
  worldPosition: Vector3;
  velocity: Vector3;
  gain: number;
  lifecycle: EventLifecycle;
  active: boolean;
  plannedStartMs?: number;
  runtimeActivationMs?: number;
  plannedEndMs?: number;
  runtimeFinishedMs?: number;
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
  foregroundSalience?: 'minimal' | 'low' | 'moderate';
  /** Normalized authored event envelope, kept separate from spatial gain. */
  foregroundEnvelope?: number;
}

export interface RuntimeJourneyState {
  plannedPath: Vector3[];
  currentSegmentIndex: number;
  remainingWaypoints: Vector3[];
}

export interface RuntimeWorldState {
  timestampMs: SessionTimestampMs;
  listener: ListenerState;
  journey?: RuntimeJourneyState;
  ambient: AmbientState[];
  action: ActionState[];
  event: EventState[];
}
