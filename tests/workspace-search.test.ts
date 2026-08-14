import { describe, expect, it } from "vitest";
import type { ProjectRecord, SessionRecord } from "../src/shared/contracts";
import {
  projectDisplayName,
  workspaceSearchItems,
} from "../src/renderer/workspace-search";

const projects: ProjectRecord[] = [
  {
    id: "mall",
    name: "mall-service",
    alias: "商城服务",
    pinned: true,
    rootPath: "D:\\workspace\\mall-service",
    createdAt: 1,
    lastOpenedAt: 2,
  },
  {
    id: "order",
    name: "order-center",
    pinned: false,
    rootPath: "D:\\workspace\\order-center",
    createdAt: 2,
    lastOpenedAt: 3,
  },
];

const sessions: SessionRecord[] = [
  {
    id: "scratch",
    projectId: null,
    title: "临时方案讨论",
    cwd: "C:\\Users\\dev\\AppData\\Roaming\\Claude Workspace\\temporary-workspaces\\session-one",
    status: "running",
    createdAt: 3,
  },
  {
    id: "login-fix",
    projectId: "mall",
    title: "修复登录超时",
    cwd: "D:\\workspace\\mall-service",
    status: "running",
    createdAt: 4,
  },
];

describe("workspace search", () => {
  it("uses a project alias as its display name", () => {
    expect(projectDisplayName(projects[0])).toBe("商城服务");
    expect(projectDisplayName(projects[1])).toBe("order-center");
  });

  it("finds projects by path and sessions by title or project alias", () => {
    expect(workspaceSearchItems(projects, sessions, "order-center")).toEqual([
      expect.objectContaining({ kind: "project", projectId: "order" }),
    ]);
    expect(workspaceSearchItems(projects, sessions, "登录")).toEqual([
      expect.objectContaining({ kind: "session", sessionId: "login-fix" }),
    ]);
    expect(workspaceSearchItems(projects, sessions, "商城")).toEqual([
      expect.objectContaining({ kind: "project", projectId: "mall" }),
      expect.objectContaining({ kind: "session", sessionId: "login-fix" }),
    ]);
    expect(workspaceSearchItems(projects, sessions, "临时")).toEqual([
      expect.objectContaining({
        kind: "session",
        projectId: null,
        sessionId: "scratch",
      }),
    ]);
  });
});
