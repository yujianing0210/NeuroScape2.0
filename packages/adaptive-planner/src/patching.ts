import type { AdaptivePlannerConfig } from './config.js';
import {
  audioLibraryById,
  canonicalPlaybackPolicy,
  getSceneNode,
  getSemanticAudioAsset,
  normalizeLegacyLocationId,
} from '@neuroscape/contracts';
import {
  measureBasePlan,
  type BasePlanElement,
  type BaseScenePlan,
} from './base-plan.js';
import type { AdaptationIntent, AdaptationSalience } from './types.js';
import type { AdaptationDecision, SoundscapePlanPatch } from './types.js';

export const PATCH_POLICY_VERSION = 'future_patch_v1';
export type PatchOperationKind =
  'KEEP' | 'ADJUST' | 'RESCHEDULE' | 'REPLACE' | 'SUPPRESS' | 'INSERT';
export interface FuturePatchOperation {
  operation: PatchOperationKind;
  targetElementId?: string;
  effectiveStartMs: number;
  transitionMs: number;
  gain?: number;
  replacementAssetId?: string;
  insertedElement?: BasePlanElement;
  /** Deterministic runtime support, not authored by Decision 2. */
  systemGenerated?:
    'scene_transition_footsteps' | 'scene_transition_foundation_handoff';
  destinationFoundationFor?: string;
}
export interface AdaptationHypothesis {
  mechanismCode: string;
  expectedResponseCode:
    | 'REDUCE_VARIABILITY_OR_HALT_DECLINE'
    | 'PRESERVE_STABILITY'
    | 'GENTLE_REORIENTATION';
  failureSignalCode:
    | 'CONTINUED_DECLINE_WITH_VALID_SIGNAL'
    | 'INCREASED_VARIABILITY'
    | 'LOSS_OF_STABILITY';
}
export interface FutureScenePatch {
  adaptationId: string;
  status: 'PATCH_PROPOSED' | 'NO_SAFE_PATCH';
  intent: AdaptationIntent;
  salience: AdaptationSalience;
  operations: FuturePatchOperation[];
  preservedElementIds: string[];
  hypothesis: AdaptationHypothesis;
  priorAdaptationIds: string[];
  lessonCode: string | null;
  lessonConfidence: 'high' | 'medium' | 'low' | 'unavailable';
  reasonCodes: string[];
  journeyUpdate?: {
    fromNodeId: string;
    toNodeId: string;
    arrivalTimeMs: number;
  };
}
export interface ComplexityProjection {
  projectedConcurrentSources: number;
  projectedAmbientLayers: number;
  projectedEventRate: number;
  projectedBodyAnchorRate: number;
  projectedSalienceLoad: number;
  projectedTransitionOverlap: number;
  recentAssetRepetition: number;
  cumulativePatchCount: number;
  usesReservedHeadroom: boolean;
}
export interface PatchValidationResult {
  valid: boolean;
  violations: string[];
  projection: ComplexityProjection;
  projectedPlan?: BaseScenePlan;
}

