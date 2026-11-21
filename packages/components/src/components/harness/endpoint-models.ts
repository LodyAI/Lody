/*
 * The wire protocols a user-defined endpoint can speak, and how the form and
 * the row chip label them. Model discovery belongs to Sorbet on the machine —
 * `sorbet/providers-create` reports what the endpoint serves — so nothing here
 * talks to the endpoint directly.
 */
import type { EndpointProtocol } from './store';

export const ENDPOINT_PROTOCOLS: EndpointProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
];

export const PROTOCOL_LABEL: Record<EndpointProtocol, string> = {
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'OpenAI · Responses',
  'openai-completions': 'OpenAI · Completions',
};
