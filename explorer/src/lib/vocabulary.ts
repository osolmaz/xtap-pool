import { createContext, useContext } from "react";

import type { LinkableConcept } from "./concept-links.js";

/**
 * Concept vocabulary shared app-wide for inline linking. Empty until the
 * one-time /api/concepts fetch resolves, and stays empty when it fails, so
 * tweet text degrades to plain rendering without concept links.
 */
export const VocabularyContext = createContext<readonly LinkableConcept[]>([]);

/** The active concept vocabulary ([] while loading or unavailable). */
export function useVocabulary(): readonly LinkableConcept[] {
  return useContext(VocabularyContext);
}
