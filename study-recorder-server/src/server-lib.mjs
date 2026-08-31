import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createOpenAIRequester } from './openai-api.mjs';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_RESULTS_ROOT = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'study-results',
);

export function validateStudyPath(participantId, sessionId, filename) {
  if (!SAFE_ID.test(participantId)) throw new Error('Invalid participant ID.');
  if (!SAFE_ID.test(sessionId)) throw new Error('Invalid session ID.');
  if (filename !== undefined && !SAFE_FILE.test(filename))
    throw new Error('Invalid artifact filename.');
}

function json(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  response.end(JSON.stringify(payload));
}

const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const answer = (submission, id) =>
  submission?.answers?.find((item) => item.questionId === id)?.value ?? null;
const sessionQuestionnaire = (record, sessionNumber) => {
  const post = record.sessions.find(
    (item) =>
      item.sessionNumber === sessionNumber &&
      item.attemptStatus !== 'failed' &&
      item.attemptStatus !== 'excluded',
  )?.post;
  return {
    q1_present_attention: answer(post, 'Q1'),
    q2_mind_wandering: answer(post, 'Q2'),
    q3_meta_awareness: answer(post, 'Q3'),
    q4_reorientation: answer(post, 'Q4'),
    q5_relaxation: answer(post, 'Q5'),
    q6_spatial_presence: answer(post, 'Q6'),
    q7_coherence: answer(post, 'Q7'),
    q8_intrusiveness: answer(post, 'Q8'),
    q9_helpfulness: answer(post, 'Q9'),
    comfort_issue: answer(post, 'COMFORT'),
    comfort_description: answer(post, 'COMFORT_TEXT'),
  };
};
function participantOutputs(record) {
  const submissions = [
    record.calibrationQuestionnaire,
    ...record.sessions.flatMap((session) => [session.pre, session.post]),
    record.finalComparison,
  ].filter(Boolean);
  const metadata = {
    C1: 'calibration_attention',
    C2: 'calibration_mind_wandering',
    C3: 'calibration_relaxation',
    Q1: 'present_moment_attention',
    Q2: 'mind_wandering',
    Q3: 'meta_awareness',
    Q4: 'attentional_reorientation',
    Q5: 'relaxation',
    Q6: 'spatial_presence',
    Q7: 'soundscape_coherence',
    Q8: 'intrusiveness',
    Q9: 'overall_helpfulness',
    COMFORT: 'comfort',
    COMFORT_TEXT: 'comfort_text',
    F1: 'more_responsive_session',
    F2: 'preferred_session',
  };
  const headers = [
    'participant_id',
    'study_mode',
    'questionnaire_version',
    'stage',
    'session_number',
    'condition',
    'session_id',
    'question_id',
    'construct',
    'value_numeric',
    'value_text',
    'shown_at_iso',
    'submitted_at_iso',
  ];
  const rows = submissions.flatMap((submission) =>
    submission.answers.map((item) => [
      record.participantId,
      record.studyMode ?? 'production',
      record.questionnaireVersion,
      submission.stage,
      submission.sessionNumber ?? '',
      submission.condition ?? '',
      submission.sessionId ?? '',
      item.questionId,
      metadata[item.questionId] ?? '',
      typeof item.value === 'number' ? item.value : '',
      typeof item.value === 'number'
        ? ''
        : item.value === null
          ? 'not_applicable'
          : item.value,
      submission.shownAtIso,
      submission.submittedAtIso,
    ]),
  );
  const csv =
    [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') +
    '\n';
  const conditions = {};
  for (const session of record.sessions.filter(
    (item) =>
      item.attemptStatus !== 'failed' && item.attemptStatus !== 'excluded',
  )) {
    conditions[
      session.condition === 'non-adaptive' ? 'nonAdaptive' : 'adaptive'
    ] = {
      sessionId: session.sessionId,
      sessionNumber: session.sessionNumber,
      ...Object.fromEntries(
        ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9'].map((id) => [
          id,
          answer(session.post, id),
        ]),
      ),
      comfort: answer(session.post, 'COMFORT'),
      comfortText: answer(session.post, 'COMFORT_TEXT'),
    };
  }
  const rawPreference = answer(record.finalComparison, 'F2');
  const preferredNumber =
    rawPreference === 'session1' ? 1 : rawPreference === 'session2' ? 2 : null;
  return {
    csv,
    report: {
      participantId: record.participantId,
      studyMode: record.studyMode ?? 'production',
      isQuickTest: record.studyMode === 'quick_test',
      questionnaireVersion: record.questionnaireVersion,
      recommendedOrder: record.recommendedOrder,
      actualOrder: record.actualOrder,
      assignmentSource: record.assignmentSource,
      conditionOrder: record.conditionOrder,
      calibrationSessionId: record.calibrationSessionId ?? null,
      calibration: {
        c1_attention: answer(record.calibrationQuestionnaire, 'C1'),
        c2_mind_wandering: answer(record.calibrationQuestionnaire, 'C2'),
        c3_relaxation: answer(record.calibrationQuestionnaire, 'C3'),
      },
      session1: sessionQuestionnaire(record, 1),
      session2: sessionQuestionnaire(record, 2),
      finalComparison: {
        more_responsive_session: answer(record.finalComparison, 'F1'),
        preferred_session: rawPreference,
      },
      conditions,
      preference: {
        raw: rawPreference,
        mappedCondition: preferredNumber
          ? (record.sessions.find(
              (item) => item.sessionNumber === preferredNumber,
            )?.condition ?? null)
          : null,
      },
    },
  };
}

