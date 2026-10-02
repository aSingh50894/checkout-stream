import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCsvState, feed, flush } from '../src/core.js';

/** Helper: parse a complete CSV string to an array of records. */
function parse(input, opts) {
  const s = createCsvState(opts);
  const out = feed(s, input);
  out.push(...flush(s));
  return out;
}

test('simple two-row csv', () => {
  assert.deepEqual(parse('a,b,c\n1,2,3\n'), [['a','b','c'],['1','2','3']]);
});

test('no trailing newline still emits the last record', () => {
  assert.deepEqual(parse('a,b\nc,d'), [['a','b'],['c','d']]);
});

test('empty input yields no records', () => {
  assert.deepEqual(parse(''), []);
});

test('trailing newline does not produce a phantom empty record', () => {
  assert.deepEqual(parse('a,b\n'), [['a','b']]);
});

test('quoted field containing delimiter and newline', () => {
  const src = '"a,b",c\n"line1\nline2",d\n';
  assert.deepEqual(parse(src), [['a,b','c'],['line1\nline2','d']]);
});

test('escaped quotes inside quoted fields (RFC 4180 """" -> "")', () => {
  assert.deepEqual(parse('"he said ""hi""",x\n'), [['he said "hi"','x']]);
});

test('custom delimiter (semicolon)', () => {
  assert.deepEqual(parse('a;b;c\n', { delimiter: ';' }), [['a','b','c']]);
});

test('custom delimiter (tab)', () => {
  assert.deepEqual(parse('a\tb\tc\n', { delimiter: '\t' }), [['a','b','c']]);
});

test('CRLF line endings are treated as one separator', () => {
  assert.deepEqual(parse('a,b\r\nc,d\r\n'), [['a','b'],['c','d']]);
});

test('lone CR is also a record separator', () => {
  assert.deepEqual(parse('a,b\rc,d'), [['a','b'],['c','d']]);
});

test('blank line in the middle is preserved as an empty record', () => {
  assert.deepEqual(parse('a,b\n\nc,d\n'), [['a','b'],[],['c','d']]);
});

test('trailing empty fields are kept ("a," -> ["a",""])', () => {
  assert.deepEqual(parse('a,\n'), [['a','']]);
});

test('a record with a single empty field is emitted', () => {
  assert.deepEqual(parse('\n'), [[]]);
});

test('quote appearing mid-unquoted-field is a literal char', () => {
  // Excel/Sheets: a quote not at field start is just text.
  assert.deepEqual(parse('ab"cd,x\n'), [['ab"cd','x']]);
});

test('chunked input produces the same output as one-shot', () => {
  const src = 'a,b,"q\"q",c\n1,2,3,4\n';
  const one = parse(src);

  const s = createCsvState();
  const collected = [];
  for (let i = 0; i < src.length; i++) {
    collected.push(...feed(s, src[i]));
  }
  collected.push(...flush(s));
  assert.deepEqual(collected, one);
});

test('unterminated quoted field at EOF is closed leniently', () => {
  assert.deepEqual(parse('a,b,"unterminated'), [['a','b','unterminated']]);
});

test('constructor rejects delimiter equal to quote', () => {
  assert.throws(() => createCsvState({ delimiter: '"', quote: '"' }), /must differ/);
});

test('constructor rejects multi-char delimiter', () => {
  assert.throws(() => createCsvState({ delimiter: ';;' }), /single character/);
});

test('feed rejects non-string chunks', () => {
  const s = createCsvState();
  assert.throws(() => feed(s, Buffer.from('a')), /must be a string/);
});

test('quote at start then trailing chars after close is recovered', () => {
  // "ab"cd — quote closes after ab, then trailing cd is part of the field.
  assert.deepEqual(parse('"ab"cd,x\n'), [['abcd','x']]);
});

test('single field per row (no delimiter present)', () => {
  assert.deepEqual(parse('hello\nworld\n'), [['hello'],['world']]);
});

test('streaming wrapper produces same records as sync helper', async () => {
  const { CsvParser } = await import('../src/index.js');
  const { Readable } = await import('node:stream');
  const src = 'a,b,c\n"x,y",z\n';
  const r = Readable.from([src]);
  const p = new CsvParser();
  const got = [];
  for await (const rec of r.pipe(p)) got.push(rec);
  assert.deepEqual(got, [['a','b','c'],['x,y','z']]);
});
