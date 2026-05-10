import type { Task } from '@shared/types';

export function hasUnseenAgentResponse(task: Task): boolean {
  return (
    task.last_agent_response_at !== null &&
    (task.last_viewed_at === null ||
      task.last_viewed_at < task.last_agent_response_at)
  );
}
