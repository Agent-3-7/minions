import type { ScheduledTask } from '@shared/types';
import { scheduleRaw, scheduleSummary } from './schedule';

function deliveryName(scheduledTask: ScheduledTask): string {
  const deliver = scheduledTask.deliver?.trim();
  if (!deliver || deliver === 'local') return 'Runs page / local output';
  if (deliver === 'origin') return 'Original channel';
  return deliver;
}

function rawDeliverySetting(scheduledTask: ScheduledTask): string {
  const deliver = scheduledTask.deliver?.trim();
  return deliver ? `deliver=${deliver}` : 'not set';
}

function friendlyDeliveryIssue(scheduledTask: ScheduledTask): string | null {
  const error = scheduledTask.lastDeliveryError?.trim();
  if (!error) return null;

  if (scheduledTask.deliver?.trim() === 'origin' && error.includes('no delivery target resolved')) {
    return 'The task is set to deliver to the Original channel, but this recurring task does not have an original channel attached.';
  }

  return error;
}

function scheduleLine(scheduledTask: ScheduledTask): string {
  const raw = scheduleRaw(scheduledTask);
  const summary = scheduleSummary(scheduledTask);
  return raw && raw !== summary ? `${summary} (${raw})` : summary;
}

function optionalLine(label: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `- ${label}: ${trimmed}` : null;
}

export function scheduledTaskDeliveryIssueText(scheduledTask: ScheduledTask): string | null {
  const issue = friendlyDeliveryIssue(scheduledTask);
  if (!issue) return null;

  const taskErrored = scheduledTask.lastStatus === 'error' || Boolean(scheduledTask.lastError?.trim());
  const prefix = taskErrored
    ? `The latest run failed, and the result also could not be delivered to ${deliveryName(scheduledTask)}.`
    : `The task ran successfully and saved its output, but it could not deliver the result to ${deliveryName(scheduledTask)}.`;
  return `${prefix} ${issue}`;
}

export function buildScheduledTaskFixDraft(scheduledTask: ScheduledTask): string {
  const hasDeliveryIssue = Boolean(scheduledTask.lastDeliveryError?.trim());
  const issue = scheduledTaskDeliveryIssueText(scheduledTask);
  const rawError = scheduledTask.lastDeliveryError?.trim();
  const instruction = hasDeliveryIssue && scheduledTask.deliver?.trim() === 'origin'
    ? 'Please inspect the task and make the smallest reasonable fix so future runs work correctly. For this delivery issue, if there is no original channel to send to, it is fine to switch delivery to local so results are saved in the Runs page.'
    : 'Please inspect the task and make the smallest reasonable fix so future runs work correctly.';
  const verification = 'After making the fix, run the recurring task once if that is safe, then check the new run and confirm whether the issue is resolved.';
  const lines = [
    hasDeliveryIssue
      ? 'Help me fix this recurring task delivery issue.'
      : 'Help me fix this recurring task issue.',
    '',
    'What happened:',
    issue ?? 'This recurring task needs attention.',
    '',
    'Recurring task details:',
    `- Name: ${scheduledTask.name}`,
    `- ID: ${scheduledTask.id}`,
    `- Current delivery: ${deliveryName(scheduledTask)} (${rawDeliverySetting(scheduledTask)})`,
    `- Schedule: ${scheduleLine(scheduledTask)}`,
    `- Enabled: ${scheduledTask.enabled ? 'Yes' : 'No'}`,
    optionalLine('Latest run status', scheduledTask.lastStatus),
    optionalLine('Latest run time', scheduledTask.lastRunAt),
    rawError ? `- Raw delivery error: ${rawError}` : null,
    optionalLine('Task error', scheduledTask.lastError),
    optionalLine('Model', scheduledTask.model),
    optionalLine('Provider', scheduledTask.provider),
    optionalLine('Working directory', scheduledTask.workdir),
    '',
    instruction,
    '',
    verification,
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}

export function buildScheduledTaskEditDraft(scheduledTask: ScheduledTask): string {
  return [
    'I want to edit this recurring task.',
    '',
    `Task: ${scheduledTask.name}`,
    `ID: ${scheduledTask.id}`,
    '',
    'Requested change:',
  ].join('\n');
}
