const keywords = new Set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self Self throw throws true try Type Protocol Any'.split(
    ' ',
  ),
);
const ident = (name) => (keywords.has(name) ? `\`${name}\`` : name);
const pascal = (value) =>
  value.replace(/(^|[_\-\s.]+)([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase());
const camel = (value) => {
  const name = pascal(value);
  const lower = name[0].toLowerCase() + name.slice(1);
  return /^[0-9]/.test(lower) ? `_${lower}` : lower;
};
const literal = (value) => JSON.stringify(value);

export function emitSwift(contract) {
  const declared = new Map();
  const order = [];

  const declare = (name, body) => {
    if (declared.has(name)) {
      if (declared.get(name) !== body)
        throw new Error(`Generated type name collision: ${name}`);
      return;
    }
    declared.set(name, body);
    order.push(name);
  };

  const isNull = (schema) => schema.type === 'null';
  const tagOf = (branches) => {
    if (!branches.every((b) => b.type === 'object' && b.properties)) return;
    const [first] = branches;
    for (const key of first.required ?? []) {
      const consts = branches.map((b) =>
        (b.required ?? []).includes(key) &&
        typeof b.properties[key]?.const === 'string'
          ? b.properties[key].const
          : undefined,
      );
      if (
        consts.every((c) => c !== undefined) &&
        new Set(consts).size === consts.length
      )
        return { key, consts };
    }
  };

  function swiftType(schema, hint) {
    if (schema.$ref) return pascal(schema.$ref);
    if (schema.anyOf || schema.oneOf) {
      const branches = schema.anyOf ?? schema.oneOf;
      const values = branches.filter((b) => !isNull(b));
      if (values.length < branches.length) {
        if (values.length !== 1)
          throw new Error(`${hint}: unsupported nullable union`);
        return `${swiftType(values[0], hint)}?`;
      }
      const tag = tagOf(values);
      if (!tag)
        throw new Error(`${hint}: unions need a string const discriminator`);
      emitTagged(hint, values, tag);
      return hint;
    }
    if (Array.isArray(schema.type)) {
      const values = schema.type.filter((type) => type !== 'null');
      if (values.length === 1 && values.length < schema.type.length)
        return `${swiftType({ ...schema, type: values[0] }, hint)}?`;
      throw new Error(`${hint}: unsupported type union`);
    }
    if (schema.const !== undefined) {
      if (typeof schema.const !== 'string')
        throw new Error(`${hint}: unsupported const`);
      return 'String';
    }
    switch (schema.type) {
      case 'string':
        if (schema.enum) {
          emitStringEnum(hint, schema.enum);
          return hint;
        }
        return 'String';
      case 'integer':
        return 'Int';
      case 'number':
        return 'Double';
      case 'boolean':
        return 'Bool';
      case 'array':
        return `[${swiftType(schema.items ?? {}, `${hint}Item`)}]`;
      case 'object':
        if (
          !schema.properties &&
          schema.additionalProperties &&
          schema.additionalProperties !== true
        )
          return `[String: ${swiftType(schema.additionalProperties, `${hint}Value`)}]`;
        emitStruct(hint, schema);
        return hint;
      case undefined:
        if (Object.keys(schema).length === 0) return 'JSONValue';
    }
    throw new Error(`${hint}: unsupported schema ${JSON.stringify(schema)}`);
  }

  function fields(name, schema, omit) {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {})
      .filter(([key]) => key !== omit)
      .map(([key, value]) => {
        const type = swiftType(value, name + pascal(key));
        const optional = !required.has(key);
        const nullable = type.endsWith('?');
        if (optional && nullable)
          throw new Error(
            `${name}.${key}: optional and nullable cannot be told apart on the wire; pick one`,
          );
        return {
          key,
          name: ident(key),
          type: optional && !nullable ? `${type}?` : type,
          base: nullable ? type.slice(0, -1) : type,
          mode: optional ? 'optional' : nullable ? 'nullable' : 'required',
        };
      });
  }

  function structBody(name, list) {
    const lines = [`  public struct ${name}: Codable, Sendable, Equatable {`];
    for (const f of list) lines.push(`    public var ${f.name}: ${f.type}`);
    const params = list
      .map(
        (f) => `${f.name}: ${f.type}${f.mode === 'optional' ? ' = nil' : ''}`,
      )
      .join(', ');
    lines.push(`    public init(${params}) {`);
    for (const f of list) lines.push(`      self.${f.name} = ${f.name}`);
    lines.push('    }');
    lines.push('    public init(from decoder: any Decoder) throws {');
    lines.push(
      list.length
        ? '      let c = try decoder.container(keyedBy: Key.self)'
        : '      _ = try decoder.container(keyedBy: Key.self)',
    );
    for (const f of list) {
      const call = {
        required: `try c.decode(${f.base}.self, forKey: Key(${literal(f.key)}))`,
        nullable: `try c.decode(${f.base}?.self, forKey: Key(${literal(f.key)}))`,
        optional: `try c.decodeIfPresent(${f.base}.self, forKey: Key(${literal(f.key)}))`,
      }[f.mode];
      lines.push(`      self.${f.name} = ${call}`);
    }
    lines.push('    }');
    lines.push('    public func encode(to encoder: any Encoder) throws {');
    lines.push(
      list.length
        ? '      var c = encoder.container(keyedBy: Key.self)'
        : '      _ = encoder.container(keyedBy: Key.self)',
    );
    for (const f of list) {
      const call = {
        required: `try c.encode(self.${f.name}, forKey: Key(${literal(f.key)}))`,
        nullable: `try c.encode(self.${f.name}, forKey: Key(${literal(f.key)}))`,
        optional: `try c.encodeIfPresent(self.${f.name}, forKey: Key(${literal(f.key)}))`,
      }[f.mode];
      lines.push(`      ${call}`);
    }
    lines.push('    }');
    lines.push('  }');
    return lines.join('\n');
  }

  function emitStruct(name, schema) {
    declare(name, structBody(name, fields(name, schema)));
  }

  function emitStringEnum(name, values) {
    const lines = [
      `  public enum ${name}: String, Codable, Sendable, Equatable, CaseIterable {`,
      ...values.map((v) => `    case ${ident(camel(v))} = ${literal(v)}`),
      '  }',
    ];
    declare(name, lines.join('\n'));
  }

  function emitTagged(name, branches, { key, consts }) {
    const cases = branches.map((branch, i) => {
      const variant = name + pascal(consts[i]);
      declare(variant, structBody(variant, fields(variant, branch, key)));
      return { tag: consts[i], name: ident(camel(consts[i])), variant };
    });
    const lines = [
      `  public enum ${name}: Codable, Sendable, Equatable {`,
      ...cases.map((c) => `    case ${c.name}(${c.variant})`),
      '    public init(from decoder: any Decoder) throws {',
      '      let c = try decoder.container(keyedBy: Key.self)',
      `      let tag = try c.decode(String.self, forKey: Key(${literal(key)}))`,
      '      switch tag {',
      ...cases.map(
        (c) =>
          `      case ${literal(c.tag)}: self = .${c.name}(try ${c.variant}(from: decoder))`,
      ),
      `      default: throw DecodingError.dataCorruptedError(forKey: Key(${literal(key)}), in: c, debugDescription: "Unknown ${key} \\(tag)")`,
      '      }',
      '    }',
      '    public func encode(to encoder: any Encoder) throws {',
      '      var c = encoder.container(keyedBy: Key.self)',
      '      switch self {',
      ...cases.map(
        (c) =>
          `      case .${c.name}(let value):\n        try c.encode(${literal(c.tag)}, forKey: Key(${literal(key)}))\n        try value.encode(to: encoder)`,
      ),
      '      }',
      '    }',
      '  }',
    ];
    declare(name, lines.join('\n'));
  }

  for (const [id, schema] of Object.entries(contract.types))
    swiftType(schema, pascal(id));

  const runtime = Object.entries(contract.runtimeCalls);
  const host = Object.entries(contract.hostCalls);
  const events = Object.entries(contract.events);
  const q = (id) => `RuntimeContract.${pascal(id)}`;
  const out = [
    '// Generated by packages/cloud-runtime/scripts/contract.mjs from runtime-contract.json. Do not edit.',
    'import Foundation',
    '',
    'extension RuntimeContract {',
    `  public static let version = ${contract.protocol}`,
    `  public static let runtimeMethods: [String] = ${literal(runtime.map(([m]) => m))}`,
    '',
    ...order.flatMap((name) => [declared.get(name), '']),
    '  public enum Calls {',
    ...runtime.map(([method, spec]) =>
      [
        `    public enum ${pascal(method)}: RuntimeCall {`,
        `      public typealias Params = ${q(spec.params)}`,
        `      public typealias Result = ${q(spec.result)}`,
        `      public static let method = ${literal(method)}`,
        `      public static let timeout: Double = ${spec.timeoutMs / 1000}`,
        '      public static func result(_ value: RuntimeContract.CallResult) -> Result? {',
        `        if case .${ident(method)}(let result) = value { return result }`,
        '        return nil',
        '      }',
        '    }',
      ].join('\n'),
    ),
    '  }',
    '',
    '  public enum HostCalls {',
    ...host.map(([method, spec]) =>
      [
        `    public enum ${pascal(method)}: RuntimeHostCall {`,
        `      public typealias Params = ${q(spec.params)}`,
        `      public typealias Result = ${q(spec.result)}`,
        `      public static let method = ${literal(method)}`,
        `      public static let timeout: Double = ${spec.timeoutMs / 1000}`,
        '    }',
      ].join('\n'),
    ),
    '  }',
    '',
    '  public enum CallResult: Sendable, Equatable {',
    ...runtime.map(
      ([method, spec]) => `    case ${ident(method)}(${q(spec.result)})`,
    ),
    '  }',
    '',
    '  public enum HostRequest: Sendable, Equatable {',
    ...host.map(
      ([method, spec]) => `    case ${ident(method)}(${q(spec.params)})`,
    ),
    '    public var method: String {',
    '      switch self {',
    ...host.map(
      ([method]) => `      case .${ident(method)}: ${literal(method)}`,
    ),
    '      }',
    '    }',
    '  }',
    '',
    '  public enum Event: Sendable, Equatable {',
    ...events.map(([method, id]) => `    case ${ident(method)}(${q(id)})`),
    '  }',
    '',
    '  public enum Inbound: Sendable, Equatable {',
    '    case request(id: String, HostRequest)',
    '    case result(id: String, CallResult)',
    '    case error(id: String, method: String, RuntimeError)',
    '    case event(Event)',
    '    case unsupported(kind: String, method: String, id: String?)',
    '  }',
    '',
    '  public struct Envelope: Decodable, Sendable, Equatable {',
    '    public let v: Int',
    '    public let gen: Int',
    '    public let message: Inbound',
    '    public init(from decoder: any Decoder) throws {',
    '      let c = try decoder.container(keyedBy: Key.self)',
    '      v = try c.decode(Int.self, forKey: Key("v"))',
    '      gen = try c.decode(Int.self, forKey: Key("gen"))',
    '      let kind = try c.decode(String.self, forKey: Key("kind"))',
    '      let method = try c.decode(String.self, forKey: Key("method"))',
    '      let id = try c.decodeIfPresent(String.self, forKey: Key("id"))',
    '      switch (kind, id) {',
    '      case ("request", let id?):',
    '        switch method {',
    ...host.map(
      ([method, spec]) =>
        `        case ${literal(method)}: message = .request(id: id, .${ident(method)}(try c.decode(${q(spec.params)}.self, forKey: Key("payload"))))`,
    ),
    '        default: message = .unsupported(kind: kind, method: method, id: id)',
    '        }',
    '      case ("result", let id?):',
    '        switch method {',
    ...runtime.map(
      ([method, spec]) =>
        `        case ${literal(method)}: message = .result(id: id, .${ident(method)}(try c.decode(${q(spec.result)}.self, forKey: Key("payload"))))`,
    ),
    '        default: message = .unsupported(kind: kind, method: method, id: id)',
    '        }',
    '      case ("error", let id?):',
    '        message = .error(id: id, method: method, try c.decode(RuntimeError.self, forKey: Key("error")))',
    '      case ("event", _):',
    '        switch method {',
    ...events.map(
      ([method, id]) =>
        `        case ${literal(method)}: message = .event(.${ident(method)}(try c.decode(${q(id)}.self, forKey: Key("payload"))))`,
    ),
    '        default: message = .unsupported(kind: kind, method: method, id: id)',
    '        }',
    '      default:',
    '        message = .unsupported(kind: kind, method: method, id: id)',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ];
  return out.join('\n');
}
