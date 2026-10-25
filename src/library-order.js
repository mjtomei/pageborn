export const librarySort = value => ['recent', 'added', 'name'].includes(value) ? value : 'recent';
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Saving/syncing a replacement keeps its slot. Reverse saved order therefore
// means newest added, without inventing dates for existing libraries.
export function orderedDocuments(documents = [], preferences = {}) {
  const order = librarySort(preferences.librarySort);
  const recent = new Map((Array.isArray(preferences.recent) ? preferences.recent : []).map((id, i) => [id, i]));
  return (documents || []).map((doc, index) => ({ doc, index })).sort((a, b) => {
    if (order === 'name') return names.compare(a.doc.id, b.doc.id) || a.index - b.index;
    if (order === 'recent') {
      const rank = (recent.get(a.doc.id) ?? Infinity) - (recent.get(b.doc.id) ?? Infinity);
      if (rank) return rank;
    }
    return b.index - a.index;
  }).map(({ doc }) => doc);
}
