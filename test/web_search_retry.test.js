const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithWebSearchRetry } = require('../src/anthropic');

function successResponse(query = 'q') {
  return {
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query } },
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', title: 'T', url: 'https://x.example' }],
      },
    ],
  };
}

function errorResponse(query = 'q', code = 'too_many_requests') {
  return {
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query } },
      {
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: code },
      },
    ],
  };
}

const noWait = { sleep: async () => {}, random: () => 0.5 };

test('runWithWebSearchRetry returns after first success', async () => {
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return successResponse();
    },
    ...noWait,
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.residual_errors.length, 0);
  assert.equal(result.searches.length, 1);
});

test('runWithWebSearchRetry retries on too_many_requests and eventually succeeds', async () => {
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return calls < 3 ? errorResponse('q', 'too_many_requests') : successResponse('q');
    },
    ...noWait,
  });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.residual_errors.length, 0);
});

test('runWithWebSearchRetry gives up after maxAttempts and returns residual errors', async () => {
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return errorResponse('persistent', 'unavailable');
    },
    maxAttempts: 2,
    ...noWait,
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.residual_errors.length, 1);
  assert.equal(result.residual_errors[0].error.code, 'unavailable');
});

test('runWithWebSearchRetry does not retry non-retryable error codes', async () => {
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return errorResponse('bad query', 'invalid_input');
    },
    maxAttempts: 4,
    ...noWait,
  });
  assert.equal(calls, 1, 'invalid_input is not retryable; only the initial call should fire');
  assert.equal(result.attempts, 1);
  assert.equal(result.residual_errors.length, 1);
  assert.equal(result.residual_errors[0].error.code, 'invalid_input');
});

test('runWithWebSearchRetry skips retry when any search succeeded (cost guard)', async () => {
  // Mixed response: 1 success + 1 retryable error. Under the cost-guard rule,
  // a partial success means the model has enough context; don't burn another
  // full turn on a retryable error alone.
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return {
        content: [
          ...successResponse('hit').content,
          ...errorResponse('rate', 'too_many_requests').content,
        ],
      };
    },
    maxAttempts: 3,
    ...noWait,
  });
  assert.equal(calls, 1, 'partial success should skip retry');
  assert.equal(result.attempts, 1);
  assert.equal(result.residual_errors.length, 1);
});

test('runWithWebSearchRetry retries when ANY search has a retryable error and none succeeded', async () => {
  // Mixed retryable + non-retryable, no success: retry should fire.
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return {
        content: [
          ...errorResponse('rate', 'too_many_requests').content,
          ...errorResponse('bad', 'invalid_input').content,
        ],
      };
    },
    maxAttempts: 2,
    ...noWait,
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.residual_errors.length, 2);
});

test('runWithWebSearchRetry invokes onAttempt once per attempt with summary counts and maxAttempts', async () => {
  const attempts = [];
  await runWithWebSearchRetry({
    doCall: async () => errorResponse('rate', 'too_many_requests'),
    maxAttempts: 2,
    onAttempt: async (info) => attempts.push(info),
    ...noWait,
  });
  assert.equal(attempts.length, 2);
  for (const a of attempts) {
    assert.equal(a.summary.search_count, 1);
    assert.equal(a.summary.success_count, 0);
    assert.equal(a.summary.retryable_error_count, 1);
    assert.equal(a.summary.non_retryable_error_count, 0);
    assert.equal(a.maxAttempts, 2);
  }
});

test('runWithWebSearchRetry returns the LAST attempt response, not an earlier one', async () => {
  // Distinct response objects per call; assert the final one is returned.
  const responses = [
    errorResponse('q', 'too_many_requests'),
    errorResponse('q', 'too_many_requests'),
    successResponse('q'),
  ];
  let i = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => responses[i++],
    maxAttempts: 3,
    ...noWait,
  });
  assert.equal(result.response, responses[2]);
  assert.equal(result.attempts, 3);
});

test('runWithWebSearchRetry lets doCall rejections propagate to caller', async () => {
  // Transport-level errors come pre-retried by apiQueue; the helper should not
  // swallow them. Contract: a doCall throw bypasses the retry loop entirely.
  const boom = new Error('transport failure');
  let calls = 0;
  await assert.rejects(
    () =>
      runWithWebSearchRetry({
        doCall: async () => {
          calls += 1;
          throw boom;
        },
        ...noWait,
      }),
    (err) => err === boom
  );
  assert.equal(calls, 1, 'helper should not call again after a doCall throw');
});

test('runWithWebSearchRetry maxAttempts=1 fires once and returns residuals', async () => {
  let calls = 0;
  const result = await runWithWebSearchRetry({
    doCall: async () => {
      calls += 1;
      return errorResponse('q', 'too_many_requests');
    },
    maxAttempts: 1,
    ...noWait,
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.residual_errors.length, 1);
});
