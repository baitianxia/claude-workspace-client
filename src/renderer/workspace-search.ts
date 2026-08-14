import type { ProjectRecord, SessionRecord } from "../shared/contracts";

export interface WorkspaceSearchItem {
  key: string;
  kind: "project" | "session";
  projectId: string | null;
  sessionId?: string;
  title: string;
  subtitle: string;
}

export function projectDisplayName(project: ProjectRecord): string {
  return project.alias?.trim() || project.name;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function workspaceSearchItems(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  query: string,
): WorkspaceSearchItem[] {
  const needle = normalized(query);
  const sessionsByProject = new Map<string | null, SessionRecord[]>();
  for (const session of sessions) {
    const projectSessions = sessionsByProject.get(session.projectId) ?? [];
    projectSessions.push(session);
    sessionsByProject.set(session.projectId, projectSessions);
  }

  const items: WorkspaceSearchItem[] = [];
  for (const session of sessionsByProject.get(null) ?? []) {
    const sessionItem: WorkspaceSearchItem = {
      key: `session:${session.id}`,
      kind: "session",
      projectId: null,
      sessionId: session.id,
      title: session.title,
      subtitle: "临时会话 · 不关联工程目录",
    };
    if (
      !needle ||
      normalized(`${session.title} 临时会话 ${session.cwd}`).includes(needle)
    ) {
      items.push(sessionItem);
    }
  }
  for (const project of projects) {
    const projectTitle = projectDisplayName(project);
    const projectItem: WorkspaceSearchItem = {
      key: `project:${project.id}`,
      kind: "project",
      projectId: project.id,
      title: projectTitle,
      subtitle: project.rootPath,
    };
    if (
      !needle ||
      normalized(`${projectTitle} ${project.name} ${project.rootPath}`).includes(
        needle,
      )
    ) {
      items.push(projectItem);
    }

    for (const session of sessionsByProject.get(project.id) ?? []) {
      const sessionItem: WorkspaceSearchItem = {
        key: `session:${session.id}`,
        kind: "session",
        projectId: project.id,
        sessionId: session.id,
        title: session.title,
        subtitle: projectTitle,
      };
      if (
        !needle ||
        normalized(
          `${session.title} ${projectTitle} ${project.name} ${project.rootPath}`,
        ).includes(needle)
      ) {
        items.push(sessionItem);
      }
    }
  }
  return items;
}
