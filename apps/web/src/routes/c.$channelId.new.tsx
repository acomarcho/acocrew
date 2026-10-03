import { createFileRoute } from '@tanstack/react-router';
import { NewThread } from '../ui';

export const Route = createFileRoute('/c/$channelId/new')({ component: StartThread });

function StartThread() {
  const { channel } = Route.useRouteContext();
  return (
    <div className="flex h-full flex-col p-3 md:justify-center md:p-10">
      <div className="mx-auto w-full max-w-2xl">
        <h2 className="mb-3 text-xl font-bold">Start a thread</h2>
        <NewThread channelId={channel.id} channelName={channel.name} />
      </div>
    </div>
  );
}
