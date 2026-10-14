import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTRACT_CASES, runAdapterContract, runContractCase } from './helpers/adapter-contract.mjs';
import { createOpenAIAdapter } from '../src/adapters/openai.mjs';

const openai = ({ timeoutMs }) => createOpenAIAdapter({ providerIdleTimeoutMs: timeoutMs });

test('OpenAI adapter passes every named contract case', async () => {
  await runAdapterContract({ adapterFactory: openai });
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
