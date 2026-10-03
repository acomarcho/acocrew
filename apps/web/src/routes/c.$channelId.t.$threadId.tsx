import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useApp } from '../store';
import { ThreadView } from '../ui';

export const Route = createFileRoute('/c/$channelId/t/$threadId')({ component: OpenThread });

function OpenThread() {
  const { channelId, threadId } = Route.useParams();
  const { channels, threads } = useApp();
  // The parent route only shows this page when the channel exists.
  const channel = channels.find((c) => c.id === channelId)!;
  const thread = threads.find((t) => t.id === threadId && t.channelId === channelId);
  // A link to a thread that does not exist falls back to the channel.
  if (!thread) return <Navigate to="/c/$channelId" params={{ channelId }} replace />;
  return <ThreadView key={thread.id} thread={thread} channel={channel} />;
}
