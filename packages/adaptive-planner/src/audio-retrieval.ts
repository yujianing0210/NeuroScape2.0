import {
  audioLibrary,
  audioLibraryById,
  canonicalAudioAssetId,
  getReachableSceneNodes,
  getSceneEdgeBetween,
  getSceneNode,
  normalizeLegacyLocationId,
  semanticAudioLibrary,
} from '@neuroscape/contracts';
import type { AdaptivePlannerConfig } from './config.js';
import type {
  AdaptationDecision,
  CandidateExclusionReason,
  Decision2Input,
  DecisionContext,
  PlanningResult,
  RecentlyUsedAsset,
  SemanticAudioCandidate,
  SoundscapeCapacityContext,
} from './types.js';

export const DECISION_2_PROMPT_VERSION = 'decision-2-semantic-scene-graph-v10';
const SESSION_ONLY = new Set(['meditation_opening', 'non_adaptive_10min']);

export const audioFamilyId = (id: string) => id.replace(/_\d+$/, '');
export const currentCanonicalNodeId = (context: DecisionContext) =>
  normalizeLegacyLocationId(
    context.currentPlan.userJourney.waypoints.at(-1)?.locationId ??
      'forest_clearing',
  );

function coverage(nodeId: string): string[] {
  const node = getSceneNode(nodeId);
  return node ? Object.values(node.audio_coverage).flat() : [];
}

export function destinationFoundationAssetIds(nodeId: string): string[] {
  return (getSceneNode(nodeId)?.audio_coverage.foundation ?? []).filter(
    (assetId) => {
      const technical = audioLibraryById.get(assetId);
      return (
        technical?.planner_eligible !== false &&
        technical?.layer === 'ambient' &&
        technical.playback_contract?.mode === 'long_bed'
      );
    },
  );
}

function activeItems(context: DecisionContext) {
  const now = context.state.timestampMs;
  return [
    ...context.currentPlan.soundscape.ambient.filter((x) => x.active),
    ...context.currentPlan.soundscape.action.filter((x) => x.active),
    ...context.currentPlan.soundscape.event.filter(
      (x) =>
        x.activationTimeMs <= now && now < x.activationTimeMs + x.durationMs,
    ),
  ];
}

export function computeSoundscapeCapacity(
  context: DecisionContext,
  config: AdaptivePlannerConfig,
): SoundscapeCapacityContext {
  const active = activeItems(context);
  const ambient = context.currentPlan.soundscape.ambient.filter(
    (x) => x.active,
  );
  const actions = context.currentPlan.soundscape.action.filter((x) => x.active);
  const events = active.filter((x) => 'durationMs' in x);
  const salience = active.reduce((sum, x) => sum + x.gain, 0);
  return {
    activeSourceCount: active.length,
    activeAmbientCount: ambient.length,
    activeEventCount: events.length,
    activeActionCount: actions.length,
    currentSalienceLoad: salience,
    remainingConcurrentSourceHeadroom: Math.max(
      0,
      config.maxConcurrentSources - active.length,
    ),
    remainingAmbientHeadroom: Math.max(
      0,
      config.maxAmbientLayers - ambient.length,
    ),
    remainingSalienceHeadroom: Math.max(0, config.maxSalienceLoad - salience),
  };
}

function historyByAsset(
  context: DecisionContext,
): Map<string, RecentlyUsedAsset> {
  const map = new Map<string, RecentlyUsedAsset>();
  for (const h of context.history) {
    if (h.experiencedAtMs === undefined) continue;
    for (const raw of h.assetIds) {
      const id = canonicalAudioAssetId(raw);
      const old = map.get(id);
      map.set(id, {
        assetId: id,
        family: audioFamilyId(id),
        lastPlayedMs: Math.max(old?.lastPlayedMs ?? 0, h.experiencedAtMs),
        useCount: (old?.useCount ?? 0) + 1,
        ...(h.intent ? { lastIntent: h.intent } : {}),
      });
    }
  }
  return map;
}

