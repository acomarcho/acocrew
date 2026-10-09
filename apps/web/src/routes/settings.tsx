// Settings: your own name and password, and for admins the accounts of the team and the machine's GitHub account.
import type { Person, Temporary } from '@acocrew/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Check, ChevronLeft, Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Field, Form, PasswordForm } from '../login';
import {
  addUser,
  deleteUser,
  loadGithub,
  logOut,
  rename,
  resetPassword,
  setAdmin,
  switchGithub,
  useApp,
  useMe,
} from '../store';
import { Avatar, Popup } from '../ui';

export const Route = createFileRoute('/settings')({ component: Settings });

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

// Tells the person their change went through, until they change something again.
function Saved({ when }: { when: boolean }) {
  return when ? <p className="mt-2 text-sm text-emerald-600">Saved.</p> : null;
}

function Profile() {
  const me = useMe();
  const [name, setName] = useState(me.name);
  const [saved, setSaved] = useState(false);
  return (
    <Section title="Profile">
      <Form
        button="Save name"
        onSubmit={async () => {
          await rename(name);
          setSaved(true);
        }}
      >
        <Field
          label="Display name"
          required
          maxLength={50}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <p className="text-xs text-muted-foreground">
          This is the name your team sees on your messages. You log in as @{me.username}.
        </p>
      </Form>
      <Saved when={saved} />
    </Section>
  );
}

function Password() {
  const [saved, setSaved] = useState(false);
  return (
    <Section title="Password">
      <PasswordForm onDone={() => setSaved(true)} />
      <Saved when={saved} />
    </Section>
  );
}

const ACTION = 'rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground';

const BUTTON = 'rounded-lg px-3.5 py-2 text-sm font-semibold hover:opacity-90';

// An account, with the temporary password the server just made for it.
type Given = Person & Temporary;

// Shows a temporary password for the admin to pass on. This is the only time it can be seen: once closed, the
// way to get one is to reset the password again.
function TemporaryPassword({ given, onClose }: { given: Given; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Popup title={`Temporary password for ${given.name}`}>
      <p className="text-sm text-muted-foreground">
        Pass it on now, it is not shown again. {given.name} logs in as @{given.username} with it, and then picks a
        password of their own.
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-muted py-2 pr-2 pl-3">
        <code className="min-w-0 flex-1 font-mono break-all select-all">{given.password}</code>
        <button
          type="button"
          autoFocus
          onClick={() => void navigator.clipboard.writeText(given.password).then(() => setCopied(true))}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm font-medium hover:opacity-90"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <button type="button" onClick={onClose} className={`${BUTTON} bg-primary text-primary-foreground`}>
        Done
      </button>
    </Popup>
  );
}

// Something an admin is asked to be sure about before it is done: what happens, and the button that does it.
type Question = { title: string; text: string; button: string; color: string; run: () => Promise<unknown> };