function applyOperation(
  elements: BasePlanElement[],
  operation: FuturePatchOperation,
): void {
  const index = operation.targetElementId
    ? elements.findIndex((e) => e.elementId === operation.targetElementId)
    : -1;
  if (operation.operation === 'KEEP') return;
  if (operation.operation === 'INSERT' && operation.insertedElement) {
    const inserted = structuredClone(operation.insertedElement);
    if (operation.destinationFoundationFor)
      inserted.destinationFoundationFor = operation.destinationFoundationFor;
    elements.push(inserted);
    return;
  }
  if (index < 0) return;
  const target = elements[index]!;
  if (operation.destinationFoundationFor) {
    target.destinationFoundationFor = operation.destinationFoundationFor;
    if (target.layer === 'ambient') {
      const payload = target.payload as {
        mode: 'global' | 'localized';
        locationId?: string;
      };
      payload.mode = 'localized';
      payload.locationId = operation.destinationFoundationFor;
    }
  }
  if (operation.operation === 'SUPPRESS') {
    elements.splice(index, 1);
    return;
  }
  if (operation.operation === 'ADJUST' && operation.gain !== undefined) {
    target.gain = operation.gain;
    (target.payload as { gain: number }).gain = operation.gain;
  }
  if (operation.operation === 'RESCHEDULE') {
    const duration = target.endMs - target.startMs;
    target.startMs = operation.effectiveStartMs;
    target.endMs = target.startMs + duration;
    if (target.layer === 'event') {
      const payload = target.payload as {
        activationTimeMs: number;
        trajectory: Array<{ timestampMs: number }>;
      };
      const shift = target.startMs - payload.activationTimeMs;
      payload.activationTimeMs = target.startMs;
      payload.trajectory.forEach((waypoint) => {
        waypoint.timestampMs += shift;
      });
    }
  }
  if (operation.operation === 'REPLACE' && operation.replacementAssetId) {
    target.assetId = operation.replacementAssetId;
    target.assetFamily = operation.replacementAssetId.replace(/_\d+$/, '');
    (target.payload as { assetId: string }).assetId =
      operation.replacementAssetId;
    (
      target.payload as {
        playback?: import('@neuroscape/contracts').PlaybackPolicy;
      }
    ).playback = canonicalPlaybackPolicy(
      operation.replacementAssetId,
      target.gain,
    );
  }
}

