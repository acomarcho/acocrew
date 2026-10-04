// Settings: your own name and password, and for admins the accounts of the team.
import type { Person } from '@acocrew/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Field, Form, PasswordForm } from '../login';
import { useApp } from '../store';
import { Avatar } from '../ui';

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
  const { me, rename } = useApp();
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

// One account, and what an admin can do to it.
function UserRow({ person }: { person: Person }) {
  const { me, setAdmin, deleteUser, resetPassword } = useApp();
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const attempt = (change: Promise<unknown>) =>
    change.then(
      () => setError(''),
      (err) => setError(err.message),
    );
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
              <button type="button" className={ACTION} onClick={() => setResetting(!resetting)}>
                Reset password
              </button>
              <button
                type="button"
                className={`${ACTION} hover:text-rose-500`}
                onClick={() =>
                  confirm(`Delete ${person.name}'s account? Their messages stay.`) &&
                  void attempt(deleteUser(person.id))
                }
              >
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      {error && <p className="mt-1 text-sm text-rose-500">{error}</p>}
      {resetting && (
        <div className="mt-2 rounded-lg bg-muted p-3">
          <Form
            button="Set temporary password"
            onSubmit={async () => {
              await resetPassword(person.id, password);
              setPassword('');
              setResetting(false);
            }}
          >
            <Field
              label={`Temporary password for ${person.name}`}
              autoFocus
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {person.name} is logged out everywhere, and picks a new password after logging in with this one.
            </p>
          </Form>
        </div>
      )}
    </li>
  );
}

function Users() {
  const { people, addUser } = useApp();
  const empty = { username: '', name: '', password: '' };
  const [next, setNext] = useState(empty);
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setNext({ ...next, [key]: e.target.value });
  return (
    <Section title="Users">
      <ul className="mb-4">
        {people
          .filter((person) => !person.deleted)
          .map((person) => (
            <UserRow key={person.id} person={person} />
          ))}
      </ul>
      <h4 className="mb-2 text-sm font-semibold">Add a user</h4>
      <Form
        button="Add user"
        onSubmit={async () => {
          await addUser(next);
          setNext(empty);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Username" required autoCapitalize="none" value={next.username} onChange={set('username')} />
          <Field label="Display name" placeholder="Same as username" value={next.name} onChange={set('name')} />
          <Field label="Temporary password" required minLength={8} value={next.password} onChange={set('password')} />
        </div>
        <p className="text-xs text-muted-foreground">
          Tell them the username and the temporary password. They pick their own password the first time they log in.
        </p>
      </Form>
    </Section>
  );
}

function Settings() {
  const { me, logOut } = useApp();
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
        {me.admin && <Users />}
      </div>
    </div>
  );
}
