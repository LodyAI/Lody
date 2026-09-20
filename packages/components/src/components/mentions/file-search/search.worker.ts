import { buildMentionFileIndex, searchSuggestions } from './engine';
import type { FileSearchRequest, FileSearchResponse } from './client';

let index: ReturnType<typeof buildMentionFileIndex> = null;
let generation = 0;
const channel = new MessageChannel();
let resume: (() => void) | undefined;
channel.port1.onmessage = () => {
  resume?.();
  resume = undefined;
};
const yieldToMessages = () =>
  new Promise<void>((resolve) => {
    resume = resolve;
    channel.port2.postMessage(null);
  });
const post = (message: FileSearchResponse) => self.postMessage(message);

async function search(data: Extract<FileSearchRequest, { type: 'query' }>) {
  const current = ++generation;
  try {
    if (!index) throw new Error('File search index is not ready');
    const task = searchSuggestions(index, data.term);
    let step = task.next();
    while (!step.done) {
      await yieldToMessages();
      if (current !== generation) {
        task.return([]);
        post({ type: 'cancelled' });
        return;
      }
      step = task.next();
    }
    post({ type: 'result', id: data.id, term: data.term, items: step.value });
  } catch {
    post({ type: 'error' });
  }
}

self.onmessage = ({ data }: MessageEvent<FileSearchRequest>) => {
  if (data.type === 'cancel') {
    generation++;
    return;
  }
  if (data.type === 'query') {
    void search(data);
    return;
  }
  try {
    index = buildMentionFileIndex(data.entry);
    post({ type: 'ready' });
  } catch {
    post({ type: 'error' });
  }
};
