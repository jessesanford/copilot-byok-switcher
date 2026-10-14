import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdapterEventError,
  adapterEvent,
  assembleAdapterEvents,
} from '../src/adapters/events.mjs';

const interleavedEvents = [
  { type: 'reasoning', text: 'Need two ', metadata: { anthropic: { signature: 'sig-1' } } },
  { type: 'tool-fragment', index: 1, id: 'call-b', name: 'lookup_', arguments: '{"city":"' },
  { type: 'text', text: 'Checking ' },
  { type: 'tool-fragment', index: 0, id: 'call-a', name: 'get_', arguments: '{"city":"' },
  { type: 'metadata', namespace: 'gemini', data: { safetyRatings: [{ category: 'safe' }] } },
  { type: 'tool-fragment', index: 1, name: 'time', arguments: 'Tokyo"}' },
  { type: 'reasoning', text: 'places.' },
  { type: 'tool-fragment', index: 0, name: 'weather', arguments: 'Berlin"}' },
  {
    type: 'tool',
    index: 1,
    id: 'call-b',
    name: 'lookup_time',
    arguments: '{"city":"Tokyo"}',
    result: { timezone: 'Asia/Tokyo' },
  },
  { type: 'text', text: 'both.' },
  {
    type: 'tool',
    index: 0,
    id: 'call-a',
    name: 'get_weather',
    arguments: '{"city":"Berlin"}',
    result: { temperature: 18 },
  },
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
  { type: 'finish', reason: 'tool-calls', metadata: { openai: { systemFingerprint: 'fp-1' } } },
  new AdapterEventError('provider overloaded', {
    category: 'upstream',
    status: 503,
    retryable: true,
    metadata: { anthropic: { requestId: 'req-1' } },
  }).toEvent(),
];

test('assembles interleaved fragmented parallel tools deterministically without losing events', () => {
  const assembled = assembleAdapterEvents(interleavedEvents);

  assert.equal(assembled.text, 'Checking both.');
  assert.equal(assembled.reasoning, 'Need two places.');
  assert.deepEqual(assembled.tools, [
    {
      id: 'call-a',
      index: 0,
      name: 'get_weather',
      arguments: '{"city":"Berlin"}',
      result: { temperature: 18 },
      complete: true,
    },
    {
      id: 'call-b',
      index: 1,
      name: 'lookup_time',
      arguments: '{"city":"Tokyo"}',
      result: { timezone: 'Asia/Tokyo' },
      complete: true,
    },
  ]);
  assert.deepEqual(assembled.usage, [{ inputTokens: 11, outputTokens: 7, totalTokens: 18 }]);
  assert.deepEqual(assembled.finishes, ['tool-calls']);
  assert.deepEqual(assembled.metadata, {
    anthropic: [{ signature: 'sig-1' }, { requestId: 'req-1' }],
    gemini: [{ safetyRatings: [{ category: 'safe' }] }],
    openai: [{ systemFingerprint: 'fp-1' }],
  });
  assert.deepEqual(assembled.errors, [{
    category: 'upstream',
    message: 'provider overloaded',
    retryable: true,
    status: 503,
  }]);
  assert.deepEqual(assembled.events, interleavedEvents);
  assert.equal(Object.isFrozen(assembled), true);
  assert.equal(Object.isFrozen(assembled.events[0]), true);
});

test('uses first-seen order when completed tools have no provider index', () => {
  const assembled = assembleAdapterEvents([
    { type: 'tool-fragment', id: 'second', arguments: '{}' },
    { type: 'tool-fragment', id: 'first', arguments: '{}' },
    { type: 'tool', id: 'first', name: 'first', arguments: '{}' },
    { type: 'tool', id: 'second', name: 'second', arguments: '{}' },
  ]);

  assert.deepEqual(assembled.tools.map(({ id }) => id), ['second', 'first']);
});

test('keeps incomplete tool assembly visible and preserves usage snapshots', () => {
  const assembled = assembleAdapterEvents([
    { type: 'tool-fragment', index: 0, name: 'partial', arguments: '{' },
    { type: 'usage', usage: { inputTokens: 3 } },
    { type: 'usage', usage: { outputTokens: 2 } },
  ]);

  assert.deepEqual(assembled.tools, [{
    index: 0,
    name: 'partial',
    arguments: '{',
    complete: false,
  }]);
  assert.deepEqual(assembled.usage, [{ inputTokens: 3 }, { outputTokens: 2 }]);
});

test('rejects invalid event shapes and contradictory completed tools', () => {
  assert.throws(() => adapterEvent({ type: 'metadata', namespace: 'openai', data: [] }), /must be an object/);
  assert.throws(() => assembleAdapterEvents([
    { type: 'tool-fragment', id: 'call-1', name: 'by_id' },
    { type: 'tool-fragment', index: 0, name: 'by_index' },
    { type: 'tool-fragment', id: 'call-1', index: 0, arguments: '{}' },
  ]), /refer to different fragmented tools/);
  assert.throws(() => adapterEvent({
    type: 'error',
    error: { category: 'secret-provider-code', message: 'bad', retryable: false },
  }), /Unknown adapter error category/);
  assert.throws(() => assembleAdapterEvents([
    { type: 'tool-fragment', id: 'call-1', name: 'weather', arguments: '{}' },
    { type: 'tool', id: 'call-1', name: 'other', arguments: '{}' },
  ]), /does not match assembled name/);
});

test('accepts metadata namespaces that overlap object prototype names', () => {
  const metadata = Object.create(null);
  metadata.__proto__ = { value: 1 };
  const assembled = assembleAdapterEvents([
    { type: 'text', text: 'safe', metadata },
    { type: 'metadata', namespace: '__proto__', data: { value: 2 } },
    { type: 'metadata', namespace: 'constructor', data: { value: 3 } },
  ]);

  assert.deepEqual(assembled.metadata.__proto__, [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(assembled.metadata.constructor, [{ value: 3 }]);
});

test('typed errors validate categories and produce normalized events', () => {
  assert.throws(
    () => new AdapterEventError('bad', { category: 'provider-secret' }),
    /Unknown adapter error category/,
  );

  assert.deepEqual(new AdapterEventError('timed out', {
    category: 'timeout',
    status: 504,
    retryable: true,
  }).toEvent(), {
    type: 'error',
    error: {
      category: 'timeout',
      message: 'timed out',
      retryable: true,
      status: 504,
    },
  });
});
