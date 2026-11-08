/*
 * Copyright 2026 MB AFKzona Group
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A typed builder for statements of reasons. Each method sets the
 * attributes for one element of Article 17(3) DSA; `build()` validates the
 * result with the same rules as the client and returns the normalised
 * statement.
 */

import { StatementValidationError } from './errors.js';
import type {
  AccountTypeValue,
  AutomatedDecisionValue,
  AutomatedDetectionValue,
  CategoryAdditionValue,
  CategorySpecificationValue,
  CategoryValue,
  ContentLanguageValue,
  ContentTypeValue,
  DecisionAccountValue,
  DecisionMonetaryValue,
  DecisionProvisionValue,
  DecisionVisibilityValue,
  IncompatibleContentIllegalValue,
  SourceTypeValue,
  Statement,
  TerritorialScopeValue,
} from './generated/openapi-types.js';
import { TERRITORIAL_PRESETS } from './schema.js';
import { toIsoDate } from './text.js';
import { validateStatement, type ValidateOptions, type ValidationResult } from './validate.js';

/** A date as YYYY-MM-DD, or a Date (converted in UTC). */
export type DateInput = string | Date;

function date(d: DateInput): string {
  return typeof d === 'string' ? d : toIsoDate(d);
}

/** Builder for one statement of reasons. Methods return the builder for chaining. */
export class StatementBuilder {
  readonly #data = new Map<string, unknown>();

