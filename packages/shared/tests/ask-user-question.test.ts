import { describe, expect, it } from 'vitest';
import type { CreateElicitationRequest, RequestPermissionRequest } from '@agentclientprotocol/sdk';

import {
  buildAskUserQuestionElicitationResponse,
  createAskUserQuestionPermissionOutcome,
  extractAskUserQuestionAnswersFromOutcome,
  getAskUserQuestionDisplayTitle,
  getAskUserQuestionPermissionDisplayTitle,
  getAskUserQuestionAnswerKey,
  isAskUserQuestionPermissionRequest,
  parseAskUserQuestionElicitationRequest,
  parseAskUserQuestionPermissionMeta,
} from '../src/acp/ask-user-question';

describe('AskUserQuestion permission metadata', () => {
  const meta = {
    claudeCode: {
      requestType: 'askUserQuestion',
      askUserQuestion: {
        version: 1,
        allowCustomAnswer: true,
        questions: [
          {
            question: 'Which database should we use?',
            header: 'Database',
            options: [
              { label: 'Postgres', description: 'Use PostgreSQL' },
              { label: 'SQLite', description: 'Use SQLite', preview: 'sqlite.db' },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  };

  it('parses valid Claude Code AskUserQuestion permission metadata', () => {
    expect(parseAskUserQuestionPermissionMeta(meta)).toEqual({
      source: 'claude',
      version: 1,
      allowCustomAnswer: true,
      questions: [
        {
          question: 'Which database should we use?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'Use PostgreSQL' },
            { label: 'SQLite', description: 'Use SQLite', preview: 'sqlite.db' },
          ],
          multiSelect: false,
        },
      ],
    });
  });

  it('accepts options without descriptions', () => {
    const parsed = parseAskUserQuestionPermissionMeta({
      claudeCode: {
        askUserQuestion: {
          version: 1,
          allowCustomAnswer: false,
          questions: [
            {
              question: 'Pick one',
              header: 'Pick',
              options: [{ label: 'Yes' }, { label: 'No' }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    expect(parsed?.questions[0]?.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
  });

  it('parses Codex request_user_input metadata with dynamic options', () => {
    expect(
      parseAskUserQuestionPermissionMeta({
        codex: {
          requestUserInput: {
            callId: 'call-1',
            turnId: 'turn-1',
            questions: [
              {
                id: 'next_step',
                header: 'Next step',
                question: 'How should I proceed with this plan?',
                isOther: true,
                isSecret: false,
                options: [
                  {
                    label: 'Tighten the plan first',
                    description: 'Review edge cases before implementation',
                  },
                  {
                    label: 'Start implementation',
                    description: 'Use the current proposal as the implementation guide',
                  },
                ],
              },
            ],
          },
        },
      })
    ).toEqual({
      source: 'codex',
      version: 1,
      allowCustomAnswer: true,
      questions: [
        {
          id: 'next_step',
          question: 'How should I proceed with this plan?',
          header: 'Next step',
          options: [
            {
              label: 'Tighten the plan first',
              description: 'Review edge cases before implementation',
            },
            {
              label: 'Start implementation',
              description: 'Use the current proposal as the implementation guide',
            },
          ],
          multiSelect: false,
          allowCustomAnswer: true,
          isSecret: false,
        },
      ],
    });
  });

  it('parses Codex request_user_input options without descriptions', () => {
    expect(
      parseAskUserQuestionPermissionMeta({
        codex: {
          requestUserInput: {
            callId: 'call-1',
            turnId: 'turn-1',
            questions: [
              {
                id: 'next_step',
                header: 'Next step',
                question: 'What should happen next?',
                is_other: true,
                is_secret: true,
                options: [{ label: 'Revise plan' }, { label: 'Start implementation' }],
              },
            ],
          },
        },
      })
    ).toEqual({
      source: 'codex',
      version: 1,
      allowCustomAnswer: true,
      questions: [
        {
          id: 'next_step',
          question: 'What should happen next?',
          header: 'Next step',
          options: [{ label: 'Revise plan' }, { label: 'Start implementation' }],
          multiSelect: false,
          allowCustomAnswer: true,
          isSecret: true,
        },
      ],
    });
  });

  it('rejects malformed question payloads', () => {
    expect(
      parseAskUserQuestionPermissionMeta({
        claudeCode: {
          askUserQuestion: {
            questions: [{ question: 'Missing header', options: [] }],
          },
        },
      })
    ).toBeNull();
  });

  it('detects AskUserQuestion request permission objects', () => {
    expect(
      isAskUserQuestionPermissionRequest({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1' },
        options: [],
        _meta: meta,
      } as RequestPermissionRequest)
    ).toBe(true);
  });

  it('extracts a notification display title from question metadata', () => {
    expect(getAskUserQuestionDisplayTitle(meta)).toBe('Which database should we use?');
    expect(
      getAskUserQuestionPermissionDisplayTitle({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1' },
        options: [],
        _meta: meta,
      } as RequestPermissionRequest)
    ).toBe('Which database should we use?');
  });

  it('builds selected outcomes with ACP answer metadata', () => {
    expect(
      createAskUserQuestionPermissionOutcome('answer', {
        'Which database should we use?': 'Postgres',
        'Which constraints matter?': ['Docker', 'Offline'],
      })
    ).toEqual({
      outcome: 'selected',
      optionId: 'answer',
      _meta: {
        claudeCode: {
          askUserQuestion: {
            answers: {
              'Which database should we use?': 'Postgres',
              'Which constraints matter?': ['Docker', 'Offline'],
            },
          },
        },
      },
    });
  });

  it('builds Codex selected outcomes as RequestUserInputResponse metadata', () => {
    expect(
      createAskUserQuestionPermissionOutcome(
        'answer',
        {
          next_step: 'Start implementation',
          constraints: ['Docker', 'Offline'],
        },
        'codex'
      )
    ).toEqual({
      outcome: 'selected',
      optionId: 'answer',
      _meta: {
        codex: {
          requestUserInput: {
            answers: {
              next_step: { answers: ['Start implementation'] },
              constraints: { answers: ['Docker', 'Offline'] },
            },
          },
        },
      },
    });
  });

  it('uses stable answer keys without overwriting duplicate question text', () => {
    const questions = [
      {
        question: 'Which option?',
        header: 'Database',
        options: [],
        multiSelect: false,
      },
      {
        question: 'Which option?',
        header: 'Runtime',
        options: [],
        multiSelect: false,
      },
      {
        question: 'Which option?',
        header: 'Runtime',
        options: [],
        multiSelect: false,
      },
    ];

    expect(getAskUserQuestionAnswerKey(questions, 0)).toBe('Database');
    expect(getAskUserQuestionAnswerKey(questions, 1)).toBe('1');
    expect(getAskUserQuestionAnswerKey(questions, 2)).toBe('2');
  });

  it('uses Codex question ids as answer keys', () => {
    const questions = [
      {
        id: 'next_step',
        question: 'Which option?',
        header: 'Next step',
        options: [],
        multiSelect: false,
      },
      {
        id: 'constraints',
        question: 'Which constraints?',
        header: 'Constraints',
        options: [],
        multiSelect: false,
      },
    ];

    expect(getAskUserQuestionAnswerKey(questions, 0)).toBe('next_step');
    expect(getAskUserQuestionAnswerKey(questions, 1)).toBe('constraints');
  });

  it('accepts legacy Claude answers for a Core question request', () => {
    const coreMeta = parseAskUserQuestionPermissionMeta({
      lody: {
        elicitation: {
          version: 1,
          questions: [
            {
              id: 'question_0',
              question: 'Which database should we use?',
              header: 'Database',
              options: [{ label: 'Postgres' }],
              multiSelect: false,
            },
          ],
        },
      },
    })!;

    expect(
      extractAskUserQuestionAnswersFromOutcome(coreMeta, {
        _meta: {
          claudeCode: {
            askUserQuestion: {
              answers: { 'Which database should we use?': 'Postgres' },
            },
          },
        },
      })
    ).toEqual({ question_0: 'Postgres' });
  });

  it('accepts legacy Codex answers for a Core question request', () => {
    const coreMeta = parseAskUserQuestionPermissionMeta({
      lody: {
        elicitation: {
          version: 1,
          questions: [
            {
              id: 'next_step',
              question: 'What next?',
              header: 'Next step',
              options: [{ label: 'Ship' }],
              multiSelect: false,
            },
          ],
        },
      },
    })!;

    expect(
      extractAskUserQuestionAnswersFromOutcome(coreMeta, {
        _meta: {
          codex: {
            requestUserInput: {
              answers: { next_step: { answers: ['Ship'] } },
            },
          },
        },
      })
    ).toEqual({ next_step: 'Ship' });
  });
});

describe('AskUserQuestion form elicitation bridge (Claude >= 0.44.0)', () => {
  // Mirrors `askUserQuestionsToCreateRequest` from acp-extension-claude 0.44.0:
  // a single-question form carries the prompt on `message`, encodes the option
  // description as `${label} — ${description}` in the enum title, and appends a
  // free-text `customAnswer` field.
  const singleRequest = {
    mode: 'form',
    sessionId: 's1',
    toolCallId: 'tc1',
    message: 'Which database should we use?',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Database',
          oneOf: [
            { const: 'Postgres', title: 'Postgres — Use PostgreSQL' },
            { const: 'SQLite', title: 'SQLite' },
          ],
        },
        customAnswer: {
          type: 'string',
          title: 'Other',
          description: 'Type your own answer instead of choosing an option above (optional).',
        },
      },
    },
  } as unknown as CreateElicitationRequest;

  it('parses a single-question form into AskUserQuestion metadata', () => {
    expect(parseAskUserQuestionElicitationRequest(singleRequest)).toEqual({
      meta: {
        source: 'claude',
        version: 1,
        allowCustomAnswer: true,
        questions: [
          {
            question: 'Which database should we use?',
            header: 'Database',
            options: [{ label: 'Postgres', description: 'Use PostgreSQL' }, { label: 'SQLite' }],
            multiSelect: false,
          },
        ],
      },
      fieldKeys: ['question_0'],
    });
  });

  it('folds a selected answer back into form content keyed by field id', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(singleRequest)!;
    const outcome = createAskUserQuestionPermissionOutcome('answer', {
      'Which database should we use?': 'Postgres',
    });
    expect(buildAskUserQuestionElicitationResponse(elicitation, { outcome })).toEqual({
      action: 'accept',
      content: { question_0: 'Postgres' },
    });
  });

  it('carries a custom (non-option) answer through the same field', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(singleRequest)!;
    const outcome = createAskUserQuestionPermissionOutcome('answer', {
      'Which database should we use?': 'CockroachDB',
    });
    expect(buildAskUserQuestionElicitationResponse(elicitation, { outcome })).toEqual({
      action: 'accept',
      content: { question_0: 'CockroachDB' },
    });
  });

  // Multi-question forms put the prompt in each field `description` and use an
  // array `items.anyOf` for multi-select questions.
  const multiRequest = {
    mode: 'form',
    sessionId: 's1',
    toolCallId: 'tc2',
    message: 'Please answer the following questions.',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Database',
          description: 'Which database?',
          oneOf: [
            { const: 'Postgres', title: 'Postgres' },
            { const: 'SQLite', title: 'SQLite' },
          ],
        },
        question_1: {
          type: 'array',
          title: 'Constraints',
          description: 'Which constraints matter?',
          items: {
            anyOf: [
              { const: 'Docker', title: 'Docker' },
              { const: 'Offline', title: 'Offline' },
            ],
          },
        },
        customAnswer: { type: 'string', title: 'Other', description: 'optional' },
      },
    },
  } as unknown as CreateElicitationRequest;

  it('parses a multi-question form with a multi-select field', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(multiRequest)!;
    expect(elicitation.fieldKeys).toEqual(['question_0', 'question_1']);
    expect(elicitation.meta.questions).toEqual([
      {
        question: 'Which database?',
        header: 'Database',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        multiSelect: false,
      },
      {
        question: 'Which constraints matter?',
        header: 'Constraints',
        options: [{ label: 'Docker' }, { label: 'Offline' }],
        multiSelect: true,
      },
    ]);
  });

  it('maps multi-question answers (including arrays) to their fields', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(multiRequest)!;
    const outcome = createAskUserQuestionPermissionOutcome('answer', {
      'Which database?': 'Postgres',
      'Which constraints matter?': ['Docker', 'Offline'],
    });
    expect(buildAskUserQuestionElicitationResponse(elicitation, { outcome })).toEqual({
      action: 'accept',
      content: { question_0: 'Postgres', question_1: ['Docker', 'Offline'] },
    });
  });

  it('maps cancellation and the cancel option to a cancel action', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(singleRequest)!;
    expect(
      buildAskUserQuestionElicitationResponse(elicitation, { outcome: { outcome: 'cancelled' } })
    ).toEqual({ action: 'cancel' });
    const cancelOutcome = createAskUserQuestionPermissionOutcome('cancel', {});
    expect(
      buildAskUserQuestionElicitationResponse(elicitation, { outcome: cancelOutcome })
    ).toEqual({ action: 'cancel' });
  });

  it('accepts with empty content when no answers were provided', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(singleRequest)!;
    expect(
      buildAskUserQuestionElicitationResponse(elicitation, {
        outcome: { outcome: 'selected', optionId: 'answer' },
      })
    ).toEqual({ action: 'accept', content: {} });
  });

  it('declines non-AskUserQuestion elicitations', () => {
    expect(
      parseAskUserQuestionElicitationRequest({
        mode: 'url',
        sessionId: 's1',
        url: 'https://example.com',
        message: 'Open this',
        elicitationId: 'e1',
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
    // A form with only free-text fields (no enum-backed questions) is not an
    // AskUserQuestion form.
    expect(
      parseAskUserQuestionElicitationRequest({
        mode: 'form',
        sessionId: 's1',
        message: 'What is your name?',
        requestedSchema: {
          type: 'object',
          properties: { name: { type: 'string', title: 'Name' } },
        },
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
  });
});

describe('AskUserQuestion form elicitation bridge (Lody extension)', () => {
  const request = {
    mode: 'form',
    sessionId: 's1',
    toolCallId: 'request-user-input-1',
    message: 'Input requested',
    requestedSchema: {
      type: 'object',
      properties: {
        next_step: {
          type: 'string',
          title: 'Next step',
          description: 'How should I proceed?',
          oneOf: [
            {
              const: 'Revise plan',
              title: 'Revise plan',
              description: 'Review edge cases first',
            },
            { const: 'Start implementation', title: 'Start implementation' },
          ],
          _meta: { lody: { elicitation: { version: 1, secret: false } } },
        },
        next_step__other: {
          type: 'string',
          title: 'Other',
          description: 'Type your own answer instead of choosing an option above.',
          _meta: {
            lody: {
              elicitation: { version: 1, customAnswerFor: 'next_step', secret: false },
            },
          },
        },
        api_key: {
          type: 'string',
          title: 'API key',
          description: 'Which API key should I use?',
          _meta: { lody: { elicitation: { version: 1, secret: true } } },
        },
      },
      required: ['api_key'],
    },
    _meta: { lody: { elicitation: { version: 1, autoResolveAfterSeconds: 60 } } },
  } as unknown as CreateElicitationRequest;

  it('parses options, free text, secrets, Other fields, and automatic resolution', () => {
    expect(parseAskUserQuestionElicitationRequest(request)).toEqual({
      meta: {
        source: 'lody',
        version: 1,
        allowCustomAnswer: true,
        questions: [
          {
            id: 'next_step',
            question: 'How should I proceed?',
            header: 'Next step',
            options: [
              { label: 'Revise plan', description: 'Review edge cases first' },
              { label: 'Start implementation' },
            ],
            multiSelect: false,
            allowCustomAnswer: true,
          },
          {
            id: 'api_key',
            question: 'Which API key should I use?',
            header: 'API key',
            options: [],
            multiSelect: false,
            allowCustomAnswer: true,
            isSecret: true,
          },
        ],
      },
      fieldKeys: ['next_step', 'api_key'],
      customFieldKeys: ['next_step__other', undefined],
      autoResolutionMs: 60_000,
    });
  });

  it('writes custom choices to the linked Other field', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(request)!;
    const outcome = createAskUserQuestionPermissionOutcome(
      'answer',
      { next_step: 'Use a smaller patch', api_key: 'secret-value' },
      elicitation.meta
    );
    expect(buildAskUserQuestionElicitationResponse(elicitation, { outcome })).toEqual({
      action: 'accept',
      content: {
        next_step__other: 'Use a smaller patch',
        api_key: 'secret-value',
      },
    });
  });

  it('writes selected options to the primary field', () => {
    const elicitation = parseAskUserQuestionElicitationRequest(request)!;
    const outcome = createAskUserQuestionPermissionOutcome(
      'answer',
      { next_step: 'Start implementation', api_key: 'secret-value' },
      elicitation.meta
    );
    expect(buildAskUserQuestionElicitationResponse(elicitation, { outcome })).toEqual({
      action: 'accept',
      content: { next_step: 'Start implementation', api_key: 'secret-value' },
    });
  });
});
