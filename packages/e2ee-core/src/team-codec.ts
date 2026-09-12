import { checkHex, checkSigningKey, invariant, fromHex, toHex, type ControlEvent } from './wire';

export interface TeamDeviceInput {
  readonly id: string;
  readonly signingKey: string;
  readonly encryptionKey: string;
  readonly kind: 'personal' | 'machine';
  /** Explicit control-ledger authority ceiling; never inferred from the user's role. */
  readonly canManage: boolean;
}

export interface TeamMemberInput {
  readonly userId: string;
  readonly instance: string;
  readonly recoverySigningKey: string;
  readonly recoveryEncryptionKey: string;
  readonly device: TeamDeviceInput;
}

export interface TeamGenesis {
  /** Client-generated random 32-byte nonce; distinguishes Teams created with the same identity. */
  readonly nonce: string;
  readonly owner: TeamMemberInput;
}

export type TeamAction = { readonly configVersion: number } & (
  | { readonly type: 'epoch.publish'; readonly epoch: number; readonly commitment: string }
  | { readonly type: 'member.add'; readonly member: TeamMemberInput }
  | { readonly type: 'member.admit'; readonly request: string }
  | { readonly type: 'member.cancel'; readonly request: string }
  | { readonly type: 'member.remove'; readonly userId: string; readonly instance: string }
  | {
      readonly type: 'member.role';
      readonly userId: string;
      readonly instance: string;
      readonly role: 'admin' | 'member';
    }
  | {
      readonly type: 'device.add';
      readonly device: TeamDeviceInput;
    }
  | {
      readonly type: 'device.revoke';
      readonly deviceId: string;
    }
  | {
      readonly type: 'owner.transfer';
      readonly userId: string;
      readonly instance: string;
      readonly acceptingDevice: string;
    }
);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Both domains bind the flat policy: old signed revocations must never gain new semantics.
const ACTION_DOMAIN = 'lody-team-action/v3';
const GENESIS_DOMAIN = 'lody-team-genesis/v3';
const MAX_ACTION_BYTES = 4096;

function id(value: unknown): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'invalid-team-id');
  return value;
}

function key(value: unknown): string {
  checkHex(value, 32);
  return value;
}

function signingKey(value: unknown): string {
  checkSigningKey(value);
  return value;
}

function version(value: number): string {
  invariant(Number.isSafeInteger(value) && value >= 0, 'invalid-config-version');
  return String(value);
}

function deviceParts(device: TeamDeviceInput): string[] {
  invariant(device.kind === 'personal' || device.kind === 'machine', 'invalid-device-kind');
  invariant(typeof device.canManage === 'boolean', 'invalid-device-permissions');
  invariant(device.kind !== 'machine' || !device.canManage, 'machine-management-forbidden');
  return [
    id(device.id),
    signingKey(device.signingKey),
    key(device.encryptionKey),
    device.kind,
    device.canManage ? 'manage' : 'none',
  ];
}

function memberParts(member: TeamMemberInput): string[] {
  return [
    id(member.userId),
    id(member.instance),
    signingKey(member.recoverySigningKey),
    key(member.recoveryEncryptionKey),
    ...deviceParts(member.device),
  ];
}

export function encodeTeamAction(action: TeamAction): Pick<ControlEvent, 'kind' | 'payload'> {
  let fields: string[];
  switch (action.type) {
    case 'epoch.publish':
      fields = [version(action.epoch), key(action.commitment)];
      break;
    case 'member.add':
      fields = memberParts(action.member);
      break;
    case 'member.admit':
    case 'member.cancel':
      invariant(
        typeof action.request === 'string' && action.request.length <= MAX_ACTION_BYTES,
        'join-request-too-large'
      );
      fields = [action.request];
      break;
    case 'member.remove':
      fields = [id(action.userId), id(action.instance)];
      break;
    case 'member.role':
      invariant(action.role === 'admin' || action.role === 'member', 'invalid-role');
      fields = [id(action.userId), id(action.instance), action.role];
      break;
    case 'device.add':
      fields = deviceParts(action.device);
      break;
    case 'device.revoke':
      fields = [id(action.deviceId)];
      break;
    case 'owner.transfer':
      fields = [id(action.userId), id(action.instance), id(action.acceptingDevice)];
      break;
    default:
      throw new Error('unknown-team-action');
  }
  const bytes = encoder.encode(
    JSON.stringify([ACTION_DOMAIN, action.type, version(action.configVersion), ...fields])
  );
  invariant(bytes.length <= MAX_ACTION_BYTES, 'team-action-too-large');
  return { kind: `team-${action.type.replace('.', '-')}`, payload: toHex(bytes) };
}

