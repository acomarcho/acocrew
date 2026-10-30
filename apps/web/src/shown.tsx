// Files Claude shows in a message by writing `![name](path)`, where the path is a file in the thread's folder.
// Images show as images, HTML pages run in a sandboxed frame, and Excalidraw drawings are drawn as pictures.
import { lazy, Suspense, type ComponentProps } from 'react';
import type { StreamdownProps } from 'streamdown';
import { Picture } from './ui';

type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>;
type Node = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

export const shownUrl = (threadId: string, path: string) =>
  `/api/threads/${threadId}/shown?path=${encodeURIComponent(path)}`;

// An address with a scheme (https:, data:, ...) or a host (//) is not a file path.
const isPath = (src: string) => !/^([a-z][a-z\d+.-]*:|\/\/)/i.test(src);

// Points images whose source is a file path at the thread's copy of that file, before `harden` sees them.
function pointAt(threadId: string) {
  const visit = (node: Node) => {
    const src = node.properties?.src;
    if (node.tagName === 'img' && typeof src === 'string' && isPath(src)) {
      node.properties!.src = `${location.origin}${shownUrl(threadId, decodeURI(src))}`;
    }
    node.children?.forEach(visit);
  };
  return () => visit;
}

// The plugins for one thread, made once so bubbles that did not change are not drawn again.
const made = new Map<string, RehypePlugins>();
export function pluginsFor(threadId: string, rest: RehypePlugins) {
  if (!made.has(threadId)) made.set(threadId, [pointAt(threadId), ...rest]);
  return made.get(threadId)!;
}
export const shownPrefix = () => `${location.origin}/api/threads/`;

const Drawing = lazy(() => import('./drawing'));

const ending = (src: string) =>
  new URL(src, location.origin).searchParams.get('path')?.split('.').at(-1)?.toLowerCase();

export function ShownFile({ src, alt }: ComponentProps<'img'>) {
  if (typeof src !== 'string') return null;
  const kind = ending(src);
  const frame = 'block w-full max-w-3xl rounded-md border border-border';
  if (kind === 'html') {
    return (
      <span className="my-1 block">
        <iframe
          src={src}
          title={alt || 'Page'}
          sandbox="allow-scripts allow-forms allow-popups"
          className={`${frame} h-[28rem] bg-white`}
        />
        <a href={src} target="_blank" rel="noopener" className="text-xs text-muted-foreground underline">
          Open in a new tab
        </a>
      </span>
    );
  }
  if (kind === 'excalidraw') {
    return (
      <Suspense fallback={<span className={`${frame} h-40 animate-pulse bg-muted`} />}>
        <Drawing src={src} className={`${frame} bg-white`} />
      </Suspense>
    );
  }
  return (
    <span className="my-1 inline-block max-w-full">
      <Picture src={src} alt={alt} className="max-h-96 max-w-full bg-card object-contain" />
    </span>
  );
}
