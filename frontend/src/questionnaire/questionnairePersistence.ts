import {
  assignSharedBasePlan,
  recommendedStudyOrder,
} from '@neuroscape/adaptive-planner';
import {
  PARTICIPANT_STUDY_SCHEMA_VERSION,
  QUESTIONNAIRE_VERSION,
  type ParticipantStudyRecord,
  type QuestionnaireSubmission,
  type StudyCondition,
} from './questionnaireSchema.js';

const normalizedOrder = (
  participantId: string,
): [StudyCondition, StudyCondition] =>
  assignSharedBasePlan(participantId).conditionOrder.map(
    (item) => item.replace('_', '-') as StudyCondition,
  ) as [StudyCondition, StudyCondition];

export function createParticipantRecord(
  participantId: string,
): ParticipantStudyRecord {
  const now = new Date().toISOString();
  const recommendedOrder = recommendedStudyOrder(participantId);
  return {
    schemaVersion: PARTICIPANT_STUDY_SCHEMA_VERSION,
    questionnaireVersion: QUESTIONNAIRE_VERSION,
    participantId,
    studyMode: 'production',
    createdAtIso: now,
    updatedAtIso: now,
    calibrationCompleted: false,
    conditionOrder: normalizedOrder(participantId),
    recommendedOrder,
    actualOrder: recommendedOrder,
    assignmentSource: 'participant_id_parity',
    sessions: [],
    questionnaireComplete: false,
    status: 'incomplete',
  };
}
export async function loadParticipantRecord(
  participantId: string,
): Promise<ParticipantStudyRecord> {
  const response = await fetch(
    `/api/study/participants/${encodeURIComponent(participantId)}/state`,
  );
  if (response.status === 204 || response.status === 404)
    return createParticipantRecord(participantId);
  if (!response.ok) throw new Error('Could not load study progress.');
  const saved = (await response.json()) as ParticipantStudyRecord;
  const recommendedOrder =
    saved.recommendedOrder ?? recommendedStudyOrder(participantId);
  const actualOrder =
    saved.actualOrder ??
    (saved.conditionOrder?.[0] === 'adaptive' ? 'BA' : 'AB');
  return {
    ...saved,
    studyMode: saved.studyMode ?? 'production',
    recommendedOrder,
    actualOrder,
    assignmentSource:
      saved.assignmentSource ??
      (actualOrder === recommendedOrder
        ? 'participant_id_parity'
        : 'manual_override'),
  };
}

