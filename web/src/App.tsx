import { useEffect, useState } from 'react';
import { Ctx, useAppState } from './store';
import V1Slack from './variants/V1Slack';
import V2Topics from './variants/V2Topics';
import V3Inbox from './variants/V3Inbox';
import V4Board from './variants/V4Board';
import V5Focus from './variants/V5Focus';

const LAYOUTS = [
  { name: 'Slack', View: V1Slack },
  { name: 'Topics', View: V2Topics },
  { name: 'Inbox', View: V3Inbox },
  { name: 'Board', View: V4Board },
  { name: 'Focus', View: V5Focus },
];

const fromHash = () => {
  const i = Number(location.hash.slice(1)) - 1;
  return LAYOUTS[i] ? i : 0;
};

export default function App() {
  const app = useAppState();
  const [index, setIndex] = useState(fromHash);
  const { View } = LAYOUTS[index];

  const choose = (i: number) => {
    setIndex(i);
    app.setNavOpen(false);
    history.replaceState(null, '', `#${i + 1}`);
  };

  // Keys 1 to 5 switch layout, unless you are typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const i = Number(e.key) - 1;
      if (LAYOUTS[i]) choose(i);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Ctx.Provider value={app}>
      <div className="flex h-dvh flex-col">
        <div className="flex shrink-0 items-center gap-1 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-400">
          <span className="mr-1 hidden font-medium sm:inline">Layout</span>
          {LAYOUTS.map((l, i) => (
            <button
              key={l.name}
              onClick={() => choose(i)}
              className={`flex-1 rounded-md px-2 py-1 font-medium sm:flex-none ${
                i === index ? 'bg-white text-neutral-950' : 'hover:bg-neutral-800 hover:text-white'
              }`}
            >
              {i + 1} {l.name}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <View />
        </div>
      </div>
    </Ctx.Provider>
  );
}