function parseStrings(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  invariant(
    Array.isArray(parsed) && parsed.every((value) => typeof value === 'string'),
    'invalid-team-tuple'
  );
  return parsed;
}

function deviceAt(parts: string[], start: number): TeamDeviceInput {
  const kind = parts[start + 3];
  invariant(kind === 'personal' || kind === 'machine', 'invalid-device-kind');
  invariant(
    parts[start + 4] === 'manage' || parts[start + 4] === 'none',
    'invalid-device-permissions'
  );
  return {
    id: parts[start]!,
    signingKey: parts[start + 1]!,
    encryptionKey: parts[start + 2]!,
    kind,
    canManage: parts[start + 4] === 'manage',
  };
}

function memberAt(parts: string[], start: number): TeamMemberInput {
  return {
    userId: parts[start]!,
    instance: parts[start + 1]!,
    recoverySigningKey: parts[start + 2]!,
    recoveryEncryptionKey: parts[start + 3]!,
    device: deviceAt(parts, start + 4),
  };
}

export function decodeTeamAction(event: Pick<ControlEvent, 'kind' | 'payload'>): TeamAction {
  invariant(
    typeof event.payload === 'string' && event.payload.length <= MAX_ACTION_BYTES * 2,
    'team-action-too-large'
  );
  const parts = parseStrings(decoder.decode(fromHex(event.payload)));
  invariant(parts[0] === ACTION_DOMAIN, 'unsupported-team-version');
  invariant(
    typeof parts[2] === 'string' && /^(0|[1-9][0-9]*)$/.test(parts[2]),
    'invalid-config-version'
  );
  const configVersion = Number(parts[2]);
  const type = parts[1];
  invariant(typeof type === 'string', 'unknown-team-action');
  const sized = (count: number) => invariant(parts.length === count + 3, 'invalid-team-fields');
  let action: TeamAction;
  switch (type) {
    case 'epoch.publish':
      sized(2);
      action = { type, configVersion, epoch: Number(parts[3]), commitment: parts[4]! };
      break;
    case 'member.add':
      sized(9);
      action = { type, configVersion, member: memberAt(parts, 3) };
      break;
    case 'member.admit':
    case 'member.cancel':
      sized(1);
      action = { type, configVersion, request: parts[3]! };
      break;
    case 'member.remove':
      sized(2);
      action = { type, configVersion, userId: parts[3]!, instance: parts[4]! };
      break;
    case 'member.role': {
      sized(3);
      const role = parts[5];
      invariant(role === 'admin' || role === 'member', 'invalid-role');
      action = { type, configVersion, userId: parts[3]!, instance: parts[4]!, role };
      break;
    }
    case 'device.add':
    case 'device.revoke': {
      sized(type === 'device.add' ? 5 : 1);
      action =
        type === 'device.add'
          ? { type, configVersion, device: deviceAt(parts, 3) }
          : { type, configVersion, deviceId: parts[3]! };
      break;
    }
    case 'owner.transfer':
      sized(3);
      action = {
        type,
        configVersion,
        userId: parts[3]!,
        instance: parts[4]!,
        acceptingDevice: parts[5]!,
      };
      break;
    default:
      throw new Error('unknown-team-action');
  }
  const canonical = encodeTeamAction(action);
  invariant(
    canonical.kind === event.kind && canonical.payload === event.payload,
    'noncanonical-team-action'
  );
  return action;
}

export function encodeTeamGenesis(genesis: TeamGenesis): string {
  return JSON.stringify([GENESIS_DOMAIN, key(genesis.nonce), ...memberParts(genesis.owner)]);
}

/** Validates and copies all public fields, so asynchronous hashing cannot race input mutation. */
export function normalizeTeamGenesis(genesis: TeamGenesis): TeamGenesis {
  const parts = parseStrings(encodeTeamGenesis(genesis));
  return {
    nonce: parts[1]!,
    owner: memberAt(parts, 2),
  };
}
