// Authentication progress originates in a third-party ACP process and is retained by
// Machine RPC. Per-item bounds prevent pathological dimensions, while the serialized
// form budget prevents otherwise-valid dimensions from multiplying into a huge payload.
// These are Lody transport/UI policy limits, not limits imposed by the ACP protocol.
export const ACP_AUTH_METHOD_MAX_COUNT = 32;
export const ACP_AUTH_FORM_FIELD_MAX_COUNT = 32;
export const ACP_AUTH_SELECT_OPTION_MAX_COUNT = 256;
export const ACP_AUTH_ID_MAX_LENGTH = 1024;
export const ACP_AUTH_LABEL_MAX_LENGTH = 4096;
export const ACP_AUTH_TEXT_MAX_LENGTH = 16_384;
export const ACP_AUTHORIZATION_URL_MAX_LENGTH = 8192;
export const ACP_AUTHENTICATION_FORM_MAX_BYTES = 256 * 1024;

const textEncoder = new TextEncoder();

export const isAcpAuthenticationFormWithinByteLimit = (form: unknown): boolean =>
  textEncoder.encode(JSON.stringify(form)).byteLength <= ACP_AUTHENTICATION_FORM_MAX_BYTES;
