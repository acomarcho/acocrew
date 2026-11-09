// Statistics, for admins: what the machine's Claude Code and Codex would have cost at API prices over the last
// 30 days, per day and per model. The server reads it from their logs (see `apps/server/src/usage.ts`).
import type { UsageProvider, UsageStats } from '@acocrew/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadUsage } from '../store';

export const Route = createFileRoute('/statistics')({ component: Statistics });

const SERIES: { id: UsageProvider; name: string; color: string }[] = [
  { id: 'claude', name: 'Claude Code', color: '#2a78d6' },
  { id: 'codex', name: 'Codex', color: '#eb6834' },
];

const dollars = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 100 ? 0 : 2 });
const count = (value: number) => value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const date = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// The lines behind the bars: a round step (1, 2, 2.5 or 5 times a power of ten), and how many steps it takes to
// reach `max`. At most four.
function scaleFor(max: number) {
  const rough = Math.max(max, 1) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((times) => times * power).find((step) => step >= rough)!;
  return { step, lines: Math.ceil(Math.max(max, 1) / step) };
}

function Legend() {
  return (
    <div className="flex gap-4 text-sm text-muted-foreground">
      {SERIES.map((series) => (
        <span key={series.id} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: series.color }} />
          {series.name}
        </span>
      ))}
    </div>
  );
}

// One bar per day, Codex stacked on Claude Code. Hovering or tapping a day shows its numbers.
function DailyChart({ daily }: { daily: UsageStats['daily'] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { step, lines } = scaleFor(Math.max(...daily.map((row) => row.claude + row.codex)));
  const top = step * lines;
  const shown = hovered === null ? null : daily[hovered];
  return (
    <div>
      <div className="relative ml-12 h-56">
        {Array.from({ length: lines + 1 }, (_, line) => (
          <div
            key={line}
            className="absolute inset-x-0 border-t border-border"
            style={{ bottom: `${(line / lines) * 100}%` }}
          >
            <span className="absolute right-full mr-2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">
              ${(line * step).toLocaleString('en-US')}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 flex gap-[2px]" onMouseLeave={() => setHovered(null)}>
          {daily.map((row, i) => {
            const parts = SERIES.filter((series) => row[series.id] > 0);
            return (
              <div
                key={row.day}
                className={`flex h-full flex-1 flex-col-reverse gap-[2px] rounded-t-sm ${i === hovered ? 'bg-muted/70' : ''}`}
                onMouseEnter={() => setHovered(i)}
                onClick={() => setHovered(i)}
              >
                {parts.map((series, part) => (
                  <div
                    key={series.id}
                    className={part === parts.length - 1 ? 'rounded-t-[4px]' : ''}
                    style={{ height: `${(row[series.id] / top) * 100}%`, background: series.color }}
                  />
                ))}
              </div>
            );
          })}
        </div>
        {shown && (
          <div
            className="pointer-events-none absolute -top-2 z-10 w-max -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg"
            style={{ left: `clamp(4.5rem, ${((hovered! + 0.5) / daily.length) * 100}%, calc(100% - 4.5rem))` }}
          >
            <div className="mb-1 font-semibold">{date(shown.day)}</div>
            {SERIES.map((series) => (
              <div key={series.id} className="flex items-center gap-2">
                <span className="size-2 rounded-sm" style={{ background: series.color }} />
                <span className="flex-1 text-muted-foreground">{series.name}</span>
                <span className="tabular-nums">{dollars(shown[series.id])}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between gap-4 border-t border-border pt-1 font-medium">
              <span>Total</span>
              <span className="tabular-nums">{dollars(shown.claude + shown.codex)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-1.5 ml-12 flex justify-between text-xs text-muted-foreground">
        <span>{date(daily[0].day)}</span>
        <span>{date(daily[Math.floor(daily.length / 2)].day)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function Models({ models }: { models: UsageStats['models'] }) {
  const cell = 'px-2 py-2 text-right tabular-nums';
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-2 py-2 text-left font-medium">Model</th>
            <th className={`${cell} font-medium`}>Cost</th>
            <th className={`${cell} font-medium`}>Input</th>
            <th className={`${cell} font-medium`}>Cache read</th>
            <th className={`${cell} font-medium`}>Cache write</th>
            <th className={`${cell} font-medium`}>Output</th>
          </tr>
        </thead>
        <tbody>
          {models.map((row) => (
            <tr key={`${row.provider}/${row.model}`} className="border-b border-border last:border-b-0">
              <td className="px-2 py-2">
                <div className="font-medium">{row.model}</div>
                <div className="text-xs text-muted-foreground">
                  {SERIES.find((series) => series.id === row.provider)!.name}
                </div>
              </td>
              <td className={`${cell} font-medium`}>
                {row.cost === null ? <span className="text-muted-foreground">No price</span> : dollars(row.cost)}
              </td>
              <td className={cell}>{count(row.tokens.input)}</td>
              <td className={cell}>{count(row.tokens.cacheRead)}</td>
              <td className={cell}>{count(row.tokens.cacheWrite)}</td>
              <td className={cell}>{count(row.tokens.output)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Statistics() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState('');
  useEffect(() => void loadUsage().then(setStats, (err) => setError(err.message)), []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-3 md:py-10">
        <div className="flex items-center gap-2">
          <Link to="/" className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Back">
            <ChevronLeft size={20} />
          </Link>
          <h2 className="flex-1 text-xl font-bold">Statistics</h2>
        </div>
        {error && <p className="text-sm text-rose-500">{error}</p>}
        {!stats && !error && (
          <p className="text-sm text-muted-foreground">
            Reading the logs on this machine. The first time after the server starts can take a minute.
          </p>
        )}
        {stats && (
          <>
            <section className="rounded-xl border border-border bg-card p-4">
              <p className="text-sm text-muted-foreground">API cost of the last {stats.days} days</p>
              <p className="text-4xl font-bold tabular-nums">{dollars(stats.total)}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                What Claude Code and Codex on this machine would have cost at API prices, worked out from their logs. It
                is an estimate: a subscription is not billed per token. Everything run on this machine counts, also
                outside acocrew.
              </p>
            </section>
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">Each day</h3>
                <Legend />
              </div>
              <DailyChart daily={stats.daily} />
            </section>
            <section className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-2 font-semibold">By model</h3>
              {stats.models.length ? (
                <Models models={stats.models} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing was run in these days.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
