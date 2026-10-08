import { z } from "zod";
import { BALANCE_STATUSES, DOC_STATUSES, FINDING_TYPES, MATCH_RULES, TX_KINDS, TX_STATUSES } from "../../../src/workers/finance-month-close/contract.js";

/**
 * Formato do expected.json de cada caso.
 *
 * Referência de movimentação:
 *   "fitid:<FITID>"              (extratos OFX)
 *   "tx:<AAAA-MM-DD>|<centavos>"  (extratos sem FITID, ex.: PDF)
 * Referência de documento: nome do arquivo. Em listas, qualquer um deles vale ("anyOf").
 * "*" = curinga (qualquer movimentação / qualquer documento).
 */
const TxRef = z.string().regex(/^(fitid:.+|tx:\d{4}-\d{2}-\d{2}\|-?\d+|\*)$/);
const OneOrMany = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.array(t).min(1)]);

const FindingPattern = z.object({
  type: z.enum(FINDING_TYPES),
  tx: OneOrMany(TxRef).optional(),
  doc: OneOrMany(z.string()).optional(),
  expectedCents: z.number().int().optional(),
  foundCents: z.number().int().optional(),
  diffCents: z.number().int().optional(),
  why: z.string().optional(),
});
export type FindingPattern = z.infer<typeof FindingPattern>;

const PairPattern = z.object({ tx: TxRef, doc: OneOrMany(z.string()) });
export type PairPattern = z.infer<typeof PairPattern>;

const DocTruth = z.object({
  docType: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  date: z.string().nullable(),
  counterparty: z.string().nullable(),
  legibility: z.enum(["ok", "partial", "illegible"]),
});
export type DocTruth = z.infer<typeof DocTruth>;

export const CaseSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().regex(/^C\d{2}b?$/),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  availableFrom: z.enum(["STEP_07", "STEP_10", "STEP_11"]),
  plantedErrors: z.array(
    z.object({
      text: z.string(),
      // ponteiro para a expectativa que prova que o erro foi detectado
      expect: z.string().regex(/^(finding:[a-z_]+|forbidden_finding:[a-z_]+|forbidden_confirmation|pending_match:[a-z_]+|outcome:rejected|status:needs_review|ignored_file|doc_truth:.+)$/),
    }),
  ),
  input: z.object({ statement: z.string(), documents: z.array(z.string()) }),
  documentsTruth: z.record(z.string(), DocTruth),
  expect: z.object({
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("result") }),
      z.object({ kind: z.literal("rejected"), code: z.string(), file: z.string() }),
    ]),
    status: z.enum(["completed", "needs_review"]).optional(),
    reviewReasonsInclude: z.array(z.string()).optional(),
    balanceCheck: z.enum(BALANCE_STATUSES).optional(),
    transactionCount: z.number().int().optional(),
    ignoredFiles: z.array(z.string()).optional(),
    transactions: z
      .array(
        z.object({
          ref: TxRef,
          kind: z.enum(TX_KINDS).optional(),
          status: z.enum(TX_STATUSES).optional(),
          statusAnyOf: z.array(z.enum(TX_STATUSES)).optional(),
        }),
      )
      .optional(),
    documents: z
      .array(
        z.object({
          file: z.string(),
          amountCents: z.number().int().nullable().optional(),
          legibility: z.enum(["ok", "partial", "illegible", "unprocessed"]).optional(),
          status: z.enum(DOC_STATUSES).optional(),
        }),
      )
      .optional(),
    confirmedMatches: z.array(PairPattern).optional(),
    optionalConfirmations: z.array(PairPattern).optional(),
    forbiddenConfirmations: z.array(z.object({ tx: TxRef, doc: z.string() })).optional(),
    requiredPendingMatches: z
      .array(z.object({ tx: z.array(TxRef).min(1), docs: z.array(z.string()).min(1), rule: z.enum(MATCH_RULES) }))
      .optional(),
    requiredFindings: z.array(FindingPattern).optional(),
    allowedFindings: z.array(FindingPattern).optional(),
    forbiddenFindings: z.array(FindingPattern).optional(),
  }),
});
export type RegressionCase = z.infer<typeof CaseSchema>;

export const SourcesSchema = z.record(
  z.string(),
  z.object({
    kind: z.enum(["ofx", "pdf_text", "pdf_encrypted", "png", "png_illegible", "copy_of"]),
    textLines: z.array(z.string()).optional(),
    injectionLines: z.array(z.string()).optional(),
    of: z.string().optional(),
    statementTruth: z
      .object({
        openingCents: z.number().int(),
        transactions: z.array(z.object({ date: z.string(), cents: z.number().int(), desc: z.string(), present: z.boolean() })),
      })
      .optional(),
  }),
);
export type CaseSources = z.infer<typeof SourcesSchema>;

export const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