async function participantEegOutputs(record, resultsRoot) {
  const headers = [
    'participant_id',
    'study_mode',
    'session_number',
    'condition',
    'session_id',
    'timestamp_ms',
    'theta',
    'beta',
    'tbr',
    'tbr_baseline',
    'tbr_representation',
    'valid',
    'quality_score',
    'artifact_flags',
  ];
  const rows = [],
    summary = {};
  for (const session of record.sessions.filter(
    (item) =>
      item.attemptStatus !== 'failed' && item.attemptStatus !== 'excluded',
  )) {
    try {
      const recording = JSON.parse(
        await readFile(
          resolve(
            resultsRoot,
            record.participantId,
            session.sessionId,
            'final-session-bundle.json',
          ),
          'utf8',
        ),
      );
      const metrics = recording.eegMetrics ?? [];
      for (const metric of metrics)
        rows.push([
          record.participantId,
          record.studyMode ?? 'production',
          session.sessionNumber,
          session.condition,
          session.sessionId,
          metric.timestampMs,
          metric.theta,
          metric.beta,
          metric.tbr,
          metric.tbrBaseline,
          'log_tbr',
          metric.valid,
          metric.qualityScore,
          (metric.artifactFlags ?? []).join('|'),
        ]);
      summary[
        session.condition === 'non-adaptive' ? 'nonAdaptive' : 'adaptive'
      ] = {
        sessionId: session.sessionId,
        metricCount: metrics.length,
        tbrRepresentation: 'log_tbr',
        baselineAvailable: metrics.some((metric) =>
          Number.isFinite(metric.tbrBaseline),
        ),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      summary[
        session.condition === 'non-adaptive' ? 'nonAdaptive' : 'adaptive'
      ] = {
        sessionId: session.sessionId,
        metricCount: 0,
        tbrRepresentation: 'log_tbr',
        baselineAvailable: false,
      };
    }
  }
  return {
    csv:
      [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') +
      '\n',
    summary: { ...summary, export: 'eeg-comparison-long.csv' },
  };
}

async function atomicWrite(destination, content) {
  const temporary = `${destination}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, content);
  await rename(temporary, destination);
}

async function readJson(request, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maximumBytes) throw new Error('Request exceeds size limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateLlmRequest(payload) {
  if (
    typeof payload?.prompt !== 'string' ||
    typeof payload?.promptVersion !== 'string' ||
    typeof payload?.outputSchema?.name !== 'string' ||
    payload?.outputSchema?.strict !== true ||
    typeof payload?.outputSchema?.schema !== 'object'
  )
    throw new Error('Invalid LLM request.');
}

function llmOriginAllowed(request) {
  const origin = request.headers.origin;
  return !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

async function writeRequestBody(request, destination, maximumBytes) {
  let received = 0;
  request.on('data', (chunk) => {
    received += chunk.length;
    if (received > maximumBytes)
      request.destroy(new Error('Artifact exceeds size limit.'));
  });
  await pipeline(request, createWriteStream(destination, { flags: 'wx' }));
}

export function createStudyServer(options = {}) {
  const resultsRoot = resolve(
    options.resultsRoot ??
      process.env.NEUROSCAPE_RESULTS_DIR ??
      DEFAULT_RESULTS_ROOT,
  );
  const maximumBytes = options.maximumBytes ?? 256 * 1024 * 1024;
  const requestOpenAI =
    options.openAIRequest ?? createOpenAIRequester(options.openAIOptions);
  return createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader(
      'access-control-allow-methods',
      'GET, PUT, POST, OPTIONS',
    );
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/study/health') {
      json(response, 200, { ok: true, resultsRoot });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/llm/health') {
      json(response, 200, {
        ok: true,
        configured: Boolean(
          options.openAIRequest ||
          options.openAIOptions?.apiKey ||
          process.env.OPENAI_API_KEY,
        ),
        decision1: {
          model:
            process.env.OPENAI_DECISION_1_MODEL ??
            process.env.OPENAI_MODEL ??
            'gpt-5.6',
          reasoningEffort: 'low',
        },
        decision2: {
          model:
            process.env.OPENAI_DECISION_2_MODEL ??
            process.env.OPENAI_MODEL ??
            'gpt-5.6',
          reasoningEffort: 'low',
          escalatedReasoningEffort: 'medium',
        },
        store: false,
      });
      return;
    }
    const artifactMatch = url.pathname.match(
      /^\/api\/study\/sessions\/([^/]+)\/([^/]+)\/artifacts\/([^/]+)$/,
    );
    const finalizeMatch = url.pathname.match(
      /^\/api\/study\/sessions\/([^/]+)\/([^/]+)\/finalize$/,
    );
    const participantStateMatch = url.pathname.match(
      /^\/api\/study\/participants\/([^/]+)\/state$/,
    );
    const participantReportMatch = url.pathname.match(
      /^\/api\/study\/participants\/([^/]+)\/report$/,
    );
    try {
      const llmMatch = url.pathname.match(
        /^\/api\/llm\/(decision-1|decision-2)$/,
      );
      if (request.method === 'POST' && llmMatch) {
        if (!llmOriginAllowed(request)) {
          json(response, 403, { ok: false, error: 'Origin not allowed.' });
          return;
        }
        const payload = await readJson(request);
        validateLlmRequest(payload);
        const result = await requestOpenAI({
          stage: llmMatch[1],
          prompt: payload.prompt,
          promptVersion: payload.promptVersion,
          outputSchema: payload.outputSchema,
          reasoningEffort: payload.reasoningEffort,
        });
        json(response, 200, result);
        return;
      }
      if (request.method === 'PUT' && artifactMatch) {
        const [, participantId, sessionId, filename] = artifactMatch.map(
          (value) => decodeURIComponent(value),
        );
        validateStudyPath(participantId, sessionId, filename);
        const sessionDirectory = resolve(resultsRoot, participantId, sessionId);
        await mkdir(sessionDirectory, { recursive: true });
        const destination = resolve(sessionDirectory, filename);
        const temporary = `${destination}.upload-${Date.now()}`;
        try {
          await writeRequestBody(request, temporary, maximumBytes);
          await rm(destination, { force: true });
          await rename(temporary, destination);
          if (
            filename === 'questionnaire.json' ||
            filename === 'questionnaire.csv'
          ) {
            const manifestPath = resolve(sessionDirectory, 'manifest.json');
            try {
              const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
              const bytes = Buffer.byteLength(await readFile(destination));
              manifest.files = (manifest.files ?? []).filter(
                (item) => item.filename !== filename,
              );
              manifest.files.push({
                filename,
                mimeType:
                  request.headers['content-type'] ?? 'application/octet-stream',
                bytes,
              });
              await atomicWrite(
                manifestPath,
                JSON.stringify(manifest, null, 2),
              );
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error;
            }
          }
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
        json(response, 201, { ok: true, participantId, sessionId, filename });
        return;
      }
      if (request.method === 'GET' && artifactMatch) {
        const [, participantId, sessionId, filename] = artifactMatch.map(
          (value) => decodeURIComponent(value),
        );
        validateStudyPath(participantId, sessionId, filename);
        try {
          const content = await readFile(
            resolve(resultsRoot, participantId, sessionId, filename),
          );
          const mimeType = filename.endsWith('.json')
            ? 'application/json'
            : filename.endsWith('.csv')
              ? 'text/csv'
              : 'application/octet-stream';
          response.writeHead(200, {
            'content-type': mimeType,
            'access-control-allow-origin': '*',
          });
          response.end(content);
        } catch (error) {
          if (error?.code === 'ENOENT')
            json(response, 404, { ok: false, error: 'Artifact not found.' });
          else throw error;
        }
        return;
      }
      if (request.method === 'POST' && finalizeMatch) {
        const [, participantId, sessionId] = finalizeMatch.map((value) =>
          decodeURIComponent(value),
        );
        validateStudyPath(participantId, sessionId);
        const sessionDirectory = resolve(resultsRoot, participantId, sessionId);
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(
          resolve(sessionDirectory, '_COMPLETE.json'),
          JSON.stringify(
            { participantId, sessionId, finalizedAt: new Date().toISOString() },
            null,
            2,
          ),
        );
        json(response, 200, {
          ok: true,
          participantId,
          sessionId,
          directory: sessionDirectory,
        });
        return;
      }
      if (request.method === 'GET' && participantStateMatch) {
        const participantId = decodeURIComponent(participantStateMatch[1]);
        validateStudyPath(participantId, 'participant');
        try {
          const record = JSON.parse(
            await readFile(
              resolve(resultsRoot, participantId, 'participant-study.json'),
              'utf8',
            ),
          );
          json(response, 200, record);
        } catch (error) {
          // A missing record is the normal first-visit state, not a failed
          // resource load. 204 also keeps the browser console free of noisy
          // expected 404s while retaining 404 compatibility in older clients.
          if (error?.code === 'ENOENT') {
            response.writeHead(204, {
              'access-control-allow-origin': '*',
            });
            response.end();
          } else throw error;
        }
        return;
      }
      if (request.method === 'PUT' && participantStateMatch) {
        const participantId = decodeURIComponent(participantStateMatch[1]);
        validateStudyPath(participantId, 'participant');
        const record = await readJson(request, 4 * 1024 * 1024);
        if (
          record?.participantId !== participantId ||
          !['1.1', '2.0'].includes(record?.questionnaireVersion) ||
          !Array.isArray(record?.sessions)
        )
          throw new Error('Invalid participant study record.');
        const directory = resolve(resultsRoot, participantId);
        await mkdir(directory, { recursive: true });
        const outputs = participantOutputs(record);
        const eegOutputs = await participantEegOutputs(record, resultsRoot);
        outputs.report.eegComparison = eegOutputs.summary;
        await atomicWrite(
          resolve(directory, 'participant-study.json'),
          JSON.stringify(record, null, 2),
        );
        await atomicWrite(
          resolve(directory, 'questionnaire-long.csv'),
          outputs.csv,
        );
        await atomicWrite(
          resolve(directory, 'participant-report.json'),
          JSON.stringify(outputs.report, null, 2),
        );
        await atomicWrite(
          resolve(directory, 'eeg-comparison-long.csv'),
          eegOutputs.csv,
        );
        json(response, 200, { ok: true, participantId, directory });
        return;
      }
      if (request.method === 'GET' && participantReportMatch) {
        const participantId = decodeURIComponent(participantReportMatch[1]);
        validateStudyPath(participantId, 'participant');
        try {
          json(
            response,
            200,
            JSON.parse(
              await readFile(
                resolve(resultsRoot, participantId, 'participant-report.json'),
                'utf8',
              ),
            ),
          );
        } catch (error) {
          if (error?.code === 'ENOENT')
            json(response, 404, {
              ok: false,
              error: 'Participant report not found.',
            });
          else throw error;
        }
        return;
      }
      json(response, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      json(
        response,
        error instanceof SyntaxError ||
          (error instanceof Error && error.message.startsWith('Invalid'))
          ? 400
          : error instanceof Error && error.message.startsWith('OPENAI_API_KEY')
            ? 503
            : 500,
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  });
}
