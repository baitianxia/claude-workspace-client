import { stat } from "node:fs/promises";
import type { ClaudeExecutableState } from "../shared/contracts";
import {
  detectClaudeExecutable,
  validateClaudeExecutable,
} from "./claude-executable";
import type { ProjectStore } from "./project-store";

export class ClaudeLocator {
  private state: ClaudeExecutableState = {
    path: null,
    source: "missing",
  };

  constructor(private readonly projectStore: ProjectStore) {}

  getState(): ClaudeExecutableState {
    return { ...this.state };
  }

  async initialize(): Promise<ClaudeExecutableState> {
    const configured = this.projectStore.getClaudeExecutable();
    if (configured) {
      try {
        const validated = await validateClaudeExecutable(configured);
        this.state = { path: validated, source: "custom" };
        return this.getState();
      } catch {
        await this.projectStore.setClaudeExecutable(undefined);
      }
    }

    return this.autoDetect();
  }

  async autoDetect(): Promise<ClaudeExecutableState> {
    const previousState = this.getState();
    const detected = await detectClaudeExecutable();
    if (detected) {
      if (this.projectStore.getClaudeExecutable()) {
        await this.projectStore.setClaudeExecutable(undefined);
      }
      this.state = { path: detected, source: "detected" };
    } else if (previousState.path && (await this.isFile(previousState.path))) {
      this.state = previousState;
    } else {
      this.state = {
        path: null,
        source: "missing",
        error:
          "未找到本机 Claude Code。请安装原生 CLI，或手动选择 %USERPROFILE%\\.local\\bin\\claude.exe。",
      };
    }
    return this.getState();
  }

  async setCustomExecutable(executablePath: string): Promise<ClaudeExecutableState> {
    const validated = await validateClaudeExecutable(executablePath);
    await this.projectStore.setClaudeExecutable(validated);
    this.state = { path: validated, source: "custom" };
    return this.getState();
  }

  requireExecutable(): string {
    if (!this.state.path) {
      throw new Error("未找到 Claude Code，请先选择本机 claude.exe。");
    }
    return this.state.path;
  }

  private async isFile(candidate: string): Promise<boolean> {
    try {
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  }
}
