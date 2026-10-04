import { createFileRoute, Navigate } from '@tanstack/react-router';
import { AutomationPage } from '../automations';
import { useApp } from '../store';

export const Route = createFileRoute('/c/$channelId/a/$automationId')({ component: OpenAutomation });

function OpenAutomation() {
  const { channelId, automationId } = Route.useParams();
  const channels = useApp((state) => state.channels);
  const automations = useApp((state) => state.automations);
  // The parent route only shows this page when the channel exists.
  const channel = channels.find((c) => c.id === channelId)!;
  const automation = automations.find((a) => a.id === automationId && a.channelId === channelId);
  // A link to an automation that does not exist (or was just deleted) falls back to the channel.
  if (!automation) return <Navigate to="/c/$channelId" params={{ channelId }} replace />;
  return <AutomationPage key={automation.id} channel={channel} automation={automation} />;
}
