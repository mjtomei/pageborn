import { pdfAnchor, restorePdfAnchor, pdfPageTurn } from './pdf-layout.js';
import { PdfAutoscroll } from './pdf-native.js';

// Growing layouts have new screen coordinates. Follow the source location,
// keeping playback and the exact word cursor when its source crop is unchanged.
export function updatePdfReader(reader, previous, next, saved, entryLines) {
  const anchor = previous ? pdfAnchor(previous, reader.positionY) : saved;
  const cursor = previous ? reader.speedReading.saved : saved?.speedCursor;
  const playing = reader.playing; const elapsed = reader.elapsed;
  const fill = reader.autoPosition?.fill;
  const position = restorePdfAnchor(next, anchor);
  reader.setDocument(next.maxY, position, next.pages,
    (y, direction) => pdfPageTurn(next, y, direction), new PdfAutoscroll(next, entryLines), { preserveSession: !!previous });
  reader.setSpeedDocument(next, cursor);
  if (previous) {
    if (fill) reader.autoPosition.fill = { ...fill, y: position };
    reader.playing = playing && (reader.mode === 'speed' ? !reader.wordStop && !reader.speedReading.finished : reader.canAutoAdvance);
    reader.elapsed = elapsed;
  }
}
