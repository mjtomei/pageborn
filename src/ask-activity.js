// Activity is display-only: it is never an answer, unread receipt or prompt.
export function boundedActivities(value) {
  if (!Array.isArray(value)) return [];
  const kept = [], ids = new Set(); let size = 0;
  for (const item of value.slice(-24).reverse()) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || !['tool', 'thinking', 'status'].includes(item.kind) || typeof item.text !== 'string') continue;
    const text = item.text.trim().slice(0, item.kind === 'thinking' ? 800 : 200);
    if (!text || size + text.length > 4000) continue;
    size += text.length; ids.add(item.id);
    kept.unshift({ id: item.id.slice(0, 300), kind: item.kind, text,
      state: ['pending', 'complete', 'error'].includes(item.state) ? item.state : 'complete' });
  }
  return kept;
}

export function chatMessages(turn) {
  const activity = boundedActivities(turn.activities);
  const messages = [{ key: 'user', role: 'user', text: turn.question || '' }];
  for (const item of activity) {
    const pending = item.state === 'pending' && turn.state === 'pending';
    const prefix = item.kind === 'thinking' ? (pending ? 'Thinking' : 'Thought')
      : item.kind === 'status' ? '' : item.state === 'error' ? 'Failed' : pending ? 'Running' : 'Tool';
    messages.push({ key: `activity:${item.id}`, role: 'activity', text: prefix ? `${prefix}: ${item.text}` : item.text });
  }
  if (!activity.length && turn.state === 'pending' && !turn.answer)
    messages.push({ key: 'activity:status', role: 'activity', text: 'Working…' });
  messages.push({ key: 'assistant', role: 'assistant', text: turn.answer || '' });
  return messages;
}
