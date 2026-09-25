/**
 * Export helpers — CSV / HTML converters + the exportReport dispatcher
 * that looks up a stored report by ID and renders it to the requested
 * format. Pure functions; dispatcher provides the report-getter callback.
 */
import { AgentTask, TaskResult } from '@shared/types/agent';

export function convertToCSV(report: Record<string, unknown>): string {
  return Object.entries(report)
    .map(([key, value]) => `${key},${JSON.stringify(value)}`)
    .join('\n');
}

export function convertToHTML(report: Record<string, unknown>): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>ZKward Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #2c3e50; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #3498db; color: white; }
  </style>
</head>
<body>
  <h1>ZKward Report</h1>
  <pre>${JSON.stringify(report, null, 2)}</pre>
</body>
</html>
    `;
}

export async function exportReport(
  task: AgentTask,
  agentId: string,
  getReport: (reportId: string) => unknown,
): Promise<TaskResult> {
  const startTime = Date.now();
  const parameters = task.parameters as { reportId: string; format: 'JSON' | 'PDF' | 'HTML' | 'CSV' };
  const { reportId, format } = parameters;

  const report = getReport(reportId);
  if (!report) {
    throw new Error(`Report ${reportId} not found`);
  }

  let exportedData: string;
  switch (format) {
    case 'JSON':
      exportedData = JSON.stringify(report, null, 2);
      break;
    case 'CSV':
      exportedData = convertToCSV(report as Record<string, unknown>);
      break;
    case 'HTML':
      exportedData = convertToHTML(report as Record<string, unknown>);
      break;
    case 'PDF':
      // In production, use a PDF library. Matches pre-refactor behavior.
      exportedData = JSON.stringify(report);
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  return {
    success: true,
    data: { reportId, format, data: exportedData },
    error: null,
    executionTime: Date.now() - startTime,
    agentId,
  };
}
