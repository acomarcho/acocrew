import { createFileRoute, redirect } from '@tanstack/react-router';
import { CHANNELS } from '../data';

// There is no home page yet, so open the first channel.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/c/$channelId', params: { channelId: CHANNELS[0].id } });
  },
});
