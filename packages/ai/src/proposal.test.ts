import { describe, expect, it } from 'vitest';
import { parseWritingProposal, WritingProposalError } from './index';

const valid = {
  markdown: '先说明前提，再推出结论。',
  explanations: [{ questionId: 'q1', quote: '先说明前提', coverage: 'partial' }],
  deferred: [{ questionId: 'q1', nodeId: 'n3', reason: '下一段推出结论。' }],
};

describe('writing proposal parsing', () => {
  it('accepts bare and wholly fenced JSON, preserving proposed text verbatim', () => {
    const text = JSON.stringify(valid);
    for (const wrapped of [text, `\n\n${text}\n`, `\`\`\`json\n${text}\n\`\`\``, `~~~~JSON\r\n${text}\r\n~~~~`]) {
      expect(parseWritingProposal(wrapped)).toEqual(valid);
    }
  });

  it('leaves existing-ID and quotation verification to the document controller', () => {
    const proposal = { ...valid, explanations: [{ questionId: 'unknown-but-well-formed', quote: 'not in the markdown', coverage: 'full' }], deferred: [] };
    expect(parseWritingProposal(JSON.stringify(proposal))).toEqual(proposal);
  });

  it.each([
    null, [], {}, { ...valid, extra: true }, { ...valid, markdown: ' \n\t' },
    { ...valid, explanations: null }, { ...valid, deferred: {} },
    { ...valid, explanations: [{ questionId: 'q1', quote: '', coverage: 'partial' }] },
    { ...valid, explanations: [{ questionId: 'q1', quote: 'text', coverage: 'understood' }] },
    { ...valid, explanations: [{ questionId: ' q1 ', quote: 'text', coverage: 'partial' }] },
    { ...valid, explanations: [{ questionId: 'q1', quote: 'text', coverage: 'partial', resolved: true }] },
    { ...valid, explanations: [valid.explanations[0], valid.explanations[0]] },
    { ...valid, deferred: [valid.deferred[0], { questionId: 'q1', nodeId: 'n4' }] },
    { ...valid, explanations: [{ questionId: 'q1', quote: 'text', coverage: 'full' }] },
    { ...valid, deferred: [{ questionId: 'q2', nodeId: 'n3', reason: '' }] },
    { ...valid, markdown: 'x'.repeat(500_001) },
    { ...valid, deferred: Array.from({ length: 257 }, (_, i) => ({ questionId: `q${i}`, nodeId: 'n3' })) },
  ])('rejects invalid, duplicate or oversized structures', value => {
    expect(() => parseWritingProposal(JSON.stringify(value))).toThrow(WritingProposalError);
  });

  it('rejects prose wrappers, duplicate JSON properties, excessive nesting and excessive total size', () => {
    const text = JSON.stringify(valid);
    for (const invalid of [
      `Here is the result: ${text}`, `${text}\nMore thoughts.`,
      `{"markdown":"first","\\u006darkdown":"second","explanations":[],"deferred":[]}`,
      `{"markdown":"body","explanations":[],"deferred":[{"questionId":"q1","nodeId":"n1","nodeId":"n2"}]}`,
      '['.repeat(30) + '0' + ']'.repeat(30), ' '.repeat(1_000_001),
    ]) expect(() => parseWritingProposal(invalid)).toThrow(WritingProposalError);
  });

  it('never repeats malformed model output in an error', () => {
    try { parseWritingProposal('sensitive untrusted output'); }
    catch (error) { expect(String(error)).not.toContain('sensitive untrusted output'); }
  });
});
