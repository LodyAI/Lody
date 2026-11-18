import { CliType, SUPPORTED_CLI_TYPES } from '@lody/shared';

export type CliAvailability = Record<CliType, string | false>;

export type ResolveCliTypesSelectionParams = {
  requestedCliTypes?: CliType[];
  availability: CliAvailability;
};

export function resolveCliTypesSelection(params: ResolveCliTypesSelectionParams): {
  configuredCliTypes: CliType[];
  cliTypes: CliType[];
  missing: CliType[];
  invalid: string[];
  isDefaultSelection: boolean;
} {
  const hasRequestedCliTypes = !!params.requestedCliTypes && params.requestedCliTypes.length > 0;
  const requestedCliTypes = [...(params.requestedCliTypes ?? [])] as string[];
  const invalid = hasRequestedCliTypes
    ? requestedCliTypes.filter((type) => !isSupportedCliType(type))
    : [];
  const configuredCliTypes: CliType[] = hasRequestedCliTypes
    ? requestedCliTypes.filter(isSupportedCliType)
    : getDefaultCliTypes(params.availability);
  const missing = configuredCliTypes.filter((type) => !params.availability[type]);
  const cliTypes = configuredCliTypes.filter((type) => !!params.availability[type]);
  return {
    configuredCliTypes,
    cliTypes,
    missing,
    invalid,
    isDefaultSelection: !hasRequestedCliTypes,
  };
}

function getDefaultCliTypes(availability: CliAvailability): CliType[] {
  const installedCliTypes = SUPPORTED_CLI_TYPES.filter((type) => !!availability[type]);
  return installedCliTypes;
}

function isSupportedCliType(value: string): value is CliType {
  return SUPPORTED_CLI_TYPES.includes(value as CliType);
}

/** Resolve optional builtins before opening any provider credential source.
 * This never changes command authentication or explicit custom providers. */
export function resolveStartupBuiltinAgentDiscovery(input: {
  setting: string | undefined;
  requestedCliTypes?: CliType[];
  discover: () => CliAvailability;
}) {
  const enabled = input.setting !== '0';
  const availability: CliAvailability = enabled
    ? input.discover()
    : {
        kimi: false,
        grok: false,
        claude: false,
        codex: false,
        antigravity: false,
        pi: false,
        devin: false,
      };
  if (!enabled) {
    for (const requested of input.requestedCliTypes ?? []) {
      if (isSupportedCliType(requested)) availability[requested] = 'explicitly-selected';
    }
  }
  return {
    availability,
    selection: resolveCliTypesSelection({
      requestedCliTypes: input.requestedCliTypes,
      availability,
    }),
  };
}
