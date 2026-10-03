import type { DocumentSummary } from '@vde-open/shared';

// The sidebar tree (spec 13.1). A view built from the paths of registered documents; it never touches the filesystem.
export type TreeNode =
  | { kind: 'directory'; name: string; children: TreeNode[] }
  | { kind: 'document'; name: string; document: DocumentSummary };

export const INPUT_GROUP_NAME = 'Input and generated documents';

interface Branch {
  directories: Map<string, Branch>;
  documents: DocumentSummary[];
}

function emptyBranch(): Branch {
  return { directories: new Map(), documents: [] };
}

function commonPrefixLength(paths: string[][]): number {
  if (paths.length === 0) return 0;
  // Keep the file name and compare only the directory part.
  const directories = paths.map((segments) => segments.slice(0, -1));
  const shortest = Math.min(...directories.map((segments) => segments.length));
  let length = 0;
  while (
    length < shortest &&
    directories.every((segments) => segments[length] === directories[0]?.[length])
  ) {
    length += 1;
  }
  return length;
}

function toNodes(branch: Branch): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [name, child] of branch.directories) {
    // If the only child is a single directory, collapse it into one row like `a/b/c`.
    let label = name;
    let current = child;
    while (current.documents.length === 0 && current.directories.size === 1) {
      const [nextName, next] = [...current.directories.entries()][0] as [string, Branch];
      label = `${label}/${nextName}`;
      current = next;
    }
    nodes.push({ kind: 'directory', name: label, children: toNodes(current) });
  }
  for (const document of branch.documents) {
    nodes.push({
      kind: 'document',
      name: document.pathSegments.at(-1) ?? document.title,
      document,
    });
  }
  return nodes;
}

export function buildTree(documents: DocumentSummary[]): TreeNode[] {
  const files = documents.filter((document) => document.sourceKind === 'file');
  const others = documents.filter((document) => document.sourceKind !== 'file');
  // Drop the parent directories shared by all documents. Documents under different roots are shown from where they start to differ.
  const skip = commonPrefixLength(files.map((document) => document.pathSegments));
  const root = emptyBranch();
  for (const document of files) {
    let branch = root;
    for (const segment of document.pathSegments.slice(skip, -1)) {
      let next = branch.directories.get(segment);
      if (!next) {
        next = emptyBranch();
        branch.directories.set(segment, next);
      }
      branch = next;
    }
    branch.documents.push(document);
  }
  const nodes = toNodes(root);
  if (others.length > 0) {
    nodes.push({
      kind: 'directory',
      name: INPUT_GROUP_NAME,
      children: others.map((document) => ({ kind: 'document', name: document.title, document })),
    });
  }
  return nodes;
}
