# CSV Stream Parser

A zero-dependency Node.js Transform stream that parses CSV text into arrays of
field strings, one record per emitted chunk. Handles quoted fields, escaped
quotes (`""` inside a quoted field becomes a literal `"`), and configurable
delimiters.

## Usage

```js
import { CsvParser, parseCsv } from 'csv-stream-parser';

// Stream API
import { Readable } from 'node:stream';
const rows = [];
for await (const record of Readable.from('a,b\n1,2\n').pipe(new CsvParser())) {
  rows.push(record);
}
// rows === [['a','b'], ['1','2']]

// Synchronous convenience helper
const out = parseCsv('a,b\n1,2\n');
// out === [['a','b'], ['1','2']]
```

## Why this exists

There are many CSV parsers on npm. This one is for cases where you want a
tiny, dependency-free Transform stream you can read and audit in a single
file, and where you are willing to accept a strict, single interpretation
of the format rather than a forest of options.

The trade-off is simplicity over features. There is no auto-delimiter
detection, no comment stripping, no header-to-object mode, and no streaming
of large fields in chunks — a field is accumulated as a string, so a single
quoted field larger than available memory will fail. That is the one real
limitation; it is documented here rather than hidden.

## The awkward edge you will hit

A quote character that appears *after* the first character of an unquoted
field is treated as a literal, not as a field-start quote. So the row
`ab"cd,x` parses as `['ab"cd', 'x']`. This matches Excel and Google Sheets.
If you have CSV where stray quotes were meant to open fields mid-stream,
this parser will not read them that way — fix the producer instead, because
no single parser can disambiguate that case reliably.

A completely empty line between records is preserved as an empty array `[]`,
to keep row counts aligned with the source. A trailing newline at EOF does
*not* produce a phantom empty record.

## Exported names

- `CsvParser` — `stream.Transform` subclass. Constructor options:
  `delimiter` (single char, default `','`) and `quote` (single char, default `'"'`),
  plus any standard Transform options. Operates in object mode, pushing one
  `string[]` per record.
- `parseCsv(input: string, opts?: { delimiter?, quote? }): string[][]` —
  synchronous helper.

No other names are exported.
