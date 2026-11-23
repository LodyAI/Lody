import type { HistoryWriter } from '../src/history-writer';
import type { SessionHistory } from '../src/schema';
import type { HistoryEntryWrite, HistoryEntryWriteSchema } from '../src/history-write-schema';
import type { MessageContent } from '../src/ai';
import type { MessageContentValidated } from '../src/message-schemas';

type AssertNever<T extends never> = T;
export type AllHistoryVariantsHaveAParser = AssertNever<
  Exclude<MessageContent['type'], MessageContentValidated['type']>
>;
type Notice = Extract<MessageContent, { type: 'system_notice' }>;
type ParsedNotice = Extract<MessageContentValidated, { type: 'system_notice' }>;
export type AllNoticeNamesHaveAParser = AssertNever<Exclude<Notice['name'], ParsedNotice['name']>>;
export type AllParsedNoticeNamesAreKnown = AssertNever<
  Exclude<ParsedNotice['name'], Notice['name']>
>;
export type NoticeMetadataMatchesParser = AssertNever<Exclude<Notice, ParsedNotice>>;
export type ParsedNoticeMetadataMatchesDomain = AssertNever<Exclude<ParsedNotice, Notice>>;
export type AllHistoryFieldsHaveAParser = AssertNever<
  Exclude<keyof SessionHistory, '$cid' | keyof typeof HistoryEntryWriteSchema.shape>
>;
export type AllParserFieldsBelongToHistory = AssertNever<
  Exclude<keyof typeof HistoryEntryWriteSchema.shape, keyof SessionHistory>
>;

// Check nested field coverage too. Semantic narrowing (e.g. supported MIME types)
// is intentional; open protocol dictionaries are separately checked at runtime.
type Variant<A, B> = A extends { type: infer T }
  ? Extract<B, { type: T }>
  : A extends { name: infer N }
    ? Extract<B, { name: N }>
    : B;
type Keys<B> = B extends unknown ? keyof B : never;
type Field<B, K extends PropertyKey> = B extends unknown
  ? K extends keyof B
    ? B[K]
    : never
  : never;
type MissingFields<A, B, P extends string = ''> = A extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  ? never
  : A extends readonly (infer E)[]
    ? NonNullable<B> extends readonly (infer F)[]
      ? MissingFields<E, F, `${P}[]`>
      : never
    : A extends object
      ? string extends keyof A
        ? never
        : {
            [K in keyof A & string]: K extends Keys<NonNullable<B>>
              ? unknown extends Field<NonNullable<B>, K>
                ? never
                : MissingFields<
                    NonNullable<A[K]>,
                    NonNullable<Field<NonNullable<B>, K>>,
                    `${P}.${K}`
                  >
              : `${P}.${K}`;
          }[keyof A & string]
      : never;
type MissingMessageFields<A = MessageContent> = A extends MessageContent
  ? MissingFields<A, Variant<A, MessageContentValidated>>
  : never;
export type AllNestedMessageFieldsHaveAParser = AssertNever<MissingMessageFields>;
export type AllNestedInputConfigFieldsHaveAParser = AssertNever<
  MissingFields<
    NonNullable<SessionHistory['inputConfig']>,
    NonNullable<HistoryEntryWrite['inputConfig']>
  >
>;
export type MissingNestedFieldIsDetected = AssertNever<
  // @ts-expect-error a newly declared nested field must fail the coverage guard
  MissingFields<{ content: { newField: string }[] }, { content: { text: string }[] }>
>;

// Included by the normal shared typecheck, not executed by the test runner.
export function historyWriterTypeContract(writer: HistoryWriter, entry: SessionHistory) {
  writer.append(entry);
  // @ts-expect-error plain caller-owned data cannot mint stored-history provenance
  writer.copyFrom({ history: [entry] }, [entry]);
  writer.setField('turn', 'finished', true);
  writer.setField('turn', 'inputConfig', { _lodyDeliveryKind: 'steer' });
  // @ts-expect-error local delivery provenance has one explicit value
  writer.setField('turn', 'inputConfig', { _lodyDeliveryKind: 'normal' });
  // @ts-expect-error missing required text
  writer.append({ ...entry, items: [{ type: 'text' }] });
  // @ts-expect-error unknown new item type
  writer.append({ ...entry, items: [{ type: 'unknown' }] });
  // @ts-expect-error invalid role
  writer.append({ ...entry, role: 'invalid' });
  // @ts-expect-error field value must match its field
  writer.setField('turn', 'finished', 'yes');
  writer.append({
    ...entry,
    // @ts-expect-error notice name determines metadata
    items: [{ type: 'system_notice', name: 'agent_warning', meta: { truncated: true } }],
  });
  const malformed: HistoryEntryWrite = {
    id: 'x',
    role: 'user',
    timestamp: 'now',
    // @ts-expect-error runtime-schema-derived new inputs also require text
    items: [{ type: 'text' }],
  };
  void malformed;
}
