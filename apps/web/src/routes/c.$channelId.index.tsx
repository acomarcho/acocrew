import { createFileRoute } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { NewThreadButton } from '../ui';

export const Route = createFileRoute('/c/$channelId/')({ component: NothingOpen });

function NothingOpen() {
  const { channelId } = Route.useParams();
  return (
    <div className="grid h-full place-items-center p-8 text-center text-muted-foreground">
      <div>
        <MessagesSquare size={40} className="mx-auto mb-3 opacity-50" />
        <p className="mb-4">Pick a thread on the left, or start a new one.</p>
        <NewThreadButton channelId={channelId} />
      </div>
    </div>
  );
}
