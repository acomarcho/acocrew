import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Ctx, useAppState } from '../store';

export const Route = createRootRoute({ component: Root });

function Root() {
  const app = useAppState();
  return (
    <Ctx.Provider value={app}>
      <div className="h-dvh bg-bg text-fg">
        {app.ready ? <Outlet /> : <p className="grid h-full place-items-center text-muted">Connecting...</p>}
        {app.ready && !app.online && (
          <p className="fixed inset-x-0 top-2 z-50 mx-auto w-fit rounded-full bg-fg px-3 py-1 text-xs text-bg">
            Connection lost. Reconnecting...
          </p>
        )}
      </div>
    </Ctx.Provider>
  );
}
