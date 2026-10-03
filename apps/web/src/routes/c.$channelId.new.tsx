import { createFileRoute } from '@tanstack/react-router';
import { useApp } from '../store';
import { NewThread } from '../ui';

export const Route = createFileRoute('/c/$channelId/new')({ component: StartThread });

function StartThread() {
  const { channelId } = Route.useParams();
  // The parent route only shows this page when the channel exists.
  const channel = useApp().channels.find((c) => c.id === channelId)!;
  // On phones the box sits at the bottom, in reach of a thumb.
  return (
    <div className="flex h-full flex-col justify-end p-3 md:justify-center md:p-10">
      <div className="mx-auto w-full max-w-2xl">
        <h2 className="mb-3 text-xl font-bold">Start a thread</h2>
        <NewThread channel={channel} />
      </div>
    </div>
  );
}