// One account, and what an admin can do to it. `onPassword` is told the temporary password a reset made.
function UserRow({ person, onPassword }: { person: Person; onPassword: (given: Given) => void }) {
  const me = useMe();
  const [error, setError] = useState('');
  const [question, setQuestion] = useState<Question | null>(null);
  const attempt = (change: Promise<unknown>) =>
    change.then(
      () => setError(''),
      (err) => setError(err.message),
    );
  const reset: Question = {
    title: `Reset ${person.name}'s password?`,
    text: `${person.name} is logged out everywhere. You get a temporary password to pass on.`,
    button: 'Reset password',
    color: 'bg-primary text-primary-foreground',
    run: () => resetPassword(person.id).then((made) => onPassword({ ...person, ...made })),
  };
  const remove: Question = {
    title: `Delete ${person.name}'s account?`,
    text: `${person.name} can no longer log in. Their messages stay.`,
    button: 'Delete account',
    color: 'bg-rose-500 text-white',
    run: () => deleteUser(person.id),
  };
  return (
    <li className="border-b border-border py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Avatar person={person} small />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{person.name}</span>{' '}
          <span className="text-sm text-muted-foreground">@{person.username}</span>
          {person.id === me.id && <span className="text-sm text-muted-foreground"> (you)</span>}
        </span>
        {person.admin && (
          <span className="rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary">Admin</span>
        )}
        <span className="flex items-center">
          <button type="button" className={ACTION} onClick={() => void attempt(setAdmin(person.id, !person.admin))}>
            {person.admin ? 'Remove admin' : 'Make admin'}
          </button>
          {/* Your own password is changed above, and your own account cannot be deleted. */}
          {person.id !== me.id && (
            <>
              <button type="button" className={ACTION} onClick={() => setQuestion(reset)}>
                Reset password
              </button>
              <button type="button" className={`${ACTION} hover:text-rose-500`} onClick={() => setQuestion(remove)}>
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      {error && <p className="mt-1 text-sm text-rose-500">{error}</p>}
      {question && (
        <Popup title={question.title}>
          <p className="text-sm text-muted-foreground">{question.text}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={`${BUTTON} ${question.color}`}
              onClick={() => {
                setQuestion(null);
                void attempt(question.run());
              }}
            >
              {question.button}
            </button>
            <button
              type="button"
              autoFocus
              className={`${BUTTON} text-muted-foreground hover:bg-muted`}
              onClick={() => setQuestion(null)}
            >
              Cancel
            </button>
          </div>
        </Popup>
      )}
    </li>
  );
}

function Users() {
  const people = useApp((state) => state.people);
  const empty = { username: '', name: '' };
  const [next, setNext] = useState(empty);
  // The temporary password that is on screen, if one was just made.
  const [given, setGiven] = useState<Given | null>(null);
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setNext({ ...next, [key]: e.target.value });
  return (
    <Section title="Users">
      <ul className="mb-4">
        {people
          .filter((person) => !person.deleted)
          .map((person) => (
            <UserRow key={person.id} person={person} onPassword={setGiven} />
          ))}
      </ul>
      <h4 className="mb-2 text-sm font-semibold">Add a user</h4>
      <Form
        button="Add user"
        onSubmit={async () => {
          setGiven(await addUser(next));
          setNext(empty);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Username" required autoCapitalize="none" value={next.username} onChange={set('username')} />
          <Field label="Display name" placeholder="Same as username" value={next.name} onChange={set('name')} />
        </div>
        <p className="text-xs text-muted-foreground">
          You get a temporary password to pass on. They pick their own password the first time they log in.
        </p>
      </Form>
      {given && <TemporaryPassword given={given} onClose={() => setGiven(null)} />}
    </Section>
  );
}

// Which GitHub account the server machine works as. Not there on a machine without the GitHub CLI.
function Github() {
  const accounts = useApp((state) => state.github);
  const [error, setError] = useState('');
  // A switch was asked for, and the server has not answered yet.
  const [busy, setBusy] = useState(false);
  useEffect(() => void loadGithub().catch((err) => setError(err.message)), []);
  if (!accounts && !error) return null;
  return (
    <Section title="GitHub account">
      <p className="text-sm text-muted-foreground">
        What Claude does on GitHub, and what git pushes, is done as the active account. It is the same one for everyone
        and every thread: switching changes it for the whole machine.
      </p>
      {accounts?.length === 0 && (
        <p className="mt-3 text-sm">
          No GitHub account is logged in on this machine. Run <code className="font-mono">gh auth login</code> on it to
          add one.
        </p>
      )}
      <ul className="mt-1">
        {accounts?.map((account) => (
          <li
            key={`${account.host}/${account.login}`}
            className="flex items-center gap-2 border-b border-border py-2.5 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{account.login}</span>{' '}
              <span className="text-sm text-muted-foreground">{account.host}</span>
            </span>
            {account.active ? (
              <span className="rounded bg-primary/15 px-1.5 text-[11px] font-medium text-primary">Active</span>
            ) : (
              <button
                type="button"
                disabled={busy}
                className={`${ACTION} disabled:opacity-50`}
                onClick={() => {
                  setBusy(true);
                  void switchGithub(account)
                    .then(
                      () => setError(''),
                      (err) => setError(err.message),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Switch
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 text-sm text-rose-500">{error}</p>}
    </Section>
  );
}

function Settings() {
  const me = useMe();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-3 md:py-10">
        <div className="flex items-center gap-2">
          <Link to="/" className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Back">
            <ChevronLeft size={20} />
          </Link>
          <h2 className="flex-1 text-xl font-bold">Settings</h2>
          <button
            type="button"
            onClick={() => void logOut()}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          >
            Log out
          </button>
        </div>
        <Profile />
        <Password />
        {me.admin && <Github />}
        {me.admin && <Users />}
      </div>
    </div>
  );
}
