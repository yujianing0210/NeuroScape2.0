import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStudyServer, validateStudyPath } from '../src/server-lib.mjs';
import { createOpenAIRequester } from '../src/openai-api.mjs';

let server;
afterEach(() => server?.close());

describe('study recorder server', () => {
  it('rejects traversal-like IDs and filenames', () => {
    expect(() => validateStudyPath('../P1', 'session', 'file.json')).toThrow();
    expect(() => validateStudyPath('P1', 'session', '../file.json')).toThrow();
  });

  it('writes artifacts and a completion marker inside the configured root', async () => {
    const resultsRoot = await mkdtemp(join(tmpdir(), 'neuroscape-study-'));
    server = createStudyServer({ resultsRoot });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const uploaded = await fetch(
      `${base}/api/study/sessions/P001/session-01/artifacts/manifest.json`,
      { method: 'PUT', body: '{"ok":true}' },
    );
    expect(uploaded.status).toBe(201);
    const finalized = await fetch(
      `${base}/api/study/sessions/P001/session-01/finalize`,
      { method: 'POST' },
    );
    expect(finalized.status).toBe(200);
    expect(
      await readFile(
        join(resultsRoot, 'P001', 'session-01', 'manifest.json'),
        'utf8',
      ),
    ).toBe('{"ok":true}');
    expect(
      JSON.parse(
        await readFile(
          join(resultsRoot, 'P001', 'session-01', '_COMPLETE.json'),
          'utf8',
        ),
      ).participantId,
    ).toBe('P001');
  });

  it('atomically persists participant state and generates analysis exports', async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), 'neuroscape-participant-'),
    );
    server = createStudyServer({ resultsRoot });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(
      `${base}/api/study/sessions/P007/session-1/artifacts/final-session-bundle.json`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eegMetrics: [
            {
              timestampMs: 10_000,
              theta: 0.12,
              beta: 0.08,
              tbr: -0.41,
              tbrBaseline: -0.35,
              valid: true,
              qualityScore: 0.94,
              artifactFlags: [],
            },
          ],
        }),
      },
    );
    const record = {
      schemaVersion: '1.0',
      questionnaireVersion: '1.1',
      participantId: 'P007',
      studyMode: 'quick_test',
      createdAtIso: '2026-01-01T00:00:00Z',
      updatedAtIso: '2026-01-01T00:00:00Z',
      calibrationCompleted: true,
      conditionOrder: ['non-adaptive', 'adaptive'],
      recommendedOrder: 'AB',
      actualOrder: 'AB',
      assignmentSource: 'participant_id_parity',
      sessions: [
        {
          sessionNumber: 1,
          sessionId: 'session-1',
          condition: 'non-adaptive',
          sessionDataFinalized: true,
          attemptStatus: 'accepted',
          post: {
            questionnaireVersion: '2.0',
            participantId: 'P007',
            stage: 'session_post',
            sessionNumber: 1,
            sessionId: 'session-1',
            condition: 'non-adaptive',
            shownAtIso: '2026-01-01T00:02:00Z',
            submittedAtIso: '2026-01-01T00:03:00Z',
            answers: [
              { questionId: 'Q1', value: 5 },
              { questionId: 'Q3', value: null },
              { questionId: 'COMFORT', value: false },
            ],
          },
        },
      ],
      questionnaireComplete: false,
      status: 'incomplete',
      calibrationQuestionnaire: {
        questionnaireVersion: '1.1',
        participantId: 'P007',
        stage: 'calibration_post',
        shownAtIso: '2026-01-01T00:00:00Z',
        submittedAtIso: '2026-01-01T00:01:00Z',
        answers: [{ questionId: 'C1', value: 5 }],
      },
      finalComparison: {
        questionnaireVersion: '2.0',
        participantId: 'P007',
        stage: 'final_comparison',
        shownAtIso: '2026-01-01T00:04:00Z',
        submittedAtIso: '2026-01-01T00:05:00Z',
        answers: [
          { questionId: 'F1', value: 'no_clear_difference' },
          { questionId: 'F2', value: 'session1' },
        ],
      },
    };
    const saved = await fetch(`${base}/api/study/participants/P007/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    });
    expect(saved.status).toBe(200);
    expect(
      (await (await fetch(`${base}/api/study/participants/P007/state`)).json())
        .participantId,
    ).toBe('P007');
    expect(
      await readFile(
        join(resultsRoot, 'P007', 'questionnaire-long.csv'),
        'utf8',
      ),
    ).toContain('calibration_attention');
    expect(
      await readFile(
        join(resultsRoot, 'P007', 'questionnaire-long.csv'),
        'utf8',
      ),
    ).toContain('quick_test');
    expect(
      await readFile(
        join(resultsRoot, 'P007', 'questionnaire-long.csv'),
        'utf8',
      ),
    ).toContain('not_applicable');
    expect(
      JSON.parse(
        await readFile(
          join(resultsRoot, 'P007', 'participant-report.json'),
          'utf8',
        ),
      ).calibration.c1_attention,
    ).toBe(5);
    const questionnaireReport = JSON.parse(
      await readFile(
        join(resultsRoot, 'P007', 'participant-report.json'),
        'utf8',
      ),
    );
    expect(questionnaireReport.session1.q1_present_attention).toBe(5);
    expect(questionnaireReport.session1.q3_meta_awareness).toBeNull();
    expect(questionnaireReport.finalComparison).toEqual({
      more_responsive_session: 'no_clear_difference',
      preferred_session: 'session1',
    });
    expect(
      JSON.parse(
        await readFile(
          join(resultsRoot, 'P007', 'participant-report.json'),
          'utf8',
        ),
      ).isQuickTest,
    ).toBe(true);
    expect(
      await readFile(
        join(resultsRoot, 'P007', 'eeg-comparison-long.csv'),
        'utf8',
      ),
    ).toContain('log_tbr');
    expect(
      JSON.parse(
        await readFile(
          join(resultsRoot, 'P007', 'participant-report.json'),
          'utf8',
        ),
      ).eegComparison.nonAdaptive.metricCount,
    ).toBe(1);
    expect(
      (
        await fetch(
          `${base}/api/study/sessions/P007/session-1/artifacts/final-session-bundle.json`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}/api/study/participants/P008/state`)).status,
    ).toBe(204);
  });

  it('accepts the current questionnaire version for a new Quick Test record', async () => {
    const resultsRoot = await mkdtemp(
      join(tmpdir(), 'neuroscape-questionnaire-v2-'),
    );
    server = createStudyServer({ resultsRoot });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/study/participants/P009/state`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          participantId: 'P009',
          questionnaireVersion: '2.0',
          studyMode: 'quick_test',
          sessions: [],
        }),
      },
    );
    expect(response.status).toBe(200);
  });

  it('proxies structured LLM requests without exposing the API key', async () => {
    const calls = [];
    server = createStudyServer({
      openAIRequest: async (request) => {
        calls.push(request);
        return {
          output: {
            shouldAdapt: false,
            goal: 'maintain',
            scope: 'maintain',
            rationale: 'Stable state.',
          },
          model: 'gpt-5.6-test',
          responseId: 'resp_test',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/llm/decision-1`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          prompt: 'test prompt',
          promptVersion: 'decision-1-test',
          outputSchema: {
            name: 'decision_1',
            strict: true,
            schema: { type: 'object' },
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe('gpt-5.6-test');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('OPENAI_API_KEY');
  });

  it('configures the Responses API with private storage disabled and tiered effort', async () => {
    const requests = [];
    const requester = createOpenAIRequester({
      apiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({
            id: 'resp_test',
            model: 'gpt-5.6-test',
            output_text: '{"ok":true}',
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              total_tokens: 30,
              output_tokens_details: { reasoning_tokens: 4 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const base = {
      prompt: 'test',
      promptVersion: 'v1',
      outputSchema: {
        name: 'test_schema',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    };
    await requester({ ...base, stage: 'decision-1' });
    await requester({ ...base, stage: 'decision-2' });
    await requester({
      ...base,
      stage: 'decision-2',
      reasoningEffort: 'medium',
    });
    expect(requests[0]).toMatchObject({
      model: 'gpt-5.6',
      reasoning: { effort: 'low', context: 'current_turn' },
      store: false,
      max_output_tokens: 900,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(requests[1]).toMatchObject({
      reasoning: { effort: 'low', context: 'current_turn' },
      store: false,
      max_output_tokens: 2_000,
    });
    expect(requests[2]).toMatchObject({
      reasoning: { effort: 'medium', context: 'current_turn' },
    });
  });

  it('reads structured text from a raw Responses REST payload', async () => {
    const requester = createOpenAIRequester({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'resp_raw',
            status: 'completed',
            model: 'gpt-5.6-test',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '{"shouldAdapt":false}',
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const response = await requester({
      stage: 'decision-1',
      prompt: 'test',
      promptVersion: 'v1',
      outputSchema: {
        name: 'test_schema',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    });

    expect(response.output).toEqual({ shouldAdapt: false });
    expect(response.responseId).toBe('resp_raw');
  });

  it('retries one transport failure without retrying an HTTP response', async () => {
    let calls = 0;
    const requester = createOpenAIRequester({
      apiKey: 'test-key',
      networkRetryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return new Response(
          JSON.stringify({
            id: 'resp_retry',
            model: 'gpt-5.6-test',
            output_text: '{"ok":true}',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const response = await requester({
      stage: 'decision-1',
      prompt: 'test',
      promptVersion: 'v1',
      outputSchema: {
        name: 'test_schema',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    });

    expect(response.output).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('reports the Responses API incomplete reason when no text is returned', async () => {
    const requester = createOpenAIRequester({
      apiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(
      requester({
        stage: 'decision-1',
        prompt: 'test',
        promptVersion: 'v1',
        outputSchema: {
          name: 'test_schema',
          strict: true,
          schema: { type: 'object', additionalProperties: false },
        },
      }),
    ).rejects.toThrow('incomplete (max_output_tokens)');
  });
});
