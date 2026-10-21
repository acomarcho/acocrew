import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// Where attached files are put in the folder Claude works in. Git is told to leave the folder alone, so they
// are never committed by accident.
export const ATTACHED = '.attachments';

// Files people attach to messages (anything that is not an image), kept in one folder. The id is the file name:
// a random UUID, a dash, and the name the file had, with anything that could point at another folder replaced.
export function openFiles(dir: string) {
  mkdirSync(dir, { recursive: true });
  return {
    save(name: string, bytes: Uint8Array) {
      // A file name can be 255 bytes. 50 characters of up to 4 bytes each leave room for the UUID.
      const kept = [...name.replace(/[/\\\p{Cc}]/gu, '_')].slice(-50).join('');
      const id = `${randomUUID()}-${kept || 'file'}`;
      writeFileSync(join(dir, id), bytes);
      return id;
    },
    // Whether the id is a file in the folder.
    has(id: unknown) {
      return (
        typeof id === 'string' && basename(id) === id && existsSync(join(dir, id)) && statSync(join(dir, id)).isFile()
      );
    },
    // Copies files into `folder`, where Claude can open them, and gives back where they are from there.
    copyTo(folder: string, ids: string[]) {
      mkdirSync(join(folder, ATTACHED), { recursive: true });
      writeFileSync(join(folder, ATTACHED, '.gitignore'), '*\n');
      for (const id of ids) copyFileSync(join(dir, id), join(folder, ATTACHED, id));
      return ids.map((id) => `${ATTACHED}/${id}`);
    },
  };
}

export type Files = ReturnType<typeof openFiles>;
