import type { ActionAttachment, Vector3 } from './runtime-world-state.js';

export type TransitionCurve = 'linear' | 'smoothstep';

/** Semantically meaningful playback choices. DSP and anti-click ramps are excluded. */
export interface PlaybackPolicy {
  mode: 'once' | 'loop' | 'repeat' | 'repeat-count' | 'loop-until-arrival';
  durationPolicy: 'natural' | 'loop-until-end' | 'truncate-at-end';
  repeatCount?: number;
  repeatGapMs?: number;
  perRepeatGain?: number[];
  /** Evenly distribute a finite burst over the remaining planned lifecycle. */
  spreadAcrossLifecycle?: boolean;
}

export type EventMotionMode =
  'stationary' | 'drift' | 'pass-by' | 'orbit-arc' | 'approach-recede';

export interface EventMotion {
  motionMode: EventMotionMode;
  startPosition: Vector3;
  endPosition: Vector3;
  controlPoint?: Vector3;
  arcDirection?: 'clockwise' | 'counterclockwise';
}

export interface DistancePolicy {
  mode: 'none' | 'inverse';
  referenceDistance?: number;
  maxDistance?: number;
  minGain?: number;
}

export interface JourneyWaypoint {
  locationId: string;
  arrivalTimeMs?: number;
  pauseDurationMs?: number;
}

export interface UserJourneyPlan {
  goal: string;
  waypoints: JourneyWaypoint[];
}

export interface AmbientPlanItem {
  id: string;
  adaptationId?: string;
  assetId: string;
  mode: 'global' | 'localized';
  locationId?: string;
  gain: number;
  active: boolean;
  /** Authoritative session-time execution window, when the item is scheduled. */
  startMs?: number;
  endMs?: number;
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
}

export interface ActionPlanItem {
  id: string;
  adaptationId?: string;
  assetId: string;
  attachment: ActionAttachment;
  relativePosition: Vector3;
  gain: number;
  active: boolean;
  /** Authoritative session-time execution window, when the item is scheduled. */
  startMs?: number;
  endMs?: number;
  activationCondition?: 'always' | 'listener-moving';
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
}

export interface EventTrajectoryWaypoint {
  locationId: string;
  timestampMs: number;
}

export interface EventPlanItem {
  id: string;
  adaptationId?: string;
  assetId: string;
  activationTimeMs: number;
  durationMs: number;
  trajectory?: EventTrajectoryWaypoint[];
  motion?: EventMotion;
  interpolation?: 'linear' | 'smoothstep';
  trajectoryUpdatePolicy?:
    'replace-at-effective-time' | 'continue-from-current-position';
  distancePolicy?: DistancePolicy;
  playback?: PlaybackPolicy;
  gain: number;
  /** Perceptual foreground request retained for deterministic runtime mixing. */
  foregroundSalience?: 'minimal' | 'low' | 'moderate';
}

export interface SoundscapePlan {
  ambient: AmbientPlanItem[];
  action: ActionPlanItem[];
  event: EventPlanItem[];
}

export interface TransitionPolicy {
  defaultDurationMs: number;
  curve: TransitionCurve;
}

export interface SceneJourneyPlan {
  planId: string;
  planningHorizonSec: number;
  reasoningSummary?: string;
  userJourney: UserJourneyPlan;
  soundscape: SoundscapePlan;
  transitionPolicy: TransitionPolicy;
}
