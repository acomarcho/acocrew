import { renderToStaticMarkup } from 'react-dom/server';
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown';
import { expect, test } from 'vite-plus/test';

Object.assign(globalThis, { location: new URL('https://acocrew.test') });
const { pluginsFor, shownPrefix } = await import('./shown');

// The same plugin list thread.tsx builds.
type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>;
const [harden, hardenOptions] = defaultRehypePlugins.harden as [RehypePlugins[number], object];
const rehypePlugins = Object.values({
  ...defaultRehypePlugins,
  harden: [harden, { ...hardenOptions, defaultOrigin: location.origin, allowedImagePrefixes: [shownPrefix()] }],
}) as RehypePlugins;

// A reply from a real thread, as Claude wrote it.
const reply = '![Agent typing into the table](tabular-review/agent-typing.gif)';
const draw = (threadId: string) =>
  renderToStaticMarkup(<Streamdown rehypePlugins={pluginsFor(threadId, rehypePlugins)}>{reply}</Streamdown>);
const shown = (threadId: string) =>
  `${location.origin}/api/threads/${threadId}/shown?path=tabular-review%2Fagent-typing.gif`;

test('an image in a reply points at the thread it is in, also after another thread was shown first', () => {
  expect(draw('thread-a')).toContain(`src="${shown('thread-a')}"`);
  expect(draw('thread-b')).toContain(`src="${shown('thread-b')}"`);
  expect(draw('thread-a')).toContain(`src="${shown('thread-a')}"`);
});
