// What Claude is waiting on the user for: a yes to an action, or an answer to its questions.
// Both are pinned above the message box, so nobody has to scroll to find them.
import type { Answer, Item, Question } from '@acocrew/shared';
import { Check, Ellipsis, Hand, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';

type Tool = Extract<Item, { kind: 'tool' }>;
type Reply = (answer: Omit<Answer, 'toolId'>) => Promise<unknown>;

export const isAsking = (item: Item): item is Tool => item.kind === 'tool' && item.ask === 'pending' && !item.done;

// Model output decides what a question looks like, so only treat it as one when the shape is what we expect.
const questionsOf = (tool: Tool): Question[] | undefined =>
  tool.questions?.length && tool.questions.every((q) => q.question && Array.isArray(q.options))
    ? tool.questions
    : undefined;

const panel = 'mb-2 rounded-lg border border-rose-500/30 bg-card p-3 text-sm shadow-sm';
const button = 'rounded-md px-3 py-1.5 text-sm font-medium';

// Approve or decline what Claude wants to do. The two rarer choices sit behind the "..." button.
export function ApprovalPanel({ tool, reply }: { tool: Tool; reply: Reply }) {
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const send = (decision: Answer['decision']) => {
    setMenu(false);
    reply({ decision }).catch((err: Error) => setError(err.message));
  };
  const more = 'block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted';
  return (
    <div className={panel}>
      <div className="flex items-center gap-2">
        <Hand size={15} className="shrink-0 text-rose-500" />
        <span className="font-medium">Claude wants to use {tool.name}</span>
      </div>
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">
        {tool.input}
      </pre>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <div className="relative">
          <button
            type="button"
            aria-label="More choices"
            onClick={() => setMenu(!menu)}
            className={`${button} border border-border px-2`}
          >
            <Ellipsis size={16} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="absolute right-0 bottom-full z-50 mb-1 w-64 rounded-lg border border-border bg-card p-1 shadow-xl">
                <button type="button" className={more} onClick={() => send('always')}>
                  Always allow this session
                  <span className="block text-xs text-muted-foreground">
                    Yes, and stop asking about this kind of action
                  </span>
                </button>
                <button type="button" className={more} onClick={() => send('cancel')}>
                  Cancel
                  <span className="block text-xs text-muted-foreground">No, and stop what Claude is doing</span>
                </button>
              </div>
            </>
          )}
        </div>
        <button type="button" className={`${button} border border-border`} onClick={() => send('decline')}>
          Decline
        </button>
        <button
          type="button"
          className={`${button} bg-primary text-primary-foreground`}
          onClick={() => send('approve')}
        >
          Approve
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
    </div>
  );
}

// Walks through Claude's questions one at a time. An answer is a picked choice or whatever the user typed.
export function useQuestions(tool: Tool | undefined, reply: Reply) {
  const [saved, setSaved] = useState({
    toolId: '',
    index: 0,
    answers: {} as Record<string, string>,
    picked: [] as string[],
  });
  const questions = tool && questionsOf(tool);
  if (!tool || !questions) return undefined;
  // A new set of questions starts from the top.
  const state = saved.toolId === tool.id ? saved : { toolId: tool.id, index: 0, answers: {}, picked: [] };
  const question = questions[state.index];
  const last = state.index === questions.length - 1;

  // Records the answer to the question on screen, then moves on. After the last one, everything is sent.
  const settle = (value: string) => {
    const answers = { ...state.answers, [question.question]: value };
    if (last) return reply({ decision: 'approve', answers });
    setSaved({ toolId: tool.id, index: state.index + 1, answers, picked: [] });
  };

  return {
    question,
    position: `${state.index + 1}/${questions.length}`,
    picked: state.picked,
    // Clicking a choice. With one allowed it is the answer right away, except on the last question, where
    // the user still gets to look before sending.
    pick(label: string) {
      if (!question.multiSelect && !last) return void settle(label);
      const has = state.picked.includes(label);
      const picked = question.multiSelect
        ? has
          ? state.picked.filter((l) => l !== label)
          : [...state.picked, label]
        : [label];
      setSaved({ ...state, picked });
    },
    // The Send button: what was typed wins, otherwise the picked choices.
    canSend: state.picked.length > 0,
    send: async (typed: string) => {
      const value = typed || state.picked.join(', ');
      if (value) await settle(value);
    },
    skip: () => reply({ decision: 'decline' }),
  };
}

type Flow = NonNullable<ReturnType<typeof useQuestions>>;

export function QuestionPanel({ flow }: { flow: Flow }) {
  const { question, picked, pick } = flow;
  const [error, setError] = useState('');

  // Number keys pick a choice, unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A key held down repeats. Without this, one long press would answer several questions.
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      pick(option.label);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div className={panel}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageCircleQuestion size={15} className="shrink-0 text-rose-500" />
        <span className="font-medium">{question.header || 'Claude has a question'}</span>
        <span className="flex-1" />
        <span className="tabular-nums">{flow.position}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          onClick={() => flow.skip().catch((err: Error) => setError(err.message))}
        >
          Skip
        </button>
      </div>
      <p className="mt-1.5">{question.question}</p>
      {question.multiSelect && <p className="mt-0.5 text-xs text-muted-foreground">Select one or more options.</p>}
      <div className="mt-2 space-y-0.5">
        {question.options.map((option, i) => {
          const on = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => pick(option.label)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${on ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{option.label}</span>
                {option.description && option.description !== option.label && (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </span>
              {on && <Check size={14} className="shrink-0 text-primary" />}
              {!on && i < 9 && <kbd className="shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</kbd>}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
    </div>
  );
}
