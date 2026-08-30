import type {
  ActionPlanItem,
  AmbientPlanItem,
  EventPlanItem,
  SceneJourneyPlan,
} from '@neuroscape/contracts';
import { canonicalPlaybackPolicy } from '@neuroscape/contracts';
import type { AdaptivePlannerConfig } from './config.js';

export const BASE_PLAN_VERSION = 'base_plan_v5_constrained_journey';
export const ASSIGNMENT_RULE_VERSION = 'shared_base_v1';

export type BasePlanPhaseId =
  'settling' | 'deepening' | 'sustaining' | 'closing';
export type BasePlanLayer = 'ambient' | 'event' | 'action';
export type BasePlanDensity = 'low' | 'medium';
export type BasePlanFlexibility = 'low' | 'medium' | 'high';

export interface BasePlanProfile {
  profileId: string;
  durationMs: number;
  sceneFamily: string;
  complexityEnvelopeId: 'meditation_restrained_v1';
  maxConcurrentSources: number;
  maxAmbientLayers: number;
  maxEventsPerMinute: number;
  maxBodyAnchorsPerMinute: number;
  maxSalienceLoad: number;
  reservedAdaptationHeadroom: number;
}

export interface BasePlanPhase {
  phaseId: BasePlanPhaseId;
  startMs: number;
  endMs: number;
  targetDensity: BasePlanDensity;
  adaptationFlexibility: BasePlanFlexibility;
}

export interface BasePlanElement {
  elementId: string;
  assetId: string;
  layer: BasePlanLayer;
  startMs: number;
  endMs: number;
  gain: number;
  salience: number;
  assetFamily: string;
  spatialBehavior: string;
  adjustable: boolean;
  replaceable: boolean;
  suppressible: boolean;
  payload: AmbientPlanItem | ActionPlanItem | EventPlanItem;
  /** Persistent acoustic identity established for an arrived graph node. */
  destinationFoundationFor?: string;
}

export interface BaseScenePlan {
  planId: 'forest_base';
  version: typeof BASE_PLAN_VERSION;
  profile: BasePlanProfile;
  phases: BasePlanPhase[];
  scheduledElements: BasePlanElement[];
  journey: SceneJourneyPlan['userJourney'];
  transitionPolicy: SceneJourneyPlan['transitionPolicy'];
}

export interface BasePlanMetrics {
  durationMs: number;
  phaseCount: number;
  ambientCount: number;
  eventCount: number;
  bodyAnchorCount: number;
  peakConcurrentSources: number;
  peakSalienceLoad: number;
  spatialMovementCount: number;
  assetFamilies: number;
}

export interface BasePlanAssignment {
  participantId: string;
  conditionOrder: ['non_adaptive', 'adaptive'] | ['adaptive', 'non_adaptive'];
  basePlanId: BaseScenePlan['planId'];
  assignmentRuleVersion: typeof ASSIGNMENT_RULE_VERSION;
}

const phases = (): BasePlanPhase[] => [
  {
    phaseId: 'settling',
    startMs: 0,
    endMs: 120_000,
    targetDensity: 'low',
    adaptationFlexibility: 'low',
  },
  {
    phaseId: 'deepening',
    startMs: 120_000,
    endMs: 260_000,
    targetDensity: 'medium',
    adaptationFlexibility: 'medium',
  },
  {
    phaseId: 'sustaining',
    startMs: 260_000,
    endMs: 540_000,
    targetDensity: 'low',
    adaptationFlexibility: 'high',
  },
  {
    phaseId: 'closing',
    startMs: 540_000,
    endMs: 600_000,
    targetDensity: 'low',
    adaptationFlexibility: 'low',
  },
];

function profile(config: AdaptivePlannerConfig): BasePlanProfile {
  return {
    profileId: 'forest_ambient_only_v1',
    durationMs: config.sessionDurationMs,
    sceneFamily: 'forest',
    complexityEnvelopeId: 'meditation_restrained_v1',
    maxConcurrentSources: config.maxConcurrentSources,
    maxAmbientLayers: config.maxAmbientLayers,
    maxEventsPerMinute: config.maxEventsPerMinute,
    maxBodyAnchorsPerMinute: config.maxBodyAnchorsPerMinute,
    maxSalienceLoad: config.maxSalienceLoad,
    reservedAdaptationHeadroom: config.reservedAdaptationHeadroom,
  };
}

const ambient = (
  id: string,
  assetId: string,
  gain: number,
): BasePlanElement => ({
  elementId: id,
  assetId,
  layer: 'ambient',
  startMs: 0,
  endMs: 600_000,
  gain,
  salience: 0.2,
  assetFamily: 'forest_ambient',
  spatialBehavior: 'global_stable',
  adjustable: true,
  replaceable: true,
  suppressible: false,
  payload: { id, assetId, mode: 'global', gain, active: true },
});