export function validateAndProjectPatch(options: {
  basePlan: BaseScenePlan;
  acceptedPatches: readonly FutureScenePatch[];
  proposedPatch: FutureScenePatch;
  nowMs: number;
  config: AdaptivePlannerConfig;
  recentAssetIds?: readonly string[];
}): PatchValidationResult {
  const { basePlan, acceptedPatches, proposedPatch, nowMs, config } = options;
  const violations: string[] = [];
  const freezeEnd = nowMs + config.executionFreezeBufferMs;
  const horizonEnd = freezeEnd + config.patchHorizonMs;
  if (proposedPatch.status === 'NO_SAFE_PATCH')
    return {
      valid: true,
      violations,
      projection: projection(
        basePlan,
        acceptedPatches.length,
        options.recentAssetIds,
      ),
    };
  if (
    proposedPatch.operations.filter((operation) => !operation.systemGenerated)
      .length > config.maxPatchOperations
  )
    violations.push('too_many_patch_operations');
  for (const op of proposedPatch.operations) {
    if (op.effectiveStartMs < freezeEnd)
      violations.push('operation_inside_freeze_buffer');
    if (op.effectiveStartMs > horizonEnd)
      violations.push('operation_outside_patch_horizon');
    const target = op.targetElementId
      ? basePlan.scheduledElements.find(
          (e) => e.elementId === op.targetElementId,
        )
      : undefined;
    if (op.operation !== 'INSERT' && !target)
      violations.push('unknown_target_element');
    if (
      target &&
      target.startMs >= nowMs &&
      target.startMs < freezeEnd &&
      op.operation !== 'KEEP'
    )
      violations.push('target_is_immutable');
    if (target && target.endMs <= nowMs && op.operation !== 'KEEP')
      violations.push('target_already_finished');
    if (
      op.operation === 'INSERT' &&
      op.insertedElement &&
      basePlan.scheduledElements.some(
        (element) =>
          element.assetId === op.insertedElement!.assetId &&
          element.startMs <= nowMs &&
          nowMs < element.endMs,
      )
    )
      violations.push('duplicate_active_asset_insert');
    if (op.operation === 'ADJUST' && !target?.adjustable)
      violations.push('target_not_adjustable');
    if (op.operation === 'REPLACE' && !target?.replaceable)
      violations.push('target_not_replaceable');
    if (
      op.operation === 'SUPPRESS' &&
      !target?.suppressible &&
      op.systemGenerated !== 'scene_transition_foundation_handoff'
    )
      violations.push('target_not_suppressible');
  }
  const projectedPlan = structuredClone(basePlan);
  proposedPatch.operations.forEach((op) => {
    applyOperation(projectedPlan.scheduledElements, op);
    if (op.operation === 'KEEP' || op.operation === 'SUPPRESS') return;
    const elementId = op.insertedElement?.elementId ?? op.targetElementId;
    const element = projectedPlan.scheduledElements.find(
      (candidate) => candidate.elementId === elementId,
    );
    if (element)
      (element.payload as { adaptationId?: string }).adaptationId =
        proposedPatch.adaptationId;
  });
  if (proposedPatch.journeyUpdate) {
    const update = proposedPatch.journeyUpdate;
    const current = normalizeLegacyLocationId(
      projectedPlan.journey.waypoints.at(-1)?.locationId ?? 'forest_clearing',
    );
    if (current !== update.fromNodeId)
      violations.push('journey_origin_mismatch');
    else
      projectedPlan.journey.waypoints.push({
        locationId: update.toNodeId,
        arrivalTimeMs: update.arrivalTimeMs,
      });
  }
  for (const element of projectedPlan.scheduledElements) {
    if (element.startMs >= basePlan.profile.durationMs)
      violations.push('element_starts_at_or_after_session_end');
    if (element.endMs > basePlan.profile.durationMs)
      violations.push('element_ends_after_session_end');
    if (element.layer === 'event') {
      const payload = element.payload as {
        activationTimeMs: number;
        durationMs: number;
        trajectory?: Array<{ timestampMs: number }>;
      };
      if (
        payload.activationTimeMs + payload.durationMs >
          basePlan.profile.durationMs ||
        payload.trajectory?.some(
          (waypoint) => waypoint.timestampMs > basePlan.profile.durationMs,
        ) === true
      )
        violations.push('event_payload_ends_after_session_end');
    }
  }
  const projected = projection(
    projectedPlan,
    acceptedPatches.length + 1,
    options.recentAssetIds,
  );
  if (projected.projectedConcurrentSources > config.maxConcurrentSources)
    violations.push('concurrent_source_budget_exceeded');
  if (projected.projectedAmbientLayers > config.maxAmbientLayers)
    violations.push('ambient_layer_budget_exceeded');
  if (projected.projectedEventRate > config.maxEventsPerMinute)
    violations.push('event_rate_budget_exceeded');
  if (projected.projectedBodyAnchorRate > config.maxBodyAnchorsPerMinute)
    violations.push('body_anchor_rate_budget_exceeded');
  if (projected.projectedSalienceLoad > config.maxSalienceLoad)
    violations.push('salience_budget_exceeded');
  if (projected.cumulativePatchCount > config.maxCumulativePatches)
    violations.push('PATCH_BUDGET_EXHAUSTED');
  if (proposedPatch.journeyUpdate) {
    const destination = getSceneNode(proposedPatch.journeyUpdate.toNodeId);
    const destinationCoverage = new Set([
      ...(destination?.audio_coverage.foundation ?? []),
    ]);
    const selectedPersistentFoundation = proposedPatch.operations.some(
      (operation) => {
        const assetId =
          operation.insertedElement?.assetId ?? operation.replacementAssetId;
        if (
          !assetId ||
          !destinationCoverage.has(assetId) ||
          operation.destinationFoundationFor !==
            proposedPatch.journeyUpdate!.toNodeId
        )
          return false;
        const technical = audioLibraryById.get(assetId);
        const semantic = getSemanticAudioAsset(assetId);
        if (
          technical?.layer !== 'ambient' ||
          technical.playback_contract?.mode !== 'long_bed' ||
          !semantic?.semantic_function.includes('foundation')
        )
          return false;
        const element = projectedPlan.scheduledElements.find(
          (candidate) => candidate.assetId === assetId,
        );
        return Boolean(
          element &&
          element.startMs <=
            proposedPatch.journeyUpdate!.arrivalTimeMs +
              basePlan.transitionPolicy.defaultDurationMs &&
          element.endMs - proposedPatch.journeyUpdate!.arrivalTimeMs >=
            config.destinationStabilizationMinMs,
        );
      },
    );
    if (!selectedPersistentFoundation)
      violations.push('DESTINATION_ACOUSTIC_FOUNDATION_MISSING');
  }
  const projectedCurrentNode = normalizeLegacyLocationId(
    projectedPlan.journey.waypoints.at(-1)?.locationId ?? 'forest_clearing',
  );
  if (projectedCurrentNode !== 'forest_clearing') {
    const identityPersists = projectedPlan.scheduledElements.some(
      (element) =>
        element.destinationFoundationFor === projectedCurrentNode &&
        element.layer === 'ambient' &&
        element.endMs - nowMs >= config.destinationStabilizationMinMs,
    );
    if (!identityPersists)
      violations.push('DESTINATION_ACOUSTIC_FOUNDATION_MISSING');
  }
  return {
    valid: violations.length === 0,
    violations: [...new Set(violations)],
    projection: projected,
    ...(violations.length ? {} : { projectedPlan }),
  };
}

