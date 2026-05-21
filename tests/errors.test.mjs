import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProtobufError,
  ProtobufLimitError,
  ProtobufFieldError,
  classifyProtobufError,
} from '../lib/errors.js'

test('classifies limit-exceeded errors', () => {
  const e = classifyProtobufError(
    new Error('Field exceeds max_length: acme.User.name'),
    'acme.User'
  )
  assert.ok(e instanceof ProtobufLimitError)
  assert.equal(e.kind, 'limit-exceeded')
  assert.equal(e.messageName, 'acme.User')
  assert.equal(e.field, 'acme.User.name')
})

test('classifies unknown-field and unsupported-field', () => {
  const unknown = classifyProtobufError(new Error('Unknown field "foo"'))
  assert.ok(unknown instanceof ProtobufFieldError)
  assert.equal(unknown.kind, 'unknown-field')

  const unsupported = classifyProtobufError(
    new Error('Map fields are not supported: acme.Config.labels')
  )
  assert.equal(unsupported.kind, 'unsupported-field')
  assert.equal(unsupported.field, 'acme.Config.labels')
})

test('classifies type mismatch (bytes)', () => {
  const e = classifyProtobufError(
    new Error('Bytes fields must be base64 strings or number arrays')
  )
  assert.equal(e.kind, 'type-mismatch')
})

test('unknown message + fallback', () => {
  assert.equal(
    classifyProtobufError(new Error('Unknown message: acme.Nope')).kind,
    'unknown-message'
  )
  assert.equal(classifyProtobufError(new Error('weird')).kind, 'unknown')
})

test('is idempotent on an existing ProtobufError', () => {
  const original = new ProtobufError('x', 'decode')
  assert.equal(classifyProtobufError(original), original)
})

test('preserves the original error as cause', () => {
  const cause = new Error('exceeds max_count')
  const e = classifyProtobufError(cause)
  assert.equal(e.cause, cause)
})
