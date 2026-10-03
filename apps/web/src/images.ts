// Getting an image from this device to the server, where Claude runs.
import { IMAGE_MAX_BYTES, IMAGE_TYPES, IMAGES_PATH } from '@acocrew/shared';

// Claude gains nothing from more pixels than this, and big phone photos would be slow to send.
const MAX_EDGE = 2048;

export const imageUrl = (id: string) => `${IMAGES_PATH}/${id}`;

// The file itself when the server takes it as it is. Otherwise a smaller JPEG drawn from it.
async function fit(file: File): Promise<Blob> {
  const picture = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(picture.width, picture.height));
  const asIs = scale === 1 && Object.hasOwn(IMAGE_TYPES, file.type) && file.size <= IMAGE_MAX_BYTES;
  if (asIs) picture.close();
  if (asIs) return file;
  const canvas = new OffscreenCanvas(Math.round(picture.width * scale), Math.round(picture.height * scale));
  const pen = canvas.getContext('2d')!;
  // JPEG has no see-through parts, so they turn white instead of black.
  pen.fillStyle = 'white';
  pen.fillRect(0, 0, canvas.width, canvas.height);
  pen.drawImage(picture, 0, 0, canvas.width, canvas.height);
  picture.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

// Sends one image to the server and gives back its id, which goes into the message.
export async function uploadImage(file: File): Promise<string> {
  const image = await fit(file).catch(() => {
    throw new Error(`Could not read ${file.name}.`);
  });
  const res = await fetch(IMAGES_PATH, { method: 'POST', body: image, headers: { 'content-type': image.type } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.id;
}
