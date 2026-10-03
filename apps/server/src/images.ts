import { IMAGE_TYPES } from '@acocrew/shared';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const TYPE_OF_ENDING = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ending]) => [ending, type]));

// Images people attach to messages, kept as files in one folder. The id is the file name, and its ending
// says what kind of image it is.
export function openImages(dir: string) {
  mkdirSync(dir, { recursive: true });
  return {
    save(ending: string, bytes: Uint8Array) {
      const id = `${randomUUID()}.${ending}`;
      writeFileSync(join(dir, id), bytes);
      return id;
    },
    // Where a stored image is and what kind it is, or null if the id is not a file in the folder.
    find(id: unknown) {
      if (typeof id !== 'string' || basename(id) !== id) return null;
      const type = TYPE_OF_ENDING[extname(id).slice(1)];
      const file = join(dir, id);
      return type && existsSync(file) ? { type, file } : null;
    },
  };
}

export type Images = ReturnType<typeof openImages>;