function projection(
  plan: BaseScenePlan,
  cumulativePatchCount: number,
  recentAssetIds: readonly string[] = [],
): ComplexityProjection {
  const metrics = measureBasePlan(plan);
  const minutes = plan.profile.durationMs / 60_000;
  const events = plan.scheduledElements.filter((e) => e.layer === 'event');
  const actions = plan.scheduledElements.filter((e) => e.layer === 'action');
  const repetitions = plan.scheduledElements.filter((e) =>
    recentAssetIds.includes(e.assetId),
  ).length;
  return {
    projectedConcurrentSources: metrics.peakConcurrentSources,
    projectedAmbientLayers: metrics.ambientCount,
    projectedEventRate: events.length / minutes,
    projectedBodyAnchorRate: actions.length / minutes,
    projectedSalienceLoad: metrics.peakSalienceLoad,
    projectedTransitionOverlap: 0,
    recentAssetRepetition: repetitions,
    cumulativePatchCount,
    usesReservedHeadroom:
      metrics.peakConcurrentSources >
        plan.profile.maxConcurrentSources -
          Math.ceil(plan.profile.reservedAdaptationHeadroom) ||
      metrics.peakSalienceLoad >
        plan.profile.maxSalienceLoad - plan.profile.reservedAdaptationHeadroom,
  };
}

