export interface WakeModelEntry {
  id: string;
  label: string;
  path: string;
}

export function labelForModel(id: string): string;
export function discoverWakeModels(dirs?: {
  extraDir?: string | null;
  repoDir?: string | null;
  lkwwDir?: string | null;
}): Map<string, WakeModelEntry>;
