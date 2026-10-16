import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANTHROPIC_CONTRACT_CASES,
  CONTRACT_CASES,
  OPENAI_CONTRACT_CASES,
  runAdapterContract,
  runContractCase,
} from './helpers/adapter-contract.mjs';
import { createAnthropicAdapter } from '../src/adapters/anthropic.mjs';
import { createOpenAIAdapter } from '../src/adapters/openai.mjs';

const openai = ({ timeoutMs }) => createOpenAIAdapter({ providerIdleTimeoutMs: timeoutMs });
const anthropic = ({ timeoutMs }) => createAnthropicAdapter({ providerIdleTimeoutMs: timeoutMs });

test('OpenAI adapter passes every named contract case', async () => {
  await runAdapterContract({ adapterFactory: openai, cases: OPENAI_CONTRACT_CASES });
});

test('Anthropic adapter passes every applicable named contract case', async () => {
  await runAdapterContract({
    adapterKind: 'anthropic',
    adapterFactory: anthropic,
    cases: ANTHROPIC_CONTRACT_CASES,
  });
});

for (const name of CONTRACT_CASES) {
  test(`incomplete adapter fails the ${name} contract case with its focused assertion`, async () => {
    const incomplete = {
      kind: 'openai',
      forward({ res }) {
        res.writeHead(204).end();
      },
    };
    await assert.rejects(
      runContractCase(name, { adapter: incomplete, timeoutMs: 50 }),
      focusedFailure(name),
    );
  });
}

function focusedFailure(name) {
  return {
    name: 'AssertionError',
    message: new RegExp(`adapter contract ${name}:`, 'i'),
  };
}
