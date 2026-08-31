import type {
  AdaptationDecision,
  AdaptationGoal,
  AdaptationScope,
  Decision2Input,
  DecisionContext,
  DecisionProvider,
  LlmUsage,
  PlanningProvider,
  PlanningResult,
  Decision2SemanticOutput,
} from './types.js';
import { reasoningAttentionState } from './types.js';

export const DECISION_1_PROMPT_VERSION =
  'decision-1-guided-baseline-progression-v2';

const scopes: readonly AdaptationScope[] = [
  'maintain',
  'within-scene',
  'scene-transition',
];
const intents = [
  'gently_reorient_attention',
  'support_grounding',
  'reduce_stimulation',
  'support_sustained_focus',
  'refresh_engagement',
  'preserve_recovery',
  'maintain',
] as const;
const saliences = ['minimal', 'low', 'moderate'] as const;

interface Decision1WireOutput {
  decision: 'adapt' | 'maintain';
  intent: (typeof intents)[number];
  salience: (typeof saliences)[number];
  scope: AdaptationScope;
  evidence_summary: {
    relation:
      'baseline-consistent' | 'tbr-elevated' | 'tbr-reduced' | 'uncertain';
    trajectory:
      'improving' | 'stable' | 'declining' | 'volatile' | 'unavailable';
    confidence: 'high' | 'medium' | 'low';
  };
  reason: string;
  maintain_reason: string | null;
  constraints_for_decision_2: string[];
  adaptation_basis:
    | 'none'
    | 'eeg_informed'
    | 'progression_driven'
    | 'mixed'
    | 'continuity_preserving';
}

