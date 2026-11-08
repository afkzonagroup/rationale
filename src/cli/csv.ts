/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/** A small RFC 4180 CSV reader with limits. */

import { RationaleError } from '../errors.js';

/** Limits for CSV parsing. */
export interface CsvLimits {
  readonly maxColumns?: number;
  readonly maxFieldLength?: number;
  readonly maxRows?: number;
}

/** One data row with the line number where it starts (1-based). */
export interface CsvRow {
  readonly line: number;
  readonly values: readonly string[];
}

/**
 * Parses CSV text into rows of fields. Handles quoted fields with commas,
 * doubled quotes and line breaks, CRLF and LF line ends, and a leading
 * byte order mark. Throws RationaleError("input") on malformed input.
 */
export function parseCsv(text: string, delimiter = ',', limits: CsvLimits = {}): CsvRow[] {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new RationaleError('input', 'The CSV delimiter must be one character other than a quote or line break.');
  }
  const maxColumns = limits.maxColumns ?? 1000;
  const maxField = limits.maxFieldLength ?? 1024 * 1024;
  const maxRows = limits.maxRows ?? 10_000_000;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let line = 1;
  let rowLine = 1;
  let i = 0;
  let quoted = false;
  let fieldStarted = false;

  const endField = (): void => {
    if (field.length > maxField) throw new RationaleError('input', `CSV field too long on line ${rowLine}.`);
    row.push(field);
    if (row.length > maxColumns) throw new RationaleError('input', `Too many CSV columns on line ${rowLine}.`);
    field = '';
    fieldStarted = false;
  };
  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === '')) {
      rows.push({ line: rowLine, values: row });
      if (rows.length > maxRows) throw new RationaleError('input', 'Too many CSV rows.');
    }
    row = [];
  };

  while (i < src.length) {
    const c = src[i] ?? '';
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = src[i];
        if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') {
          throw new RationaleError('input', `Unexpected character after a closing quote on line ${line}.`);
        }
        continue;
      }
      if (c === '\n') line++;
      field += c;
      if (field.length > maxField) throw new RationaleError('input', `CSV field too long on line ${rowLine}.`);
      i++;
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new RationaleError('input', `A quote inside an unquoted field on line ${line}.`);
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line++;
      rowLine = line;
      continue;
    }
    field += c;
    fieldStarted = true;
    if (field.length > maxField) throw new RationaleError('input', `CSV field too long on line ${rowLine}.`);
    i++;
  }
  if (quoted) throw new RationaleError('input', 'Unterminated quoted CSV field.');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
