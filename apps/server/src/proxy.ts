// The model proxy: a program such as CLIProxyAPI that answers like Anthropic's API and passes calls on to other
// model providers. A thread on one of its models still runs Claude Code, pointed at the proxy instead of Anthropic.
import { EFFORTS, MODELS, type Model, type NewProxySettings, type ProxySettings } from '@acocrew/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { settings } from './schema.ts';

export type Proxy = { url: string; key: string; background: string };

// Until an admin saves something: where CLIProxyAPI listens out of the box, and a quick, cheap model of
// OpenCode Go for Claude Code's side jobs.
export const PROXY_DEFAULTS: Proxy = { url: 'http://127.0.0.1:8317', key: '', background: 'deepseek-v4.1-flash' };

// How long the proxy's list of models is kept before it is asked again, and how long it gets to answer.
const MODELS_MS = 60_000;
const ASK_MS = 5000;

const isClaude = (id: string) => MODELS.some((model) => model.id === id);

// What Claude is started with to run `model` through the proxy: where its calls go, which model fills each of
// Claude Code's slots (its side jobs use the Haiku one), and how many tokens the model keeps in view. Claude Code
// does not know the models of other providers, so without `window` it takes them for 200K and summarizes the
// conversation well before most of them would need it. `login` is the key. It goes into the environment of the
// process rather than its settings, so it never shows in the machine's list of running programs.
export function throughProxy(model: string, { url, key, background }: Proxy, window: number | null) {
  return {
    env: {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: background,
      ...(window && { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) }),
    },
    login: { ANTHROPIC_AUTH_TOKEN: key },
  };
}

export function createProxy(db: Db) {
  let asked: { at: number; list: Promise<Model[]> } | undefined;
  // What the proxy said last time it answered, for what has to be known right away (see `windowOf`).
  let last: Model[] = [];

  const read = (): Proxy => {
    const row = db.select().from(settings).where(eq(settings.key, 'proxy')).get();
    return { ...PROXY_DEFAULTS, ...(row?.value as Partial<Proxy> | undefined) };
  };

  // Which models the proxy offers, how hard each one can think and how many tokens it keeps in view. CLIProxyAPI
  // tells that only when asked the way Codex asks (with a `client_version`); its plain list has the names alone.
  // A model's levels are the ones its `thinking.levels` in the proxy's config names. Of those, only the ones
  // Claude Code can ask for are kept. Its window is the config's `max-context-length`.
  // Claude's own models are left out: those always go to Anthropic.
  async function ask({ url, key }: Proxy): Promise<Model[]> {
    const res = await fetch(`${url}/v1/models?client_version=1`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ASK_MS),
    }).catch(() => {
      throw new Error(`Nothing answers at ${url}.`);
    });
    if (!res.ok) throw new Error(`The model proxy said no (${res.status}): ${(await res.text()).slice(0, 200)}`);
    type Listed = { slug: string; context_window?: number; supported_reasoning_levels: { effort: string }[] | null };
    const { models } = (await res.json()) as { models?: Listed[] };
    if (!Array.isArray(models)) throw new Error('The model proxy did not list its models the way CLIProxyAPI does.');
    return models
      .filter((model) => !isClaude(model.slug))
      .map(({ slug, context_window, supported_reasoning_levels }) => {
        const levels = (supported_reasoning_levels ?? []).map((level) => level.effort);
        const efforts = EFFORTS.map((effort) => effort.id).filter((id) => levels.includes(id));
        const window = context_window || null;
        return {
          id: slug,
          name: slug,
          hint: 'Through the model proxy',
          bigContext: false,
          fast: false,
          efforts,
          window,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // A failed try is not kept, so the next request asks again.
  function proxyModels() {
    if (asked && Date.now() - asked.at < MODELS_MS) return asked.list;
    const list = ask(read());
    asked = { at: Date.now(), list };
    list.then(
      (models) => (last = models),
      () => (asked = undefined),
    );
    return list;
  }
  const proxyModelsOrNone = () => proxyModels().catch((): Model[] => []);

  return {
    read,

    // How many tokens a proxy model keeps in view, as the proxy last said. Starting Claude cannot wait for the proxy.
    // Every message has it asked first, so only an automation run right after the server started can find nothing
    // yet, and then Claude assumes 200K for that run.
    windowOf: (id: string) => last.find((model) => model.id === id)?.window ?? null,

    // Whether a thread can run on this model. Only a model that is not Claude's own makes the proxy be asked, so a
    // proxy that is away never holds up a Claude thread.
    offers: async (id: string) => isClaude(id) || (await proxyModelsOrNone()).some((model) => model.id === id),

    // Every model a thread can run on: Claude's own, then what the proxy offers. Just Claude's while the proxy
    // does not answer.
    models: async (): Promise<Model[]> => [...MODELS, ...(await proxyModelsOrNone())],

    // How it is set up, for an admin to see. Never the key itself.
    async shown(): Promise<ProxySettings> {
      const { url, key, background } = read();
      const known = { url, background, keySet: Boolean(key) };
      return proxyModels().then(
        (models) => ({ ...known, models: models.map((model) => model.id), error: null }),
        (err: Error) => ({ ...known, models: [], error: err.message }),
      );
    },

    // Saves what an admin filled in. Gives back why it cannot be used, or null when it was saved.
    save(body: Partial<NewProxySettings>) {
      const { url, background, key } = body;
      const address = typeof url === 'string' && URL.canParse(url.trim()) ? new URL(url.trim()) : null;
      if (!address || !['http:', 'https:'].includes(address.protocol))
        return 'The address has to start with http:// or https://.';
      if (typeof background !== 'string' || !background.trim()) return 'Pick a model for side jobs.';
      const value: Proxy = {
        url: address.href.replace(/\/+$/, ''),
        background: background.trim(),
        key: (typeof key === 'string' && key.trim()) || read().key,
      };
      db.insert(settings)
        .values({ key: 'proxy', value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
      asked = undefined;
      return null;
    },
  };
}
