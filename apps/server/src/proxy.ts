// The model proxy: a program such as CLIProxyAPI that answers like Anthropic's API and passes calls on to other
// model providers. A thread on one of its models still runs Claude Code, pointed at the proxy instead of Anthropic.
import { MODELS, type Model, type NewProxySettings, type ProxySettings } from '@acocrew/shared';
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

// What Claude is started with to run `model` through the proxy: where its calls go, and which model fills each
// of Claude Code's slots (its side jobs use the Haiku one). `login` is the key. It goes into the environment of
// the process rather than its settings, so it never shows in the machine's list of running programs.
export function throughProxy(model: string, { url, key, background }: Proxy) {
  return {
    env: {
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: background,
    },
    login: { ANTHROPIC_AUTH_TOKEN: key },
  };
}

export function createProxy(db: Db) {
  let asked: { at: number; list: Promise<string[]> } | undefined;

  const read = (): Proxy => {
    const row = db.select().from(settings).where(eq(settings.key, 'proxy')).get();
    return { ...PROXY_DEFAULTS, ...(row?.value as Partial<Proxy> | undefined) };
  };

  // Which models the proxy offers. Claude's own are left out: those always go to Anthropic.
  async function ask({ url, key }: Proxy) {
    const res = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ASK_MS),
    }).catch(() => {
      throw new Error(`Nothing answers at ${url}.`);
    });
    if (!res.ok) throw new Error(`The model proxy said no (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const { data } = (await res.json()) as { data: { id: string }[] };
    return data
      .map((model) => model.id)
      .filter((id) => !isClaude(id))
      .sort();
  }

  // A failed try is not kept, so the next request asks again.
  function proxyModels() {
    if (asked && Date.now() - asked.at < MODELS_MS) return asked.list;
    const list = ask(read());
    asked = { at: Date.now(), list };
    list.catch(() => (asked = undefined));
    return list;
  }

  return {
    read,

    // Whether a thread can run on this model. Only a model that is not Claude's own makes the proxy be asked, so a
    // proxy that is away never holds up a Claude thread.
    offers: async (id: string) => isClaude(id) || (await proxyModels().catch((): string[] => [])).includes(id),

    // Every model a thread can run on: Claude's own, then what the proxy offers. Just Claude's while the proxy
    // does not answer.
    async models(): Promise<Model[]> {
      const ids = await proxyModels().catch(() => []);
      const through = ids.map((id) => ({
        id,
        name: id,
        hint: 'Through the model proxy',
        bigContext: false,
        fast: false,
      }));
      return [...MODELS, ...through];
    },

    // How it is set up, for an admin to see. Never the key itself.
    async shown(): Promise<ProxySettings> {
      const { url, key, background } = read();
      const known = { url, background, keySet: Boolean(key) };
      return proxyModels().then(
        (models) => ({ ...known, models, error: null }),
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
