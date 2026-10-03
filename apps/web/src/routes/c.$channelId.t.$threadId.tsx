import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useApp } from '../store';
import { ThreadView } from '../ui';

export const Route = createFileRoute('/c/$channelId/t/$threadId')({ component: OpenThread });

function OpenThread() {
  const { channelId, threadId } = Route.useParams();
  const thread = useApp().threads.find((t) => t.id === threadId && t.channelId === channelId);
  // Threads are fake and live in memory, so a stale link falls back to the channel.
  if (!thread) return <Navigate to="/c/$channelId" params={{ channelId }} replace />;
  return <ThreadView thread={thread} />;
}
