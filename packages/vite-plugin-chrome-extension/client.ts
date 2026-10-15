/** Values explicitly saved by a content script survive its next mount. */
export interface ContentScriptContext {
  data: Record<string, unknown>;
  onDispose(callback: (data: Record<string, unknown>) => void | Promise<void>): void;
  signal: AbortSignal;
}

export type ContentScriptCleanup = () => void | Promise<void>;
export type ContentScriptSetup = (
  context: ContentScriptContext,
) => void | ContentScriptCleanup | Promise<void | ContentScriptCleanup>;

interface Mount {
  dispose(): Promise<void>;
}

interface Slot {
  data: Record<string, unknown>;
  current?: Mount;
  pending: Promise<unknown>;
}

// A freshly injected bundle has a new module scope. Keep lifecycle ownership in
// its execution world's global instead, so a replacement can dispose its owner.
const registryKey = Symbol.for("chrome-extension:content-script-lifecycle");
const runtime = globalThis as typeof globalThis & { [registryKey]?: Map<string, Slot> };
const registry = runtime[registryKey] ||= new Map<string, Slot>();

/**
 * Mount a content script and return an idempotent asynchronous stop function.
 * Reusing an id disposes its previous mount before running the next setup.
 * The API also works in production, without Chrome or a development server.
 */
export function defineContentScript(id: string, setup: ContentScriptSetup): Promise<() => Promise<void>> {
  let slot = registry.get(id);
  if (!slot) {
    slot = { data: {}, pending: Promise.resolve() };
    registry.set(id, slot);
  }
  const owner = slot;
  const mounted = owner.pending.catch(() => undefined).then(async () => {
    const previous = owner.current;
    owner.current = undefined;
    await previous?.dispose();

    const controller = new AbortController();
    const disposers: Array<(data: Record<string, unknown>) => void | Promise<void>> = [];
    let disposal: Promise<void> | undefined;
    const mount: Mount = {
      dispose() {
        disposal ||= Promise.resolve().then(async () => {
          controller.abort();
          const errors: unknown[] = [];
          for (const dispose of disposers) {
            try { await dispose(owner.data); } catch (error) { errors.push(error); }
          }
          if (owner.current === mount) owner.current = undefined;
          if (errors.length === 1) throw errors[0];
          if (errors.length) throw new AggregateError(errors, `Content script "${id}" cleanup failed.`);
        });
        return disposal;
      },
    };
    owner.current = mount;
    try {
      const cleanup = await setup({
        data: owner.data,
        signal: controller.signal,
        onDispose(callback) { disposers.push(callback); },
      });
      if (cleanup) disposers.push(cleanup);
    } catch (error) {
      try { await mount.dispose(); } catch { /* Preserve the setup error after attempting every cleanup. */ }
      throw error;
    }
    return () => mount.dispose();
  });
  owner.pending = mounted;
  return mounted;
}
