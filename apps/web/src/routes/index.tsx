import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useApp } from '../store';

export const Route = createFileRoute('/')({ component: Home });

// There is no home page yet, so open the first channel, or the folder picker when there is none.
function Home() {
  const { channels } = useApp();
  if (channels.length === 0) return <Navigate to="/add" replace />;
  return <Navigate to="/c/$channelId" params={{ channelId: channels[0].id }} replace />;
}
