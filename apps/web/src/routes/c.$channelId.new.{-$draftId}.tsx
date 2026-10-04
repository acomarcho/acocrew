import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { AutomationEditor, KindTitle, type Kind } from '../automations';
import { useApp } from '../store';
import { NewThread } from '../ui';

// `?kind=automation` opens the screen ready to schedule an automation instead of starting a thread.
// What is typed for a new thread is kept as the draft the address names. Without one, a fresh draft is begun.
export const Route = createFileRoute('/c/$channelId/new/{-$draftId}')({
  component: Start,
  validateSearch: (search): { kind?: 'automation' } => (search.kind === 'automation' ? { kind: 'automation' } : {}),
  beforeLoad: ({ params, search }) => {
    if (params.draftId) return;
    const draftId = Math.random().toString(36).slice(2);
    throw redirect({ to: '/c/$channelId/new/{-$draftId}', params: { ...params, draftId }, search, replace: true });
  },
});

function Start() {
  const { channelId, draftId } = Route.useParams();
  const { kind = 'thread' } = Route.useSearch();
  const navigate = useNavigate();
  // The parent route only shows this page when the channel exists.
  const channel = useApp((state) => state.channels).find((c) => c.id === channelId)!;
  const title = (
    <KindTitle
      kind={kind}
      onKind={(next: Kind) => navigate({ to: '.', search: next === 'automation' ? { kind: next } : {}, replace: true })}
    />
  );
  // On phones the box sits at the bottom, in reach of a thumb.
  return (
    <div className="flex h-full flex-col justify-end p-3 md:justify-center md:p-10">
      <div className="mx-auto w-full max-w-2xl">
        {kind === 'thread' ? (
          <NewThread key={draftId} channel={channel} draftId={draftId!} title={title} />
        ) : (
          <AutomationEditor
            key={channel.id}
            channel={channel}
            title={title}
            onCancel={() => navigate({ to: '/c/$channelId', params: { channelId } })}
            onDone={(saved) =>
              navigate({
                to: '/c/$channelId/a/$automationId',
                params: { channelId, automationId: saved.id },
                replace: true,
              })
            }
          />
        )}
      </div>
    </div>
  );
}
