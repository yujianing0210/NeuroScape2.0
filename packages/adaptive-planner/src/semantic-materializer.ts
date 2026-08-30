import {
  audioLibraryById,
  canonicalPlaybackPolicy,
  getSceneEdgeBetween,
  getSceneNode,
  getSemanticAudioAsset,
  normalizeLegacyLocationId,
} from '@neuroscape/contracts';
import type { BasePlanElement, BaseScenePlan } from './base-plan.js';
import type { AdaptivePlannerConfig } from './config.js';
import type { FuturePatchOperation, FutureScenePatch } from './patching.js';
import type { AdaptationDecision, Decision2SemanticOutput } from './types.js';

export const SEMANTIC_MATERIALIZER_VERSION = 'semantic_materializer_v1';
export const SCENE_TRAVERSAL_DURATION_MS = 25_000;
const MIX_GAIN_MULTIPLIER = Object.freeze({
  default: 1,
  slightly_softer: 0.85,
  slightly_more_present: 1.1,
}); // TBD_PILOT

function gainFor(
  assetId: string,
  mix: keyof typeof MIX_GAIN_MULTIPLIER | null,
): number {
  const asset = audioLibraryById.get(assetId)!;
  const authored =
    asset.recommended_volume * (asset.gain_profile?.quality_attenuation ?? 1);
  return Math.min(
    authored * MIX_GAIN_MULTIPLIER[mix ?? 'default'],
    asset.gain_profile?.max_safe_gain ?? 1,
  );
}

function insertedElement(
  assetId: string,
  id: string,
  startMs: number,
  locationId: string,
  mix: keyof typeof MIX_GAIN_MULTIPLIER | null,
  base: BaseScenePlan,
  durationOverrideMs?: number,
  foregroundSalience?: AdaptationDecision['salience'],
): BasePlanElement | undefined {
  const asset = audioLibraryById.get(assetId);
  if (!asset?.playback_contract) return undefined;
  const gain = gainFor(assetId, mix);
  const playback = canonicalPlaybackPolicy(assetId, gain);
  const authoredLifecycleMs =
    (asset.playback_contract.resolved_lifecycle_sec ??
      asset.default_motion.duration ??
      asset.auto_delete_after_sec ??
      0) * 1_000;
  const durationMs =
    durationOverrideMs ??
    (asset.layer === 'ambient'
      ? base.profile.durationMs - startMs
      : asset.layer === 'action' && asset.playback_contract.mode === 'long_bed'
        ? base.transitionPolicy.defaultDurationMs
        : authoredLifecycleMs);
  if (durationMs <= 0) return undefined;
  const endMs = Math.min(base.profile.durationMs, startMs + durationMs);
  const isFootstep =
    assetId.includes('footstep') ||
    assetId.includes('steps') ||
    assetId.includes('walk_');
  const payload =
    asset.layer === 'ambient'
      ? {
          id,
          assetId,
          mode: 'localized' as const,
          locationId,
          gain,
          active: true,
          playback,
        }
      : asset.layer === 'action'
        ? {
            id,
            assetId,
            attachment: isFootstep ? ('feet' as const) : ('chest' as const),
            relativePosition: asset.default_position,
            gain,
            active: true,
            activationCondition: isFootstep
              ? ('listener-moving' as const)
              : ('always' as const),
            playback,
          }
        : {
            id,
            assetId,
            activationTimeMs: startMs,
            durationMs: endMs - startMs,
            trajectory: [
              { locationId, timestampMs: startMs },
              { locationId, timestampMs: endMs },
            ],
            interpolation: 'smoothstep' as const,
            trajectoryUpdatePolicy: 'replace-at-effective-time' as const,
            playback,
            gain,
            foregroundSalience,
          };
  return {
    elementId: id,
    assetId,
    layer: asset.layer,
    startMs,
    endMs,
    gain,
    salience: asset.layer === 'event' ? 0.35 : 0.2,
    assetFamily: assetId.replace(/_\d+$/, ''),
    spatialBehavior: asset.spatial_behavior.join('_'),
    adjustable: true,
    replaceable: true,
    suppressible: true,
    payload,
  };
}

/** Deterministic authored-surface choice for listener locomotion. */
export function footstepAssetForTransition(
  fromNodeId: string,
  toNodeId: string,
): string {
  if (toNodeId === 'city_park') return 'citypark_walk_on_the_street';
  if (toNodeId === 'beach_shore') return 'ocean_wet_sand_footstep_01';
  const waterNodes = new Set([
    'stream_bank',
    'waterfall_vicinity',
    'lakeside_river',
  ]);
  if (waterNodes.has(fromNodeId) || waterNodes.has(toNodeId))
    return 'forest_body_slow_creek_steps_01';
  return 'forest_grass_footstep_01';
}

