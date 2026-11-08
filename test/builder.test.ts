/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StatementValidationError, statement, validateStatement } from '../src/index.js';

const base = () =>
  statement()
    .puid('post-77')
    .visibility(['DECISION_VISIBILITY_CONTENT_REMOVED'])
    .facts('The post repeated a scam link after a warning.')
    .source('SOURCE_VOLUNTARY')
    .automation({ detection: 'Yes', decision: 'AUTOMATED_DECISION_PARTIALLY' })
    .contentType(['CONTENT_TYPE_TEXT'])
    .category('STATEMENT_CATEGORY_SCAMS_AND_FRAUD')
    .contentDate(new Date('2026-11-01T12:00:00Z'))
    .applicationDate('2026-11-02');

describe('statement builder', () => {
  it('builds a valid statement for each decision ground', () => {
    const a = base().incompatibleContent({ ground: 'Terms 3.1', explanation: 'Scam links are not allowed.', alsoIllegal: 'No' }).build();
    expect(a).toMatchObject({ decision_ground: 'DECISION_GROUND_INCOMPATIBLE_CONTENT', incompatible_content_illegal: 'No', content_date: '2026-11-01' });
    const b = base().illegalContent({ legalGround: 'Criminal Code art. 182', explanation: 'Fraud.', referenceUrl: 'https://example.com/law' }).build();
    expect(b).toMatchObject({ decision_ground: 'DECISION_GROUND_ILLEGAL_CONTENT', decision_ground_reference_url: 'https://example.com/law' });
    expect(b).not.toHaveProperty('incompatible_content_ground');
  });

  it('switching the ground removes the other ground fields', () => {
    const s = base()
      .incompatibleContent({ ground: 'T', explanation: 'E', alsoIllegal: 'Yes' })
      .illegalContent({ legalGround: 'L', explanation: 'E' })
      .build();
    expect(s).not.toHaveProperty('incompatible_content_illegal');
    expect(validateStatement(s).warnings).toEqual([]);
  });

  it('covers every Article 17(1) restriction and the optional attributes', () => {
    const s = base()
      .illegalContent({ legalGround: 'L', explanation: 'E' })
      .visibility(['DECISION_VISIBILITY_OTHER'], 'Hidden from feeds')
      .monetary('DECISION_MONETARY_OTHER', 'Payouts withheld')
      .provision('DECISION_PROVISION_PARTIAL_SUSPENSION')
      .account('DECISION_ACCOUNT_SUSPENDED', 'ACCOUNT_TYPE_PRIVATE')
      .accountType('ACCOUNT_TYPE_BUSINESS')
      .contentType(['CONTENT_TYPE_OTHER'], 'Live stream')
      .category('STATEMENT_CATEGORY_SCAMS_AND_FRAUD', ['STATEMENT_CATEGORY_CONSUMER_INFORMATION'])
      .keywords(['KEYWORD_OTHER'], 'Fake giveaway')
      .ean13('4006381333931')
      .territorialScope('EEA')
      .contentLanguage('EN')
      .endDates({ visibility: '2027-01-01', monetary: new Date('2027-02-01T00:00:00Z'), service: '2027-03-01', account: '2027-04-01' })
      .set('content_language', 'LT')
      .build();
    expect(s.territorial_scope).toHaveLength(30);
    expect(s.account_type).toBe('ACCOUNT_TYPE_BUSINESS');
    expect(s.end_date_monetary_restriction).toBe('2027-02-01');
    expect(s.content_language).toBe('LT');
    expect(s.content_id).toEqual({ 'EAN-13': '4006381333931' });
  });

  it('throws StatementValidationError with all issues', () => {
    let err: unknown;
    try {
      statement().puid('bad puid').build();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StatementValidationError);
    const issues = (err as StatementValidationError).issues.map((i) => `${i.code}:${i.attribute}`);
    expect(issues).toContain('invalid_format:puid');
    expect(issues).toContain('required:decision_ground');
    expect(issues).toContain('decision_required:decision_visibility');
    expect((err as StatementValidationError).message).toMatch(/^Invalid statement of reasons/);
  });

  it('validate() does not throw and toJSON() returns raw attributes', () => {
    const b = statement().puid('x');
    expect(b.validate().ok).toBe(false);
    expect(b.toJSON()).toEqual({ puid: 'x' });
    expect(b.set('puid', undefined).toJSON()).toEqual({});
  });
});