export async function saveQuickTestSessionArtifacts(
  participantId: string,
  sessionId: string,
  sessionNumber: 1 | 2,
  condition: StudyCondition,
): Promise<void> {
  const createdAtIso = new Date().toISOString();
  const recording = {
    metadata: {
      sessionId,
      participantId,
      protocolVersion: 'quick-test',
      schemaVersion: '1.4',
      durationMs: 0,
      startState: 'quick_test',
      endState: 'ended',
      eegMode: 'none',
      runMode: condition === 'non-adaptive' ? 'non-adaptive' : 'mock-fast',
      plannerMode: condition === 'non-adaptive' ? 'fixed' : 'mock',
      startedAtIso: createdAtIso,
      studyMode: 'quick_test',
      source: 'quick_test',
      eegAvailable: false,
      eegStreamSkipped: true,
    },
    runtimeSnapshots: [],
    neuroStates: [],
    sceneJourneyPlans: [],
    sessionEvents: [],
    plannerEvents: [],
    adaptiveTrace: [],
    eegMetrics: [],
    decisionEvents: [],
    audioPlaybackEvidence: [],
    audioExecutionDiagnostics: [],
    appliedAudioExposures: [],
  };
  const metadata = {
    studyMode: 'quick_test',
    isQuickTest: true,
    participantId,
    sessionId,
    sessionNumber,
    condition,
    eegAvailable: false,
    eegStreamSkipped: true,
    sessionDurationSkipped: true,
    audioPlaybackSkipped: true,
    createdAtIso,
  };
  const files = [
    ['final-session-bundle.json', recording],
    ['quick-test-metadata.json', metadata],
    [
      'manifest.json',
      {
        participantId,
        sessionId,
        createdAt: createdAtIso,
        schemaVersion: '1.0',
        studyMode: 'quick_test',
        files: [
          {
            filename: 'final-session-bundle.json',
            mimeType: 'application/json',
          },
          {
            filename: 'quick-test-metadata.json',
            mimeType: 'application/json',
          },
        ],
      },
    ],
  ] as const;
  const prefix = `/api/study/sessions/${encodeURIComponent(participantId)}/${encodeURIComponent(sessionId)}/artifacts`;
  for (const [filename, value] of files) {
    const response = await fetch(`${prefix}/${filename}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value, null, 2),
    });
    if (!response.ok)
      throw new Error(
        'Quick Test session artifacts could not be saved. Please retry.',
      );
  }
}

export function conditionOrderFor(
  order: 'AB' | 'BA',
): [StudyCondition, StudyCondition] {
  return order === 'AB'
    ? ['non-adaptive', 'adaptive']
    : ['adaptive', 'non-adaptive'];
}
export function withStudyOrder(
  record: ParticipantStudyRecord,
  actualOrder: 'AB' | 'BA',
): ParticipantStudyRecord {
  if (record.sessions.length) return record;
  return {
    ...record,
    actualOrder,
    assignmentSource:
      actualOrder === record.recommendedOrder
        ? 'participant_id_parity'
        : 'manual_override',
    conditionOrder: conditionOrderFor(actualOrder),
  };
}
export async function saveParticipantRecord(
  record: ParticipantStudyRecord,
): Promise<ParticipantStudyRecord> {
  const updated = {
    ...record,
    updatedAtIso: new Date().toISOString(),
    questionnaireComplete: Boolean(record.finalComparison),
    status: record.finalComparison
      ? ('complete' as const)
      : ('incomplete' as const),
  };
  const response = await fetch(
    `/api/study/participants/${encodeURIComponent(record.participantId)}/state`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updated),
    },
  );
  if (!response.ok)
    throw new Error(
      'Your responses could not be saved. Please ask the researcher to retry.',
    );
  return updated;
}
export async function uploadQuestionnaireArtifact(
  submission: QuestionnaireSubmission,
  pre?: QuestionnaireSubmission,
): Promise<void> {
  if (!submission.sessionId) return;
  const payload = {
    questionnaireVersion: QUESTIONNAIRE_VERSION,
    participantId: submission.participantId,
    sessionId: submission.sessionId,
    sessionNumber: submission.sessionNumber,
    condition: submission.condition,
    pre: pre ?? null,
    post: submission,
  };
  const prefix = `/api/study/sessions/${encodeURIComponent(submission.participantId)}/${encodeURIComponent(submission.sessionId)}/artifacts`;
  const rows = [pre, submission]
    .filter(Boolean)
    .flatMap((item) =>
      item!.answers.map((answer) => [
        item!.stage,
        answer.questionId,
        typeof answer.value === 'number' ? answer.value : '',
        typeof answer.value === 'number' ? '' : String(answer.value ?? ''),
        item!.shownAtIso,
        item!.submittedAtIso,
      ]),
    );
  const quote = (v: unknown) => `"${String(v).replaceAll('"', '""')}"`;
  const csv =
    [
      [
        'stage',
        'question_id',
        'value_numeric',
        'value_text',
        'shown_at_iso',
        'submitted_at_iso',
      ],
      ...rows,
    ]
      .map((row) => row.map(quote).join(','))
      .join('\n') + '\n';
  for (const [name, type, body] of [
    [
      'questionnaire.json',
      'application/json',
      JSON.stringify(payload, null, 2),
    ],
    ['questionnaire.csv', 'text/csv', csv],
  ] as const) {
    const response = await fetch(`${prefix}/${name}`, {
      method: 'PUT',
      headers: { 'content-type': type },
      body,
    });
    if (!response.ok)
      throw new Error(
        'Your responses could not be saved. Please ask the researcher to retry.',
      );
  }
}
export async function finalizeSession(
  participantId: string,
  sessionId: string,
): Promise<string> {
  const response = await fetch(
    `/api/study/sessions/${encodeURIComponent(participantId)}/${encodeURIComponent(sessionId)}/finalize`,
    { method: 'POST' },
  );
  if (!response.ok)
    throw new Error('The session could not be finalized. Please retry.');
  return (
    ((await response.json()) as { directory?: string }).directory ??
    `${participantId}/${sessionId}`
  );
}
