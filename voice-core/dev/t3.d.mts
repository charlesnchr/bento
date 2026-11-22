export interface Project { title: string; path: string; parts?: string[] }
export function pick(all: Project[], name: string | null | undefined, said?: string): Project | null;