export function materializeSemanticDecision2(options: {
  adaptationId: string;
  output: Decision2SemanticOutput;
  decision: AdaptationDecision;
  basePlan: BaseScenePlan;
  nowMs: number;
  config: AdaptivePlannerConfig;
}): FutureScenePatch {
  const { output, decision, basePlan, config } = options;
  const startMs = options.nowMs + config.executionFreezeBufferMs;
  const currentNodeId = normalizeLegacyLocationId(
    basePlan.journey.waypoints.at(-1)?.locationId ?? 'forest_clearing',
  );
  const destination = output.destinationNodeId
    ? normalizeLegacyLocationId(output.destinationNodeId)
    : null;
  const edge = destination
    ? getSceneEdgeBetween(currentNodeId, destination)
    : undefined;
  const invalidDestination = Boolean(
    destination &&
    (decision.scope !== 'scene-transition' ||
      !getSceneNode(destination) ||
      !edge),
  );
  const coherentIds = new Set([
    ...Object.values(getSceneNode(currentNodeId)?.audio_coverage ?? {}).flat(),
    ...(destination
      ? Object.values(getSceneNode(destination)?.audio_coverage ?? {}).flat()
      : []),
    ...(edge?.available_transition_cues ?? []),
  ]);
  for (const semantic of output.changes) {
    if (
      semantic.assetId &&
      getSemanticAudioAsset(semantic.assetId)?.source_environment === 'common'
    )
      coherentIds.add(canonicalAsset(semantic.assetId));
  }
  const incoherentAsset = output.changes.some(
    (change) =>
      change.assetId &&
      !coherentIds.has(canonicalAsset(change.assetId)) &&
      !change.targetElementId,
  );
  const validTransition = Boolean(
    output.status === 'CHANGE_PROPOSED' &&
    destination &&
    !invalidDestination &&
    !incoherentAsset,
  );
  const operations: FuturePatchOperation[] = [];
  if (
    !invalidDestination &&
    !incoherentAsset &&
    output.status === 'CHANGE_PROPOSED'
  )
    output.changes.forEach((change, index) => {
      if (change.operation === 'KEEP') return;
      const target = change.targetElementId
        ? basePlan.scheduledElements.find(
            (x) => x.elementId === change.targetElementId,
          )
        : undefined;
      if (change.operation === 'SUPPRESS' && target)
        operations.push({
          operation: 'SUPPRESS',
          targetElementId: target.elementId,
          effectiveStartMs: startMs,
          transitionMs: basePlan.transitionPolicy.defaultDurationMs,
        });
      else if (change.operation === 'ADJUST' && target)
        operations.push({
          operation: 'ADJUST',
          targetElementId: target.elementId,
          effectiveStartMs: startMs,
          transitionMs: basePlan.transitionPolicy.defaultDurationMs,
          gain: gainFor(target.assetId, change.mixIntent),
        });
      else if (change.operation === 'REPLACE' && target && change.assetId)
        operations.push({
          operation: 'REPLACE',
          targetElementId: target.elementId,
          effectiveStartMs: startMs,
          transitionMs: basePlan.transitionPolicy.defaultDurationMs,
          replacementAssetId: canonicalAsset(change.assetId),
          ...(destination && change.semanticRole === 'foundation'
            ? { destinationFoundationFor: destination }
            : {}),
        });
      else if (change.operation === 'INSERT' && change.assetId) {
        const assetId = canonicalAsset(change.assetId);
        const element = insertedElement(
          assetId,
          `${options.adaptationId}-${index}`,
          startMs,
          destination ?? currentNodeId,
          change.mixIntent,
          basePlan,
          undefined,
          decision.salience,
        );
        if (element)
          operations.push({
            operation: 'INSERT',
            effectiveStartMs: startMs,
            transitionMs: basePlan.transitionPolicy.defaultDurationMs,
            insertedElement: element,
            ...(destination && change.semanticRole === 'foundation'
              ? { destinationFoundationFor: destination }
              : {}),
          });
      }
    });
  if (destination && validTransition) {
    const footstepAssetId = footstepAssetForTransition(
      currentNodeId,
      destination,
    );
    const alreadySelected = operations.some(
      (operation) =>
        operation.insertedElement?.assetId === footstepAssetId ||
        operation.replacementAssetId === footstepAssetId,
    );
    if (!alreadySelected) {
      const footsteps = insertedElement(
        footstepAssetId,
        `${options.adaptationId}-locomotion`,
        startMs,
        destination,
        'default',
        basePlan,
        SCENE_TRAVERSAL_DURATION_MS,
      );
      if (footsteps)
        operations.push({
          operation: 'INSERT',
          effectiveStartMs: startMs,
          transitionMs: SCENE_TRAVERSAL_DURATION_MS,
          insertedElement: footsteps,
          systemGenerated: 'scene_transition_footsteps',
        });
    }
  }
  return {
    adaptationId: options.adaptationId,
    status:
      operations.length || validTransition ? 'PATCH_PROPOSED' : 'NO_SAFE_PATCH',
    intent: decision.intent,
    salience: decision.salience,
    operations,
    preservedElementIds: basePlan.scheduledElements.map((x) => x.elementId),
    hypothesis: {
      mechanismCode: decision.intent.toUpperCase(),
      expectedResponseCode:
        decision.intent === 'preserve_recovery'
          ? 'PRESERVE_STABILITY'
          : 'GENTLE_REORIENTATION',
      failureSignalCode: 'LOSS_OF_STABILITY',
    },
    priorAdaptationIds: [],
    lessonCode: null,
    lessonConfidence: 'unavailable',
    reasonCodes: invalidDestination
      ? ['INVALID_DESTINATION']
      : incoherentAsset
        ? ['SCENE_AUDIO_INCOHERENT']
        : [...output.reasonCodes, SEMANTIC_MATERIALIZER_VERSION],
    ...(destination && validTransition
      ? {
          journeyUpdate: {
            fromNodeId: currentNodeId,
            toNodeId: destination,
            arrivalTimeMs: startMs + SCENE_TRAVERSAL_DURATION_MS,
          },
        }
      : {}),
  };
}

function canonicalAsset(id: string): string {
  return id === 'ocean_waves' ? 'ocean_waves_soft_01' : id;
}
