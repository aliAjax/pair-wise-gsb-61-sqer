import { seedProjects } from '~/data/seed';
import type { ApprovalProject } from '~/types/certification';

const STORAGE_KEY = 'vehicle-type-approval-projects-v1';
const BACKUP_KEY = `${STORAGE_KEY}:backup`;

function currentProjects(): ApprovalProject[] {
  if (typeof localStorage === 'undefined') return structuredClone(seedProjects);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as ApprovalProject[];
    } catch {
      // 主键损坏，从最近完整批次恢复
    }
  }
  const backup = localStorage.getItem(BACKUP_KEY);
  if (backup) {
    try {
      return JSON.parse(backup) as ApprovalProject[];
    } catch {
      // 备份也损坏，回退种子数据
    }
  }
  return structuredClone(seedProjects);
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