export function createForestBasePlan(
  config: AdaptivePlannerConfig,
): BaseScenePlan {
  return {
    planId: 'forest_base',
    version: BASE_PLAN_VERSION,
    profile: profile(config),
    phases: phases(),
    journey: {
      goal: 'Begin from a stable forest clearing and allow restrained adaptive journey progression',
      waypoints: [{ locationId: 'forest_clearing', arrivalTimeMs: 0 }],
    },
    transitionPolicy: {
      defaultDurationMs: 5_000,
      curve: 'smoothstep' as const,
    },
    scheduledElements: [ambient('base-ambient', 'forest_ambient_bed_01', 0.38)],
  };
}

export function measureBasePlan(plan: BaseScenePlan): BasePlanMetrics {
  const points = [
    ...new Set(plan.scheduledElements.flatMap((e) => [e.startMs, e.endMs])),
  ];
  const activeAt = (t: number) =>
    plan.scheduledElements.filter((e) => e.startMs <= t && t < e.endMs);
  return {
    durationMs: plan.profile.durationMs,
    phaseCount: plan.phases.length,
    ambientCount: plan.scheduledElements.filter((e) => e.layer === 'ambient')
      .length,
    eventCount: plan.scheduledElements.filter((e) => e.layer === 'event')
      .length,
    bodyAnchorCount: plan.scheduledElements.filter((e) => e.layer === 'action')
      .length,
    peakConcurrentSources: Math.max(
      ...points.map((t) => activeAt(t).length),
      0,
    ),
    peakSalienceLoad: Math.max(
      ...points.map((t) => activeAt(t).reduce((sum, e) => sum + e.salience, 0)),
      0,
    ),
    spatialMovementCount: plan.scheduledElements.filter((e) =>
      e.spatialBehavior.includes('moving'),
    ).length,
    assetFamilies: new Set(plan.scheduledElements.map((e) => e.assetFamily))
      .size,
  };
}

export function validateBasePlan(plan: BaseScenePlan): string[] {
  const m = measureBasePlan(plan);
  const p = plan.profile;
  const errors: string[] = [];
  if (m.durationMs !== 600_000)
    errors.push('base_plan_duration_must_be_600_seconds');
  if (
    plan.phases[0]?.startMs !== 0 ||
    plan.phases.at(-1)?.endMs !== p.durationMs
  )
    errors.push('base_plan_phases_do_not_cover_duration');
  if (
    m.peakConcurrentSources >
    p.maxConcurrentSources - Math.ceil(p.reservedAdaptationHeadroom)
  )
    errors.push('reserved_adaptation_headroom_missing');
  if (m.peakSalienceLoad > p.maxSalienceLoad - p.reservedAdaptationHeadroom)
    errors.push('base_plan_salience_headroom_missing');
  return errors;
}

export function assignSharedBasePlan(
  participantId: string,
  adaptiveFirst?: boolean,
): BasePlanAssignment {
  const participantNumber = Number.parseInt(
    participantId.replace(/^P0*/i, ''),
    10,
  );
  const resolvedAdaptiveFirst =
    adaptiveFirst ??
    (Number.isInteger(participantNumber) && participantNumber % 2 === 0);
  return {
    participantId,
    conditionOrder: resolvedAdaptiveFirst
      ? ['adaptive', 'non_adaptive']
      : ['non_adaptive', 'adaptive'],
    basePlanId: 'forest_base',
    assignmentRuleVersion: ASSIGNMENT_RULE_VERSION,
  };
}

export type StudyOrder = 'AB' | 'BA';
export function recommendedStudyOrder(participantId: string): StudyOrder {
  return assignSharedBasePlan(participantId).conditionOrder[0] === 'adaptive'
    ? 'BA'
    : 'AB';
}

export function materializeBasePlan(plan: BaseScenePlan): SceneJourneyPlan {
  const hydrate = <T extends AmbientPlanItem | ActionPlanItem | EventPlanItem>(
    element: BasePlanElement,
  ): T => {
    const payload = structuredClone(element.payload) as T;
    payload.playback = canonicalPlaybackPolicy(element.assetId, element.gain);
    return payload;
  };
  return {
    planId: plan.planId,
    planningHorizonSec: plan.profile.durationMs / 1000,
    reasoningSummary:
      'Ambient-only shared Base Plan; the opening voice is played by the session audio layer and maintain preserves continuous forest ambience.',
    userJourney: structuredClone(plan.journey),
    soundscape: {
      ambient: plan.scheduledElements
        .filter((e) => e.layer === 'ambient')
        .map((e) => ({
          ...hydrate<AmbientPlanItem>(e),
          startMs: e.startMs,
          endMs: e.endMs,
        })),
      action: plan.scheduledElements
        .filter((e) => e.layer === 'action')
        .map((e) => ({
          ...hydrate<ActionPlanItem>(e),
          startMs: e.startMs,
          endMs: e.endMs,
        })),
      event: plan.scheduledElements
        .filter((e) => e.layer === 'event')
        .map((e) => hydrate<EventPlanItem>(e)),
    },
    transitionPolicy: structuredClone(plan.transitionPolicy),
  };
}
