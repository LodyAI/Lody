/** Options for {@link IrohNative.openEndpoint}. */
export interface OpenOptions {
  /** Lody relay URLs from the official build composition; empty disables relays. */
  relayUrls: string[];
  /** Shared relay access token. */
  relayToken?: string;
  /** Accept incoming requests (machine side). */
  accept: boolean;
  /** UPnP/NAT-PMP/PCP port mapping; defaults to enabled. Mobile hosts disable it. */
  portmapper?: boolean;
  /** HTTP(S) proxy for relay connections; see {@link proxyUrlFromEnv}. */
  proxyUrl?: string;
}

/** A remote ledger device. */
export interface CallTarget {
  /** 64 lower-case hex characters: the remote ledger signing public key. */
  endpointId: string;
  /** Optional direct `ip:port` addresses (tests and local diagnostics). */
  directAddrs?: string[];
}

/** Replies of one outgoing request. */
export interface IrohCall {
  /** Next reply, or `null` once the listener finished the stream. */
  nextReply(): Promise<Buffer | null>;
  /** Stops reading replies and resets the stream at once; a pending `nextReply`
   * resolves `null`. */
  cancel(): void;
}

/** One incoming request. `remoteEndpointId` is transport identity, not authority. */
export interface IrohRequest {
  readonly remoteEndpointId: string;
  readonly body: Buffer;
  reply(message: Buffer): Promise<void>;
  finish(): Promise<void>;
  reject(): Promise<void>;
}

/** A live endpoint bound to one ledger device key. */
export interface IrohEndpoint {
  readonly endpointId: string;
  directAddrs(): string[];
  online(timeoutMs: number): Promise<boolean>;
  hasConnection(endpointId: string): Promise<boolean>;
  warm(target: CallTarget, timeoutMs: number): Promise<void>;
  call(target: CallTarget, request: Buffer, connectTimeoutMs: number): Promise<IrohCall>;
  nextRequest(): Promise<IrohRequest | null>;
  close(): Promise<void>;
}

/** The Node-API module. Errors carry an `iroh_*` code at the start of `message`. */
export interface IrohNative {
  /**
   * Opens an endpoint for one 32-byte ledger device seed. The buffer is overwritten
   * with zeros before the call returns. Rejects with `iroh_key_in_use` while another
   * live endpoint in this process holds the same key.
   */
  openEndpoint(secretKey: Buffer, options: OpenOptions): Promise<IrohEndpoint>;
}

export declare function nativeFileName(platform?: string, arch?: string): string;
/** Development build location inside this package. */
export declare function developmentNativePath(): string;
/** Loads the module at `file`; `undefined` when unset, missing or unloadable. */
export declare function loadIrohNative(file: string | undefined): IrohNative | undefined;
export declare function loadError(file: string | undefined): string | undefined;
export declare const IROH_RPC_ALPN: 'lody/e2ee-rpc/1';
/** The first http(s) proxy among HTTPS_PROXY, HTTP_PROXY and ALL_PROXY (either case). */
export declare function proxyUrlFromEnv(
  env: Readonly<Record<string, string | undefined>>
): string | undefined;
