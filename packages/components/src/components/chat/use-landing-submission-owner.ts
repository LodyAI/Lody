import { useCallback, useLayoutEffect, useRef } from 'react';

/** An accepted session outlives its composer; clearing/navigating its draft does not. */
export function useLandingSubmissionOwner(identity: string) {
  const owner = useRef({ identity, generation: 0, mounted: false });
  if (owner.current.identity !== identity) {
    owner.current.identity = identity;
    owner.current.generation += 1;
  }
  useLayoutEffect(() => {
    const mountedOwner = owner.current;
    mountedOwner.mounted = true;
    return () => {
      mountedOwner.mounted = false;
      mountedOwner.generation += 1;
    };
  }, []);
  return useCallback(() => {
    const generation = owner.current.generation;
    return () => owner.current.mounted && owner.current.generation === generation;
  }, []);
}
