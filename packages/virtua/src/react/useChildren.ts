import { type ReactElement, type ReactNode, useMemo } from 'react';
import { type ItemElement, flattenChildren, getKey } from './utils.js';
import type { ItemKey } from '../core/index.js';

/**
 * @internal
 */
export const useChildren = <T>(
  children: ReactNode | ((data: T, i: number) => ReactElement),
  data: ArrayLike<T> | undefined
) => {
  return useMemo((): [
    (i: number) => ItemElement,
    number,
    /** Lody: every item's key; only for element children. */
    () => ItemKey[],
  ] => {
    if (typeof children === 'function') {
      return [
        (i) => children(data![i]!, i),
        data!.length,
        () => {
          throw new Error('A keyed Virtualizer needs element children, not a render function.');
        },
      ];
    }
    // Memoize element array
    const _elements = flattenChildren(children);
    let keys: ItemKey[] | undefined;
    return [
      (i) => _elements[i]!,
      _elements.length,
      () => (keys ??= _elements.map((e, i) => getKey(e, i) as ItemKey)),
    ];
  }, [children, data]);
};
