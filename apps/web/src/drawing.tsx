// An Excalidraw drawing, drawn as a picture. Loaded only when a message shows one, since Excalidraw is big.
import { exportToSvg, FONT_FAMILY, restore } from '@excalidraw/excalidraw';
import { useEffect, useState } from 'react';
import { Picture } from './ui';

// Where Excalidraw finds its fonts: copied into the build by vite.config.ts.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: `${location.origin}/excalidraw/` });

export default function Drawing({ src, className }: { src: string; className: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let url: string | undefined;
    fetch(src)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Drawing not found.'))))
      // Opens it the way excalidraw.com does. A hand-written file may leave out the font, which then falls back to
      // a system one, so text without a font gets Excalidraw's own.
      .then((scene) => {
        const elements = (scene.elements ?? []).map((el: object) => ({ fontFamily: FONT_FAMILY.Excalifont, ...el }));
        return exportToSvg(restore({ ...scene, elements }, null, null));
      })
      .then((drawn) => {
        url = URL.createObjectURL(new Blob([drawn.outerHTML], { type: 'image/svg+xml' }));
        setSvg(url);
      })
      .catch((cause: Error) => setError(cause.message));
    return () => void (url && URL.revokeObjectURL(url));
  }, [src]);
  if (error) return <span className="text-sm text-rose-500">{error}</span>;
  if (!svg) return <span className={`${className} block h-40 animate-pulse`} />;
  return (
    <span className="my-1 inline-block max-w-full">
      <Picture src={svg} alt="Drawing" className={`${className} max-h-[32rem] object-contain`} />
    </span>
  );
}
