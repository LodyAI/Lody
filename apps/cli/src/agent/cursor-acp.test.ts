import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CURSOR_LIST_AVAILABLE_MODELS_METHOD,
  fetchCursorModelCatalog,
  isRegistryCursorAgent,
} from './cursor-acp';

type CatalogClient = {
  requestExtMethod: ReturnType<typeof vi.fn>;
};

const createCatalogClient = (
  impl: (
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal }
  ) => Promise<Record<string, unknown>>
): CatalogClient => ({
  requestExtMethod: vi.fn(impl),
});

const selectOption = (value: string, name: string) => ({ value, name });

const selectConfig = (fields: {
  id: string;
  name: string;
  currentValue: string;
  category?: string;
  options: Array<{ value: string; name: string }>;
}) => ({
  type: 'select' as const,
  id: fields.id,
  name: fields.name,
  currentValue: fields.currentValue,
  ...(fields.category ? { category: fields.category } : {}),
  options: fields.options,
});

const fullModelCatalogResponse = {
  models: [
    {
      value: 'model-full',
      name: 'Full',
      configOptions: [
        selectConfig({
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'model-full',
          options: [selectOption('model-full', 'Full')],
        }),
        selectConfig({
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          currentValue: 'agent',
          options: [selectOption('agent', 'Agent')],
        }),
        selectConfig({
          id: 'thinking',
          name: 'Thinking',
          category: 'thought_level',
          currentValue: 'true',
          options: [selectOption('true', 'On'), selectOption('false', 'Off')],
        }),
        selectConfig({
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          currentValue: 'low',
          options: [selectOption('low', 'Low'), selectOption('high', 'High')],
        }),
        selectConfig({
          id: 'fast',
          name: 'Fast',
          currentValue: 'false',
          options: [selectOption('true', 'On'), selectOption('false', 'Off')],
        }),
        selectConfig({
          id: 'context',
          name: 'Context',
          category: 'model_config',
          currentValue: 'default',
          options: [selectOption('default', 'Default')],
        }),
        {
          type: 'boolean' as const,
          id: 'boolean',
          name: 'Boolean',
          currentValue: false,
        },
      ],
    },
    {
      value: 'model-empty',
      configOptions: [],
    },
  ],
};

const rejectWhenAborted = (signal: AbortSignal | undefined): Promise<Record<string, unknown>> =>
  new Promise((_resolve, reject) => {
    if (!signal) {
      return;
    }
    const rejectAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener('abort', rejectAbort, { once: true });
  });

describe('isRegistryCursorAgent', () => {
  it('is true only for registry Cursor identity', () => {
    expect(isRegistryCursorAgent({ cliType: 'registry', agentType: 'cursor' })).toBe(true);
    expect(isRegistryCursorAgent({ cliType: 'custom', agentType: 'cursor' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: 'builtin', agentType: 'claude' })).toBe(false);
    expect(isRegistryCursorAgent({ cliType: undefined, agentType: undefined })).toBe(false);
  });
});

describe('fetchCursorModelCatalog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('normalizes per-model options and drops model and mode entries', async () => {
    const client = createCatalogClient(async () => fullModelCatalogResponse);
    const result = await fetchCursorModelCatalog({ client });

    expect(result).toBeDefined();
    expect(Object.keys(result ?? {})).toEqual(['model-full', 'model-empty']);
    expect(result?.['model-full']?.map((option) => option.id)).toEqual([
      'thinking',
      'effort',
      'fast',
      'context',
      'boolean',
    ]);
    expect(
      result?.['model-full']?.some(
        (option) => option.category === 'model' || option.category === 'mode'
      )
    ).toBe(false);
    expect(result?.['model-empty']).toEqual([]);
    expect(result?.['model-absent']).toBeUndefined();
    expect(client.requestExtMethod).toHaveBeenCalledWith(
      CURSOR_LIST_AVAILABLE_MODELS_METHOD,
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('returns undefined when the agent reports method not found', async () => {
    const client = createCatalogClient(async () => {
      throw { code: -32601, message: 'Method not found' };
    });

    await expect(fetchCursorModelCatalog({ client })).resolves.toBeUndefined();
  });

  it('rejects other JSON-RPC errors as incomplete with cause', async () => {
    const rpcError = Object.assign(new Error('internal error'), { code: -32000 });
    const client = createCatalogClient(async () => {
      throw rpcError;
    });

    await expect(fetchCursorModelCatalog({ client })).rejects.toMatchObject({
      message: expect.stringMatching(/^\[ACP_CAPABILITIES_INCOMPLETE\]/),
      cause: rpcError,
    });
  });

  it('rejects a response that omits models', async () => {
    const client = createCatalogClient(async () => ({}));

    await expect(fetchCursorModelCatalog({ client })).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models response failed validation'
    );
  });

  it('rejects an option with an unknown type', async () => {
    const client = createCatalogClient(async () => ({
      models: [
        {
          value: 'model-full',
          configOptions: [
            {
              type: 'slider',
              id: 'temperature',
              name: 'Temperature',
              currentValue: '0.5',
            },
          ],
        },
      ],
    }));

    await expect(fetchCursorModelCatalog({ client })).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models response failed validation'
    );
  });

  it('rejects a select option that is missing currentValue', async () => {
    const client = createCatalogClient(async () => ({
      models: [
        {
          value: 'model-full',
          configOptions: [
            {
              type: 'select',
              id: 'thinking',
              name: 'Thinking',
              options: [selectOption('true', 'On')],
            },
          ],
        },
      ],
    }));

    await expect(fetchCursorModelCatalog({ client })).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models response failed validation'
    );
  });

  it('rejects a catalog that lists the same model value twice', async () => {
    const client = createCatalogClient(async () => ({
      models: [
        { value: 'model-empty', configOptions: [] },
        { value: 'model-empty', configOptions: [] },
      ],
    }));

    await expect(fetchCursorModelCatalog({ client })).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models listed model model-empty more than once'
    );
  });

  it('rejects with incomplete when the catalog request times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }, timeoutMs);
      return controller.signal;
    });
    const client = createCatalogClient((_method, _params, options) =>
      rejectWhenAborted(options.signal)
    );

    const pending = fetchCursorModelCatalog({ client, timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models timed out or was aborted'
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('rejects with incomplete when the caller aborts after the request starts', async () => {
    const controller = new AbortController();
    const client = createCatalogClient((_method, _params, options) =>
      rejectWhenAborted(options.signal)
    );

    const pending = fetchCursorModelCatalog({ client, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow(
      '[ACP_CAPABILITIES_INCOMPLETE] cursor/list_available_models timed out or was aborted'
    );
    controller.abort();
    await assertion;
  });

  it('rejects a pre-aborted signal before requesting the catalog', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createCatalogClient(async () => fullModelCatalogResponse);

    await expect(fetchCursorModelCatalog({ client, signal: controller.signal })).rejects.toThrow();
    expect(client.requestExtMethod).not.toHaveBeenCalled();
  });
});