export function retrieveDecision2Candidates(
  context: DecisionContext,
  decision: AdaptationDecision,
  _config: AdaptivePlannerConfig,
) {
  const now = context.state.timestampMs;
  const currentNodeId = currentCanonicalNodeId(context);
  const authoredReachable = getReachableSceneNodes(currentNodeId);
  const reachable = authoredReachable.filter(
    (node) => destinationFoundationAssetIds(node.id).length > 0,
  );
  const unavailableDestinationNodeIds = authoredReachable
    .filter((node) => destinationFoundationAssetIds(node.id).length === 0)
    .map((node) => node.id);
  const scope = new Set(coverage(currentNodeId));
  if (decision.scope === 'scene-transition')
    for (const node of reachable) {
      coverage(node.id).forEach((id) => scope.add(id));
      getSceneEdgeBetween(
        currentNodeId,
        node.id,
      )?.available_transition_cues.forEach((id) => scope.add(id));
    }
  semanticAudioLibrary
    .filter((x) => x.source_environment === 'common')
    .forEach((x) => scope.add(x.asset_id));
  const active = new Map(
    activeItems(context).map((x) => [canonicalAudioAssetId(x.assetId), x]),
  );
  active.forEach((_x, id) => scope.add(id));
  const history = historyByAsset(context);
  const excludedCandidates: Array<{
    assetId: string;
    reason: CandidateExclusionReason;
  }> = [];
  const candidates: SemanticAudioCandidate[] = [];
  for (const semantic of semanticAudioLibrary) {
    const id = semantic.asset_id;
    const technical = audioLibraryById.get(id);
    const used = history.get(id);
    let reason: CandidateExclusionReason | undefined;
    if (SESSION_ONLY.has(id)) reason = 'session_only';
    else if (!technical) reason = 'no_technical_record';
    else if (technical.planner_eligible === false)
      reason = 'not_planner_eligible';
    else if (!scope.has(id)) reason = 'outside_graph_scope';
    else if (
      technical.session_limits?.max_appearances != null &&
      (used?.useCount ?? 0) >= technical.session_limits.max_appearances
    )
      reason = 'session_limit';
    else if (
      used &&
      technical.session_limits?.min_interval_sec_exclusive != null &&
      now - used.lastPlayedMs <=
        technical.session_limits.min_interval_sec_exclusive * 1_000
    )
      reason = 'cooldown';
    if (reason) {
      excludedCandidates.push({ assetId: id, reason });
      continue;
    }
    const activeItem = active.get(id);
    const authored = context.basePlan?.scheduledElements.find(
      (x) => x.assetId === id,
    );
    candidates.push({
      assetId: id,
      label: semantic.label,
      description: semantic.description,
      layer: semantic.layer,
      semanticFunction: semantic.semantic_function,
      spatialCharacter: {
        behaviors: [...semantic.spatial_character.behaviors],
        defaultDistance: semantic.spatial_character.default_distance,
      },
      qualityTier: semantic.quality_tier,
      currentlyActive: Boolean(activeItem),
      ...(activeItem ? { activeElementId: activeItem.id } : {}),
      allowedOperations: activeItem
        ? [
            ...(authored?.adjustable !== false ? ['ADJUST' as const] : []),
            ...(authored?.replaceable !== false ? ['REPLACE' as const] : []),
            ...(authored?.suppressible !== false ? ['SUPPRESS' as const] : []),
          ]
        : ['INSERT'],
      recentUse: used
        ? {
            status:
              now - used.lastPlayedMs <= 120_000 ? 'recent' : 'used_before',
            useCount: used.useCount,
            secondsSinceLastUse: (now - used.lastPlayedMs) / 1_000,
          }
        : { status: 'unused', useCount: 0 },
    });
  }
  return {
    currentNodeId,
    reachableNodeIds: reachable.map((x) => x.id),
    candidates,
    eligibleCandidateCount: candidates.length,
    recentlyUsedAssets: [...history.values()],
    excludedCandidates,
    unavailableDestinationNodeIds,
  };
}

export function buildDecision2OutputSchema(
  candidates: readonly SemanticAudioCandidate[],
): Record<string, unknown> {
  const ids = candidates.map((x) => x.assetId);
  const targets = candidates.flatMap((x) =>
    x.activeElementId ? [x.activeElementId] : [],
  );
  return {
    name: 'neuroscape_decision_2_semantic',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'destinationNodeId',
        'traversalPreset',
        'changes',
        'selectedAssetIds',
        'reasonCodes',
        'rationale',
      ],
      properties: {
        status: { type: 'string', enum: ['CHANGE_PROPOSED', 'NO_SAFE_CHANGE'] },
        destinationNodeId: { anyOf: [{ type: 'null' }, { type: 'string' }] },
        traversalPreset: {
          anyOf: [
            { type: 'null' },
            { type: 'string', enum: ['normal', 'slow'] },
          ],
        },
        changes: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'operation',
              'assetId',
              'targetElementId',
              'semanticRole',
              'mixIntent',
            ],
            properties: {
              operation: {
                type: 'string',
                enum: ['KEEP', 'ADJUST', 'REPLACE', 'SUPPRESS', 'INSERT'],
              },
              assetId: {
                anyOf: [{ type: 'null' }, { type: 'string', enum: ids }],
              },
              targetElementId: {
                anyOf: [{ type: 'null' }, { type: 'string', enum: targets }],
              },
              semanticRole: {
                type: 'string',
                enum: [
                  'foundation',
                  'supporting_ambient',
                  'event',
                  'body_anchor',
                  'transition_cue',
                ],
              },
              mixIntent: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'string',
                    enum: [
                      'default',
                      'slightly_softer',
                      'slightly_more_present',
                    ],
                  },
                ],
              },
            },
          },
        },
        selectedAssetIds: {
          type: 'array',
          items: { type: 'string', enum: ids },
        },
        reasonCodes: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
      },
    },
  };
}

