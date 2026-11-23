import { atom } from 'jotai';

/** A target-bound hidden view may render but cannot act as a presented surface. */
export const windowPreparationAtom = atom(false);
