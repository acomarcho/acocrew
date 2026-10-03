import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Ctx, useAppState } from '../store';

export const Route = createRootRoute({ component: Root });

function Root() {
  const app = useAppState();
  return (
    <Ctx.Provider value={app}>
      <div className="h-dvh bg-bg text-fg">
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
