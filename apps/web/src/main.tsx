import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useDrafts } from './drafts';
import './index.css';
import { routeTree } from './routeTree.gen';

const router = createRouter({ routeTree });

// The browser says when another tab saved drafts. They are read again, so that this tab's next save does not
// undo what the other one saved.
window.addEventListener('storage', (event) => {
  if (event.key === useDrafts.persist.getOptions().name) void useDrafts.persist.rehydrate();
});

// Lets links and params be type checked everywhere.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
