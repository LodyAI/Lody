// Synthetic platform I/O shared by the two redirected native-plugin mocks.
// A module redirect avoids a manual mock factory's import stack being mistaken
// for recursion when two real exports dynamically import the plugin together.
export const nativeShareState = {
  files: new Map<string, Buffer>(),
  received: [] as { name: string; bytes: Buffer }[],
  failure: null as string | null,
  failWrite: false,
  failUri: false,
};
const state = nativeShareState;

export const Directory = { Cache: 'CACHE' };
export const Filesystem = {
  async writeFile({ path, data }: { path: string; data: string }) {
    state.files.set(path, Buffer.from(data, 'base64'));
    if (state.failWrite) throw new Error('Disk full');
  },
  async appendFile({ path, data }: { path: string; data: string }) {
    state.files.set(path, Buffer.concat([state.files.get(path)!, Buffer.from(data, 'base64')]));
  },
  async getUri({ path }: { path: string }) {
    if (state.failUri) throw new Error('URI unavailable');
    return { uri: `file://${path}` };
  },
  async deleteFile({ path }: { path: string }) {
    state.files.delete(path);
  },
};

export const Share = {
  async share({ files }: { files: string[] }) {
    const path = files[0].slice('file://'.length);
    const bytes = state.files.get(path);
    if (!bytes) throw new Error('Missing staged file');
    if (state.failure) throw new Error(state.failure);
    state.received.push({ name: path, bytes });
  },
};
