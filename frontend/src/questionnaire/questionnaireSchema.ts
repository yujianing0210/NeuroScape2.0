export const QUESTIONNAIRE_VERSION = '1.1';
export const PARTICIPANT_STUDY_SCHEMA_VERSION = '1.0';

export type StudyCondition = 'adaptive' | 'non-adaptive';
export type StudyOrder = 'AB' | 'BA';
export type AssignmentSource = 'participant_id_parity' | 'manual_override';
export type QuestionnaireStage =
  'calibration_post' | 'session_pre' | 'session_post' | 'final_comparison';
export type QuestionId =
  | 'C1'
  | 'C2'
  | 'C3'
  | 'M1'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'Q5'
  | 'Q6'
  | 'COMFORT'
  | 'COMFORT_TEXT'
  | 'F1'
  | 'F2'
  | 'F3';

export interface QuestionnaireAnswer {
  questionId: QuestionId;
  value: number | string | boolean | null;
}
export interface QuestionnaireSubmission {
  questionnaireVersion: string;
  participantId: string;
  stage: QuestionnaireStage;
  sessionId?: string | null;
  condition?: StudyCondition | null;
  sessionNumber?: 1 | 2 | null;
  shownAtIso: string;
  submittedAtIso: string;
  answers: QuestionnaireAnswer[];
}
export interface ParticipantSessionRecord {
  sessionNumber: 1 | 2;
  sessionId: string;
  condition: StudyCondition;
  pre?: QuestionnaireSubmission;
  post?: QuestionnaireSubmission;
  sessionDataFinalized: boolean;
  attemptStatus?: 'accepted' | 'failed' | 'excluded';
  quickTest?: {
    eegAvailable: false;
    eegStreamSkipped: true;
    sessionDurationSkipped: true;
  };
}
export interface ParticipantStudyRecord {
  schemaVersion: string;
  questionnaireVersion: string;
  participantId: string;
  studyMode: 'production' | 'quick_test';
  createdAtIso: string;
  updatedAtIso: string;
  calibrationSessionId?: string;
  calibrationCompleted: boolean;
  calibrationQuestionnaire?: QuestionnaireSubmission;
  conditionOrder: [StudyCondition, StudyCondition];
  recommendedOrder: StudyOrder;
  actualOrder: StudyOrder;
  assignmentSource: AssignmentSource;
  orderDeviations?: Array<{
    attemptedCondition: StudyCondition;
    recordedAtIso: string;
    reason: 'operator_confirmation';
  }>;
  sessions: ParticipantSessionRecord[];
  finalComparison?: QuestionnaireSubmission;
  questionnaireComplete: boolean;
  status: 'incomplete' | 'complete';
}

export const QUESTION_METADATA: Record<
  QuestionId,
  { construct: string; label: string; direction: 'higher_more' | 'categorical' }
> = {
  C1: {
    construct: 'calibration_attention',
    label: 'Attention to practice',
    direction: 'higher_more',
  },
  C2: {
    construct: 'calibration_mind_wandering',
    label: 'Mind wandering',
    direction: 'higher_more',
  },
  C3: {
    construct: 'calibration_relaxation',
    label: 'Relaxation',
    direction: 'higher_more',
  },
  M1: {
    construct: 'momentary_relaxation',
    label: 'Momentary Relaxation',
    direction: 'higher_more',
  },
  Q1: {
    construct: 'present_moment_attention',
    label: 'Present-Moment Attention',
    direction: 'higher_more',
  },
  Q2: {
    construct: 'mind_wandering',
    label: 'Mind Wandering',
    direction: 'higher_more',
  },
  Q3: {
    construct: 'session_relaxation',
    label: 'Session Relaxation',
    direction: 'higher_more',
  },
  Q4: {
    construct: 'spatial_presence',
    label: 'Spatial Presence',
    direction: 'higher_more',
  },
  Q5: {
    construct: 'soundscape_coherence',
    label: 'Soundscape Coherence',
    direction: 'higher_more',
  },
  Q6: {
    construct: 'distraction',
    label: 'Distraction',
    direction: 'higher_more',
  },
  COMFORT: {
    construct: 'comfort',
    label: 'Comfort check',
    direction: 'categorical',
  },
  COMFORT_TEXT: {
    construct: 'comfort_text',
    label: 'Comfort note',
    direction: 'categorical',
  },
  F1: {
    construct: 'session_1_responsiveness',
    label: 'Session 1 Responsiveness',
    direction: 'higher_more',
  },
  F2: {
    construct: 'session_2_responsiveness',
    label: 'Session 2 Responsiveness',
    direction: 'higher_more',
  },
  F3: {
    construct: 'preference',
    label: 'Preference',
    direction: 'categorical',
  },
};

const LIKERT_BY_STAGE: Record<QuestionnaireStage, QuestionId[]> = {
  calibration_post: ['C1', 'C2', 'C3'],
  session_pre: ['M1'],
  session_post: ['M1', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
  final_comparison: ['F1', 'F2'],
};
export function validateSubmission(value: QuestionnaireSubmission): string[] {
  const errors: string[] = [];
  if (value.questionnaireVersion !== QUESTIONNAIRE_VERSION)
    errors.push('Invalid questionnaire version.');
  if (!/^P0*[1-9][0-9]*$/.test(value.participantId))
    errors.push('Invalid participant ID.');
  const answers = new Map(
    value.answers.map((answer) => [answer.questionId, answer.value]),
  );
  for (const id of LIKERT_BY_STAGE[value.stage]) {
    const rating = answers.get(id);
    if (!Number.isInteger(rating) || Number(rating) < 1 || Number(rating) > 7)
      errors.push(`${id} must be rated 1–7.`);
  }
  if (value.stage === 'session_post') {
    if (typeof answers.get('COMFORT') !== 'boolean')
      errors.push('Comfort response is required.');
    if (
      answers.get('COMFORT') === true &&
      !String(answers.get('COMFORT_TEXT') ?? '').trim()
    )
      errors.push('Comfort description is required.');
  }
  if (
    value.stage === 'final_comparison' &&
    !['Session 1', 'Session 2', 'No preference'].includes(
      String(answers.get('F3')),
    )
  )
    errors.push('A valid preference is required.');
  return errors;
}

export const answerValue = (
  submission: QuestionnaireSubmission | undefined,
  id: QuestionId,
) => submission?.answers.find((answer) => answer.questionId === id)?.value;
