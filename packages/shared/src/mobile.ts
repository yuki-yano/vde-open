import { z } from 'zod';

import {
  assetRoleSchema,
  documentFormatSchema,
  documentIdSchema,
  htmlModeSchema,
  renderLinkSchema,
  repositoryReasonSchema,
  revisionSchema,
  sourceStateSchema,
} from './documents.ts';

// The phone reader (ADR-0017). Its API carries what reading and the list need: display names, opaque keys, and paths
// within a checkout, never an absolute path, a repository ID, or a question.

// Changes when the shown content or its script permission changes. Not a secret and never used for authorization.
export const viewEpochSchema = z.string().regex(/^\d+\.\d+$/);

// Where a document is, named as the PC list names it. Keys are opaque and stable while the daemon runs.
export const mobileLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stdin') }),
  z.strictObject({ kind: z.literal('generated') }),
  z.strictObject({ kind: z.literal('outside'), fileName: z.string() }),
  // Repository detection has not finished yet.
  z.strictObject({ kind: z.literal('pending'), fileName: z.string() }),
  z.strictObject({
    kind: z.literal('repository'),
    key: z.string(),
    name: z.string(),
    checkout: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('main') }),
      // label: as the PC list shows the worktree. full: with its own name when that differs from the branch.
      z.strictObject({
        kind: z.literal('linked'),
        key: z.string(),
        label: z.string(),
        full: z.string(),
      }),
      // Inside the .git directory, for example a removed worktree.
      z.strictObject({ kind: z.literal('unknown') }),
    ]),
    // From the checkout to the document, including the file name.
    path: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal('unresolved'),
    key: z.string(),
    name: z.string(),
    reason: repositoryReasonSchema,
    path: z.array(z.string()),
  }),
]);
export type MobileLocation = z.infer<typeof mobileLocationSchema>;

export const mobileDocumentSchema = z.strictObject({
  documentId: documentIdSchema,
  title: z.string(),
  format: documentFormatSchema,
  location: mobileLocationSchema,
  openedAt: z.string(),
  updatedAt: z.string(),
  // null until the first content has been read.
  revision: revisionSchema.nullable(),
  sourceState: sourceStateSchema,
  // HTML only: whether the PC allowed its scripts. null for Markdown and images.
  effectiveMode: htmlModeSchema.nullable(),
  viewEpoch: viewEpochSchema,
});
export type MobileDocument = z.infer<typeof mobileDocumentSchema>;

export const mobileListResultSchema = z.strictObject({
  daemonId: z.string(),
  catalogVersion: z.number().int().nonnegative(),
  documents: z.array(mobileDocumentSchema),
  nextCursor: z.string().nullable(),
});
export type MobileListResult = z.infer<typeof mobileListResultSchema>;

export const mobileContentResultSchema = z.strictObject({
  documentId: documentIdSchema,
  revision: revisionSchema,
  content: z.string(),
  nextCursor: z.string().nullable(),
});
export type MobileContentResult = z.infer<typeof mobileContentResultSchema>;

export const mobileGrantParamsSchema = z.strictObject({
  revision: revisionSchema,
  viewEpoch: viewEpochSchema,
});

export const mobileGrantResultSchema = z.strictObject({
  grant: z.string(),
  documentId: documentIdSchema,
  revision: revisionSchema,
  viewEpoch: viewEpochSchema,
  format: documentFormatSchema,
  mode: htmlModeSchema,
  documentUrl: z.string().nullable(),
  filesBaseUrl: z.string(),
  documentLogicalPath: z.string(),
  assets: z.array(z.strictObject({ logicalPath: z.string(), role: assetRoleSchema })),
  links: z.array(renderLinkSchema),
  headingTargets: z.array(
    z.strictObject({ sectionId: z.string().regex(/^sec_\d{4,}$/), anchor: z.string() }),
  ),
});
export type MobileGrantResult = z.infer<typeof mobileGrantResultSchema>;

export const mobileCloseParamsSchema = z.strictObject({});

export const mobileGrantKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const mobileReleaseParamsSchema = z.strictObject({
  grants: z.array(z.string().min(1).max(128)).max(256),
});

export const mobileCheckParamsSchema = z.strictObject({ grant: z.string().min(1).max(128) });

export const mobileLinkParamsSchema = z.strictObject({
  grant: z.string().min(1).max(128),
  linkId: z.string().regex(/^lnk_\d{4,}$/),
});

export const mobileLinkResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('open'), documentId: documentIdSchema }),
  z.strictObject({ status: z.literal('not-open') }),
]);
export type MobileLinkResult = z.infer<typeof mobileLinkResultSchema>;

// Notifications to the phone. `changed` only asks it to fetch the list again.
export const mobileEventSchema = z.strictObject({
  type: z.enum(['hello', 'changed', 'resync-required', 'daemon-stopping']),
  daemonId: z.string(),
  documentId: documentIdSchema.optional(),
});
export type MobileEvent = z.infer<typeof mobileEventSchema>;
