/**
 * `LanguageAdapter` and its registry — `docs/contracts/04-providers.md` §2.
 *
 * **Stage 1 ships the interface and the registry, and no adapter.** ADR 0001 registers
 * exactly one adapter, German, and it is written in Stage 4 alongside the spaCy sidecar.
 * The registry exists now because it is the single hook that keeps Portuguese, Spanish,
 * and French a registration rather than a refactor, and because Stage 4 should find a
 * home rather than invent one.
 */

export interface AnnotatedToken {
  surface: string;
  normalized: string;
  lemma: string;
  pos: string;
  morph: Record<string, string>;
  headIndex: number | null;
  depRelation: string | null;
  isEntity: boolean;
  entityType: string | null;
  startChar: number;
  endChar: number;
  isTargetLanguage: boolean;
}

export interface MweRelationSpec {
  relation: string;
  description: string;
}

export interface ConstructionTemplate {
  id: string;
  slots: Array<{
    index: number;
    kind: 'fixed' | 'slot';
    text: string | null;
    slotLabel: string | null;
    constraints: string[];
  }>;
  functionalExplanation: string;
}

export interface LanguageAdapter {
  readonly language: string;
  readonly version: string;

  annotate(sentence: string): Promise<AnnotatedToken[]>;
  normalizeOrthography(surface: string): string;

  /** Which POS tags are suppressed as isolated candidates
   *  (`01-domain-model.md` §6). Never hardcoded in pipeline code. */
  isSuppressedAsIsolatedItem(token: AnnotatedToken): boolean;

  /** Dependency relations marking a lexicalized attachment. MWE generation runs on the
   *  dependency graph, not the token sequence — German separable verbs are discontinuous
   *  and no n-gram window recovers them (ADR 0009). */
  mweRelations(): MweRelationSpec[];

  constructionPatterns(): ConstructionTemplate[];

  frequencyRank(lemma: string): number | null;
  frequencyBand(lemma: string): number | null;
}

export class UnsupportedLanguageError extends Error {
  constructor(language: string, supported: string[]) {
    super(
      `No language adapter registered for "${language}". Registered: ${
        supported.length > 0 ? supported.join(', ') : '(none)'
      }.`,
    );
    this.name = 'UnsupportedLanguageError';
  }
}

/**
 * `get()` throws rather than falling back, deliberately. A silent fallback to the German
 * adapter for a Spanish profile would produce plausible, wrong lemmas — and every
 * downstream symptom would point somewhere else.
 */
export class LanguageAdapterRegistry {
  readonly #adapters = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    this.#adapters.set(adapter.language, adapter);
  }

  get(language: string): LanguageAdapter {
    const adapter = this.#adapters.get(language);
    if (!adapter) throw new UnsupportedLanguageError(language, this.supported());
    return adapter;
  }

  supported(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}
