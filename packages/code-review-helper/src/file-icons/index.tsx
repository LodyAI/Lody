import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { useMemo } from 'react';

import { compoundExtensionMap, defaultFileIcon, extensionMap, fileNameMap } from './mappings';

/*
 * Per-extension file-type icons, copied from `@lody/components` (which adapts the
 * MIT-licensed "vscode-symbols" icon set by Miguel Solorio) so this package stays
 * standalone. Only the file icons (`./files/*.svg`) are included — folders use a
 * plain lucide icon. The dynamic `new URL(..., import.meta.url)` pattern lets Vite
 * emit the referenced SVGs as assets.
 */

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

/** Resolve the icon asset name for a file path (filename match → compound ext → ext). */
export function getFileIconName(filePath: string): string {
  const fileName = getFileName(filePath).toLowerCase();
  if (fileNameMap[fileName]) {
    return fileNameMap[fileName];
  }
  const original = getFileName(filePath);
  if (fileNameMap[original]) {
    return fileNameMap[original];
  }
  for (const [ext, icon] of Object.entries(compoundExtensionMap)) {
    if (fileName.endsWith(`.${ext}`)) {
      return icon;
    }
  }
  const dot = fileName.lastIndexOf('.');
  if (dot !== -1) {
    const ext = fileName.slice(dot + 1);
    if (extensionMap[ext]) {
      return extensionMap[ext];
    }
  }
  return defaultFileIcon;
}

const iconUrlCache = new Map<string, string>();

function iconUrl(name: string): string {
  const cached = iconUrlCache.get(name);
  if (cached) {
    return cached;
  }
  const url = new URL(`./files/${name}.svg`, import.meta.url).href;
  iconUrlCache.set(name, url);
  return url;
}

export function FileIcon({
  filePath,
  className,
}: {
  readonly filePath: string;
  readonly className?: string;
}) {
  const src = useMemo(() => iconUrl(getFileIconName(filePath)), [filePath]);
  const sx = stylex.props(iconStyles.base, className === undefined && iconStyles.defaultSize);
  return <img src={src} alt="" aria-hidden {...sx} className={clsx(sx.className, className)} />;
}

const iconStyles = stylex.create({
  base: { flexShrink: 0 },
  defaultSize: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
});