  #set(key: string, value: unknown): this {
    if (value === undefined) this.#data.delete(key);
    else this.#data.set(key, value);
    return this;
  }

  /** Your unique identifier for this decision (`puid`): letters, digits, "-" and "_", at most 500 characters, never reused. */
  puid(value: string): this {
    return this.#set('puid', value);
  }

  /** Visibility restrictions, Article 17(1)(a). Pass `other` with DECISION_VISIBILITY_OTHER. */
  visibility(values: readonly DecisionVisibilityValue[], other?: string): this {
    return this.#set('decision_visibility', [...values]).#set('decision_visibility_other', other);
  }

  /** Restriction of monetary payments, Article 17(1)(b). Pass `other` with DECISION_MONETARY_OTHER. */
  monetary(value: DecisionMonetaryValue, other?: string): this {
    return this.#set('decision_monetary', value).#set('decision_monetary_other', other);
  }

  /** Suspension or termination of the service, Article 17(1)(c). */
  provision(value: DecisionProvisionValue): this {
    return this.#set('decision_provision', value);
  }

  /** Suspension or termination of the account, Article 17(1)(d). */
  account(value: DecisionAccountValue, type?: AccountTypeValue): this {
    return this.#set('decision_account', value).#set('account_type', type);
  }

  /** Type of the affected account (optional). */
  accountType(value: AccountTypeValue): this {
    return this.#set('account_type', value);
  }

  /** The decision concerns allegedly illegal content, Article 17(3)(d). */
  illegalContent(ground: { readonly legalGround: string; readonly explanation: string; readonly referenceUrl?: string }): this {
    for (const k of ['incompatible_content_ground', 'incompatible_content_explanation', 'incompatible_content_illegal']) this.#data.delete(k);
    return this.#set('decision_ground', 'DECISION_GROUND_ILLEGAL_CONTENT')
      .#set('illegal_content_legal_ground', ground.legalGround)
      .#set('illegal_content_explanation', ground.explanation)
      .#set('decision_ground_reference_url', ground.referenceUrl);
  }

  /** The decision concerns content incompatible with the terms and conditions, Article 17(3)(e). */
  incompatibleContent(ground: { readonly ground: string; readonly explanation: string; readonly alsoIllegal?: IncompatibleContentIllegalValue; readonly referenceUrl?: string }): this {
    for (const k of ['illegal_content_legal_ground', 'illegal_content_explanation']) this.#data.delete(k);
    return this.#set('decision_ground', 'DECISION_GROUND_INCOMPATIBLE_CONTENT')
      .#set('incompatible_content_ground', ground.ground)
      .#set('incompatible_content_explanation', ground.explanation)
      .#set('incompatible_content_illegal', ground.alsoIllegal)
      .#set('decision_ground_reference_url', ground.referenceUrl);
  }

  /** Facts and circumstances relied on, Article 17(3)(b). No personal data (Article 24(5)). */
  facts(text: string): this {
    return this.#set('decision_facts', text);
  }

  /** Whether the decision followed a notice or own-initiative investigation, Article 17(3)(b). */
  source(type: SourceTypeValue, identity?: string): this {
    return this.#set('source_type', type).#set('source_identity', identity);
  }

  /** Use of automated means, Article 17(3)(c). */
  automation(a: { readonly detection: AutomatedDetectionValue; readonly decision: AutomatedDecisionValue }): this {
    return this.#set('automated_detection', a.detection).#set('automated_decision', a.decision);
  }

  /** Types of the affected content. Pass `other` with CONTENT_TYPE_OTHER. */
  contentType(values: readonly ContentTypeValue[], other?: string): this {
    return this.#set('content_type', [...values]).#set('content_type_other', other);
  }

  /** Category of the decision, plus optional additional categories. */
  category(value: CategoryValue, additional?: readonly CategoryAdditionValue[]): this {
    return this.#set('category', value).#set('category_addition', additional ? [...additional] : undefined);
  }

  /** Keywords (category specification). Pass `other` with KEYWORD_OTHER. */
  keywords(values: readonly CategorySpecificationValue[], other?: string): this {
    return this.#set('category_specification', [...values]).#set('category_specification_other', other);
  }

  /** An EAN-13 product identifier of the affected content. */
  ean13(code: string): this {
    return this.#set('content_id', { 'EAN-13': code });
  }

  /** Territorial scope, Article 17(3)(a): country codes, or "EU" / "EEA" for all of them. */
  territorialScope(scope: 'EU' | 'EEA' | readonly TerritorialScopeValue[]): this {
    const list = scope === 'EU' || scope === 'EEA' ? TERRITORIAL_PRESETS[scope] : scope;
    return this.#set('territorial_scope', [...list]);
  }

  /** Language of the content (upper-case ISO 639-1 code). */
  contentLanguage(code: ContentLanguageValue): this {
    return this.#set('content_language', code);
  }

  /** When the content was posted or the account created. */
  contentDate(d: DateInput): this {
    return this.#set('content_date', date(d));
  }

  /** Date from which the restriction applies, Article 17(3)(a). */
  applicationDate(d: DateInput): this {
    return this.#set('application_date', date(d));
  }

  /** End dates of the restrictions (duration, Article 17(3)(a)). Leave out for indefinite restrictions. */
  endDates(e: { readonly visibility?: DateInput; readonly monetary?: DateInput; readonly service?: DateInput; readonly account?: DateInput }): this {
    return this.#set('end_date_visibility_restriction', e.visibility === undefined ? undefined : date(e.visibility))
      .#set('end_date_monetary_restriction', e.monetary === undefined ? undefined : date(e.monetary))
      .#set('end_date_service_restriction', e.service === undefined ? undefined : date(e.service))
      .#set('end_date_account_restriction', e.account === undefined ? undefined : date(e.account));
  }

  /** Sets any attribute directly. */
  set<K extends keyof Statement>(key: K, value: Statement[K] | undefined): this {
    return this.#set(key, value);
  }

  /** The raw attributes set so far. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.#data);
  }

  /** Validates without throwing. */
  validate(options?: ValidateOptions): ValidationResult {
    return validateStatement(this.toJSON(), options);
  }

  /** Validates and returns the normalised statement. Throws StatementValidationError. */
  build(options?: ValidateOptions): Statement {
    const r = this.validate(options);
    if (!r.ok || r.statement === undefined) throw new StatementValidationError(r.errors);
    return r.statement;
  }
}

/** Starts a new statement. */
export function statement(): StatementBuilder {
  return new StatementBuilder();
}