export function buildDecision2Prompt(
  context: DecisionContext,
  decision: AdaptationDecision,
  candidates: readonly SemanticAudioCandidate[],
  capacity: SoundscapeCapacityContext,
): string {
  const currentId = currentCanonicalNodeId(context);
  const node = getSceneNode(currentId);
  const adjacent =
    decision.scope === 'scene-transition'
      ? getReachableSceneNodes(currentId).map((x) => ({
          id: x.id,
          label: x.label,
          description: x.description,
          acousticCharacter: x.acoustic_character,
          edge: getSceneEdgeBetween(currentId, x.id),
        }))
      : [];
  const payload = {
    decision1: {
      intent: decision.intent,
      salience: decision.salience,
      scope: decision.scope,
      adaptationBasis: decision.adaptationBasis ?? 'eeg_informed',
      constraints: decision.constraintsForDecision2,
    },
    spatialContext: {
      currentNode: node && {
        id: node.id,
        label: node.label,
        description: node.description,
        acousticCharacter: node.acoustic_character,
      },
      adjacentDestinations: adjacent,
      progressionPressure: context.progressionPressure ?? 'low',
      recentLocationHistory: context.currentPlan.userJourney.waypoints.map(
        (x) => x.locationId,
      ),
      destinationFoundationCandidateIds: Object.fromEntries(
        adjacent.map((item) => [
          item.id,
          destinationFoundationAssetIds(item.id),
        ]),
      ),
    },
    activeSoundscape: activeItems(context).map((x) => ({
      id: x.id,
      assetId: x.assetId,
      gain: x.gain,
    })),
    capacity,
    priorOutcomes: context.relevantPriorOutcomes?.slice(0, 3) ?? [],
    recentAdaptations: context.history.slice(-6).map((item) => ({
      intent: item.intent,
      scope: item.scope,
      selectedAssetIds: item.decision2SelectedAssetIds ?? item.assetIds,
      semanticRoles: item.semanticRoles ?? [],
      ...(item.destinationNodeId
        ? { destinationNodeId: item.destinationNodeId }
        : {}),
      ...(item.experiencedAtMs !== undefined
        ? { experiencedAtMs: item.experiencedAtMs }
        : {}),
    })),
    candidates,
  };
  return [
    'You are NeuroScape Decision 2: Semantic Spatial Planning.',
    'Decision 1 already decided whether and why to adapt. Do not reinterpret EEG.',
    'Choose semantic changes only; code owns gain, timing, fades, playback, duration, position, and motion. For a transition, traversalPreset may be normal or slow; never provide milliseconds.',
    'Within-scene requires a null destination and no listener locomotion. Scene-transition may choose exactly one adjacent destination.',
    'For a scene transition, select at least one supplied destination foundation ambient for INSERT or REPLACE so it remains audible after arrival; transient events and footsteps do not establish destination identity.',
    'High progression pressure is context, not a command. Do not create a fixed route or fixed intent-to-sound mapping.',
    'Select only supplied candidates and allowed operations; use at most three minimal coherent changes. limited_use is cautionary, not forbidden.',
    'Use recentAdaptations only as context. When multiple choices are equally coherent, prefer perceptual and semantic variation over repeating the same treatment; repetition remains allowed when it is clearly best.',
    'Return strict JSON with concise rationale, not hidden chain-of-thought.',
    `INPUT_JSON=${JSON.stringify(payload)}`,
  ].join('\n');
}

