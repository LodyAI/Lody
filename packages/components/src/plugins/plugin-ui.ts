import { toast } from 'sonner';
import type { LodyClient } from '@lody/plugin-sdk/client';
import { openExternalUrl } from '../lib/native-browser';
import { copyTextToClipboard } from '../lib/clipboard';

export function pluginUi(title: string, signal: AbortSignal): LodyClient['ui'] {
  return {
    toast(message) {
      signal.throwIfAborted();
      toast(message, { description: title });
    },
    async confirm(message) {
      signal.throwIfAborted();
      return window.confirm(title + '\n\n' + message);
    },
    async openExternalUrl(value) {
      signal.throwIfAborted();
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw Error('Unsafe external URL');
      return openExternalUrl(url.href);
    },
    async copyToClipboard(text) {
      signal.throwIfAborted();
      await copyTextToClipboard(text);
    },
  };
}
