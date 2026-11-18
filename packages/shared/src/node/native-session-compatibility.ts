/** Supplied only by the trusted Node composition after checking the complete
 * installed client/json-patch/engine artifact and native binary proof. A package
 * version string, renderer message or persisted document is not this proof. */
export type NativeSessionSdkCompatibility = {
  readonly artifactId: string;
  readonly setValue: boolean;
  readonly losslessWireI64: boolean;
};
export const supportsNativeSessionLiteralValues = (proof?: NativeSessionSdkCompatibility) =>
  Boolean(proof?.artifactId && proof.setValue);
export const supportsNativeSessionI64 = (proof?: NativeSessionSdkCompatibility) =>
  Boolean(proof?.artifactId && proof.losslessWireI64);