export function prepareDecision2Input(
  context: DecisionContext,
  decision: AdaptationDecision,
  config: AdaptivePlannerConfig,
): Decision2Input {
  const r = retrieveDecision2Candidates(context, decision, config);
  const capacity = computeSoundscapeCapacity(context, config);
  const density =
    capacity.activeSourceCount <= 1
      ? 'low'
      : capacity.activeSourceCount === 2
        ? 'medium'
        : 'high';
  const compatibilityCandidates = r.candidates.map((semantic) => {
    const asset = audioLibraryById.get(semantic.assetId)!;
    return {
      assetId: semantic.assetId,
      familyId: audioFamilyId(semantic.assetId),
      label: semantic.label,
      description: semantic.description,
      scene: [...asset.scene],
      layer: semantic.layer,
      tags: [...asset.tags],
      loop: asset.loop,
      suddenness: asset.suddenness,
      intensity: asset.intensity,
      recommendedDistance: asset.recommended_distance,
      recommendedVolume: asset.recommended_volume,
      useWhen: [...asset.use_when],
      avoidWhen: [...asset.avoid_when],
      spatialBehavior: [...asset.spatial_behavior],
      defaultPosition: [...asset.default_position] as [number, number, number],
      defaultMotion: {
        type: asset.default_motion.type,
        durationSec: asset.default_motion.duration ?? null,
        ...(asset.default_motion.start
          ? {
              start: [...asset.default_motion.start] as [
                number,
                number,
                number,
              ],
            }
          : {}),
        ...(asset.default_motion.mid
          ? { mid: [...asset.default_motion.mid] as [number, number, number] }
          : {}),
        ...(asset.default_motion.end
          ? { end: [...asset.default_motion.end] as [number, number, number] }
          : {}),
      },
      autoDeleteAfterSec: asset.auto_delete_after_sec,
      fadeInSec: asset.fade_in_sec,
      fadeOutSec: asset.fade_out_sec,
      priority: asset.priority,
      isPrimaryAmbient: asset.is_primary_ambient,
      isRareEvent: asset.is_rare_event,
      qualityTier: asset.quality_tier ?? 'standard',
      selectionWeight: asset.selection_weight ?? 1,
      remainingSessionAppearances:
        asset.session_limits?.max_appearances ?? null,
      cooldownRemainingSec: 0,
      maxSafeGain: asset.gain_profile?.max_safe_gain ?? 1,
      qualityAttenuation: asset.gain_profile?.quality_attenuation ?? 1,
      playbackContractSummary: asset.playback_contract?.mode ?? 'single',
      compatibleEnvironmentalBonds: [],
      gainRange: {
        min: 0,
        recommended: asset.recommended_volume,
        max: asset.gain_profile?.max_safe_gain ?? 1,
      },
      currentlyActive: semantic.currentlyActive,
      ...(semantic.activeElementId
        ? { activeElementId: semantic.activeElementId }
        : {}),
      currentLayer: semantic.layer,
      allowedOperations: semantic.allowedOperations,
    };
  });
  return {
    promptVersion: DECISION_2_PROMPT_VERSION,
    prompt: buildDecision2Prompt(context, decision, r.candidates, capacity),
    outputSchema: buildDecision2OutputSchema(r.candidates),
    currentScene: r.currentNodeId,
    candidates: compatibilityCandidates,
    semanticCandidates: r.candidates,
    reasoningEffort: 'medium',
    operationGuidance: {
      currentDensity: density,
      upcomingDensity: density,
      complexityHeadroom: capacity.remainingConcurrentSourceHeadroom,
      salienceHeadroom: capacity.remainingSalienceHeadroom,
      prolongedStasis: context.stasisPressure,
      preferredOperations: [],
    },
    capacity,
    fullLibrarySize: audioLibrary.length,
    eligibleCandidateCount: r.eligibleCandidateCount,
    retrievedCandidateIds: r.candidates.map((x) => x.assetId),
    hardEligibleCandidateIds: r.candidates.map((x) => x.assetId),
    recentlyUsedAssets: r.recentlyUsedAssets,
    retrievalAudit: [],
    excludedCandidates: r.excludedCandidates,
    currentNodeId: r.currentNodeId,
    reachableNodeIds: r.reachableNodeIds,
    unavailableDestinationNodeIds: r.unavailableDestinationNodeIds,
  };
}

export function validateDecision2Selection(
  result: PlanningResult,
  input: Decision2Input,
): void {
  const output = result.semanticOutput;
  const ids = output?.selectedAssetIds ?? result.selectedAssetIds;
  if (new Set(ids).size !== ids.length)
    throw new Error('Decision 2 selectedAssetIds must not contain duplicates.');
  const allowed = new Set(
    input.hardEligibleCandidateIds ?? input.retrievedCandidateIds,
  );
  for (const id of ids)
    if (!allowed.has(canonicalAudioAssetId(id)))
      throw new Error(`Decision 2 selected non-candidate asset: ${id}`);
  if (!output) return;
  if (output.changes.length > 3)
    throw new Error('Decision 2 exceeds semantic change limit.');
  if (
    output.changes.some(
      (x) => x.assetId && !allowed.has(canonicalAudioAssetId(x.assetId)),
    )
  )
    throw new Error('Decision 2 change references a non-candidate asset.');
  if (
    output.destinationNodeId &&
    !getSceneEdgeBetween(
      input.currentNodeId ?? input.currentScene,
      output.destinationNodeId,
    )
  )
    throw new Error(
      `Decision 2 destination is not graph-adjacent: ${output.destinationNodeId}`,
    );
}
