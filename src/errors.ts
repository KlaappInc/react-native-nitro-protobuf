// Structured error types for encode/decode failures. The native codec throws
// plain Errors with descriptive messages; `classifyProtobufError` maps those to
// these typed classes so callers can branch without string matching.

export type ProtobufErrorKind =
  | 'unknown-field'
  | 'unsupported-field'
  | 'limit-exceeded'
  | 'type-mismatch'
  | 'unknown-message'
  | 'decode'
  | 'unknown'

export class ProtobufError extends Error {
  readonly kind: ProtobufErrorKind
  /** The message name being encoded/decoded, when known. */
  readonly messageName?: string
  /** The offending field path, parsed from the message when present. */
  readonly field?: string

  constructor(
    message: string,
    kind: ProtobufErrorKind,
    opts?: { messageName?: string; field?: string; cause?: unknown }
  ) {
    super(message)
    this.name = 'ProtobufError'
    this.kind = kind
    this.messageName = opts?.messageName
    this.field = opts?.field
    if (opts?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = opts.cause
    }
  }
}

/** Encode rejected a field over its `max_length`/`max_size`/`max_count`. */
export class ProtobufLimitError extends ProtobufError {
  constructor(
    message: string,
    opts?: { messageName?: string; field?: string; cause?: unknown }
  ) {
    super(message, 'limit-exceeded', opts)
    this.name = 'ProtobufLimitError'
  }
}

/** A field name not present in the schema, or a wrong JS type for a field. */
export class ProtobufFieldError extends ProtobufError {
  constructor(
    message: string,
    kind: 'unknown-field' | 'unsupported-field' | 'type-mismatch',
    opts?: { messageName?: string; field?: string; cause?: unknown }
  ) {
    super(message, kind, opts)
    this.name = 'ProtobufFieldError'
  }
}

const FIELD_RE = /:\s*([A-Za-z_][\w.]*\.[A-Za-z_]\w*)\s*$/

// Map a thrown native error to a typed ProtobufError. Idempotent: a value that
// is already a ProtobufError is returned unchanged.
export function classifyProtobufError(
  error: unknown,
  messageName?: string
): ProtobufError {
  if (error instanceof ProtobufError) return error
  const msg = error instanceof Error ? error.message : String(error)
  const field = FIELD_RE.exec(msg)?.[1]
  const opts = { messageName, field, cause: error }

  if (/max_length|max_size|max_count|exceeds/.test(msg)) {
    return new ProtobufLimitError(msg, opts)
  }
  if (/Unknown field/i.test(msg)) {
    return new ProtobufFieldError(msg, 'unknown-field', opts)
  }
  if (/not supported/i.test(msg)) {
    return new ProtobufFieldError(msg, 'unsupported-field', opts)
  }
  if (/must be|expected|Bytes fields/i.test(msg)) {
    return new ProtobufFieldError(msg, 'type-mismatch', opts)
  }
  if (/Unknown message|not registered/i.test(msg)) {
    return new ProtobufError(msg, 'unknown-message', opts)
  }
  if (/decode|truncated|invalid wire/i.test(msg)) {
    return new ProtobufError(msg, 'decode', opts)
  }
  return new ProtobufError(msg, 'unknown', opts)
}
