class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    for (const key of this.#values.keys()) {
      delete (this as unknown as Record<string, string>)[key];
    }
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    const normalizedKey = String(key);
    this.#values.delete(normalizedKey);
    delete (this as unknown as Record<string, string>)[normalizedKey];
  }

  setItem(key: string, value: string): void {
    const normalizedKey = String(key);
    this.#values.set(normalizedKey, String(value));
    Object.defineProperty(this, normalizedKey, {
      configurable: true,
      enumerable: true,
      get: () => this.#values.get(normalizedKey),
      set: (nextValue: string) => this.#values.set(normalizedKey, String(nextValue)),
    });
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage'): void {
  let storage: Storage | undefined;
  try {
    storage = globalThis[name];
  } catch {
    // A jsdom origin without storage access throws here; tests still need the
    // same deterministic browser boundary as Node-only suites.
  }
  if (storage != null) return;

  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: new MemoryStorage(),
  });
}

installStorage('localStorage');
installStorage('sessionStorage');

if (typeof Element !== 'undefined' && typeof Element.prototype.getAnimations !== 'function') {
  // jsdom does not run Web Animations. Base UI waits for subtree animations
  // before measuring scroll areas, so expose the empty animation set here.
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: (): Animation[] => [],
  });
  // Preserve Base UI's no-animation path for dialog/popover teardown: adding
  // getAnimations alone would make those parts start waiting for another frame.
  Object.defineProperty(globalThis, 'BASE_UI_ANIMATIONS_DISABLED', {
    configurable: true,
    writable: true,
    value: true,
  });
}

if (typeof window !== 'undefined' && typeof window.PointerEvent !== 'function') {
  class TestPointerEvent extends window.MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;

    constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? '';
      this.pointerId = 1;
    }
  }

  Object.defineProperty(window, 'PointerEvent', {
    configurable: true,
    value: TestPointerEvent,
  });
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    value: TestPointerEvent,
  });
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      }) as MediaQueryList,
  });
}
