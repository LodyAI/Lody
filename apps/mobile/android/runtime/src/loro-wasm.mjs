// Initialize the public web build before any runtime consumer constructs a document.
// Android WebView rejects large synchronous WASM compilation on its main thread.
import init from 'loro-crdt/web';
import bytes from 'loro-crdt/web/loro_wasm_bg.wasm';
await init({module_or_path: bytes});
export * from 'loro-crdt/web';
