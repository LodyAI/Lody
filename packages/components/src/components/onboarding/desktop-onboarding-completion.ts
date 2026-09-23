export type DesktopOnboardingPersistenceResult =
  | { ok: true }
  | { ok: false; message?: string }
  | undefined;

export interface EnterDesktopProductOptions {
  persistCompletion: () => Promise<DesktopOnboardingPersistenceResult> | undefined;
  navigate: () => Promise<void>;
  onProductEntered: () => void;
  onDurableCompletion: () => void;
  onPersistenceFailure: (error: unknown) => void;
  onNavigationFailure: (error: unknown) => void;
}

/**
 * Starts the native completion write before navigation, but never makes product
 * entry wait for that write. Resumable renderer state is cleared only after both
 * sides succeed, so a failed native write remains recoverable on the next launch.
 */
export function enterDesktopProduct(options: EnterDesktopProductOptions): Promise<boolean> {
  let productEntered = false;
  let completionPersisted = false;
  let durableCompletionCommitted = false;

  const commitDurableCompletion = () => {
    if (!productEntered || !completionPersisted || durableCompletionCommitted) return;
    durableCompletionCommitted = true;
    options.onDurableCompletion();
  };

  try {
    const persistence = options.persistCompletion();
    if (!persistence) {
      options.onPersistenceFailure(undefined);
    } else {
      void persistence.then((result) => {
        if (!result?.ok) {
          options.onPersistenceFailure(result?.message);
          return;
        }
        completionPersisted = true;
        commitDurableCompletion();
      }, options.onPersistenceFailure);
    }
  } catch (error) {
    options.onPersistenceFailure(error);
  }

  let navigation: Promise<void>;
  try {
    navigation = options.navigate();
  } catch (error) {
    options.onNavigationFailure(error);
    return Promise.resolve(false);
  }

  return navigation.then(
    () => {
      productEntered = true;
      options.onProductEntered();
      commitDurableCompletion();
      return true;
    },
    (error: unknown) => {
      options.onNavigationFailure(error);
      return false;
    }
  );
}