export const decision1OutputSchema: Record<string, unknown> = Object.freeze({
  name: 'neuroscape_decision_1',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'decision',
      'intent',
      'salience',
      'scope',
      'evidence_summary',
      'reason',
      'maintain_reason',
      'constraints_for_decision_2',
      'adaptation_basis',
    ],
    properties: {
      decision: { type: 'string', enum: ['adapt', 'maintain'] },
      intent: { type: 'string', enum: intents },
      salience: { type: 'string', enum: saliences },
      scope: { type: 'string', enum: scopes },
      evidence_summary: {
        type: 'object',
        additionalProperties: false,
        required: ['relation', 'trajectory', 'confidence'],
        properties: {
          relation: {
            type: 'string',
            enum: [
              'baseline-consistent',
              'tbr-elevated',
              'tbr-reduced',
              'uncertain',
            ],
          },
          trajectory: {
            type: 'string',
            enum: [
              'improving',
              'stable',
              'declining',
              'volatile',
              'unavailable',
            ],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
      reason: { type: 'string' },
      maintain_reason: { type: ['string', 'null'] },
      constraints_for_decision_2: { type: 'array', items: { type: 'string' } },
      adaptation_basis: {
        type: 'string',
        enum: [
          'none',
          'eeg_informed',
          'progression_driven',
          'mixed',
          'continuity_preserving',
        ],
      },
    },
  },
});

export function buildDecision1Prompt(context: DecisionContext): string {
  return [
    'You are NeuroScape Decision 1: Should Adapt?',
    'Decide whether the current soundscape should be adapted at this eligible checkpoint.',
    'The deterministic eligibility gate has already approved an LLM assessment. Eligibility does not itself mean an adaptation is necessary.',
    'The baseline is an empirical guided-breathing reference, not maximum focus, a physiological bound, or a diagnostic threshold.',
    'Positive delta means TBR is higher than baseline; it does not objectively detect mind wandering.',
    'Negative delta means TBR is lower than baseline; it does not mean the participant is more than 100% focused.',
    'Do not infer a definitive mental state from a single checkpoint.',
    'Never invent attention decline or mind wandering merely to justify a soundscape change or meet an adaptation count.',
    'Interpret raw delta, TBR ratio, robust deviation, signal quality, confidence, trajectory, duration, scene history, and prior outcomes together.',
    'Sustained, high-confidence TBR elevation may support a conservative gentle-reorientation hypothesis, but never a definitive mental-state claim.',
    'A scene transition may be EEG-informed after insufficient lighter interventions, or non-corrective journey progression when progression pressure and capacity permit.',
    'Prefer maintain only when evidence is transient, already improving, low-confidence, or a recent intervention has not had enough time to take effect; do not maintain merely because the state is intermediate.',
    'Scene transition is rare. For progression-driven transitions, never frame the change as EEG correction or detected mind wandering.',
    'Opening and closing phase restrictions are authoritative. Never request a forbidden event, body anchor, or scene transition.',
    'When stasisPressure is true, a minimal non-corrective evolution may be considered, but do not invent an EEG claim.',
    'Low-confidence or unusable EEG cannot support a corrective claim. It may only support conservative history-driven evolution or maintain.',
    'When baseline or measurement quality is insufficient, prioritize soundscape continuity and maintain rather than EEG-directed correction.',
    'Under that low-calibration fallback, do not adapt merely to create activity. Prefer maintain when the current layer hierarchy is coherent; adapt conservatively only when stasis pressure, a missing sound role, excessive density, repetition, or a clearly better-quality compatible layer justifies it.',
    'adaptationProgress is a soft session-level target, never permission to violate safety or invent an EEG claim. When behindPace is true and a safe minimal system-sound evolution exists, prefer that evolution over repeated maintain; when no safe useful change exists, maintain remains valid.',
    'If decision=maintain, intent must be maintain or preserve_recovery, scope must be maintain, and maintain_reason must be concrete.',
    'If decision=adapt, intent and scope must not be maintain. Pass salience and constraints_for_decision_2 without selecting assets.',
    'constraints_for_decision_2 should constrain safety, maximum scope, salience, continuity, forbidden operations, and evidentiary framing. Do not prescribe an audio layer, asset family, bird-like cue, brief natural event, or exact acoustic tactic unless a hard system restriction requires it. Decision 2 owns semantic sound-design selection.',
    'Maintain means preserving the currently scheduled Base Plan evolution; it never means freezing the current soundscape or cancelling scheduled future events.',
    'Use supplied prior outcomes only as non-causal, provisional observations. If the last applied patch is not yet observable, avoid stacking another intervention unless clearly necessary.',
    'Provide a concise, inspectable rationale based only on supplied observations. Do not claim objective mind-wandering detection and do not expose hidden chain-of-thought.',
    `INPUT_JSON=${JSON.stringify({
      baselineReference: {
        calibrationSessionId: context.profile.profileId,
        sourcePolicy: 'single_five_minute_guided_calibration_only',
        baselineLogTbr: context.profile.baselineLogTbr,
        baselineMad: context.profile.baselineMad,
        effectiveBaselineScale: context.profile.effectiveBaselineScale,
        validEpochs: context.profile.validEpochCount,
        qualityStatus: context.profile.qualityStatus,
        selfReportedFocus: context.profile.selfReportedFocus,
        selfReportedDrowsiness: context.profile.selfReportedDrowsiness,
      },
      currentWindow: reasoningAttentionState(context.state),
      recentTrajectorySummary: context.recentStates.slice(-3).map((state) => ({
        timestampMs: state.timestampMs,
        robustDeltaFromBaseline: state.robustDeltaFromBaseline,
        baselineRelation: state.baselineRelation,
        trajectory: state.trajectory,
        measurementConfidence: state.measurementConfidence,
        signalQuality: state.signalQuality,
      })),
      sceneSummary: {
        planId: context.currentPlan.planId,
        currentLocation:
          context.currentPlan.userJourney.waypoints.at(-1)?.locationId,
        secondsSinceLastSpatialProgression:
          context.secondsSinceLastSpatialProgression ?? 0,
        lastSpatialProgressionMs: context.lastSpatialProgressionMs,
        committedSceneTransitionCount:
          context.committedSceneTransitionCount ?? 0,
        progressionPressure: context.progressionPressure ?? 'low',
        appliedSceneTransitions: context.history.filter(
          (item) => item.scope === 'scene-transition',
        ).length,
        transitionsRemaining: context.restrictions.sceneTransitionsRemaining,
        activeAmbientIds: context.currentPlan.soundscape.ambient
          .filter((item) => item.active)
          .map((item) => item.id),
        upcomingEventIds: context.currentPlan.soundscape.event
          .filter((item) => item.activationTimeMs >= context.state.timestampMs)
          .slice(0, 3)
          .map((item) => item.id),
      },
      lastRelevantAdaptation: context.history.at(-1) ?? null,
      restrictions: context.restrictions,
      secondsSinceLastMeaningfulChange:
        context.secondsSinceLastMeaningfulChange,
      stasisPressure: context.stasisPressure,
      transitionInProgress: context.transitionInProgress,
      adaptationProgress: context.adaptationProgress,
      relevantPriorOutcomes: context.relevantPriorOutcomes?.slice(0, 3) ?? [],
    })}`,
  ].join('\n');
}

interface OpenAIProxyResponse<T> {
  output: T;
  model: string;
  responseId: string;
  usage: LlmUsage;
}

export interface OpenAIProviderOptions {
  baseUrl?: string;
  sessionId?: string;
  fetchImpl?: typeof fetch;
}

async function requestStructuredOutput<T>(
  path: string,
  body: Record<string, unknown>,
  options: OpenAIProviderOptions,
): Promise<OpenAIProxyResponse<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl ?? ''}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: options.sessionId }),
  });
  const payload = (await response.json()) as
    OpenAIProxyResponse<T> | { error?: string };
  if (!response.ok || !('output' in payload))
    throw new Error(
      `OpenAI planner request failed (${response.status}): ${
        'error' in payload && payload.error
          ? payload.error
          : response.statusText
      }`,
    );
  return payload;
}

