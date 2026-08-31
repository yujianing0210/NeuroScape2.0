export interface AdaptivePlannerConfig {
  sessionDurationMs: number;
  openingDurationMs: number;
  epochDurationMs: number;
  analysisWindowMs: number;
  checkpointIntervalMs: number;
  minimumValidEpochs: number;
  trendWindowCount: number;
  trendObservationSpanMs: number;
  minimumBaselineScaleLogTbr: number;
  baselineRelationThreshold: number;
  robustDeltaTrendThreshold: number;
  highVariabilityMad: number;
  sustainedWindowCount: number;
  minimumConfidence: number;
  adaptationCooldownMs: number;
  sceneTransitionCooldownMs: number;
  maxSceneTransitions: number;
  exactAssetCooldownMs: number;
  assetFamilyCooldownMs: number;
  bodyAnchorCooldownMs: number;
  maxMeaningfulStasisMs: number;
  /** TBD_PILOT: spatial progression context, independent of local adaptation. */
  progressionPressureMediumMs: number;
  /** TBD_PILOT: context for D1, never a forced-transition threshold. */
  progressionPressureHighMs: number;
  /** TBD_PILOT: destination identity must persist this long after arrival. */
  destinationStabilizationMinMs: number;
  patchHorizonMs: number;
  executionFreezeBufferMs: number;
  outcomeObservationWindowMs: number;
  llmDecision1TimeoutMs: number;
  llmDecision2TimeoutMs: number;
  maxPatchOperations: number;
  maxConcurrentSources: number;
  maxAmbientLayers: number;
  maxEventsPerMinute: number;
  maxBodyAnchorsPerMinute: number;
  maxSalienceLoad: number;
  reservedAdaptationHeadroom: number;
  maxCumulativePatches: number;
  targetAdaptationsMin: number;
  targetAdaptationsMax: number;
}

/**
 * Runnable Phase-1 defaults. Every numeric policy value below is TBD_PILOT:
 * it is an explicit starting hypothesis, not a validated scientific threshold.
 */
export const phase1Config: AdaptivePlannerConfig = Object.freeze({
  sessionDurationMs: 600_000,
  openingDurationMs: 45_000,
  epochDurationMs: 10_000,
  analysisWindowMs: 60_000,
  // Decision 1/2 reasoning cadence requested for the live adaptive session.
  checkpointIntervalMs: 20_000,
  minimumValidEpochs: 5,
  trendWindowCount: 3,
  // Preserve the Phase-1 EEG trend horizon independently of planner cadence.
  trendObservationSpanMs: 80_000,
  minimumBaselineScaleLogTbr: 0.05,
  baselineRelationThreshold: 1,
  robustDeltaTrendThreshold: 0.25,
  highVariabilityMad: 0.12,
  sustainedWindowCount: 2,
  minimumConfidence: 0.6,
  adaptationCooldownMs: 5_000,
  sceneTransitionCooldownMs: 90_000,
  maxSceneTransitions: 2,
  exactAssetCooldownMs: 90_000,
  assetFamilyCooldownMs: 45_000,
  bodyAnchorCooldownMs: 80_000,
  maxMeaningfulStasisMs: 80_000,
  progressionPressureMediumMs: 70_000,
  progressionPressureHighMs: 110_000,
  destinationStabilizationMinMs: 30_000,
  // TBD_PILOT: receding-horizon, latency, and restrained-complexity policy.
  patchHorizonMs: 120_000,
  // Minimal lead time for deterministic validation/plan handoff. Runtime's
  // scheduler remains authoritative and will activate on its next tick.
  executionFreezeBufferMs: 250,
  outcomeObservationWindowMs: 60_000,
  llmDecision1TimeoutMs: 12_000,
  llmDecision2TimeoutMs: 12_000,
  maxPatchOperations: 3,
  maxConcurrentSources: 3,
  maxAmbientLayers: 2,
  maxEventsPerMinute: 1,
  maxBodyAnchorsPerMinute: 1,
  maxSalienceLoad: 1,
  reservedAdaptationHeadroom: 0.25,
  maxCumulativePatches: 10,
  targetAdaptationsMin: 5,
  targetAdaptationsMax: 6,
});
