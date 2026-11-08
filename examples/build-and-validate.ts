import { statement, validateStatement } from '@afkzona/rationale';

const sor = statement()
  .puid('listing-48213')
  .visibility(['DECISION_VISIBILITY_CONTENT_REMOVED'])
  .illegalContent({
    legalGround: 'Article 5 of the national product safety act',
    explanation: 'The listing offers a product that this provision prohibits.',
  })
  .facts('A notice reported the listing. A review confirmed that the product is prohibited.')
  .source('SOURCE_ARTICLE_16')
  .automation({ detection: 'No', decision: 'AUTOMATED_DECISION_NOT_AUTOMATED' })
  .contentType(['CONTENT_TYPE_PRODUCT'])
  .category('STATEMENT_CATEGORY_UNSAFE_AND_PROHIBITED_PRODUCTS')
  .territorialScope('EU')
  .contentDate('2026-10-01')
  .applicationDate('2026-10-02')
  .build();

console.log(sor.puid, sor.territorial_scope?.length);
// listing-48213 27

const check = validateStatement({ ...sor, decision_facts: 'Reported by jane@example.com.' });
console.log(check.ok, JSON.stringify(check.warnings.map((w) => w.code)));
// true ["possible_personal_data"]

const bad = validateStatement({ ...sor, decision_ground: 'Illegal content', puid: 'listing 48213' });
console.log(JSON.stringify(bad.errors.map((e) => `${e.attribute}: ${e.code}`)));
// ["decision_ground: invalid_value","puid: invalid_format"]