export function normalizeLegacyPlanPatch(options: {
  adaptationId: string;
  patch: SoundscapePlanPatch;
  decision: AdaptationDecision;
  basePlan: BaseScenePlan;
  nowMs: number;
  freezeBufferMs: number;
}): FutureScenePatch {
  const { patch, decision, basePlan, nowMs, freezeBufferMs } = options;
  const earliest = nowMs + freezeBufferMs;
  const operations: FuturePatchOperation[] = [];
  let sessionBoundaryRejected = false;
  for (const id of patch.removeIds ?? []) {
    const target = basePlan.scheduledElements.find((e) => e.elementId === id);
    operations.push({
      operation: 'SUPPRESS',
      targetElementId: id,
      effectiveStartMs: Math.max(earliest, target?.startMs ?? earliest),
      transitionMs: patch.transitionDurationMs ?? 0,
    });
  }
  const upserts = [
    ...(patch.upsertAmbient ?? []).map((payload) => {
      // Strict structured outputs represent an omitted optional field as null.
      // Module 03 requires global ambient sources to omit locationId entirely.
      const normalizedPayload = structuredClone(payload);
      if (normalizedPayload.mode === 'global')
        delete normalizedPayload.locationId;
      return {
        layer: 'ambient' as const,
        payload: normalizedPayload,
      };
    }),
    ...(patch.upsertAction ?? []).map((payload) => ({
      layer: 'action' as const,
      payload: structuredClone(payload),
    })),
    ...(patch.upsertEvent ?? []).map((payload) => ({
      layer: 'event' as const,
      payload: structuredClone(payload),
    })),
  ];
  for (const { layer, payload } of upserts) {
    if (earliest >= basePlan.profile.durationMs) {
      sessionBoundaryRejected = true;
      continue;
    }
    const target = basePlan.scheduledElements.find(
      (e) => e.elementId === payload.id,
    );
    // The runtime owns absolute session timing. Decision 2 may describe event
    // motion, but its activation timestamp is never trusted because the model
    // response arrives after the checkpoint that produced the prompt.
    const startMs = earliest;
    if (layer === 'event') {
      const eventPayload = payload as {
        activationTimeMs: number;
        durationMs: number;
        trajectory: Array<{ timestampMs: number }>;
        playback?: { durationPolicy?: string };
      };
      const shift = startMs - eventPayload.activationTimeMs;
      eventPayload.activationTimeMs = startMs;
      eventPayload.trajectory.forEach((waypoint) => {
        waypoint.timestampMs += shift;
      });
      const remainingMs = basePlan.profile.durationMs - startMs;
      if (eventPayload.durationMs > remainingMs) {
        if (eventPayload.playback?.durationPolicy !== 'truncate-at-end') {
          sessionBoundaryRejected = true;
          continue;
        }
        eventPayload.durationMs = remainingMs;
        eventPayload.trajectory.forEach((waypoint) => {
          waypoint.timestampMs = Math.min(
            waypoint.timestampMs,
            basePlan.profile.durationMs,
          );
        });
      }
    }
    if (target) {
      operations.push({
        operation: target.assetId === payload.assetId ? 'ADJUST' : 'REPLACE',
        targetElementId: target.elementId,
        effectiveStartMs: Math.max(startMs, target.startMs),
        transitionMs: patch.transitionDurationMs ?? 0,
        gain: payload.gain,
        ...(target.assetId === payload.assetId
          ? {}
          : { replacementAssetId: payload.assetId }),
      });
      continue;
    }
    const durationMs =
      layer === 'event'
        ? (payload as { durationMs: number }).durationMs
        : 60_000;
    operations.push({
      operation: 'INSERT',
      effectiveStartMs: startMs,
      transitionMs: patch.transitionDurationMs ?? 0,
      insertedElement: {
        elementId: payload.id,
        assetId: payload.assetId,
        layer,
        startMs,
        endMs: Math.min(basePlan.profile.durationMs, startMs + durationMs),
        gain: payload.gain,
        salience:
          decision.salience === 'moderate'
            ? 0.45
            : decision.salience === 'low'
              ? 0.25
              : 0.15,
        assetFamily: payload.assetId.replace(/_\d+$/, ''),
        spatialBehavior: 'decision_2_authored',
        adjustable: true,
        replaceable: true,
        suppressible: true,
        payload: structuredClone(payload),
      },
    });
  }
  return {
    adaptationId: options.adaptationId,
    status: operations.length ? 'PATCH_PROPOSED' : 'NO_SAFE_PATCH',
    intent: decision.intent,
    salience: decision.salience,
    operations,
    preservedElementIds: basePlan.scheduledElements
      .filter((e) => !patch.removeIds?.includes(e.elementId))
      .map((e) => e.elementId),
    hypothesis: {
      mechanismCode: decision.intent.toUpperCase(),
      expectedResponseCode:
        decision.intent === 'preserve_recovery' ||
        decision.intent === 'support_sustained_focus'
          ? 'PRESERVE_STABILITY'
          : decision.intent === 'gently_reorient_attention' ||
              decision.intent === 'refresh_engagement'
            ? 'GENTLE_REORIENTATION'
            : 'REDUCE_VARIABILITY_OR_HALT_DECLINE',
      failureSignalCode:
        decision.intent === 'preserve_recovery'
          ? 'LOSS_OF_STABILITY'
          : 'CONTINUED_DECLINE_WITH_VALID_SIGNAL',
    },
    priorAdaptationIds: [],
    lessonCode: null,
    lessonConfidence: 'unavailable',
    reasonCodes: [
      'COMPATIBILITY_NORMALIZED_PATCH',
      ...(operations.some((op) => op.operation === 'INSERT')
        ? ['NO_SMALLER_OPERATION_AVAILABLE']
        : ['MINIMAL_SUFFICIENT_PATCH']),
      'PRESERVE_BASE_CONTINUITY',
      ...(sessionBoundaryRejected ? ['SESSION_BOUNDARY_NO_SAFE_PATCH'] : []),
    ],
  };
}
