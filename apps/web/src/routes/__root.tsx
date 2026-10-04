import type { Me } from '@acocrew/shared';
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { Login, SetPassword } from '../login';
import { connect, LOGGED_OUT, useApp, whoAmI } from '../store';

export const Route = createRootRoute({ component: Root });

const Waiting = () => <p className="grid h-dvh place-items-center text-muted-foreground">Connecting...</p>;

// Nothing of the app is shown, or even asked from the server, until someone is logged in with a password of
// their own.
function Root() {
  // undefined until the server has said who is logged in. null when nobody is.
  const [me, setMe] = useState<Me | null>();
  const recheck = useCallback(async () => {
    const next = await whoAmI();
    if (next !== undefined) setMe(next);
  }, []);
  // Asks until the server answers.
  const unknown = me === undefined;
  useEffect(() => {
    if (!unknown) return;
    let again: ReturnType<typeof setTimeout>;
    const ask = () => whoAmI().then((next) => (next === undefined ? (again = setTimeout(ask, 1000)) : setMe(next)));
    void ask();
    return () => clearTimeout(again);
  }, [unknown]);

  useEffect(() => {
    window.addEventListener(LOGGED_OUT, recheck);
    return () => window.removeEventListener(LOGGED_OUT, recheck);
  }, [recheck]);

  if (me === undefined) return <Waiting />;
  if (!me) return <Login onDone={recheck} />;
  if (me.mustChangePassword) return <SetPassword me={me} onDone={recheck} />;
  return <App key={me.id} me={me} recheck={recheck} />;
}

function App({ me, recheck }: { me: Me; recheck: () => Promise<unknown> }) {
  const ready = useApp((state) => state.ready);
  const online = useApp((state) => state.online);
  useEffect(() => useApp.setState({ login: me }), [me]);
  useEffect(() => connect(recheck), [recheck]);
  return (
    <div className="h-dvh bg-background text-foreground">
      {ready ? <Outlet /> : <p className="grid h-full place-items-center text-muted-foreground">Connecting...</p>}
      {ready && !online && (
        <p className="fixed inset-x-0 top-2 z-50 mx-auto w-fit rounded-full bg-foreground px-3 py-1 text-xs text-background">
          Connection lost. Reconnecting...
        </p>
      )}
    </div>
  );
}