function assertDecision1(
  value: Decision1WireOutput,
  context: DecisionContext,
): void {
  if (
    !intents.includes(value.intent) ||
    !saliences.includes(value.salience) ||
    !scopes.includes(value.scope)
  )
    throw new Error(
      'Decision 1 returned an unsupported intent, salience, or scope.',
    );
  if (
    (value.decision === 'maintain' &&
      (!['maintain', 'preserve_recovery'].includes(value.intent) ||
        value.scope !== 'maintain' ||
        !value.maintain_reason)) ||
    (value.decision === 'adapt' &&
      (value.intent === 'maintain' || value.scope === 'maintain'))
  )
    throw new Error(
      'Decision 1 returned an inconsistent decision/intent/scope.',
    );
  if (
    value.scope === 'scene-transition' &&
    !context.restrictions.allowSceneTransition
  )
    throw new Error('Decision 1 requested a forbidden scene transition.');
  if (
    value.intent === 'support_grounding' &&
    !context.restrictions.allowBodyAnchor
  )
    throw new Error('Decision 1 requested a forbidden body anchor.');
}

export class OpenAIDecisionProvider implements DecisionProvider {
  readonly #options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#options = options;
  }

  async decide(context: DecisionContext): Promise<AdaptationDecision> {
    const startedAt = performance.now();
    const prompt = buildDecision1Prompt(context);
    const response = await requestStructuredOutput<Decision1WireOutput>(
      '/api/llm/decision-1',
      {
        promptVersion: DECISION_1_PROMPT_VERSION,
        prompt,
        outputSchema: decision1OutputSchema,
      },
      this.#options,
    );
    try {
      assertDecision1(response.output, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        decision: 'maintain',
        intent: 'maintain',
        salience: 'minimal',
        adaptationBasis: 'none',
        evidenceSummary: {
          relation: context.state.baselineRelation,
          trajectory: context.state.trajectory,
          confidence: context.state.measurementConfidence,
        },
        reason: `decision_1_validation_error: ${reason}`,
        maintainReason: 'Invalid Decision 1 output; safe maintain fallback.',
        constraintsForDecision2: [],
        shouldAdapt: false,
        goal: 'maintain',
        scope: 'maintain',
        rationale: `Invalid Decision 1 output; safe maintain fallback. ${reason}`,
        provider: 'openai-validation-fallback',
        promptVersion: DECISION_1_PROMPT_VERSION,
        prompt,
        outputSchema: decision1OutputSchema,
        model: response.model,
        responseId: response.responseId,
        usage: response.usage,
      };
    }
    const goalByIntent: Record<Decision1WireOutput['intent'], AdaptationGoal> =
      {
        gently_reorient_attention: 'gently-reorient',
        support_grounding: 'support-grounding',
        reduce_stimulation: 'reduce-stimulation',
        support_sustained_focus: 'support-sustained-focus',
        refresh_engagement: 'refresh-engagement',
        preserve_recovery: 'preserve-recovery',
        maintain: 'maintain',
      };
    const decision: AdaptationDecision = {
      decision: response.output.decision,
      intent: response.output.intent,
      salience: response.output.salience,
      adaptationBasis: response.output.adaptation_basis,
      evidenceSummary: response.output.evidence_summary,
      reason: response.output.reason,
      maintainReason: response.output.maintain_reason,
      constraintsForDecision2: response.output.constraints_for_decision_2,
      shouldAdapt: response.output.decision === 'adapt',
      goal: goalByIntent[response.output.intent],
      scope: response.output.scope,
      rationale: response.output.reason,
      provider: 'openai-responses',
      promptVersion: DECISION_1_PROMPT_VERSION,
      prompt,
      outputSchema: decision1OutputSchema,
      model: response.model,
      responseId: response.responseId,
      usage: response.usage,
      latencyMs: performance.now() - startedAt,
    };
    return decision;
  }
}

export class OpenAIPlanningProvider implements PlanningProvider {
  readonly #options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#options = options;
  }

  async plan(
    _context: DecisionContext,
    decision: AdaptationDecision,
    input: Decision2Input,
  ): Promise<PlanningResult> {
    const startedAt = performance.now();
    const response = await requestStructuredOutput<Decision2SemanticOutput>(
      '/api/llm/decision-2',
      {
        promptVersion: input.promptVersion,
        prompt: input.prompt,
        outputSchema: input.outputSchema,
        reasoningEffort: input.reasoningEffort,
      },
      this.#options,
    );
    return {
      patch: { reasoningSummary: response.output.rationale },
      semanticOutput: response.output,
      selectedAssetIds: response.output.selectedAssetIds,
      candidateAssetIds: input.candidates.map((candidate) => candidate.assetId),
      promptVersion: input.promptVersion,
      prompt: input.prompt,
      outputSchema: input.outputSchema,
      rationale: response.output.rationale,
      provider: 'openai-responses',
      model: response.model,
      responseId: response.responseId,
      usage: response.usage,
      latencyMs: performance.now() - startedAt,
    };
  }
}
