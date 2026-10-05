import { seedProjects } from '~/data/seed';
import type { ApprovalProject, LegacyApprovalProject } from '~/types/certification';
import { backfillRevision, deepClone } from './version-chain';

const STORAGE_KEY = 'vehicle-type-approval-projects-v1';

function currentProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') {
    return (deepClone(seedProjects) as LegacyApprovalProject[]).map((project) => backfillRevision(project));
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return (JSON.parse(raw) as LegacyApprovalProject[]).map((project) => backfillRevision(project));
    }
    return (deepClone(seedProjects) as LegacyApprovalProject[]).map((project) => backfillRevision(project));
  } catch {
    return (deepClone(seedProjects) as LegacyApprovalProject[]).map((project) => backfillRevision(project));
  }
}

export const mockFetch: typeof fetch = async (input) => {
  const source = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(source, 'http://local.test');
  await new Promise((resolve) => setTimeout(resolve, 70));

  const send = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        'content-type': 'application/json'
      }
    });

  if (url.pathname === '/api/projects') {
    return send(currentProjects());
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match) {
    const project = currentProjects().find((item) => item.id === decodeURIComponent(match[1]));
    return project ? send(project) : send({ message: '项目不存在' }, 404);
  }

  return send({ message: '未实现的模拟接口' }, 404);
};
