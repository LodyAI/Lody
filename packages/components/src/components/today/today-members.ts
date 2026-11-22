import { createContext, useContext } from 'react';
import type { WorkspaceMember } from '@/hooks/use-workspace-members';

/** The workspace's members by user id, for member mentions and the picker. */
export const TodayMembersContext = createContext<ReadonlyMap<string, WorkspaceMember>>(new Map());

export function useTodayMembers(): ReadonlyMap<string, WorkspaceMember> {
  return useContext(TodayMembersContext);
}

/** Members whose name or email contains `query` (any case), in the given order. */
export function selectTodayMembers(
  members: Iterable<WorkspaceMember>,
  query: string,
  limit: number
): WorkspaceMember[] {
  const term = query.trim().toLocaleLowerCase();
  const out: WorkspaceMember[] = [];
  for (const member of members) {
    if (out.length >= limit) break;
    const fields = [member.name, member.email ?? ''].map((field) => field.toLocaleLowerCase());
    if (!term || fields.some((field) => field.includes(term))) out.push(member);
  }
  return out;
}
