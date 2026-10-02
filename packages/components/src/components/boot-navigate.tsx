import {
  Navigate,
  type AnyRouter,
  type NavigateOptions,
  type RegisteredRouter,
} from '@tanstack/react-router';
import type { Attributes } from 'react';
import { BootShell } from './boot-shell';

/** Keep the boot frame visible until the destination commits. */
export function BootNavigate<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(props: NavigateOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & Attributes) {
  return (
    <>
      <BootShell />
      <Navigate {...props} />
    </>
  );
}
