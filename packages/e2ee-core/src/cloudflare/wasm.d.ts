/** Workers bundlers import a `.wasm` file as a compiled module. */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
