import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { inspectPublicEntries, inspectPublicSurface } from '../scripts/check-public-docs';

const { surface, missing } = inspectPublicSurface();
/** Backticked names in each `## \`entry\`` section of a surface document. */
const listed = (file: string) => {
  const sections = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')) {
    const heading = /^## `([^`]+)`/.exec(line);
    if (heading) sections.set(heading[1]!, (current = new Set()));
    else if (current)
      for (const [, name] of line.matchAll(/`([A-Za-z_][\w]*)`/g)) current.add(name!);
  }
  return sections;
};

describe('public surface documentation', () => {
  it('documents public exports, namespace exports and every service member with JSDoc', () => {
    expect(missing).toEqual([]);
  });
  it.each(['../docs/surface.md', '../docs/surface.zh.md'])(
    '%s lists exactly the exports of each entry',
    (file) => {
      const sections = listed(file);
      for (const { entry, names } of surface)
        expect([...(sections.get(entry) ?? [])].sort(), entry).toEqual([...names].sort());
    }
  );

  it('checks aliased exports, namespace members and inherited service contracts', () => {
    const files: Record<string, string> = {
      '/entry.ts': `
        export { Port as PublicPort, InheritedPort } from './ports';
        /** Protocol helpers. */
        export * as Bytes from './bytes';
      `,
      '/ports.ts': `
        declare class Service<S> { readonly Service: S }
        /** A documented port with an undocumented operation. */
        export class Port extends Service<{
          /** Read the current value. */
          read(): string;
          write(value: string): void;
        }> {}
        /** Inherits the same operation contract. */
        export class InheritedPort extends Service<Port['Service']> {}
      `,
      '/bytes.ts': `
        /** Copy the input bytes. */
        export const copy = (value: Uint8Array) => value.slice();
        export const unsafe = () => 0;
      `,
    };
    const inspect = () => {
      const options: ts.CompilerOptions = {
        noLib: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (file, languageVersion) =>
        files[file] === undefined
          ? undefined
          : ts.createSourceFile(file, files[file], languageVersion, true);
      host.fileExists = (file) => files[file] !== undefined;
      host.readFile = (file) => files[file];
      host.directoryExists = (directory) => directory === '/';
      return inspectPublicEntries(ts.createProgram(Object.keys(files), options, host), [
        ['.', '/entry.ts'],
      ]);
    };
    expect(inspect()).toEqual({
      surface: [{ entry: '@lody/e2ee-core', names: ['Bytes', 'InheritedPort', 'PublicPort'] }],
      missing: ['.: Bytes.unsafe', '.: InheritedPort.write', '.: PublicPort.write'],
    });
    files['/ports.ts'] = files['/ports.ts']!.replace(
      'write(value:',
      '/** Persist the value atomically. */\nwrite(value:'
    );
    files['/bytes.ts'] = files['/bytes.ts']!.replace(
      'export const unsafe',
      '/** A synthetic protocol constant. */\nexport const unsafe'
    );
    expect(inspect().missing).toEqual([]);
    files['/entry.ts'] = files['/entry.ts']!.replace('/** Protocol helpers. */', '');
    expect(inspect().missing).toEqual(['.: Bytes']);
  });
});
