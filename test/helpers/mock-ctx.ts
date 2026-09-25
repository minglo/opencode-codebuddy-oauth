// test/helpers/mock-ctx.ts — V2 mock context（不 import 宿主包）
import { vi } from "vitest";
import { getConfig, resolveServerUrl } from "../../src/config.js";
import { LRUMap } from "../../src/lru.js";
import type { PluginState } from "../../src/state.js";

type TransformCb = (editor: any) => void;
type HookCb = (event: any) => unknown;
type DisposeFn = ReturnType<typeof vi.fn>;

export interface MockCredential {
  type: "oauth" | "key";
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
}

export interface MockCtxOptions {
  credential?: MockCredential;
  subscription?: (signal: AbortSignal) => AsyncIterable<any>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function makeTestState(overrides: Partial<PluginState> = {}): PluginState {
  const cfg = getConfig();
  return {
    cfg,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    server: resolveServerUrl(cfg),
    conversationIds: new LRUMap<string, string>(1000),
    discoveryCache: { get: vi.fn(async () => []) } as any,
    discovered: null,
    requestSnapshots: new LRUMap(32),
    ...overrides,
  };
}

export function makeIntegrationEditor() {
  const updates: any[] = [];
  return {
    updates,
    editor: {
      list: () => [],
      get: () => undefined,
      update: () => {},
      remove: () => {},
      method: {
        list: () => [],
        update: (input: any) => updates.push(input),
        remove: () => {},
      },
    },
  };
}

export function makeProviderEditor(seed?: any) {
  const added: any[] = [];
  const updates: string[] = [];
  const existing = seed ?? undefined;
  return {
    added,
    updates,
    editor: {
      list: () => (existing ? [existing] : []),
      get: (id: string) => (existing && id === "codebuddy" ? existing : undefined),
      add: (input: any) => added.push(input),
      update: (id: string, cb: (p: any) => void) => { updates.push(id); if (existing) cb(existing.provider); },
      remove: () => {},
      models: { set: vi.fn(), update: vi.fn(), remove: vi.fn() },
    },
  };
}

export function makeModelEditor(draftSeed: Record<string, unknown> = {}) {
  const updates: Array<{ providerID: string; modelID: string }> = [];
  const drafts: any[] = [];
  return {
    updates,
    drafts,
    editor: {
      list: () => [],
      get: () => undefined,
      update: (providerID: string, modelID: string, cb: (m: any) => void) => {
        updates.push({ providerID, modelID });
        const draft: any = { ...draftSeed };
        cb(draft);
        drafts.push(draft);
      },
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
      provider: { list: () => [], get: () => undefined },
    },
  };
}

export function createMockCtx(opts: MockCtxOptions = {}) {
  let credential = opts.credential;
  const calls = {
    integrationTransforms: [] as TransformCb[],
    providerTransforms: [] as TransformCb[],
    modelTransforms: [] as TransformCb[],
    hooks: new Map<string, HookCb>(),
    hookOptions: new Map<string, unknown>(),
    subscriptions: [] as Array<(signal: AbortSignal) => AsyncIterable<any>>,
    reloads: { provider: 0, model: 0 },
    disposals: [] as DisposeFn[],
  };

  const registration = () => {
    const dispose: DisposeFn = vi.fn(async () => {});
    calls.disposals.push(dispose);
    return { dispose };
  };

  const integration = {
    transform: vi.fn(async (cb: TransformCb) => { calls.integrationTransforms.push(cb); return registration(); }),
    reload: vi.fn(async () => {}),
    connection: {
      active: vi.fn(async () => (credential ? { type: "credential", id: "cred-1", label: "test" } : undefined)),
      resolve: vi.fn(async () => credential),
    },
  };
  const provider = {
    transform: vi.fn(async (cb: TransformCb) => { calls.providerTransforms.push(cb); return registration(); }),
    reload: vi.fn(async () => { calls.reloads.provider++; }),
    list: vi.fn(async () => []),
  };
  const model = {
    transform: vi.fn(async (cb: TransformCb) => { calls.modelTransforms.push(cb); return registration(); }),
    reload: vi.fn(async () => { calls.reloads.model++; }),
    list: vi.fn(async () => []),
  };
  const event = {
    subscribe: vi.fn((options?: { signal?: AbortSignal }) => {
      const factory = opts.subscription ?? (async function* () { /* 空流 */ });
      calls.subscriptions.push(factory);
      return factory(options?.signal ?? new AbortController().signal);
    }),
  };
  const session = {
    hook: vi.fn(async (name: string, cb: HookCb, options?: unknown) => {
      calls.hooks.set(name, cb);
      calls.hookOptions.set(name, options);
      return registration();
    }),
  };

  const ctx = {
    app: { name: "opencode", version: "2.0.11", channel: "test" },
    location: { directory: "/tmp/proj", project: { id: "proj-1", directory: "/tmp/proj", canonical: "/tmp/proj" } },
    options: {},
    integration,
    provider,
    model,
    event,
    session,
    storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), scan: vi.fn() },
  };

  return {
    ctx: ctx as any,
    calls,
    setCredential: (v: MockCredential | undefined) => { credential = v; },
    triggerHook: async (name: string, eventArg: any) => {
      const cb = calls.hooks.get(name);
      if (!cb) throw new Error(`hook ${name} 未注册`);
      return cb(eventArg);
    },
    applyIntegrationTransforms: (editor: any) => { calls.integrationTransforms.forEach((cb) => cb(editor)); },
    applyProviderTransforms: (editor: any) => { calls.providerTransforms.forEach((cb) => cb(editor)); },
    applyModelTransforms: (editor: any) => { calls.modelTransforms.forEach((cb) => cb(editor)); },
  };
}
