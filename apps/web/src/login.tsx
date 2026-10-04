// What shows before the app itself: logging in, and picking a password. The forms are also used in Settings.
import { LOGIN_PATH, LOGOUT_PATH, type Me } from '@acocrew/shared';
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { changePassword, request } from './store';

export function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <input
        {...input}
        className="mt-1 block w-full rounded-lg border border-border bg-card px-3 py-2 text-base font-normal outline-none focus:border-primary md:text-sm"
      />
    </label>
  );
}

// Fields with one button under them. While the server is asked the button waits, and if the server says no,
// its reason shows above the button.
export function Form({ button, onSubmit, children }: { button: string; onSubmit: () => unknown; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      {children}
      {error && <p className="text-sm text-rose-500">{error}</p>}
      <button
        disabled={busy}
        className="rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
      >
        {button}
      </button>
    </form>
  );
}

export function PasswordForm({ onDone }: { onDone: () => unknown }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <Form
      button="Change password"
      onSubmit={async () => {
        await changePassword(current, next);
        setCurrent('');
        setNext('');
        await onDone();
      }}
    >
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <Field
        label="New password (8 characters or more)"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
    </Form>
  );
}

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid h-dvh place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="text-sm font-bold text-primary">acocrew</div>
        <h1 className="text-xl font-bold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => Promise<unknown> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Screen title="Log in">
      <Form
        button="Log in"
        onSubmit={async () => {
          await request(LOGIN_PATH, { username, password });
          await onDone();
        }}
      >
        <Field
          label="Username"
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Form>
      <p className="text-xs text-muted-foreground">No account, or forgot your password? Ask an admin of your team.</p>
    </Screen>
  );
}

// Shown to someone whose password was given to them, until they have picked their own.
export function SetPassword({ me, onDone }: { me: Me; onDone: () => Promise<unknown> }) {
  return (
    <Screen title="Pick a new password">
      <p className="text-sm text-muted-foreground">
        Hi {me.name}. The password you logged in with was a temporary one. Pick your own to go on.
      </p>
      <PasswordForm onDone={onDone} />
      <button
        type="button"
        onClick={() => void request(LOGOUT_PATH, {}).then(onDone)}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Log out
      </button>
    </Screen>
  );
}
